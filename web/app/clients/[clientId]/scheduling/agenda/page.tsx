import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";
import { listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
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
  searchParams: Promise<{ site?: string; date?: string; from?: string }>;
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

  // A ?site= from another client never matches this client's sites → first valid.
  const site = sites.find((s) => s.id === sp.site) ?? sites[0];

  // Resolve the local day (site tz) → a UTC [dayStart, dayEnd) window.
  const todayParts = utcToZonedParts(new Date(), site.timezone);
  const dateStr = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
    ? sp.date
    : `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-${String(todayParts.day).padStart(2, "0")}`;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayStart = zonedPartsToUtc(y, m, d, 0, 0, site.timezone);
  const dayEnd = zonedPartsToUtc(y, m, d + 1, 0, 0, site.timezone);

  const [staff, services, appts, crmEnabled] = await Promise.all([
    listStaff(tenantId, { siteId: site.id, clientId: client.id }),
    listServicesForSite(tenantId, site.id),
    listAppointments(tenantId, { siteId: site.id, from: dayStart, to: dayEnd, clientId: client.id }),
    isClientModuleEnabled(tenantId, client.id, "crm"),
  ]);

  return (
    <AgendaView
      clientId={client.id}
      basePath={`/clients/${client.id}/scheduling/agenda`}
      contactsBase={crmEnabled ? `/clients/${client.id}/contacts` : null}
      from={sp.from ?? null}
      canManage={hasFullAccess(scope)}
      timezone={site.timezone}
      date={dateStr}
      dayStartIso={dayStart.toISOString()}
      dayEndIso={dayEnd.toISOString()}
      sites={sites.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone }))}
      currentSiteId={site.id}
      staff={staff.map((s) => ({ id: s.id, name: s.name }))}
      services={services.map((s) => ({ id: s.id, name: s.name, duration_min: s.effective_duration_min }))}
      appointments={appts.map((a) => ({
        id: a.id,
        staff_id: a.staff_id,
        staff_name: a.staff_name,
        service_id: a.service_id,
        start_at: a.start_at.toISOString(),
        service_end_at: a.service_end_at.toISOString(),
        service_name: a.service_name_snapshot,
        status: a.status,
        origin: a.origin,
        contact_id: a.contact_id,
        contact_name: a.contact_name,
        source_conversation_id: a.source_conversation_id,
      }))}
    />
  );
}
