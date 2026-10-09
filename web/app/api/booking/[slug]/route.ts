import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { checkRateLimit, clientIp, parseIsoDate } from "@/lib/schedulingApi";
import {
  projectPublicConfirmation,
  publicEngineError,
  publicError,
  publicInvalid,
  publicJson,
  publicNotFound,
  publicRateLimited,
} from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { TURNSTILE_TOKEN_MAX, verifyTurnstileToken } from "@/lib/turnstileVerify";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { getPublicStaffName } from "@worker/db/repositories/scheduling/publicCatalog.js";
import {
  consumeRateBucket,
  hashRateKey,
  sweepExpiredRateBuckets,
} from "@worker/db/repositories/scheduling/publicBookingRateLimit.js";
import { createAppointment } from "@worker/scheduling/booking.js";
import { dialingRegionForTimezone, normalizeE164 } from "@worker/scheduling/phone.js";
import { logger } from "@worker/logger.js";

/**
 * POST /api/booking/{slug} — PUBLIC booking creation (no session, no cookies).
 *
 * The defences run in this order, each before the next costs anything:
 *   1. per-process burst limiter (cheap, in memory — unchanged);
 *   2. global kill switch PUBLIC_BOOKING_DISABLED → the generic 404;
 *   3. THE public gate getPublicBookingSiteBySlug (active site + non-default client +
 *      scheduling enabled) — BEFORE any body is read, so a disabled site 404s even for
 *      junk input (test/unit/publicBookingHandlerOrder.test.ts);
 *   4. persistent IP+site limit (PostgreSQL, shared across instances, hashed key);
 *   5. strict body validation — unknown keys (tenant_id, price, status, origin…) are
 *      REJECTED, never ignored: the server derives every one of those itself;
 *   6. Cloudflare Turnstile, only when PUBLIC_BOOKING_TURNSTILE_ENABLED — verified
 *      server-side, fail closed;
 *   7. persistent phone+site limit (after Turnstile, so a bot can't burn a real
 *      customer's phone quota without solving a challenge);
 *   8. the SAME booking engine as staff and n8n: availability revalidation, the
 *      PostgreSQL exclusion constraint, Idempotency-Key replay, contact resolution by
 *      normalized phone, and the per-phone cap of future active bookings — all inside
 *      one transaction.
 *
 * A public booking is origin "public" / created_by_type "public" / channel "public" —
 * never a walk-in. The response is the minimal confirmation projection (no row ids).
 * Logs never carry a phone, an email, a name or a Turnstile token.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    service_id: z.string().uuid(),
    staff_id: z.string().uuid().nullish(),
    start_at: z.string().min(1).max(64),
    customer_name: z.string().trim().min(2).max(120),
    customer_phone: z.string().trim().min(7).max(32),
    customer_email: z.union([z.literal(""), z.string().trim().toLowerCase().email().max(254)]).nullish(),
    /** The visitor ticked "I accept the processing of my data to manage this booking". */
    privacy_accepted: z.literal(true),
    turnstile_token: z.string().max(TURNSTILE_TOKEN_MAX).nullish(),
  })
  .strict();

/** Client-chosen Idempotency-Key: a bounded, boring charset. */
const IDEMPOTENCY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** A non-reversible handle for diagnostics — never the raw value. */
const diag = (v: string): string => createHash("sha256").update(v).digest("hex").slice(0, 12);

