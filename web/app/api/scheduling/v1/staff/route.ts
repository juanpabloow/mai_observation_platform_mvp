import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { resolveServiceParam } from "@/lib/semanticParams";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";
import { normalizeName } from "@worker/scheduling/nameMatch.js";

/**
 * GET /api/scheduling/v1/staff?site_id=&(service_id|service)=&bookable=true — active staff at
 * a site OWNED BY the resolved client. When a service is given (by `service_id` UUID or
 * `service` NAME), only staff who can perform it. MACHINE endpoint; foreign/unknown site_id → 404.
 *
 * `bookable=true` (optional) drops staff who hold no chair (takes_bookings = false, e.g. the
 * front desk) on BOTH paths — so the bot answering "which barbers are there?" sees only the
 * bookable team. Absent → behavior is exactly as before. Any other value → 400 invalid_request.
 *
 * Each item carries only public, non-PII fields: id, name, site_id, and the published
 * `public_title` / `public_bio` (null when empty). No photo, takes_bookings, internal title
 * or employee PII. Results are ordered by name, case- and accent-insensitive, identically on
 * both paths.
 */
export const dynamic = "force-dynamic";

const orNull = (v: string | null): string | null => (v && v.trim() !== "" ? v : null);

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const siteId = params.get("site_id");
  const serviceIdParam = params.get("service_id");
  const serviceName = params.get("service");
  const bookableParam = params.get("bookable");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  // Optional bot filter. Only the literal "true" enables it; absent keeps today's behavior;
  // anything else is a client mistake, rejected with the standard 400 shape.
  if (bookableParam !== null && bookableParam !== "true") {
    return schedulingError(400, "invalid_request", "bookable must be 'true' when provided.");
  }
  const bookableOnly = bookableParam === "true";

  // requireActive: this lists bookable staff at a site; a deactivated site → site_inactive (409).
  const owned = await resolveOwnedSite(auth.auth, siteId, { requireActive: true });
  if (!owned.ok) return owned.response;

  let rows;
  if (serviceIdParam || serviceName) {
    // service_id (UUID) or service (NAME) → the specific 400/404/ambiguous errors.
    const svc = await resolveServiceParam(auth.auth, owned.site.id, serviceIdParam, serviceName);
    if (!svc.ok) return svc.response;
    // listStaffForService already returns only staff with takes_bookings = true, so bookable=true
    // is already satisfied on this path; without it, the result is unchanged (service-qualified).
    rows = await listStaffForService(auth.auth.tenantId, owned.site.id, svc.value);
  } else {
    rows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id, clientId: auth.auth.clientId, bookableOnly });
  }

  // ONE order for the bot: by name, case- and accent-insensitive (normalizeName), with id as a
  // deterministic tiebreak — identical regardless of which path produced the rows.
  const staff = rows
    .map((s) => ({
      id: s.id,
      name: s.name,
      site_id: s.site_id,
      public_title: orNull(s.public_title),
      public_bio: orNull(s.public_bio),
    }))
    .sort((a, b) => {
      const byName = normalizeName(a.name).localeCompare(normalizeName(b.name));
      return byName !== 0 ? byName : a.id.localeCompare(b.id);
    });

  return Response.json({ staff });
}
