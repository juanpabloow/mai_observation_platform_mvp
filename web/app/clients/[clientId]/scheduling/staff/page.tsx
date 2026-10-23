import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { can } from "@/lib/access";
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
import { loadOccurrences } from "@worker/db/repositories/scheduling/series.js";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { StaffWorkspace } from "@/components/scheduling/staff/StaffWorkspace";
import { isR2Configured } from "@/lib/r2";
import { readStaffProfileId } from "@/lib/staffProfileUrl";
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
  // `s` is the open profile on EVERY width (desktop drawer and phone detail); `p` is the
  // phone's old parameter, still read so its links keep working (lib/staffProfileUrl).
  searchParams: Promise<{ s?: string | string[]; site?: string; dtab?: string; p?: string | string[] }>;
}) {
  await connection();
  const { clientId } = await params;
  const sp = await searchParams;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling", "team.manage");
  // The roster is for the agency OR this client's OWNER — editors/staff are 404'd.

  const roster = await loadRoster(scope.tenantId, client.id, sp);
  // PY-1: per-artist commission is shown + editable only with payments.settings (agency / owner).
  if (roster) roster.staff.canManagePayments = can(scope, "payments.settings", client.id);
  return (
    <StaffWorkspace
      clientId={client.id}
      staff={roster?.staff ?? null}
      mobile={
        roster
          ? {
              clientName: client.name,
              // Creating a professional is the same capability as seeing this page
              // (canManageClient above); createStaffAction re-checks it on the server.
              canCreate: true,
            }
          : null
      }
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
  sp: { s?: string | string[]; site?: string; dtab?: string; p?: string | string[] },
): Promise<{ staff: StaffTabProps } | null> {
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

  const [staff, services, todayAppts, windowAppts, exceptions, todayOccurrences] = await Promise.all([
    // includeInactive: the PHONE roster lists inactive professionals (labelled), and the
    // site's avatar colours are built over every staff id, as on the agenda. The desktop
    // roster still receives the ACTIVE ones only (StaffWorkspace filters), as before.
    listStaffAdmin(tenantId, { siteId: site.id, clientId, includeInactive: true }),
    listServices(tenantId, clientId, false),
    listAppointments(tenantId, { siteId: site.id, clientId, from: dayStart, to: dayEnd }),
    listAppointments(tenantId, { siteId: site.id, clientId, from: windowStart, to: windowEnd, limit: 1000 }),
    // Time Off tab shows PAST + upcoming blocks, so the window reaches back too.
    listExceptions(tenantId, { siteId: site.id, from: windowStart, to: windowEnd }),
    // Today's RECURRING blocks — for «who is away now» only (the Ausencias tab lists the
    // series themselves). Breaks are not absences.
    loadOccurrences({ tenantId, siteId: site.id, timeZone: site.timezone, from: dayStart, to: dayEnd, staffIds: null }),
  ]);

  // One grouped query each instead of one per barber — the roster is the only place
  // that needs every barber's services and credentials at once.
  const staffIds = staff.map((s) => s.id);
  const [serviceIds, certifications] = await Promise.all([
    listStaffServiceIds(tenantId, staffIds),
    listStaffCertifications(tenantId, staffIds),
  ]);

  const openingHours = (site.opening_hours ?? {}) as Record<string, { start: string; end: string }[]>;
  // Site-wide closures (no staff named): nobody is "en turno" during one — on any width.
  const todayBlocks = todayOccurrences.filter((o) => o.kind === "block");
  const closures = [
    ...exceptions
      .filter((e) => !e.staff_id)
      .map((e) => ({ id: e.id, staffId: "", startsAt: e.starts_at.toISOString(), endsAt: e.ends_at.toISOString(), reason: e.reason, publicReason: e.public_reason ?? null })),
    // A recurring site-wide block happening today closes the site too.
    ...todayBlocks
      .filter((o) => o.staff_id === null)
      .map((o) => ({ id: `${o.series_id}:${o.date}`, staffId: "", startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), reason: o.reason, publicReason: o.public_reason ?? null })),
  ];
  /** Recurring blocks of one professional happening today: «away now» for presence only. */
  const presenceBlocks = todayBlocks
    .filter((o) => o.staff_id !== null)
    .map((o) => ({ id: `${o.series_id}:${o.date}`, staffId: o.staff_id as string, startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), reason: o.reason, publicReason: o.public_reason ?? null }));

  const staffProps: StaffTabProps = {
    // A public photo can be uploaded only where object storage is configured.
    photoUploadEnabled: isR2Configured,
    sites: sites.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone })),
    currentSiteId: site.id,
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      durationMin: s.duration_min,
      description: s.description,
      category: s.category,
    })),
    members: staff.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      siteId: s.site_id,
      siteName: sites.find((x) => x.id === s.site_id)?.name ?? site.name,
      workingHours: (s.working_hours ?? {}) as Record<string, { start: string; end: string }[]>,
      siteOpeningHours: (sites.find((x) => x.id === s.site_id)?.opening_hours ?? {}) as Record<string, { start: string; end: string }[]>,
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
      // PUBLIC profile (booking page). Not PII — written to be published.
      publicTitle: s.public_title,
      publicBio: s.public_bio,
      publicPhotoUrl: s.public_photo_url,
      phone: s.phone,
      email: s.email,
      emergencyContactName: s.emergency_contact_name,
      emergencyContactPhone: s.emergency_contact_phone,
      commissionPctServices: s.commission_pct_services,
      commissionPctProducts: s.commission_pct_products,
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
    // One profile for both trees: `s`, or the old phone `p` when `s` is absent.
    selectedId: readStaffProfileId(sp),
    detailTab: sp.dtab,
    todayAppointments: todayAppts.map((a) => ({
      id: a.id,
      staffId: a.staff_id ?? "",
      serviceId: a.service_id,
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
        id: e.id,
        staffId: e.staff_id as string,
        startsAt: e.starts_at.toISOString(),
        endsAt: e.ends_at.toISOString(),
        reason: e.reason,
        publicReason: e.public_reason ?? null,
      })),
    openingHours,
    closures,
    presenceBlocks,
  };

  return { staff: staffProps };
}

/** A DATE column → yyyy-mm-dd, the only part of it that means anything. */
function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
