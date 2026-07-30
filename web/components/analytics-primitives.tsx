/**
 * CLIENT-SAFE presentational primitives (C-4.1). Split out of analytics-ui.tsx, which
 * imports ANALYTICS_RANGE_DAYS from the worker analytics repo and so transitively pulls
 * the `pg` client — that made the whole module unusable from CLIENT components (the
 * reason the contact rail had a duplicated local card). This file has ZERO server/db
 * imports, so it renders on both the server (the W-3 Analytics pages, via analytics-ui's
 * re-export) and the client (the contact record's rail).
 *
 * Everything here is pure/presentational (no hooks/state), themed via tokens so it is
 * legible in both light and dark. Markup is byte-for-byte what analytics-ui exported, so
 * the original Analytics consumers render identically.
 */

/** Rate split-bar colors — fixed mid-tones legible on light and dark. */
export const RATE_SUCCESS = "#22c55e";
export const RATE_ERROR = "#ef4444";

/* ------------------------------------------------------------ stat tiles -- */

/**
 * THE stat-tile primitive: label, big value, optional sub-line, and an optional
 * inline extra via `children` (e.g. the Success-rate split bar). Every stat tile in
 * both Analytics views renders through this — no bespoke tile markup elsewhere.
 */
export function KpiCard({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
      {children}
    </div>
  );
}

/** The success/error split bar + ok/err legend — the KpiCard inline-bar content. */
export function RateBar({ success, error }: { success: number; error: number }) {
  const completed = success + error;
  const sPct = completed > 0 ? (success / completed) * 100 : 0;
  const ePct = completed > 0 ? (error / completed) * 100 : 0;
  return (
    <>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-subtle">
        <div style={{ width: `${sPct}%`, background: RATE_SUCCESS }} />
        <div style={{ width: `${ePct}%`, background: RATE_ERROR }} />
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: RATE_SUCCESS }} />
          {success.toLocaleString()} ok
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: RATE_ERROR }} />
          {error.toLocaleString()} err
        </span>
      </div>
    </>
  );
}

/** The Success-rate tile: a KpiCard whose inline bar is the RateBar. Shared by both
 * Analytics views and by the Hub delegate below. */
export function SuccessRateCard({
  rate,
  success,
  error,
}: {
  rate: number | null;
  success: number;
  error: number;
}) {
  return (
    <KpiCard label="Success rate" value={rate === null ? "—" : `${rate}%`}>
      <RateBar success={success} error={error} />
    </KpiCard>
  );
}

/**
 * Hub compatibility delegate (app/page.tsx): keeps the StatCard API but is now just a
 * KpiCard, so the Hub is byte-identical while the markup lives in ONE place. The two
 * W-3 Analytics views use KpiCard directly.
 */
export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return <KpiCard label={label} value={value} sub={sub} />;
}

/* ---------------------------------------------------------------- panels -- */

/**
 * Card chrome for a chart / side-panel block: ONE radius+border+padding and a header
 * row with a title + optional `aside` (e.g. a chart legend). Used for the primary
 * chart and every side-panel block in both views.
 */
export function PanelCard({
  title,
  aside,
  children,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside ? <div className="flex items-center gap-3 text-xs text-muted">{aside}</div> : null}
      </div>
      {children}
    </div>
  );
}

/* -------------------------------------------------------- layout skeleton -- */

/** The KPI row — the same responsive grid in both views (2-up, 4-up ≥ lg). */
export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{children}</div>;
}

/** The primary-chart | side-panel block: wider chart, narrower side, stacking at the
 * SAME breakpoint in both views. `side` is a stack (its children flow top-to-bottom). */
export function AnalyticsColumns({
  primary,
  side,
}: {
  primary: React.ReactNode;
  side: React.ReactNode;
}) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
      <div className="min-w-0">{primary}</div>
      <div className="flex min-w-0 flex-col gap-4">{side}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- states -- */

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

/** Page-level empty state: no executions ever exist in this scope. */
export function AnalyticsEmpty({ hint }: { hint: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <p className="text-sm text-muted">Not enough data yet.</p>
      <p className="mt-1 text-sm text-faint">{hint}</p>
    </div>
  );
}

/** In-panel empty state: the chart has no rows in the selected range. */
export function NoDataInRange({ days }: { days: number }) {
  return (
    <div className="flex h-60 items-center justify-center text-sm text-faint">
      No executions in the last {days} days.
    </div>
  );
}

/** In-panel empty state for a side panel (no ranked rows / no conversation activity). */
export function PanelEmpty({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-faint">{children}</p>;
}
