import { can, isSchedulingStaff, canAccessSchedulingSite } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import {
  freeMinutesByStaff,
  occupancySeriesByStaff,
  occupancyTotalsByStaff,
} from "@worker/db/repositories/scheduling/occupancyReads.js";
import { buildOccupancyHeatmap, type OccupancyHeatmap } from "@worker/occupancy/heatmap.js";
import { localDayKey } from "@worker/occupancy/compute.js";
import {
  assembleRows,
  periodRange,
  siteTotalRow,
  trendBucketStarts,
  type OccupancyGranularity,
  type OccupancyRow,
  type Period,
  type RawBucket,
  type RawTotals,
} from "./occupancyView";

/**
 * JP-8 §3/§4 — the server loader for the Ocupación screen. ALL permission enforcement lives here
 * (the page and the panel only render what this returns):
 *   - gate: `agenda.view` under the scheduling module (agency / owner / setter / staff). A failure is
 *     indistinguishable 404 at the page.
 *   - a STAFF login sees ONLY its own site + its own row (payload contains no other professional).
 *   - MONEY (collected + sales per available hour) is attached ONLY when `analytics.view` holds
 *     (owner/agency) — a Setter/staff payload carries none.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const GRAN: Record<string, OccupancyGranularity> = { dia: "day", semana: "week", mes: "month" };
const TREND_PERIODS = 6;
const FREE_WINDOW_DAYS = 7;

export interface OccupancyView {
  granularity: OccupancyGranularity;
  period: Period;
  today: string;
  canMoney: boolean;
  isStaff: boolean;
  sites: Array<{ id: string; name: string }>;
  selectedSiteId: string | null;
  rows: OccupancyRow[];
  siteTotal: OccupancyRow | null;
  trendStarts: string[];
  heatmap: OccupancyHeatmap | null;
  /** The professional the heatmap is focused on, or null for the whole site. */
  heatmapStaffId: string | null;
}

export type OccupancyResult = { ok: true; clientName: string; view: OccupancyView } | { ok: false };

export interface OccupancyParams {
  g?: string; // dia | semana | mes
  d?: string; // anchor day YYYY-MM-DD (site-local)
  site?: string;
  staff?: string; // heatmap focus
}

export async function loadOccupancyView(clientId: string, params: OccupancyParams): Promise<OccupancyResult> {
  const res = await resolveClientModuleContext(clientId, "scheduling", "agenda.view");
  if (!res.ok) return { ok: false };
  const { scope, client } = res.context;
  const tenantId = scope.tenantId;

  const canMoney = can(scope, "analytics.view", client.id);
  const staffLogin = isSchedulingStaff(scope);

  // Sites this login may see (a professional is pinned to their own site).
  const allSites = await listSites(tenantId, { clientId: client.id });
  const sites = allSites.filter((s) => canAccessSchedulingSite(scope, s.id));
  const granularity = GRAN[params.g ?? ""] ?? "week";

  if (sites.length === 0) {
    const today = "1970-01-01";
    return {
      ok: true,
      clientName: client.name,
      view: {
        granularity,
        period: periodRange(granularity, today),
        today,
        canMoney,
        isStaff: staffLogin,
        sites: [],
        selectedSiteId: null,
        rows: [],
        siteTotal: null,
        trendStarts: [],
        heatmap: null,
        heatmapStaffId: null,
      },
    };
  }

  // A staff login is forced to its own site; everyone else may pick (defaulting to the first).
  const selectedSite =
    (staffLogin && scope.schedulingSiteId ? sites.find((s) => s.id === scope.schedulingSiteId) : null) ??
    (params.site ? sites.find((s) => s.id === params.site) : null) ??
    sites[0];
  const tz = selectedSite.timezone;
  const today = localDayKey(new Date(), tz);
  const anchor = params.d && DAY_RE.test(params.d) ? params.d : today;
  const period = periodRange(granularity, anchor);

  // Bookable professionals of the site; a staff login is narrowed to its own row.
  const allStaff = await listStaff(tenantId, { clientId: client.id, siteId: selectedSite.id, bookableOnly: true });
  const staff = staffLogin ? allStaff.filter((s) => s.id === scope.schedulingStaffId) : allStaff;
  const staffList = staff.map((s) => ({ id: s.id, name: s.name }));

  const trendStarts = trendBucketStarts(granularity, anchor, TREND_PERIODS);
  const freeTo = addDaysStr(today, FREE_WINDOW_DAYS - 1);
  const [totals, free, buckets] = await Promise.all([
    occupancyTotalsByStaff(tenantId, client.id, period.from, period.to),
    freeMinutesByStaff(tenantId, client.id, today, freeTo),
    occupancySeriesByStaff(tenantId, client.id, trendStarts[0] ?? period.from, period.to, granularity),
  ]);

  const allowedIds = new Set(staffList.map((s) => s.id));
  const totalsMap = new Map<string, RawTotals>(totals.filter((t) => allowedIds.has(t.staff_id)).map((t) => [t.staff_id, t]));
  const freeMap = new Map<string, number>(free.filter((f) => allowedIds.has(f.staff_id)).map((f) => [f.staff_id, f.free_min]));
  const bucketsMap = new Map<string, RawBucket[]>();
  for (const b of buckets) {
    if (!allowedIds.has(b.staff_id)) continue;
    bucketsMap.set(b.staff_id, [...(bucketsMap.get(b.staff_id) ?? []), b]);
  }

  const rows = assembleRows(staffList, totalsMap, freeMap, bucketsMap, trendStarts, canMoney);
  const siteTotal = staffLogin ? null : siteTotalRow(rows, canMoney);

  // Heatmap: the whole site, or a chosen professional (a staff login = always only itself).
  const heatmapStaffId = staffLogin
    ? (scope.schedulingStaffId ?? null)
    : params.staff && allowedIds.has(params.staff)
      ? params.staff
      : null;
  const heatmapStaffIds = heatmapStaffId ? [heatmapStaffId] : staffList.map((s) => s.id);
  const heatmap = heatmapStaffIds.length
    ? await buildOccupancyHeatmap({ tenantId, clientId: client.id, siteId: selectedSite.id, staffIds: heatmapStaffIds, fromDay: period.from, toDay: period.to })
    : null;

  return {
    ok: true,
    clientName: client.name,
    view: {
      granularity,
      period,
      today,
      canMoney,
      isStaff: staffLogin,
      sites: sites.map((s) => ({ id: s.id, name: s.name })),
      selectedSiteId: selectedSite.id,
      rows,
      siteTotal,
      trendStarts,
      heatmap,
      heatmapStaffId,
    },
  };
}

function addDaysStr(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const u = new Date(Date.UTC(y, m - 1, d + n, 12));
  return `${u.getUTCFullYear()}-${String(u.getUTCMonth() + 1).padStart(2, "0")}-${String(u.getUTCDate()).padStart(2, "0")}`;
}
