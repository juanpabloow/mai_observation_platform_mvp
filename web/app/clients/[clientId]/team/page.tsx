import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireFullAccessOrLand } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
// listStaffAdmin, NOT listStaff: this page is owner/admin only (requireFullAccessOrLand
// above), and the Staff screen is the one surface that shows an employee's contact
// details. Every other reader — booking, machine API, agenda, availability — keeps the
// PII-free listStaff. See the header of the staff repository.
import { listStaffAdmin } from "@worker/db/repositories/scheduling/staff.js";
import { listStaffCertifications } from "@worker/db/repositories/scheduling/staffCertifications.js";
import { listServices, listStaffServiceIds } from "@worker/db/repositories/scheduling/services.js";
import { listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { listExceptions } from "@worker/db/repositories/scheduling/exceptions.js";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { InviteForm } from "@/components/InviteForm";
import { TeamMembers, type TeamMemberView } from "@/components/TeamMembers";
import { TeamInvitations, type TeamInviteView } from "@/components/TeamInvitations";
import { TeamWorkspace } from "@/components/team/TeamWorkspace";
import type { StaffTabProps } from "@/components/team/StaffTab";

/** A DATE column → yyyy-mm-dd, the only part of it that means anything. */
function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Per-client TEAM (CLIENT level). Owner/admin only (requireFullAccessOrLand sends a
 * member to their own client); the clientId is resolved tenant-scoped via
 * getClientForTenant, so a foreign/bogus client 404s and the URL is never trusted.
 *
 * Two populations, one screen (see TeamWorkspace):
 *   STAFF — the agendable roster (`staff` + their hours, services and exceptions),
 *     which used to live inside Scheduling settings. It is loaded ONLY when this
 *     client has the scheduling module AND a site; otherwise the tab explains why
 *     rather than showing an empty table.
 *   ROLES & PERMISSIONS — the existing member/invite management, unchanged: the same
 *     TeamMembers / InviteForm / TeamInvitations components and the same actions,
 *     handed to the workspace as children so nothing was reimplemented.
 */
export default async function ClientTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ tab?: string; s?: string; site?: string; dtab?: string }>;
}) {
  await connection();
  const scope = await requireFullAccessOrLand(); // owner/admin only
  const { clientId } = await params;
  const sp = await searchParams;
  const client = await getClientForTenant(clientId); // tenant-scoped; foreign → null
  if (!client) notFound();
  const clientLabel = client.is_default ? "Unassigned" : client.name;
  const tenantId = scope.tenantId;

  const [clients, members, invites, schedulingEnabled] = await Promise.all([
    listClientsForTenant(tenantId),
    listMembersForTenant(tenantId),
    listInvitationsForTenant(tenantId),
    isClientModuleEnabled(tenantId, client.id, "scheduling"),
  ]);

  // All clients — for the per-row "move to another client" picker in TeamMembers.
  const clientOptions = clients.map((c) => ({ id: c.id, name: c.is_default ? "Unassigned" : c.name }));

  // THIS client's members.
  const memberViews: TeamMemberView[] = members
    .filter((m) => m.role === "member" && m.member_client_id === clientId)
    .map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: "member",
      clientId: m.member_client_id,
      clientName: m.client_name,
      isYou: m.user_id === scope.userId,
    }));

  // THIS client's invitations.
  const now = Date.now();
  const inviteViews: TeamInviteView[] = invites
    .filter((inv) => inv.role === "member" && inv.member_client_id === clientId)
    .map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      clientName: inv.client_name,
      status: inv.status,
      sentLabel: fmtDate(inv.created_at),
      expiryLabel: fmtDate(inv.expires_at),
      invitedByEmail: inv.invited_by_email,
      isExpired: inv.status === "pending" && inv.expires_at.getTime() <= now,
    }));

  const staff = schedulingEnabled ? await loadStaffTab(tenantId, client.id, sp) : null;

  return (
    <TeamWorkspace
      clientId={clientId}
      clientLabel={clientLabel}
      activeTab={sp.tab ?? "staff"}
      schedulingEnabled={schedulingEnabled}
      staff={staff}
      roleCount={memberViews.length}
      roles={
        <div className="flex flex-col gap-8">
          <section className="space-y-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Members</h2>
            {memberViews.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
                No members assigned to this client yet.
              </p>
            ) : (
              <TeamMembers
                members={memberViews}
                clients={clientOptions}
                viewerRole={scope.role as "owner" | "admin"}
              />
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invite a member</h2>
            <InviteForm mode="member" clientId={clientId} clientName={clientLabel} />
          </section>

          {inviteViews.length > 0 ? <TeamInvitations invites={inviteViews} /> : null}
        </div>
      }
    />
  );
}

/**
 * Everything the Staff tab derives its statuses from. The tab NEVER invents a status:
 * "with a client until 12:30" is today's appointments, "off today" is the weekly
 * working_hours, "time off · 3 days" is a schedule_exceptions row. So the page loads
 * exactly those three, plus a 30-day window for the Performance tab's counts.
 */
async function loadStaffTab(
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
  // Performance looks BACK 30 days (and the Time off tab forward), so the window spans both.
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
      // A DATE comes back as a Date at UTC midnight; only the calendar day is
      // meaningful, so it crosses to the client as yyyy-mm-dd.
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
