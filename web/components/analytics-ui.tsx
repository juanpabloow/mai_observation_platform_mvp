import Link from "next/link";
import { ANALYTICS_RANGE_DAYS } from "@worker/db/repositories/analytics.js";

/**
 * Shared, server-rendered analytics UI primitives, used by BOTH the per-workflow
 * Analytics tab (CL-5a) and the tenant Hub dashboard (CL-5b). Presentational only
 * (no hooks/state), themed via the CL-4b tokens so they're legible in both modes.
 */

/** Rate split-bar colors — fixed mid-tones legible on light and dark. */
export const RATE_SUCCESS = "#22c55e";
export const RATE_ERROR = "#ef4444";

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

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">{value}</div>
      {sub ? <div className="mt-1 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

export function SuccessRateCard({
  rate,
  success,
  error,
}: {
  rate: number | null;
  success: number;
  error: number;
}) {
  const completed = success + error;
  const sPct = completed > 0 ? (success / completed) * 100 : 0;
  const ePct = completed > 0 ? (error / completed) * 100 : 0;
  return (
    <div className="rounded-2xl border border-line bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Success rate</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight sm:text-3xl">
        {rate === null ? "—" : `${rate}%`}
      </div>
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
    </div>
  );
}

export function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}

export function NoDataInRange({ days }: { days: number }) {
  return (
    <div className="flex h-60 items-center justify-center text-sm text-faint">
      No executions in the last {days} days.
    </div>
  );
}
