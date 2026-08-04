"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

interface ApptDTO {
  id: string;
  start_at: string;
  service_end_at: string;
  service_name: string;
  status: string;
  contact_id: string | null;
  contact_name: string | null;
}
interface RangeSummary {
  total: number;
  scheduled: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
}
interface WorkingDay {
  weekday: string;
  ranges: Array<{ start: string; end: string }>;
}

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-subtle text-foreground",
  confirmed: "bg-accent/15 text-accent",
  completed: "bg-success/15 text-success",
  cancelled: "text-faint line-through",
  no_show: "text-danger",
};
const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;

function fmt(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(iso));
}

/**
 * Barber (staff) detail — READ-ONLY operational view. Info + site + services +
 * working hours + upcoming + a date-range/status filtered history with a range
 * summary. Filters persist in the query string (start/end/status); `from` (origin
 * workflow) is preserved. Editing lives in Settings (owner/admin), not here.
 */
export function StaffDetail(props: {
  basePath: string;
  backHref: string;
  from: string | null;
  contactsBase: string | null;
  timezone: string;
  staff: { name: string; siteName: string; active: boolean; services: string[]; workingHours: WorkingDay[] };
  upcoming: ApptDTO[];
  range: { start: string; end: string; status: string | null };
  summary: RangeSummary;
  history: ApptDTO[];
}) {
  const router = useRouter();

  const navigate = (patch: { start?: string; end?: string; status?: string | null }) => {
    const params = new URLSearchParams();
    params.set("start", patch.start ?? props.range.start);
    params.set("end", patch.end ?? props.range.end);
    const status = patch.status !== undefined ? patch.status : props.range.status;
    if (status) params.set("status", status);
    if (props.from) params.set("from", props.from);
    router.push(`${props.basePath}?${params.toString()}`);
  };

  const renderList = (items: ApptDTO[], empty: string) =>
    items.length === 0 ? (
      <p className="text-sm text-muted">{empty}</p>
    ) : (
      <ul className="flex flex-col gap-2">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{fmt(a.start_at, props.timezone)}</p>
              <p className="text-xs text-muted">
                {a.service_name}
                {" · "}
                {a.contact_id && props.contactsBase ? (
                  <Link href={`${props.contactsBase}/${a.contact_id}${props.from ? `?from=${encodeURIComponent(props.from)}` : ""}`} className="hover:underline">
                    {a.contact_name ?? "Contact"}
                  </Link>
                ) : (
                  <span>{a.contact_id ? a.contact_name ?? "Contact" : "Walk-in"}</span>
                )}
              </p>
            </div>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${STATUS_STYLE[a.status] ?? ""}`}>{a.status}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-6 py-6">
      <Link href={props.backHref} className="text-sm text-muted hover:text-foreground">
        ← Team
      </Link>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{props.staff.name}</h1>
          {props.staff.active ? (
            <span className="rounded bg-success/15 px-2 py-0.5 text-xs text-success">active</span>
          ) : (
            <span className="rounded bg-subtle px-2 py-0.5 text-xs text-faint">inactive</span>
          )}
          <span className="text-xs text-faint">{props.staff.siteName}</span>
        </div>
        <p className="text-sm text-muted">
          Services: {props.staff.services.length > 0 ? props.staff.services.join(", ") : "—"}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Working hours</h2>
        {props.staff.workingHours.length === 0 ? (
          <p className="text-sm text-muted">Inherits the site&apos;s opening hours.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            {props.staff.workingHours.map((w) => (
              <li key={w.weekday} className="flex justify-between gap-2">
                <span className="uppercase text-faint">{w.weekday}</span>
                <span>{w.ranges.map((r) => `${r.start}–${r.end}`).join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Upcoming appointments</h2>
        {renderList(props.upcoming, "No upcoming appointments.")}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">History &amp; summary</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            From
            <input type="date" value={props.range.start} onChange={(e) => e.target.value && navigate({ start: e.target.value })} className="rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            To
            <input type="date" value={props.range.end} onChange={(e) => e.target.value && navigate({ end: e.target.value })} className="rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm" />
          </label>
          <select value={props.range.status ?? ""} onChange={(e) => navigate({ status: e.target.value || null })} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm">
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {props.range.status ? (
            <button onClick={() => navigate({ status: null })} className="px-2 py-1.5 text-sm text-muted hover:text-foreground">
              Clear status
            </button>
          ) : null}
        </div>

        {/* Range summary (metrics over the selected [start, end] in the site timezone). */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <Stat label="Total" value={props.summary.total} />
          <Stat label="Scheduled" value={props.summary.scheduled} />
          <Stat label="Confirmed" value={props.summary.confirmed} />
          <Stat label="Completed" value={props.summary.completed} />
          <Stat label="Cancelled" value={props.summary.cancelled} />
          <Stat label="No-show" value={props.summary.no_show} />
        </div>

        {renderList(props.history, "No appointments in this range.")}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line px-3 py-2">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] uppercase tracking-wide text-faint">{label}</p>
    </div>
  );
}
