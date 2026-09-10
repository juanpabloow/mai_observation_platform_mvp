import { z } from "zod";

/**
 * Validación PURA de los cuerpos de `/api/meetings/v1`. Sin `server-only`, sin
 * PostgreSQL, así que se prueba en aislamiento.
 *
 * Misma convención que `crmValidation.ts`, y por las mismas razones:
 *
 *  - `.strict()` **rechaza claves desconocidas**. No es purismo: un cuerpo con
 *    `attemp` en vez de `attempt` fallaría igual por campo obligatorio ausente,
 *    pero uno con `tenantId` de más avisa de que alguien está intentando
 *    inyectar ámbito — y ese campo NUNCA se lee de la petición.
 *  - **sin coerción**: `"3"` no se convierte en `3` ni `"true"` en `true`. Un
 *    worker que manda el tipo equivocado tiene un bug, y descubrirlo en el
 *    borde es más barato que descubrirlo cuando la base rechace el valor.
 *  - los `parse*` devuelven `{ ok, value } | { ok: false, error }` y **nunca
 *    lanzan**, así que una entrada inválida no puede convertirse en un 500.
 *  - el llamador reconstruye el payload desde `value`, nunca reutiliza el
 *    objeto crudo.
 *
 * ── Por qué esto no estaba y qué arregla ────────────────────────────────────
 *
 * Las rutas leían campo a campo con helpers (`requireString`, `requireInt`) y
 * hacían `body.sourceKind as never` para el enum. Ese cast significaba que un
 * `sourceKind: "loquesea"` llegaba intacto al `INSERT` y salía como una
 * violación de CHECK — es decir, como un 500 causado por entrada inválida. Aquí
 * es un 400 con el campo nombrado.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

const uuid = z.string().refine(isUuid, "must be a UUID");
/** SHA-256 en hexadecimal, minúsculas o mayúsculas. */
const sha256Hex = z.string().regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest");
/** ISO 8601 con offset explícito: sin él, «cuándo empezó» es ambiguo. */
const isoDateTime = z.string().datetime({ offset: true });
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

/** Espeja el CHECK de `meetings.source_kind`. */
export const SOURCE_KINDS = ["file", "meet", "inbox", "room", "api"] as const;
/** Espeja `meetings_stage_capability`, para el filtro voluntario del claim. */
export const WORKER_CAPABILITIES = ["meetings.transcribe", "meetings.analyze"] as const;

/**
 * Cotas de tamaño. No son adornos: `attempt` es `smallint` en la base y
 * `progress_pct` tiene un CHECK de 0..100. Validarlos aquí convierte una
 * violación de constraint —un 500— en un 400 que dice qué campo está mal.
 */
const attempt = z.number().int().min(0).max(999);
const byteCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const leaseToken = z.string().min(8).max(512);

// ── Lado aplicación (sesión) ────────────────────────────────────────────────

export const CreateMeetingBody = z
  .object({
    clientId: uuid,
    title: nonEmpty(500),
    idempotencyKey: nonEmpty(200),
    sourceKind: z.enum(SOURCE_KINDS).optional(),
    startedAt: isoDateTime.nullish(),
    languageHint: nonEmpty(35).nullish(),
  })
  .strict();

export const UploadInitBody = z
  .object({
    clientId: uuid,
    filename: nonEmpty(400),
    contentType: nonEmpty(200),
    bytes: byteCount,
    checksumSha256: sha256Hex.optional(),
  })
  .strict();

/**
 * Cuántas personas hablan, si quien sube la reunión lo sabe.
 *
 * `null` y ausente significan lo mismo: AUTOMÁTICO, que el diarizador lo decida. No
 * es lo mismo que 1 — «no lo sé» y «habla una sola persona» son respuestas distintas
 * y llevan al diarizador por caminos distintos.
 *
 * El tope es el mismo `diarization_max_speakers` del worker (10). Pedir más no lo
 * mejoraría: el worker lo recortaría, y entonces la base guardaría una intención que
 * no fue la que corrió.
 */
export const SPEAKER_COUNT_MIN = 1;
export const SPEAKER_COUNT_MAX = 10;
export const speakerCount = z
  .number()
  .int()
  .min(SPEAKER_COUNT_MIN)
  .max(SPEAKER_COUNT_MAX)
  .nullish();

export const UploadCompleteBody = z
  .object({
    clientId: uuid,
    bytes: byteCount,
    checksumSha256: sha256Hex,
    speakerCount: speakerCount,
  })
  .strict();

export const ClientScopedBody = z.object({ clientId: uuid }).strict();

/** La query de la lectura de estado. `clientId` va ahí, no en el cuerpo. */
export const MeetingStateQuery = z.object({ clientId: uuid }).strict();

// ── Lado worker (token) ─────────────────────────────────────────────────────

