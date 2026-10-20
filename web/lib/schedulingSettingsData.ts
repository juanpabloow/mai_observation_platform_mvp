import "server-only";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listBookingCategories } from "@worker/db/repositories/scheduling/bookingCategories.js";
import { listPromotions } from "@worker/db/repositories/scheduling/promotions.js";
import { utcToZonedParts } from "@worker/scheduling/timezone.js";
import {
  listServices,
  listServicesForSite,
  listStaffServices,
} from "@worker/db/repositories/scheduling/services.js";
import { listExceptions } from "@worker/db/repositories/scheduling/exceptions.js";
import { isSchedulingBookable } from "@worker/db/repositories/clientModules.js";
import type { SchedulingSettingsProps } from "@/components/scheduling/AdminPanel";

/**
 * The data every scheduling settings page renders (Sedes, Reglas, Disponibilidad,
 * Servicios, Promociones, Página de reservas) — what the single admin page used to load,
 * unchanged. The CALLER has already gated the request (requireClientModulePage +
 * canManageClient) and passes the VALIDATED tenant + client: everything here is scoped
 * to that one client, so a page can never cross into another.
 */
export async function loadSchedulingSettings(
  tenantId: string,
  client: { id: string; name: string },
): Promise<Omit<SchedulingSettingsProps, "page" | "tab">> {
  const [sites, services, staff, bookingCategories, promotions] = await Promise.all([
    listSites(tenantId, { clientId: client.id, includeInactive: true }),
    listServices(tenantId, client.id, true),
    listStaff(tenantId, { clientId: client.id, includeInactive: true }),
    listBookingCategories(tenantId, client.id),
    listPromotions(tenantId, client.id),
  ]);
  // The promotion editor works in the SITE's wall clock (A. vigencia), never the browser's.
  const tzOf = (siteId: string | null) => sites.find((x) => x.id === siteId)?.timezone ?? sites[0]?.timezone ?? "America/Bogota";
  const localInput = (d: Date | null, tz: string) => {
    if (!d) return "";
    const z = utcToZonedParts(d, tz);
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${z.year}-${p2(z.month)}-${p2(z.day)}T${p2(z.hour)}:${p2(z.minute)}`;
  };

  const staffServices = await Promise.all(
    staff.map(async (s) => ({ staffId: s.id, serviceIds: (await listStaffServices(tenantId, s.id)).filter((x) => x.active).map((x) => x.service_id) })),
  );
  const staffServiceMap = Object.fromEntries(staffServices.map((x) => [x.staffId, x.serviceIds]));

  // REAL per-site service enablement (site_services) for THIS client's sites only.
  const siteServiceRows = await Promise.all(
    sites.map(async (s) => ({ siteId: s.id, serviceIds: (await listServicesForSite(tenantId, s.id)).map((x) => x.id) })),
  );
  const siteServiceMap = Object.fromEntries(siteServiceRows.map((x) => [x.siteId, x.serviceIds]));

  const now = new Date();
  const exceptions = (await Promise.all(sites.map((s) => listExceptions(tenantId, { siteId: s.id, from: now })))).flat();
  // The phone's "Pasados" tab: blocks that ENDED in the last 90 days (same repository,
  // same per-site scoping). Read-only history — the desktop list is unchanged.
  const pastFrom = new Date(now.getTime() - 90 * 86_400_000);
  const pastExceptions = (await Promise.all(sites.map((s) => listExceptions(tenantId, { siteId: s.id, from: pastFrom, to: now }))))
    .flat()
    .filter((e) => e.ends_at.getTime() <= now.getTime());
  // The same predicate the public gate relies on (non-default client + module enabled),
  // read for real rather than assumed from the page gate — it feeds "Enlace de reservas".
  const schedulingEnabled = await isSchedulingBookable(tenantId, client.id);

  return {
    clientId: client.id,
    clientName: client.name,
    sites: sites.map((s) => ({
        id: s.id,
        client_id: s.client_id,
        slug: s.slug,
        name: s.name,
        address: s.address,
        timezone: s.timezone,
        active: s.active,
        public_whatsapp: s.public_whatsapp,
        public_maps_url: s.public_maps_url,
        opening_hours: s.opening_hours, // C-6: shown + editable
        scheduling_config: s.scheduling_config, // min notice / horizon / slot granularity — shown + editable
      })),
    services: services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        duration_min: s.duration_min,
        price: s.price,
        buffer_before_min: s.buffer_before_min,
        buffer_after_min: s.buffer_after_min,
        active: s.active,
        featured: s.featured,
        category: s.category,
        public_category_id: s.public_category_id,
        public_visible: s.public_visible,
        public_sort: s.public_sort,
        public_recommended: s.public_recommended,
        public_image_url: s.public_image_url,
        public_includes: s.public_includes,
        public_upgrade_service_id: s.public_upgrade_service_id,
      })),
    promotions: promotions.map((p) => ({
        id: p.id,
        status: p.status,
        version: p.version,
        booked_count: p.booked_count,
        image_url: p.image_url,
        form: {
          name: p.name,
          description: p.description ?? "",
          conditions: p.conditions ?? "",
          siteId: p.site_id ?? "",
          sortOrder: String(p.sort_order),
          benefitType: p.benefit_type,
          serviceIds: p.service_ids,
          staffIds: p.staff_ids,
          bookableFrom: localInput(p.bookable_from, tzOf(p.site_id)),
          bookableUntil: localInput(p.bookable_until, tzOf(p.site_id)),
          weekdays: p.appointment_weekdays ?? [],
          appointmentFrom: p.appointment_from ?? "",
          appointmentUntil: p.appointment_until ?? "",
          timeFrom: p.appointment_time_from ?? "",
          timeUntil: p.appointment_time_until ?? "",
        },
      })),
    bookingCategories: bookingCategories.map((c) => ({
        id: c.id,
        name: c.name,
        tagline: c.tagline,
        layout: c.layout,
        sort_order: c.sort_order,
        visible: c.visible,
        service_count: c.service_count,
      })),
    staff: staff.map((s) => ({ id: s.id, site_id: s.site_id, name: s.name, active: s.active, takes_bookings: s.takes_bookings, serviceIds: staffServiceMap[s.id] ?? [], working_hours: s.working_hours })),
    siteServiceMap: siteServiceMap,
    schedulingEnabled: schedulingEnabled,
    pastExceptions: pastExceptions.map((e) => ({
        id: e.id,
        site_id: e.site_id,
        staff_id: e.staff_id,
        starts_at: e.starts_at.toISOString(),
        ends_at: e.ends_at.toISOString(),
        reason: e.reason,
        public_reason: e.public_reason ?? null,
      })),
    exceptions: exceptions.map((e) => ({
        id: e.id,
        site_id: e.site_id,
        staff_id: e.staff_id,
        starts_at: e.starts_at.toISOString(),
        ends_at: e.ends_at.toISOString(),
        reason: e.reason,
        public_reason: e.public_reason ?? null,
      })),
  };
}
