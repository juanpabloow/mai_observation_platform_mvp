import Link from "next/link";
import { ANALYTICS_RANGE_DAYS } from "@worker/db/repositories/analytics.js";

/**
 * Shared, server-rendered analytics UI primitives. The client-scoped Analytics
 * surface (W-3) renders through these at BOTH scopes — the all-workflows aggregate
 * and a single workflow — so container, header, KPI row and the chart|side-panel
 * block are consistent BY CONSTRUCTION rather than aligned by hand:
 *   AnalyticsShell → KpiGrid(KpiCard…) → AnalyticsColumns(PanelCard | PanelCard…).
 *
 * StatCard/SuccessRateCard stay as thin KpiCard delegates so the tenant Hub
 * (app/page.tsx) — a separate surface, out of the W-3 scope — keeps its own
 * composition unchanged while there is still a SINGLE source of stat-tile markup.
 * Everything here is presentational (no hooks/state), themed via the CL-4b tokens so
 * it's legible in both modes.
 */

/** Rate split-bar colors — fixed mid-tones legible on light and dark. */
export const RATE_SUCCESS = "#22c55e";
export const RATE_ERROR = "#ef4444";

/* ---------------------------------------------------------------- shell -- */

/**
 * The Analytics page container: ONE max-width + padding, the "Analytics" H1 with a
 * muted scope subline ("All workflows" or the workflow's name), and the range
 * selector pinned top-right. Both scopes render this, so the container/header/selector
 * are identical by construction. `banner` is an optional scope-specific note under the
 * header (the aggregate's "pending across workflows" nudge); the KPI/chart skeleton
 * below it is the same in both views.
 */
export function AnalyticsShell({
  scopeLabel,
  rangeBasePath,
  rangeCurrent,
  rangeExtraQuery,
  banner,
  children,
}: {
  scopeLabel: string;
  rangeBasePath: string;
  rangeCurrent: number;
  rangeExtraQuery?: string;
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Analytics</h1>
          <p className="text-sm text-muted">{scopeLabel}</p>
        </div>
        <RangeSelector basePath={rangeBasePath} current={rangeCurrent} extraQuery={rangeExtraQuery} />
      </header>
      {banner}
      {children}
    </main>
  );
}

/** 7/30/90-day selector as URL-param links (bookmarkable, server-rendered).
 * `extraQuery` (e.g. "&from=W") is appended so other params survive a range change. */
export function RangeSelector({
  basePath,
  current,
  extraQuery = "",
}: {
  basePath: string;
  current: number;
  extraQuery?: string;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line p-0.5 text-sm">
      {ANALYTICS_RANGE_DAYS.map((d) => (
        <Link
          key={d}
          href={`${basePath}?range=${d}${extraQuery}`}
          scroll={false}
          aria-current={d === current ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 transition-colors ${
            d === current ? "bg-subtle font-medium text-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}

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