/**
 * El cuerpo del claim es OPCIONAL y sólo lleva telemetría más una restricción
 * voluntaria de capacidades. Nada de él autoriza: el ámbito y las capacidades
 * efectivas salen de la credencial. `capabilities` sólo puede REDUCIR.
 */
export const ClaimBody = z
  .object({
    workerLabel: nonEmpty(120).nullish(),
    capabilities: z.array(z.enum(WORKER_CAPABILITIES)).min(1).max(8).optional(),
  })
  .strict();

const leaseProof = { attempt, leaseToken } as const;

export const HeartbeatBody = z
  .object({
    ...leaseProof,
    progressPct: z.number().int().min(0).max(100).nullish(),
  })
  .strict();

export const FailBody = z
  .object({
    ...leaseProof,
    // Un código estable, no una frase: el worker los compara.
    failureCode: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_]+$/, "must be lower_snake_case"),
    failureDetail: z.string().max(2000).nullish(),
  })
  .strict();

export const ResultInitBody = z
  .object({
    ...leaseProof,
    bytes: byteCount,
    checksumSha256: sha256Hex,
    itemCount: z.number().int().min(0).max(10_000_000).nullish(),
    // Sólo la versión que mai sabe leer. Una futura se rechaza aquí con un
    // código propio en vez de fallar al parsear el artefacto ya subido.
    schemaVersion: z.literal(1).optional(),
  })
  .strict();

/**
 * Lo que `ffprobe` midió del audio normalizado. Sólo lo manda `normalize`.
 *
 * Los tres campos del FORMATO son obligatorios. Antes eran `nullish()`, y esa
 * laxitud dejaba pasar un sondeo a medias —`{ codec: 'pcm_s16le' }`— que mai
 * persistía como si hubiera medido el audio entero. Un sondeo parcial no es un
 * sondeo: es una afirmación sobre lo que no se miró.
 *
 * `durationSeconds` sí puede faltar, y es la única concesión: ffprobe no
 * siempre informa duración —un WAV truncado, un contenedor sin cabecera— y
 * rechazar por eso descartaría audio perfectamente transcribible. Omitirlo y
 * mandar `null` significan lo mismo.
 *
 * Los VALORES pactados (16 kHz, mono, pcm_s16le) NO se comprueban aquí: son de
 * pipeline, no de forma, y viven en `src/meetings/normalizedAudio.ts`. Aquí se
 * exige que el sondeo esté completo; allí, que diga lo correcto. Un sondeo
 * completo con los números equivocados es una petición válida sobre un medio
 * inválido, y merece 422, no 400.
 */
const probe = z
  .object({
    durationSeconds: z.number().min(0).max(24 * 3600).nullish(),
    sampleRate: z.number().int().positive().max(768_000),
    channels: z.number().int().positive().max(64),
    codec: nonEmpty(60),
  })
  .strict();

/**
 * `probe` sigue siendo OPCIONAL en el esquema, y tiene que serlo: si es
 * obligatorio depende de la ETAPA del job, y la etapa no está en el cuerpo —
 * sale del job, que el cuerpo no puede elegir. La regla condicional vive en
 * `assertProbeMatchesStage`, que sí conoce las dos cosas.
 */
export const ResultCompleteBody = z
  .object({
    ...leaseProof,
    bytes: byteCount,
    checksumSha256: sha256Hex,
    probe: probe.nullish(),
  })
  .strict();

/** El barrido no lleva cuerpo. `.strict()` sobre un objeto vacío lo dice. */
export const MaintenanceBody = z.object({}).strict();

// ── El envoltorio ───────────────────────────────────────────────────────────

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parsea sin lanzar y compone un mensaje con el CAMPO nombrado.
 *
 * El mensaje se construye a partir del path y del código de zod, no del texto
 * libre del valor: interpolar el valor recibido en la respuesta lo devolvería
 * al cliente, y de ahí a un log, y un `checksumSha256` mal formado puede ser
 * cualquier cosa que alguien pegara por error.
 */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): ParseResult<z.infer<T>> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const issue = result.error.issues[0];
  const field = issue.path.length > 0 ? issue.path.join(".") : "(cuerpo)";
  return { ok: false, error: `${field}: ${describeIssue(issue)}` };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return `se esperaba ${issue.expected}`;
    case "unrecognized_keys":
      // El caso que más importa reportar con nombre: alguien manda un campo que
      // no existe, y lo más probable es que crea que hace algo.
      return `campo no reconocido: ${issue.keys.join(", ")}`;
    case "too_big":
      return `excede el máximo permitido (${String(issue.maximum)})`;
    case "too_small":
      return `no alcanza el mínimo permitido (${String(issue.minimum)})`;
    case "invalid_value":
      return "valor no permitido";
    case "invalid_format":
      return "formato inválido";
    default:
      return "valor inválido";
  }
}
