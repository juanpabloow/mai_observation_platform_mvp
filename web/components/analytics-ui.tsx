import Link from "next/link";
import { ANALYTICS_RANGE_DAYS } from "@worker/db/repositories/analytics.js";

/**
 * Analytics shell + range selector — the ONLY primitives that need a server import
 * (ANALYTICS_RANGE_DAYS), which transitively pulls the `pg` client, so this module is
 * server-only. The pure, CLIENT-SAFE primitives (KpiCard, PanelCard, RateBar, KpiGrid,
 * columns, states…) live in ./analytics-primitives and are RE-EXPORTED here so the W-3
 * Analytics pages + the Hub keep importing everything from "@/components/analytics-ui"
 * unchanged. Client components (e.g. the contact record's rail) import the primitives
 * directly from "@/components/analytics-primitives".
 */

export * from "./analytics-primitives";

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
