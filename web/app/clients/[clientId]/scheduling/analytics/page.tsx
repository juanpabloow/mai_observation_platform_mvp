import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import { parseYmd, pickAllowedId } from "@/lib/schedulingFilters";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";
import {
  getAppointmentMetrics,
  getAppointmentsByDay,
  getAppointmentsByStaff,
  getAppointmentsByService,
} from "@worker/db/repositories/scheduling/analytics.js";
import { utcToZonedParts, localDayRangeToUtc } from "@worker/scheduling/timezone.js";
import { AnalyticsView } from "@/components/scheduling/AnalyticsView";

/**
 * Scheduling → Analytics. Gated by the central `scheduling` resolver; READ-ONLY, so
 * members authorized for this client may consult it. Analytics ALWAYS works against a
 * single SELECTED SITE so the timezone is unambiguous — the site's LOCAL date range is
 * converted to a half-open UTC `[from, to)` window via the tz helpers, and every
 * aggregate is SQL (COUNT/FILTER/SUM/GROUP BY), never rows loaded into JS. A foreign
 * site/staff/service id is ignored (validated against this client's loaded sets).
 */
export default async function SchedulingAnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ site?: string; start?: string; end?: string; staff?: string; service?: string; from?: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  const sp = await searchParams;
  const tenantId = scope.tenantId;

  const sites = await listSites(tenantId, { clientId: client.id });
  if (sites.length === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <div className="rounded-xl border border-dashed border-line-strong px-5 py-8">
          {hasFullAccess(scope) ? (
            <p className="text-sm text-muted">
              No sites yet.{" "}
              <Link href={`/clients/${client.id}/scheduling/admin`} className="text-accent hover:underline">
                Configure scheduling
              </Link>{" "}
              to see analytics.
            </p>
          ) : (
            <p className="text-sm text-muted">No sites are set up yet. Ask your administrator to configure scheduling.</p>
          )}
        </div>
      </main>
    );
  }

  // A ?site= from another client never matches → fall back to the first valid site.
  const site = sites.find((s) => s.id === sp.site) ?? sites[0];
  const tz = site.timezone;

  // Default range: the last 30 LOCAL days (site tz), inclusive.
  const today = utcToZonedParts(new Date(), tz);
  const todayYmd = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const back = new Date(Date.UTC(today.year, today.month - 1, today.day));
  back.setUTCDate(back.getUTCDate() - 29);
  const defaultStart = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}-${String(back.getUTCDate()).padStart(2, "0")}`;
  const startYmd = parseYmd(sp.start) ?? defaultStart;
  const endYmd = parseYmd(sp.end) ?? todayYmd;
  const { from, to } = localDayRangeToUtc(startYmd, endYmd, tz);

  // Filter option sets for THIS site (also the allow-lists that reject foreign ids).
  const [staff, services] = await Promise.all([
    listStaff(tenantId, { siteId: site.id, clientId: client.id }),
    listServicesForSite(tenantId, site.id),
  ]);
  const staffFilter = pickAllowedId(sp.staff, staff.map((s) => s.id));
  const serviceFilter = pickAllowedId(sp.service, services.map((s) => s.id));

  const filters = { clientId: client.id, siteId: site.id, from, to, staffId: staffFilter, serviceId: serviceFilter };
  const [metrics, byDay, byStaff, byService] = await Promise.all([
    getAppointmentMetrics(tenantId, filters),
    getAppointmentsByDay(tenantId, filters, tz),
    getAppointmentsByStaff(tenantId, filters),
    getAppointmentsByService(tenantId, filters),
  ]);

  return (
    <AnalyticsView
      basePath={`/clients/${client.id}/scheduling/analytics`}
      from={sp.from ?? null}
      sites={sites.map((s) => ({ id: s.id, name: s.name }))}
      currentSiteId={site.id}
      staff={staff.map((s) => ({ id: s.id, name: s.name }))}
      services={services.map((s) => ({ id: s.id, name: s.name }))}
      filters={{ start: startYmd, end: endYmd, staff: staffFilter ?? null, service: serviceFilter ?? null }}
      metrics={metrics}
      byDay={byDay.map((d) => ({ key: d.day, label: d.day, total: d.total, completed: d.completed }))}
      byStaff={byStaff.map((r) => ({ key: r.staff_id, label: r.staff_name ?? "—", total: r.total, completed: r.completed }))}
      byService={byService.map((r) => ({ key: r.service_id, label: r.service_name, total: r.total, completed: r.completed }))}
      statusDistribution={[
        { label: "scheduled", value: metrics.scheduled },
        { label: "confirmed", value: metrics.confirmed },
        { label: "completed", value: metrics.completed },
        { label: "cancelled", value: metrics.cancelled },
        { label: "no_show", value: metrics.no_show },
      ]}
    />
  );
}
