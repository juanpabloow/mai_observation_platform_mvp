import { connection } from "next/server";
import { requireFullAccessOrLand } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
// listStaffAdmin, NOT listStaff: this page is owner/admin only (both gates below), and
// the roster is the one surface that shows an employee's contact details. Every other
// reader — public booking, machine API, agenda, availability — keeps the PII-free
// listStaff. See the header of the staff repository.
import { listStaffAdmin } from "@worker/db/repositories/scheduling/staff.js";
import { listStaffCertifications } from "@worker/db/repositories/scheduling/staffCertifications.js";
import { listServices, listStaffServiceIds } from "@worker/db/repositories/scheduling/services.js";
import { listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { listExceptions } from "@worker/db/repositories/scheduling/exceptions.js";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { StaffWorkspace } from "@/components/scheduling/staff/StaffWorkspace";
import type { StaffTabProps } from "@/components/scheduling/staff/StaffTab";

/**
 * STAFF — the operational roster, a SCHEDULING surface.
 *
 * It lives here and not under Team because a barber is not a platform user: they are a
 * bookable resource, and everything this screen reads (working_hours, staff_services,
 * schedule_exceptions, appointments) is scheduling data. Team stayed what it is —
 * logins and roles.
 *
 * Gating, in the same order the sibling scheduling routes use:
 *   1. requireFullAccessOrLand — owner/admin (a member is bounced to their landing);
 *   2. requireClientModulePage(clientId, "scheduling") — the URL clientId is validated
 *      against the session tenant + access scope, the client must exist, be NON-default
 *      and have scheduling ENABLED; any failure is an indistinguishable 404.
 * Both are what authorise the PII read below.
 */
export default async function ClientStaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  // No `tab`: the roster is the only view now (the Turnos/Ausencias stubs are gone —
  // see StaffWorkspace), so there is nothing for it to select. An old `?tab=shifts`
  // bookmark simply lands on the roster.
  searchParams: Promise<{ s?: string; site?: string; dtab?: string }>;
}) {
  await connection();
  await requireFullAccessOrLand(); // owner/admin only
  const { clientId } = await params;
  const sp = await searchParams;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");

  return (
    <StaffWorkspace
      clientId={client.id}
      staff={await loadRoster(scope.tenantId, client.id, sp)}
    />
  );
}

/**
 * Everything the roster derives its statuses from. The screen NEVER invents a status:
 * "with a client until 12:30" is today's appointments, "off today" is the weekly
 * working_hours, "time off · 3 days" is a schedule_exceptions row. So this loads
 * exactly those three, plus a 30-day window for the Performance tab's counts.
 */
async function loadRoster(
  tenantId: string,
  clientId: string,
  sp: { s?: string; site?: string; dtab?: string },
): Promise<StaffTabProps | null> {
  const sites = await listSites(tenantId, { clientId, includeInactive: false });
  if (sites.length === 0) return null; // a barber belongs to a site — no site, no roster
  const site = sites.find((s) => s.id === sp.site) ?? sites[0];

  // The local day (site tz) → a UTC [dayStart, dayEnd) window, same convention as Agenda.
  const p = utcToZonedParts(new Date(), site.timezone);
  const dayStart = zonedPartsToUtc(p.year, p.month, p.day, 0, 0, site.timezone);
  const dayEnd = zonedPartsToUtc(p.year, p.month, p.day + 1, 0, 0, site.timezone);
  // Performance looks BACK 30 days (and Time off forward), so the window spans both.
  const windowStart = new Date(dayStart.getTime() - 30 * 86400_000);
  const windowEnd = new Date(dayStart.getTime() + 30 * 86400_000);

  const [staff, services, todayAppts, windowAppts, exceptions] = await Promise.all([
    listStaffAdmin(tenantId, { siteId: site.id, clientId, includeInactive: false }),
    listServices(tenantId, clientId, false),
    listAppointments(tenantId, { siteId: site.id, clientId, from: dayStart, to: dayEnd }),
    listAppointments(tenantId, { siteId: site.id, clientId, from: windowStart, to: windowEnd, limit: 1000 }),
    listExceptions(tenantId, { siteId: site.id, from: dayStart, to: windowEnd }),
  ]);

  // One grouped query each instead of one per barber — the roster is the only place
  // that needs every barber's services and credentials at once.
  const staffIds = staff.map((s) => s.id);
  const [serviceIds, certifications] = await Promise.all([
    listStaffServiceIds(tenantId, staffIds),
    listStaffCertifications(tenantId, staffIds),
  ]);

  return {
    sites: sites.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone })),
    currentSiteId: site.id,
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      durationMin: s.duration_min,
      description: s.description,
    })),
    members: staff.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      siteId: s.site_id,
      siteName: sites.find((x) => x.id === s.site_id)?.name ?? site.name,
      workingHours: (s.working_hours ?? {}) as Record<string, { start: string; end: string }[]>,
      serviceIds: serviceIds.get(s.id) ?? [],
      // Profile. Every one of these is a real column as of the staff-fields
      // migration; a null means nobody has filled it in, which the Details tab
      // renders as an empty editable field rather than hiding.
      title: s.title,
      employmentType: s.employment_type,
      weeklyHours: s.weekly_hours,
      startDate: isoDay(s.start_date),
      skills: s.skills,
      takesBookings: s.takes_bookings,
      phone: s.phone,
      email: s.email,
      emergencyContactName: s.emergency_contact_name,
      emergencyContactPhone: s.emergency_contact_phone,
      certifications: (certifications.get(s.id) ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        issuer: c.issuer,
        issuedOn: isoDay(c.issued_on),
        expiresOn: isoDay(c.expires_on),
      })),
    })),
    timezone: site.timezone,
    todayIso: new Date().toISOString(),
    selectedId: sp.s ?? null,
    detailTab: sp.dtab,
    todayAppointments: todayAppts.map((a) => ({
      id: a.id,
      staffId: a.staff_id ?? "",
      startAt: a.start_at.toISOString(),
      endAt: a.service_end_at.toISOString(),
      serviceName: a.service_name_snapshot,
      contactName: a.contact_name ?? null,
      status: a.status,
    })),
    windowAppointments: windowAppts.map((a) => ({
      staffId: a.staff_id ?? "",
      startAt: a.start_at.toISOString(),
      durationMin: a.duration_min_snapshot,
      status: a.status,
      // Already on the row this query returns — the "top services" bars count it. The
      // SNAPSHOT, not a join: a renamed or deleted service still counts under the name
      // it was actually sold as.
      serviceName: a.service_name_snapshot,
    })),
    timeOff: exceptions
      // Site-wide closures are not one barber's time off — the roster only shows
      // exceptions that name a staff member.
      .filter((e) => e.staff_id)
      .map((e) => ({
        staffId: e.staff_id as string,
        startsAt: e.starts_at.toISOString(),
        endsAt: e.ends_at.toISOString(),
        reason: e.reason,
      })),
  };
}

/** A DATE column → yyyy-mm-dd, the only part of it that means anything. */
function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
