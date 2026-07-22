import Link from "next/link";
import { connection } from "next/server";
import { getAccessScope } from "@/lib/access";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";
import { listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { AgendaView } from "@/components/scheduling/AgendaView";

/**
 * Internal Agenda (owner/admin, tenant-level). Day view with a column per barber.
 * The site + date come from the URL; data is loaded server-side (tenant-scoped)
 * for the selected local day, and the client AgendaView handles navigation,
 * the new-appointment/walk-in forms, per-appointment actions, and live refresh.
 */
export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string; date?: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const clientScope = scope.memberClientId; // null = owner/admin (all clients)
  const sp = await searchParams;

  const sites = await listSites(tenantId, { clientId: clientScope });
  if (sites.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
        <h1 className="text-2xl font-semibold tracking-tight">Agenda</h1>
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-strong px-5 py-8">
          <p className="text-sm text-muted">No sites yet — create one to start scheduling.</p>
          <Link href="/scheduling/admin" className="text-sm text-accent hover:underline">
            Go to Scheduling admin →
          </Link>
        </div>
      </main>
    );
  }

  const site = sites.find((s) => s.id === sp.site) ?? sites[0];

  // Resolve the local day (site tz) → a UTC [dayStart, dayEnd) window.
  const todayParts = utcToZonedParts(new Date(), site.timezone);
  const dateStr = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
    ? sp.date
    : `${todayParts.year}-${String(todayParts.month).padStart(2, "0")}-${String(todayParts.day).padStart(2, "0")}`;
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayStart = zonedPartsToUtc(y, m, d, 0, 0, site.timezone);
  const dayEnd = zonedPartsToUtc(y, m, d + 1, 0, 0, site.timezone);

  const [staff, services, appts] = await Promise.all([
    listStaff(tenantId, { siteId: site.id, clientId: clientScope }),
    listServicesForSite(tenantId, site.id),
    listAppointments(tenantId, { siteId: site.id, from: dayStart, to: dayEnd, clientId: clientScope }),
  ]);

  return (
    <AgendaView
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
