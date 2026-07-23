import { getSessionScope } from "@/lib/access";
import { resolveClientModuleForScope } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { parseIsoDate } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/internal/availability — SESSION-authed availability for
 * the client-scoped agenda's forms. Uses the SAME central gate as the pages and
 * actions (resolveClientModuleForScope): UUID → canAccessClient → client in
 * tenant → NOT the default client (a backfilled client_modules row for
 * Unassigned is inert) → `scheduling` enabled. Then site exists in the tenant
 * AND site.client_id === client.id; service/staff validity is enforced by the
 * loader's joins. Availability is never computed before the whole gate passes.
 *
 * EVERY failure is the same generic 404 — foreign, disabled, default, and
 * unknown are indistinguishable, and nothing leaks about other clients.
 */
export const dynamic = "force-dynamic";

const notFoundResponse = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope) return notFoundResponse();

  const p = new URL(req.url).searchParams;
  const clientId = p.get("client_id");
  const siteId = p.get("site_id");
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!clientId || !siteId || !serviceId || !from || !to) {
    return Response.json({ error: "client_id, site_id, service_id, from, to are required" }, { status: 400 });
  }
  if (!isUuid(siteId) || !isUuid(serviceId) || (staffId && !isUuid(staffId))) {
    return notFoundResponse();
  }

  // The SAME central gate as pages/actions (incl. is_default rejection).
  const gate = await resolveClientModuleForScope(scope, clientId, "scheduling");
  if (!gate.ok) return notFoundResponse();
  const site = await getSiteById(scope.tenantId, siteId);
  if (!site || site.client_id !== gate.context.client.id) return notFoundResponse();

  const result = await loadAvailability({
    tenantId: scope.tenantId,
    siteId,
    serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
  });
  if (!result) return notFoundResponse();
  return Response.json({
    site: { id: result.site.id, timezone: result.site.timezone },
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}
