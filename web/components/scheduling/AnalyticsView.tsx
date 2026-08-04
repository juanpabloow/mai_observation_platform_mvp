"use client";

import { useRouter } from "next/navigation";

interface Opt { id: string; name: string }
interface Metrics {
  total: number;
  scheduled: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
  completion_rate: number;
  cancellation_rate: number;
  no_show_rate: number;
  completed_value: string;
  scheduled_value: string;
}
interface Bucket { key: string; label: string; total: number; completed: number }

const money = (v: string): string => new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(Number(v));
const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;

/**
 * Scheduling analytics — read-only aggregates for ONE site + date range (so the
 * timezone is unambiguous), optionally narrowed to a barber and/or service. Every
 * chart is paired with an ACCESSIBLE data table so the numbers never depend on the
 * visualization. Filters persist in the query string. Money is labeled honestly
 * ("appointment value", not "revenue" — there is no payments data).
 */
export function AnalyticsView(props: {
  basePath: string;
  from: string | null;
  sites: Opt[];
  currentSiteId: string;
  staff: Opt[];
  services: Opt[];
  filters: { start: string; end: string; staff: string | null; service: string | null };
  metrics: Metrics;
  byDay: Bucket[];
  byStaff: Bucket[];
  byService: Bucket[];
  statusDistribution: Array<{ label: string; value: number }>;
}) {
  const router = useRouter();

  const navigate = (patch: { site?: string; start?: string; end?: string; staff?: string | null; service?: string | null }) => {
    const changingSite = patch.site !== undefined && patch.site !== props.currentSiteId;
    const params = new URLSearchParams();
    params.set("site", patch.site ?? props.currentSiteId);
    params.set("start", patch.start ?? props.filters.start);
    params.set("end", patch.end ?? props.filters.end);
    // staff/service are per-site → dropped when the site changes.
    const staff = patch.staff !== undefined ? patch.staff : changingSite ? null : props.filters.staff;
    const service = patch.service !== undefined ? patch.service : changingSite ? null : props.filters.service;
    if (staff) params.set("staff", staff);
    if (service) params.set("service", service);
    if (props.from) params.set("from", props.from);
    router.push(`${props.basePath}?${params.toString()}`);
  };

  const hasNarrowing = props.filters.staff !== null || props.filters.service !== null;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
      <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>

      {/* Filters — a SITE is required (fixes the timezone); range + optional barber/service. */}
      <div className="flex flex-wrap items-end gap-2">
        <Labeled label="Site">
          <select value={props.currentSiteId} onChange={(e) => navigate({ site: e.target.value })} className={CTRL}>
            {props.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="From">
          <input type="date" value={props.filters.start} onChange={(e) => e.target.value && navigate({ start: e.target.value })} className={CTRL} />
        </Labeled>
        <Labeled label="To">
          <input type="date" value={props.filters.end} onChange={(e) => e.target.value && navigate({ end: e.target.value })} className={CTRL} />
        </Labeled>
        <Labeled label="Barber">
          <select value={props.filters.staff ?? ""} onChange={(e) => navigate({ staff: e.target.value || null })} className={CTRL}>
            <option value="">All barbers</option>
            {props.staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Labeled>
        <Labeled label="Service">
          <select value={props.filters.service ?? ""} onChange={(e) => navigate({ service: e.target.value || null })} className={CTRL}>
            <option value="">All services</option>
            {props.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Labeled>
        {hasNarrowing ? (
          <button onClick={() => navigate({ staff: null, service: null })} className="px-2 py-1.5 text-sm text-muted hover:text-foreground">
            Clear
          </button>
        ) : null}
      </div>

      {/* Headline metrics. */}
      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Metric label="Total" value={props.metrics.total} />
        <Metric label="Scheduled" value={props.metrics.scheduled} />
        <Metric label="Confirmed" value={props.metrics.confirmed} />
        <Metric label="Completed" value={props.metrics.completed} />
        <Metric label="Cancelled" value={props.metrics.cancelled} />
        <Metric label="No-show" value={props.metrics.no_show} />
        <Metric label="Completion rate" value={pct(props.metrics.completion_rate)} />
        <Metric label="Cancellation rate" value={pct(props.metrics.cancellation_rate)} />
        <Metric label="No-show rate" value={pct(props.metrics.no_show_rate)} />
        <Metric label="Completed appointment value" value={money(props.metrics.completed_value)} />
        <Metric label="Scheduled appointment value" value={money(props.metrics.scheduled_value)} />
      </section>
      <p className="-mt-3 text-[11px] text-faint">
        Appointment value is the sum of snapshotted service prices — NOT confirmed revenue (no payments are recorded).
      </p>

      {props.metrics.total === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-sm text-muted">
          No appointments in this range for the selected filters.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ChartBlock title="Appointments per day" rows={props.byDay.map((d) => ({ key: d.key, label: d.label, total: d.total, completed: d.completed }))} />
          <ChartBlock title="By status" rows={props.statusDistribution.map((s) => ({ key: s.label, label: s.label, total: s.value, completed: 0 }))} hideCompleted />
          <ChartBlock title="By barber" rows={props.byStaff} />
          <ChartBlock title="By service" rows={props.byService} />
        </div>
      )}
    </main>
  );
}

const CTRL = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-faint">{label}</p>
    </div>
  );
}

/** A horizontal bar chart + an accessible data table (the numbers never depend on
 * the bars). `completed` overlays a darker segment unless hideCompleted. */
function ChartBlock({
  title,
  rows,
  hideCompleted,
}: {
  title: string;
  rows: Array<{ key: string; label: string; total: number; completed: number }>;
  hideCompleted?: boolean;
}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">No data.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5" aria-hidden="true">
            {rows.map((r) => (
              <li key={r.key} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 truncate text-muted" title={r.label}>
                  {r.label}
                </span>
                <span className="relative h-4 flex-1 overflow-hidden rounded bg-subtle">
                  <span className="absolute inset-y-0 left-0 rounded bg-accent/30" style={{ width: `${(r.total / max) * 100}%` }} />
                  {!hideCompleted ? (
                    <span className="absolute inset-y-0 left-0 rounded bg-accent" style={{ width: `${(r.completed / max) * 100}%` }} />
                  ) : null}
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums">{r.total}</span>
              </li>
            ))}
          </ul>
          <table className="w-full text-xs">
            <caption className="sr-only">{title}</caption>
            <thead className="text-left text-faint">
              <tr>
                <th className="py-1 font-medium">Label</th>
                <th className="py-1 text-right font-medium">Total</th>
                {!hideCompleted ? <th className="py-1 text-right font-medium">Completed</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line">
                  <td className="py-1">{r.label}</td>
                  <td className="py-1 text-right tabular-nums">{r.total}</td>
                  {!hideCompleted ? <td className="py-1 text-right tabular-nums">{r.completed}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
