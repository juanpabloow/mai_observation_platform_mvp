import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Receptor del webhook de WhatsApp de Meta — la lógica, sin Next ni pino.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 *
 * Meta manda en el MISMO campo `messages` del webhook los mensajes de los clientes y los avisos
 * de estado («enviado», «entregado», «leído») de lo que responde el bot, y no deja apagar los
 * segundos. Cada aviso arrancaba una ejecución de n8n que moría en «Filter messages types»: el
 * 69 % de las ejecuciones del plan (medido el 3 nov). Este receptor se pone delante: verifica la
 * firma de Meta, descarta los POST que solo traen `statuses` y reenvía el resto a n8n tal cual.
 *
 * ── Qué se reenvía ─────────────────────────────────────────────────────────
 *
 * El cuerpo CRUDO, byte a byte, más dos firmas:
 *   - `X-Hub-Signature-256`, la ORIGINAL de Meta. Es lo que comprueba el nodo «WhatsApp Trigger»
 *     de n8n (HMAC del cuerpo con el App Secret), así que reenviar al trigger funciona sin tocar
 *     el workflow mientras el cuerpo no cambie ni un byte.
 *   - `X-Mai-Signature`, propia: `sha256=<hex HMAC-SHA256(WHATSAPP_FORWARD_SECRET, cuerpo)>`, el
 *     mismo formato que `X-Handoff-Signature`. Es la que verifica un nodo Webhook de n8n si se
 *     sustituye el trigger (docs/ops/whatsapp-webhook-filtro.md).
 *
 * Se descarta SOLO lo que es seguro descartar: un POST en el que TODOS los cambios traen
 * `statuses` y ninguno `messages`. Lo que no se reconozca (errores de sistema, campos nuevos de
 * Meta) se reenvía, que es lo que pasaba antes de este receptor.
 *
 * ── Privacidad ─────────────────────────────────────────────────────────────
 *
 * Los registros llevan el tipo (mensajes/avisos, el `type` de cada mensaje y el `status` de cada
 * aviso), la cuenta de WhatsApp, el phone_number_id y el resultado. Nunca el texto, el teléfono,
 * el BSUID ni el nombre del cliente, y nunca la URL completa de reenvío (su ruta lleva el id del
 * webhook de n8n): solo su host.
 */

export const META_SIGNATURE_HEADER = "x-hub-signature-256";
export const MAI_SIGNATURE_HEADER = "x-mai-signature";
/** Meta manda lotes pequeños; esto solo corta cuerpos absurdos. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** n8n responde al recibir (el trigger y el Webhook usan «onReceived»): 8 s es de sobra. */
export const FORWARD_TIMEOUT_MS = 8000;

export const REQUIRED_ENV = ["META_APP_SECRET", "META_VERIFY_TOKEN", "WHATSAPP_FORWARD_URL", "WHATSAPP_FORWARD_SECRET"] as const;
type EnvName = (typeof REQUIRED_ENV)[number];

export type WebhookConfig =
  | { enabled: true; appSecret: string; verifyToken: string; forwardUrl: string; forwardSecret: string; forwardHost: string }
  | { enabled: false; missing: EnvName[]; invalid: EnvName[] };

/** Lee la configuración. Sin las cuatro variables (o con una URL inválida) queda deshabilitado. */
export function readWebhookConfig(env: Record<string, string | undefined>): WebhookConfig {
  const val = (k: EnvName) => (env[k] ?? "").trim();
  const missing = REQUIRED_ENV.filter((k) => !val(k));
  const invalid: EnvName[] = [];
  let forwardHost = "";
  const rawUrl = val("WHATSAPP_FORWARD_URL");
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      if (u.protocol === "https:" || (u.protocol === "http:" && local)) forwardHost = u.host;
      else invalid.push("WHATSAPP_FORWARD_URL");
    } catch {
      invalid.push("WHATSAPP_FORWARD_URL");
    }
  }
  if (missing.length || invalid.length) return { enabled: false, missing, invalid };
  return {
    enabled: true,
    appSecret: val("META_APP_SECRET"),
    verifyToken: val("META_VERIFY_TOKEN"),
    forwardUrl: rawUrl,
    forwardSecret: val("WHATSAPP_FORWARD_SECRET"),
    forwardHost,
  };
}

/** Una línea para el arranque: nombres de variables y host, nunca valores. */
export function describeConfig(cfg: WebhookConfig): string {
  if (cfg.enabled) return `[whatsapp-webhook] habilitado: reenvía mensajes a ${cfg.forwardHost}`;
  const parts = [
    cfg.missing.length ? `faltan ${cfg.missing.join(", ")}` : "",
    cfg.invalid.length ? `no válidas ${cfg.invalid.join(", ")} (https, o http solo en localhost)` : "",
  ].filter(Boolean);
  return `[whatsapp-webhook] deshabilitado: ${parts.join("; ")}`;
}