function fieldMessage(issue: z.core.$ZodIssue | undefined): string {
  switch (issue?.path[0]) {
    case "customer_name":
      return "Escribe tu nombre completo.";
    case "customer_phone":
      return "Escribe un teléfono de WhatsApp válido.";
    case "customer_email":
      return "Revisa el correo electrónico o déjalo vacío.";
    case "privacy_accepted":
      return "Debes aceptar el tratamiento de tus datos para gestionar la reserva.";
    case "service_id":
    case "staff_id":
    case "start_at":
      return "Vuelve a elegir el servicio, el profesional y la hora.";
    default:
      return "Revisa los datos e inténtalo de nuevo.";
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const ip = clientIp(req);
  if (!checkRateLimit(`book-write:${ip}`, 8, 60_000)) return publicRateLimited(60);

  const policy = readPublicBookingPolicy();
  if (policy.disabled) return publicNotFound();
  const { slug } = await params;

  // GATE FIRST: resolve the public booking site before reading/parsing any body.
  // A disabled/unknown/default/inactive site returns the generic 404 even for an
  // invalid or empty body — the module gate never leaks through input validation.
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return publicNotFound();
  const siteDiag = diag(site.id);

  // The bucket keys are HMACs — without a secret there is nothing safe to store, so
  // creation fails CLOSED rather than falling back to an unlimited or plain-hash path.
  if (!policy.hashSecret) {
    logger.error({ site: siteDiag }, "public booking: no hashing secret configured (PUBLIC_BOOKING_HASH_SECRET / BETTER_AUTH_SECRET)");
    return publicError(503, "unavailable", "Las reservas en línea no están disponibles en este momento. Inténtalo más tarde.");
  }
  const scope = { tenantId: site.tenant_id, clientId: site.client_id, siteId: site.id };

  const ipBucket = await consumeRateBucket({
    ...scope,
    scope: "ip",
    keyHash: hashRateKey(policy.hashSecret, "ip", site.id, ip),
    rule: policy.rateLimit.ip,
  });
  // A fresh window is the natural moment to sweep this site's dead windows — bounded,
  // scoped, and at most once per window per IP instead of on every request.
  if (ipBucket.hits === 1) {
    void sweepExpiredRateBuckets(site.tenant_id, site.id).catch(() => undefined);
  }
  if (!ipBucket.allowed) {
    logger.warn({ site: siteDiag, scope: "ip" }, "public booking: rate limited");
    return publicRateLimited(ipBucket.retryAfterSec);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return publicInvalid();
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return publicInvalid(fieldMessage(parsed.error.issues[0]));
  const data = parsed.data;

  const startAt = parseIsoDate(data.start_at);
  if (!startAt) return publicInvalid("Vuelve a elegir la hora.");
  const now = new Date();
  if (startAt.getTime() <= now.getTime()) {
    return publicError(422, "past_start", "Esa hora ya pasó. Elige otra.");
  }

  const rawKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (rawKey && !IDEMPOTENCY_RE.test(rawKey)) return publicInvalid();
  const clientKey = rawKey || randomUUID();

  if (policy.turnstile.enabled) {
    const verdict = await verifyTurnstileToken({
      secret: policy.turnstile.secretKey,
      token: data.turnstile_token,
      remoteIp: ip,
      idempotencyKey: clientKey,
    });
    if (!verdict.ok) {
      logger.warn({ site: siteDiag, reason: verdict.reason }, "public booking: turnstile rejected");
      if (verdict.reason === "missing_secret" || verdict.reason === "unavailable") {
        return publicError(503, "verification_unavailable", "No pudimos verificar la solicitud en este momento. Inténtalo de nuevo en unos segundos.");
      }
      return publicError(403, "verification_failed", "No pudimos verificar que eres una persona. Completa la verificación y vuelve a intentarlo.");
    }
  }

  // The phone bucket keys on the NORMALIZED number (site region), so "300…", "57300…"
  // and "+57 300…" share one quota. Unreadable numbers still count, by their digits.
  const region = dialingRegionForTimezone(site.timezone);
  const phoneKey = normalizeE164(data.customer_phone, { defaultRegion: region }) ?? data.customer_phone.replace(/\D/g, "");
  const phoneBucket = await consumeRateBucket({
    ...scope,
    scope: "phone",
    keyHash: hashRateKey(policy.hashSecret, "phone", site.id, phoneKey),
    rule: policy.rateLimit.phone,
  });
  if (!phoneBucket.allowed) {
    logger.warn({ site: siteDiag, scope: "phone" }, "public booking: rate limited");
    return publicRateLimited(phoneBucket.retryAfterSec);
  }

  const result = await createAppointment({
    tenantId: site.tenant_id,
    siteId: site.id,
    serviceId: data.service_id,
    // null = "Cualquier profesional": the engine assigns whoever is free at commit time.
    staffId: data.staff_id ?? null,
    startAt,
    // Public bookings identify the customer by phone (the stable channel id).
    channel: "public",
    channelUserId: data.customer_phone,
    customerName: data.customer_name,
    customerPhone: data.customer_phone,
    customerEmail: data.customer_email ? data.customer_email : null,
    origin: "public",
    createdByType: "public",
    // Namespaced per site, so a public key can never collide with an n8n / staff key
    // of the same tenant (the unique index is (tenant_id, idempotency_key)).
    idempotencyKey: `public:${site.id}:${clientKey}`,
    maxActiveFuturePerPhone: policy.maxActivePerPhone,
    // Defense in depth: the booking engine rejects any site/appointment outside
    // this client (the resolver already proved the site's client hosts booking).
    scopeClientId: site.client_id,
    now,
  });

  if (!result.ok) {
    // A CONCURRENT disable (module turned off between the gate and the commit)
    // surfaces as module_disabled — collapse it to the SAME generic 404 the gate
    // uses, never a 403 that would reveal the site once existed here.
    if (result.error === "module_disabled") return publicNotFound();
    logger.info({ site: siteDiag, error: result.error }, "public booking: refused");
    return publicEngineError(result.error);
  }

  const a = result.value;
  const staffName = await getPublicStaffName(site.tenant_id, site.id, a.staff_id);
  logger.info({ site: siteDiag, reference: a.public_reference, deduped: Boolean(result.deduped) }, "public booking: created");
  return publicJson(
    { confirmation: projectPublicConfirmation(a, site, staffName) },
    result.deduped ? 200 : 201,
  );
}
