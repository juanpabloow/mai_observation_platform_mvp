import { connection } from "next/server";
import { requireFullAccessOrLand } from "@/lib/access";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";
import { listServices, listStaffServices } from "@worker/db/repositories/scheduling/services.js";
import { listExceptions } from "@worker/db/repositories/scheduling/exceptions.js";
import { AdminPanel } from "@/components/scheduling/AdminPanel";

/**
 * Scheduling admin (owner/admin, tenant-scoped): CRUD for sites, services, staff,
 * their enablements, and schedule exceptions. All data loaded server-side; the
 * AdminPanel client wires the forms to the admin server actions.
 */
export default async function SchedulingAdminPage() {
  await connection();
  const { tenantId } = await requireFullAccessOrLand();

  const [clients, sites, services, staff] = await Promise.all([
    listClientsForTenant(tenantId),
    listSites(tenantId, { includeInactive: true }),
    listServices(tenantId, true),
    listStaff(tenantId, { includeInactive: true }),
  ]);

  const staffServices = await Promise.all(
    staff.map(async (s) => ({ staffId: s.id, serviceIds: (await listStaffServices(tenantId, s.id)).filter((x) => x.active).map((x) => x.service_id) })),
  );
  const staffServiceMap = Object.fromEntries(staffServices.map((x) => [x.staffId, x.serviceIds]));

  const exceptions = (await Promise.all(sites.map((s) => listExceptions(tenantId, { siteId: s.id, from: new Date() })))).flat();
  void listStaffForService;

  return (
    <AdminPanel
      clients={clients.map((c) => ({ id: c.id, name: c.name, is_default: c.is_default }))}
      sites={sites.map((s) => ({
        id: s.id,
        client_id: s.client_id,
        slug: s.slug,
        name: s.name,
        address: s.address,
        timezone: s.timezone,
        active: s.active,
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
      staff={staff.map((s) => ({ id: s.id, site_id: s.site_id, name: s.name, active: s.active, serviceIds: staffServiceMap[s.id] ?? [] }))}
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