export function signBody(secret: string, body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Compara `sha256=<hex>` contra el HMAC del cuerpo, en tiempo constante. */
export function verifySignature(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(signBody(secret, body), "utf8");
  const given = Buffer.from(header.trim().toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Compara dos cadenas en tiempo constante (el verify token). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface PayloadSummary {
  /** Cambios con `messages` (mensajes de clientes) y con `statuses` (avisos). */
  messages: number;
  statuses: number;
  /** Cambios que no traen ni lo uno ni lo otro (errores de sistema, campos nuevos). */
  other: number;
  /** `messages[].type` (text, image, reaction…) y `statuses[].status` (sent, delivered, read…). */
  messageTypes: Record<string, number>;
  statusValues: Record<string, number>;
  wabaIds: string[];
  phoneNumberIds: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const bump = (m: Record<string, number>, k: unknown) => {
  const key = typeof k === "string" && k ? k.slice(0, 40) : "unknown";
  m[key] = (m[key] ?? 0) + 1;
};

/** Resume el cuerpo de Meta sin copiar nada personal. */
export function summarizePayload(body: unknown): PayloadSummary {
  const s: PayloadSummary = { messages: 0, statuses: 0, other: 0, messageTypes: {}, statusValues: {}, wabaIds: [], phoneNumberIds: [] };
  const waba = new Set<string>();
  const phones = new Set<string>();
  for (const entry of arr(isObj(body) ? body.entry : undefined)) {
    if (!isObj(entry)) continue;
    if (typeof entry.id === "string") waba.add(entry.id);
    for (const change of arr(entry.changes)) {
      const value = isObj(change) ? change.value : undefined;
      if (!isObj(value)) {
        s.other++;
        continue;
      }
      const pid = isObj(value.metadata) ? value.metadata.phone_number_id : undefined;
      if (typeof pid === "string") phones.add(pid);
      const msgs = arr(value.messages);
      const sts = arr(value.statuses);
      if (msgs.length) {
        s.messages++;
        for (const m of msgs) bump(s.messageTypes, isObj(m) ? m.type : undefined);
      }
      if (sts.length) {
        s.statuses++;
        for (const st of sts) bump(s.statusValues, isObj(st) ? st.status : undefined);
      }
      if (!msgs.length && !sts.length) s.other++;
    }
  }
  s.wabaIds = [...waba];
  s.phoneNumberIds = [...phones];
  return s;
}

/** Solo avisos: hay al menos un cambio y todos son de `statuses` sin `messages`. */
export function isStatusOnly(s: PayloadSummary): boolean {
  return s.statuses > 0 && s.messages === 0 && s.other === 0;
}

export type Outcome =
  | "forwarded"
  | "dropped_statuses"
  | "forward_failed"
  | "bad_signature"
  | "invalid_body"
  | "disabled"
  | "verify_ok"
  | "verify_rejected";

/** Contadores desde que arrancó el proceso; van en cada registro para comprobarlo en Railway. */
export class WebhookCounters {
  forwarded = 0;
  dropped_statuses = 0;
  forward_failed = 0;
  bad_signature = 0;
  invalid_body = 0;
  disabled = 0;
  verify_ok = 0;
  verify_rejected = 0;
  readonly since = new Date().toISOString();
  record(o: Outcome): void {
    this[o]++;
  }
  snapshot() {
    return {
      since: this.since,
      forwarded: this.forwarded,
      dropped_statuses: this.dropped_statuses,
      forward_failed: this.forward_failed,
      bad_signature: this.bad_signature,
    };
  }
}

export interface WebhookLogEntry {
  event: "whatsapp_webhook";
  outcome: Outcome;
  messages?: number;
  statuses?: number;
  other?: number;
  message_types?: Record<string, number>;
  status_values?: Record<string, number>;
  waba_ids?: string[];
  phone_number_ids?: string[];
  forward_host?: string;
  upstream_status?: number;
  error?: string;
  duration_ms?: number;
  counters: ReturnType<WebhookCounters["snapshot"]>;
}

export interface WebhookDeps {
  config: WebhookConfig;
  fetch: typeof fetch;
  log: (level: "info" | "warn" | "error", entry: WebhookLogEntry) => void;
  counters: WebhookCounters;
  timeoutMs?: number;
}

const jsonError = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

const DISABLED_MESSAGE = "El receptor del webhook de WhatsApp no está configurado.";

/** GET — verificación de Meta al guardar la URL del webhook (o un override por cuenta/número). */
export function handleVerify(url: URL, deps: WebhookDeps): Response {
  const { config, counters } = deps;
  if (!config.enabled) {
    counters.record("disabled");
    deps.log("warn", { event: "whatsapp_webhook", outcome: "disabled", counters: counters.snapshot() });
    return jsonError(503, "disabled", DISABLED_MESSAGE);
  }
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && challenge && safeEqual(token, config.verifyToken)) {
    counters.record("verify_ok");
    deps.log("info", { event: "whatsapp_webhook", outcome: "verify_ok", counters: counters.snapshot() });
    // El challenge se devuelve tal cual (lo exige Meta), como texto plano y sin sniffing.
    return new Response(challenge, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  counters.record("verify_rejected");
  deps.log("warn", { event: "whatsapp_webhook", outcome: "verify_rejected", counters: counters.snapshot() });
  return new Response("Forbidden", { status: 403 });
}

/** POST — firma, clasificación y reenvío. */
export async function handleEvent(req: Request, deps: WebhookDeps): Promise<Response> {
  const { config, counters } = deps;
  const started = Date.now();
  if (!config.enabled) {
    // 503: si Meta llegara a apuntar aquí sin configurar, reintenta en vez de perder mensajes.
    counters.record("disabled");
    deps.log("warn", { event: "whatsapp_webhook", outcome: "disabled", counters: counters.snapshot() });
    return jsonError(503, "disabled", DISABLED_MESSAGE);
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return jsonError(413, "too_large", "Cuerpo demasiado grande.");
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return jsonError(413, "too_large", "Cuerpo demasiado grande.");

  const metaSignature = req.headers.get(META_SIGNATURE_HEADER);
  if (!verifySignature(config.appSecret, raw, metaSignature)) {
    counters.record("bad_signature");
    deps.log("warn", { event: "whatsapp_webhook", outcome: "bad_signature", counters: counters.snapshot() });
    return jsonError(401, "bad_signature", "Firma no válida.");
  }

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    counters.record("invalid_body");
    deps.log("warn", { event: "whatsapp_webhook", outcome: "invalid_body", counters: counters.snapshot() });
    return jsonError(400, "invalid_body", "El cuerpo no es JSON.");
  }

  const summary = summarizePayload(body);
  const shape = {
    messages: summary.messages,
    statuses: summary.statuses,
    other: summary.other,
    message_types: summary.messageTypes,
    status_values: summary.statusValues,
    waba_ids: summary.wabaIds,
    phone_number_ids: summary.phoneNumberIds,
  };

  if (isStatusOnly(summary)) {
    counters.record("dropped_statuses");
    deps.log("info", { event: "whatsapp_webhook", outcome: "dropped_statuses", ...shape, counters: counters.snapshot() });
    return Response.json({ ok: true, forwarded: false });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? FORWARD_TIMEOUT_MS);
  let upstream: Response | null = null;
  let error: string | undefined;
  try {
    upstream = await deps.fetch(config.forwardUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [META_SIGNATURE_HEADER]: metaSignature ?? "",
        [MAI_SIGNATURE_HEADER]: signBody(config.forwardSecret, raw),
      },
      body: raw,
      signal: ctrl.signal,
      redirect: "manual",
    });
    // El cuerpo de n8n no interesa; se consume para liberar la conexión.
    await upstream.arrayBuffer().catch(() => undefined);
  } catch (err) {
    error = ctrl.signal.aborted ? "timeout" : (err as Error).name || "fetch_error";
  } finally {
    clearTimeout(timer);
  }

  const duration_ms = Date.now() - started;
  if (upstream && upstream.status >= 200 && upstream.status < 300) {
    counters.record("forwarded");
    deps.log("info", {
      event: "whatsapp_webhook",
      outcome: "forwarded",
      ...shape,
      forward_host: config.forwardHost,
      upstream_status: upstream.status,
      duration_ms,
      counters: counters.snapshot(),
    });
    return Response.json({ ok: true, forwarded: true });
  }

  // n8n caído o con error: 502 para que Meta reintente. Los reintentos llegan con el mismo wamid
  // y el workflow ya descarta duplicados por él (external_message_id en /api/handoff/v1/messages).
  counters.record("forward_failed");
  deps.log("error", {
    event: "whatsapp_webhook",
    outcome: "forward_failed",
    ...shape,
    forward_host: config.forwardHost,
    upstream_status: upstream?.status,
    error,
    duration_ms,
    counters: counters.snapshot(),
  });
  return jsonError(502, "forward_failed", "No se pudo entregar el mensaje a n8n.");
}
