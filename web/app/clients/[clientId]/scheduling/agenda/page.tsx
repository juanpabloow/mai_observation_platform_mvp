import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";
import { listAppointments, getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { AgendaView } from "@/components/scheduling/AgendaView";

/**
 * Client-scoped Agenda (Phase 3A — the canonical route). Gated by the central
 * `scheduling` resolver (404 for foreign/default/disabled/missing). ALL data is
 * loaded with the VALIDATED client id — never scope.memberClientId — so
 * owner/admin get the same hard scoping as members. A `?site=` belonging to
 * another client can't match any loaded site, so it silently falls back to the
 * first valid one. Contact links only render when CRM is also enabled.
 */
export default async function ClientAgendaPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{
    site?: string;
    date?: string;
    view?: string;
    from?: string;
    book?: string;
    reschedule?: string;
    return?: string;
  }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  const sp = await searchParams;
  const tenantId = scope.tenantId;

  // The CANONICAL validated client id — the only client filter used below.
  const sites = await listSites(tenantId, { clientId: client.id });
  if (sites.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong px-5 py-8">
          {hasFullAccess(scope) ? (
            <>
              <p className="text-sm text-muted">No sites for {client.name} yet — create one to start scheduling.</p>
              <Link href={`/clients/${client.id}/scheduling/admin`} className="text-sm text-accent hover:underline">
                Go to Scheduling settings →
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted">
              No sites are set up yet. Ask your administrator to configure scheduling for {client.name}.
            </p>
          )}
        </div>
      </main>
    );
  }

  // C-4.1 reschedule deep-link: resolve the appointment (tenant-scoped; re-check the
  // client + that it's still live) so we land on ITS site + day with the modal open —
  // one click from the contact record, no hunting. Its site/date override the params.
  let openReschedule: string | null = null;
  let forcedSiteId: string | undefined;
  let forcedDate: string | undefined;
  if (sp.reschedule && isUuid(sp.reschedule)) {
    const appt = await getAppointmentById(tenantId, sp.reschedule);
    if (appt && appt.client_id === client.id && (appt.status === "scheduled" || appt.status === "confirmed")) {
      openReschedule = appt.id;
      forcedSiteId = appt.site_id;
      const at = sites.find((s) => s.id === appt.site_id);
      if (at) {
        const p = utcToZonedParts(appt.start_at, at.timezone);
        forcedDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      }
    }
  }

  // A ?site= from another client never matches this client's sites → first valid.
  const site = sites.find((s) => s.id === (forcedSiteId ?? sp.site)) ?? sites[0];

  // Resolve the local day (site tz) → a UTC [dayStart, dayEnd) window.
  const todayParts = utcToZonedParts(new Date(), site.timezone);
  const dateStr = forcedDate
    ? forcedDate
    : sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
      ? sp.date
      : `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-${String(todayParts.day).padStart(2, "0")}`;
  const [y, m, d] = dateStr.split("-").map(Number);
  // The DAY window is what booking/availability always uses (the modal asks for slots
  // inside it), so it is computed unconditionally and passed through untouched.
  const dayStart = zonedPartsToUtc(y, m, d, 0, 0, site.timezone);
  const dayEnd = zonedPartsToUtc(y, m, d + 1, 0, 0, site.timezone);

  // View mode. `week` widens ONLY the range handed to listAppointments — same query,
  // same repository, same client scoping. Month is not implemented (see the TODO in
  // AgendaView) so anything else falls back to `day`.
  const view = sp.view === "week" ? "week" : "day";
  // Week starts Monday, in the SITE's timezone (never the server's).
  const weekdayOfDate = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  const mondayOffset = weekdayOfDate === 0 ? -6 : 1 - weekdayOfDate;
  const rangeStart = view === "week" ? zonedPartsToUtc(y, m, d + mondayOffset, 0, 0, site.timezone) : dayStart;
  const rangeEnd = view === "week" ? zonedPartsToUtc(y, m, d + mondayOffset + 7, 0, 0, site.timezone) : dayEnd;

  // PREVIOUS equivalent window, for the KPI deltas. Same query, same client scoping,
  // just shifted back by the range's own length — so "vs last week" compares like
  // with like (a 7-day week against the prior 7 days, a day against the day before).
  const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
  const prevStart = new Date(rangeStart.getTime() - rangeMs);
  const prevEnd = new Date(rangeStart.getTime());

  const [allStaff, services, appts, prevAppts, crmEnabled, inboxEnabled] = await Promise.all([
    // includeInactive: a deactivated barber must still get a lane IF they have
    // appointments in the VISIBLE RANGE — otherwise their (intact) appointments have
    // nowhere to render and disappear. Note the range is now day OR week, so this
    // covers a barber deactivated mid-week too. The booking form still offers ACTIVE
    // staff only (AgendaView).
    listStaff(tenantId, { siteId: site.id, clientId: client.id, includeInactive: true }),
    listServicesForSite(tenantId, site.id),
    listAppointments(tenantId, { siteId: site.id, from: rangeStart, to: rangeEnd, clientId: client.id }),
    listAppointments(tenantId, { siteId: site.id, from: prevStart, to: prevEnd, clientId: client.id }),
    isClientModuleEnabled(tenantId, client.id, "crm"),
    isClientModuleEnabled(tenantId, client.id, "inbox"),
  ]);
  // Lanes = every ACTIVE staff member + any INACTIVE one who still has an appointment in
  // this window. Deactivation is forward-looking: it stops new bookings, never hides the
  // history that already points at that resource.
  const apptStaffIds = new Set(appts.map((a) => a.staff_id));
  const staff = allStaff.filter((s) => s.active || apptStaffIds.has(s.id));

  /** The same four metrics the view shows, computed over an arbitrary window. */
  const summarise = (rows: typeof appts) => {
    const settled = rows.filter((a) => a.status !== "cancelled");
    const pct = (n: number) => (settled.length === 0 ? null : Math.round((n / settled.length) * 100));
    return {
      total: rows.length,
      completedPct: pct(rows.filter((a) => a.status === "completed").length),
      noShowPct: pct(rows.filter((a) => a.status === "no_show").length),
      revenue: settled.reduce((sum, a) => sum + (Number(a.price_snapshot) || 0), 0),
    };
  };

  // C-4.1 book-for-contact deep-link: prefill the "new appointment" modal with the
  // contact (locked, not typed) so staff never retype identity already on the record.
  // Only when CRM is on and the contact really belongs to this client.
  let prefillBook: { contactId: string; contactName: string } | null = null;
  if (sp.book && isUuid(sp.book) && crmEnabled) {
    const c = await getContactById(tenantId, sp.book, client.id);
    if (c) prefillBook = { contactId: c.id, contactName: c.name ?? c.channel_user_id };
  }

  // C-5 0b: after a deep-linked book/reschedule, return to the contact record the user
  // came from. `return` is a PLAIN contact id (UUID-validated), never an arbitrary URL —
  // used only to build the in-app /contacts/{id} path.
  const returnContactId = sp.return && isUuid(sp.return) ? sp.return : null;

  // serviceId → stored category, built once for the whole board.
  const serviceCategoryById = new Map(services.map((s) => [s.id, s.category]));

  return (
    <AgendaView
      clientId={client.id}
      basePath={`/clients/${client.id}/scheduling/agenda`}
      contactsBase={crmEnabled ? `/clients/${client.id}/contacts` : null}
      inboxBase={inboxEnabled ? `/clients/${client.id}/inbox` : null}
      prefillBook={prefillBook}
      openReschedule={openReschedule}
      returnContactId={returnContactId}
      from={sp.from ?? null}
      canManage={hasFullAccess(scope)}
      timezone={site.timezone}
      date={dateStr}
      dayStartIso={dayStart.toISOString()}
      dayEndIso={dayEnd.toISOString()}
      sites={sites.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone }))}
      currentSiteId={site.id}
      // Weekly hours come off the site/staff rows ALREADY loaded above — no extra
      // query. They only drive the "closed" hatching of a day / barber lane.
      openingHours={site.opening_hours}
      staff={staff.map((s) => ({ id: s.id, name: s.name, active: s.active, workingHours: s.working_hours }))}
      services={services.map((s) => ({ id: s.id, name: s.name, duration_min: s.effective_duration_min }))}
      view={view}
      kpis={summarise(appts)}
      previousKpis={summarise(prevAppts)}
      rangeStartIso={rangeStart.toISOString()}
      rangeEndIso={rangeEnd.toISOString()}
      appointments={appts.map((a) => ({
        id: a.id,
        public_reference: a.public_reference,
        staff_id: a.staff_id,
        staff_name: a.staff_name,
        service_id: a.service_id,
        start_at: a.start_at.toISOString(),
        service_end_at: a.service_end_at.toISOString(),
        service_name: a.service_name_snapshot,
        // The colour family the OPERATOR chose, resolved through the live catalogue
        // (the appointment stores only a name snapshot). A service that has since been
        // removed from the site yields undefined → the card falls back to inferring
        // the family from the snapshot name, exactly as before this column existed.
        service_category: serviceCategoryById.get(a.service_id) ?? null,
        duration_min: a.duration_min_snapshot,
        price: a.price_snapshot,
        status: a.status,
        origin: a.origin,
        contact_id: a.contact_id,
        contact_name: a.contact_name,
        primary_identity: a.primary_identity,
        source_conversation_id: a.source_conversation_id,
      }))}
    />
  );
}
