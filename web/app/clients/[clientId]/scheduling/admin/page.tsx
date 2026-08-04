import { connection } from "next/server";
import { requireFullAccessOrLand } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import {
  listServices,
  listServicesForSite,
  listStaffServices,
} from "@worker/db/repositories/scheduling/services.js";
import { listExceptions } from "@worker/db/repositories/scheduling/exceptions.js";
import { AdminPanel } from "@/components/scheduling/AdminPanel";

/**
 * Per-CLIENT scheduling settings (owner/admin) — the CANONICAL admin route. Servicios,
 * sedes, barberos y horarios pertenecen a UN cliente, así que se administran aquí,
 * nunca desde una pantalla global. Gating, in order:
 *   1. requireFullAccessOrLand — owner/admin (a member is bounced to their landing);
 *   2. requireClientModulePage(clientId, "scheduling") — the URL clientId is validated
 *      against the session tenant + access scope, the client must exist, be NON-default,
 *      and have scheduling ENABLED; any failure is an indistinguishable 404.
 * ALL data is loaded with the VALIDATED client id — sites/staff/exceptions filtered to
 * this client; there is NO client selector, so this page can't cross into another
 * client. Each client owns its OWN service catalogue (services.client_id); those
 * services are enabled per this client's sites via site_services.
 */
export default async function ClientSchedulingAdminPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  await requireFullAccessOrLand(); // owner/admin only
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  const tenantId = scope.tenantId;

  const [sites, services, staff] = await Promise.all([
    listSites(tenantId, { clientId: client.id, includeInactive: true }),
    listServices(tenantId, client.id, true),
    listStaff(tenantId, { clientId: client.id, includeInactive: true }),
  ]);

  const staffServices = await Promise.all(
    staff.map(async (s) => ({ staffId: s.id, serviceIds: (await listStaffServices(tenantId, s.id)).filter((x) => x.active).map((x) => x.service_id) })),
  );
  const staffServiceMap = Object.fromEntries(staffServices.map((x) => [x.staffId, x.serviceIds]));

  // REAL per-site service enablement (site_services) for THIS client's sites only.
  const siteServiceRows = await Promise.all(
    sites.map(async (s) => ({ siteId: s.id, serviceIds: (await listServicesForSite(tenantId, s.id)).map((x) => x.id) })),
  );
  const siteServiceMap = Object.fromEntries(siteServiceRows.map((x) => [x.siteId, x.serviceIds]));

  const exceptions = (await Promise.all(sites.map((s) => listExceptions(tenantId, { siteId: s.id, from: new Date() })))).flat();

  return (
    <AdminPanel
      clientId={client.id}
      clientName={client.name}
      sites={sites.map((s) => ({
        id: s.id,
        client_id: s.client_id,
        slug: s.slug,
        name: s.name,
        address: s.address,
        timezone: s.timezone,
        active: s.active,
        opening_hours: s.opening_hours, // C-6: shown + editable
        scheduling_config: s.scheduling_config, // min notice / horizon / slot granularity — shown + editable
      }))}
      services={services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        duration_min: s.duration_min,
        price: s.price,
        buffer_before_min: s.buffer_before_min,
        buffer_after_min: s.buffer_after_min,
        active: s.active,
      }))}
      staff={staff.map((s) => ({ id: s.id, site_id: s.site_id, name: s.name, active: s.active, serviceIds: staffServiceMap[s.id] ?? [], working_hours: s.working_hours }))}
      siteServiceMap={siteServiceMap}
      exceptions={exceptions.map((e) => ({
        id: e.id,
        site_id: e.site_id,
        staff_id: e.staff_id,
        starts_at: e.starts_at.toISOString(),
        ends_at: e.ends_at.toISOString(),
        reason: e.reason,
      }))}
    />
  );
}
