"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PageShell } from "@/components/ui/PageShell";
import { PageTitle } from "@/components/ui/PageTitle";
import { apptCategory, apptCategoryClass, type ApptCategory } from "@/lib/agendaCategory";
import { formatMoneyCOP } from "@/lib/format";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  confirmAppointmentAction,
  createManualAppointmentAction,
  noShowAppointmentAction,
  rescheduleAppointmentAction,
} from "@/lib/schedulingActions";

/** Serializable shapes passed from the server page. */
interface SiteOpt { id: string; name: string; timezone: string }
/** A local wall-clock range in the SITE's timezone, mirroring the worker's
 *  `HoursRange`. Declared here (not imported) so this client component keeps no
 *  import edge into the worker package. */
interface HoursRange { start: string; end: string }
/** weekday key ("mon"…"sun") → the ranges worked that day. A MISSING or empty
 *  weekday means closed — that is the model's own convention, not an inference. */
type WeeklyHours = Partial<Record<string, HoursRange[]>>;
/** `active` = false means the staff member is deactivated. Such a lane still renders (so
 *  their existing appointments stay visible) with an "inactive" chip, but they are NOT
 *  offered for NEW bookings (the modal's Barber dropdown filters to active).
 *  `workingHours` = {} means "inherit the site's opening hours" (the common case). */
interface StaffOpt { id: string; name: string; active: boolean; workingHours: WeeklyHours }
interface ServiceOpt { id: string; name: string; duration_min: number }
interface Appt {
  id: string;
  public_reference: string;
  staff_id: string;
  staff_name: string | null;
  service_id: string;
  start_at: string;
  service_end_at: string;
  service_name: string;
  duration_min: number;
  /** numeric from pg → string; null when the service has no price. */
  price: string | null;
  status: string;
  origin: string;
  contact_id: string | null;
  contact_name: string | null;
  /** The contact's main phone-or-email, resolved from contact_identities by ONE
   *  lateral join in the repository. Replaces the old contact_phone: identity is
   *  canonical now. NULL for walk-ins / contacts with no phone or email. */
  primary_identity: string | null;
  source_conversation_id: string | null;
}
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }
/** When booking for an existing contact (C-4.1 deep-link), the modal locks the identity
 *  to this contact and submits its id — staff never retype what's on the record. */
interface ContactPrefill { contactId: string; contactName: string }
type ModalState =
  | { mode: "new" | "walkin"; contact?: ContactPrefill }
  | { mode: "reschedule"; appt: Appt };

/** The calendar body's vertical scale. One hour = this many px. 60 is the floor
 *  at which a 45-minute card still fits its three lines (time / customer /
 *  service) without cropping the last one. */
const HOUR_PX = 60;
/**
 * The grid's OPERATING WINDOW. Fixed on purpose: deriving it from the data meant a
 * single stray early booking stretched the grid to 3 AM and pushed the real working
 * hours off-screen. Appointments outside the window are clamped to its edges (never
 * dropped), so nothing becomes invisible or unclickable.
 * TODO(agenda): read these from the site's configured opening hours once the agenda
 *   is wired to them — `sites` already stores a weekly schedule.
 */
const GRID_FROM_HOUR = 9;
const GRID_TO_HOUR = 20;

const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;
const STATUS_LABEL: Record<string, string> = {
  scheduled: "Unconfirmed",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};
/** Drawer header copy, mirroring the design's "Appointment confirmed". */
const STATUS_TITLE: Record<string, string> = {
  scheduled: "Appointment unconfirmed",
  confirmed: "Appointment confirmed",
  completed: "Appointment completed",
  cancelled: "Appointment cancelled",
  no_show: "Marked as no show",
};

// ── Timezone helpers. Every hour/minute below is the SITE's local time, never the
// browser's — the agenda of a shop in Bogota must not shift for a viewer elsewhere.
function zonedParts(iso: string, tz: string): { h: number; m: number; dayKey: string } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "0";
  return { h: Number(get("hour")), m: Number(get("minute")), dayKey: `${get("year")}-${get("month")}-${get("day")}` };
}
function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(
    new Date(iso),
  );
}
/** "GMT-5" for the hour rail's corner label. */
function gmtLabel(tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
    .formatToParts(new Date())
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? tz;
}
const minutesOf = (p: { h: number; m: number }) => p.h * 60 + p.m;
/** YYYY-MM-DD arithmetic that never touches the local timezone. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// ── Opening hours. The weekday keys are the model's own ("sun".."sat", see
// scheduling/timezone.ts) and every lookup happens on the SITE's local day.
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** The weekday key of a YYYY-MM-DD day. Computed in UTC so it can't shift. */
function weekdayKeyOf(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return WEEKDAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const hasAnyHours = (h: WeeklyHours | undefined) => !!h && Object.keys(h).length > 0;
/** A weekly map opens on a weekday when it lists at least one range for it. */
const opensOn = (h: WeeklyHours | undefined, wd: string) => (h?.[wd]?.length ?? 0) > 0;
/**
 * Is this BARBER working that day? `working_hours = {}` is the model's "inherit
 * the site's opening hours", so an empty map falls through to the site's — it is
 * NOT "never works". A site with no hours configured at all is treated as OPEN
 * (unknown, not closed): hatching a whole agenda because nobody filled the
 * settings in would hide real appointments behind a "closed" wash.
 */
function staffWorksOn(staffHours: WeeklyHours | undefined, siteHours: WeeklyHours, wd: string): boolean {
  if (!hasAnyHours(siteHours)) return true;
  return opensOn(hasAnyHours(staffHours) ? staffHours : siteHours, wd);
}

/**
 * The Agenda: a real time-grid calendar over the EXISTING appointment model.
 *
 * DAY view = one column per barber; WEEK view = one column per day. The toggle is a
 * URL param the server reads to widen the fetch window (same query, wider range).
 *
 * Everything rendered here is backed by real data. The reference design also showed a
 * waitlist, "vs last week" KPI deltas, a per-appointment checklist and note, multiple
 * services per appointment, blocked/team-meeting entries and per-barber free-slot
 * counts — none of which exist in this schema, so they are deliberately NOT rendered
 * rather than faked. See the TODOs below.
 *
 * TODO(agenda): no waitlist model exists, so the design's "N WAITLIST" control and its
 *   "Avg waitlist time" KPI card are omitted. Needs a waitlist table first.
 * TODO(agenda): KPI deltas ("+12% vs last week") need a second, previous-period query.
 *   Omitted rather than shown as a fabricated percentage.
 * TODO(agenda): appointments have no note, no checklist (reminder sent / confirmed /
 *   follow-up booked) and exactly ONE service, so the drawer omits those blocks.
 * TODO(agenda): there is no blocked-time / "team meeting" entity (blocked_from/until
 *   are per-appointment buffers), so no blocked cards are drawn.
 * TODO(agenda): "N FREE" per barber needs an availability computation over the day.
 * TODO(agenda): staff_id is NOT NULL, so an unassigned walk-in cannot exist; the
 *   design's red "?" Unassigned column/chip is omitted.
 * TODO(agenda): Month and Staff views are not implemented -- the segmented control
 *   shows them disabled rather than pretending to switch.
 * TODO(agenda): "Mark as arrived", "Duplicate", "Remind customer" and "Edit" have no
 *   server action; the drawer exposes only the real lifecycle actions.
 */
export function AgendaView(props: {
  /** The validated owning client — every action is sent with this id. */
  clientId: string;
  /** Canonical route base, e.g. /clients/{id}/scheduling/agenda. */
  basePath: string;
  /** Client-scoped contacts base, or null when CRM is disabled for this client. */
  contactsBase: string | null;
  /** Client-scoped inbox base, or null when the inbox module is disabled — gates the
   *  "View conversation" deep link so it never lands on a disabled surface. */
  inboxBase: string | null;
  /** Origin workflow to preserve across navigation (?from=). */
  from: string | null;
  /** C-4.1 deep-links from the contact record: open the "new appointment" modal
   *  prefilled for this contact, or open "reschedule" already on this appointment. */
  prefillBook: ContactPrefill | null;
  openReschedule: string | null;
  /** C-5 0b: after a deep-linked book/reschedule, return to this contact record (a
   *  plain, server-validated contact id — used only for in-app navigation). */
  returnContactId: string | null;
  /** owner/admin — controls whether admin links (Add staff) render. */
  canManage: boolean;
  timezone: string;
  date: string;
  view: string;
  /** The four headline metrics for the visible range, computed server-side. */
  kpis: { total: number; completedPct: number | null; noShowPct: number | null; revenue: number };
  /** The SAME metrics for the preceding equivalent window — powers the deltas. */
  previousKpis: { total: number; completedPct: number | null; noShowPct: number | null; revenue: number };
  rangeStartIso: string;
  rangeEndIso: string;
  dayStartIso: string;
  dayEndIso: string;
  sites: SiteOpt[];
  currentSiteId: string;
  /** The current site's weekly opening hours — drives the CLOSED columns. Already
   *  on the site row the page loads; nothing extra is fetched for it. */
  openingHours: WeeklyHours;
  staff: StaffOpt[];
  services: ServiceOpt[];
  appointments: Appt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const isWeek = props.view === "week";
  const tz = props.timezone;

  // Auto-open from a deep-link (book-for-contact / reschedule) on first render — the
  // reschedule appointment is in props.appointments because the page forced its site+day.
  const initialModal: ModalState | null = props.prefillBook
    ? { mode: "new", contact: props.prefillBook }
    : props.openReschedule
      ? (() => {
          const appt = props.appointments.find((a) => a.id === props.openReschedule);
          return appt ? { mode: "reschedule" as const, appt } : null;
        })()
      : null;
  const [modal, setModal] = useState<ModalState | null>(initialModal);
  /** The appointment open in the side drawer (never a modal — the grid stays visible). */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Client-side facets over the ALREADY loaded range. */
  const [statusFilter, setStatusFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");

  const navigate = (patch: { site?: string; date?: string; view?: string }) => {
    const params = new URLSearchParams();
    params.set("site", patch.site ?? props.currentSiteId);
    params.set("date", patch.date ?? props.date);
    const nextView = patch.view ?? props.view;
    if (nextView === "week") params.set("view", "week");
    if (props.from) params.set("from", props.from); // keep the origin workflow
    router.push(`${props.basePath}?${params.toString()}`);
  };

  const fromQS = props.from ? `?from=${encodeURIComponent(props.from)}` : "";
  /** The site whose day is on screen — the scope line in the title band. */
  const currentSite = props.sites.find((s) => s.id === props.currentSiteId) ?? props.sites[0];
  const shiftDate = (days: number) => navigate({ date: addDays(props.date, days) });

  /**
   * ⌘A / Ctrl+A opens the new-appointment modal, so the badge on the button is a
   * real binding rather than decoration. It is IGNORED while focus is in a field
   * (input / textarea / select / contenteditable) so "select all" keeps working
   * where people actually expect it, and it never fires while a modal is already
   * open. NOTE: on the page body this does override the browser's select-all.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (modal) return;
      e.preventDefault();
      setModal({ mode: "new" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Action failed.");
      else router.refresh();
    });
  };

  // ── Derived, all from the loaded range ──────────────────────────────────────
  const visible = useMemo(
    () =>
      props.appointments.filter(
        (a) => (!statusFilter || a.status === statusFilter) && (!staffFilter || a.staff_id === staffFilter),
      ),
    [props.appointments, statusFilter, staffFilter],
  );

  const kpis = props.kpis;
  const prev = props.previousKpis;
  const rangeCaption = isWeek ? "This week" : "Today";
  const vsCaption = isWeek ? "vs last week" : "vs yesterday";

  /** Same barber, overlapping service windows — a real conflict, derived not stored. */
  const overlapIds = useMemo(() => {
    const out = new Set<string>();
    const byStaff = new Map<string, Appt[]>();
    for (const a of props.appointments) {
      if (a.status === "cancelled") continue;
      const list = byStaff.get(a.staff_id) ?? [];
      list.push(a);
      byStaff.set(a.staff_id, list);
    }
    for (const list of byStaff.values()) {
      const sorted = [...list].sort((x, z) => x.start_at.localeCompare(z.start_at));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start_at < sorted[i - 1].service_end_at) {
          out.add(sorted[i].id);
          out.add(sorted[i - 1].id);
        }
      }
    }
    return out;
  }, [props.appointments]);

  const fromHour = GRID_FROM_HOUR;
  const toHour = GRID_TO_HOUR;
  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  const bodyHeight = (toHour - fromHour) * HOUR_PX;
  const offsetTop = (mins: number) => ((mins - fromHour * 60) / 60) * HOUR_PX;

  /** The "now" marker — only drawn when today is inside the rendered range. */
  const nowParts = zonedParts(new Date().toISOString(), tz);
  const weekDays = useMemo(() => {
    if (!isWeek) return [];
    const start = zonedParts(props.rangeStartIso, tz).dayKey;
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [isWeek, props.rangeStartIso, tz]);
  const shownDayKeys = isWeek ? weekDays : [zonedParts(props.dayStartIso, tz).dayKey];
  const nowVisible = shownDayKeys.includes(nowParts.dayKey) && nowParts.h >= fromHour && nowParts.h < toHour;

  // Picking a barber in the "All staff" facet collapses the grid to that column —
  // the job the removed chips used to do, using a control that already existed.
  const shownStaff = staffFilter ? props.staff.filter((s) => s.id === staffFilter) : props.staff;
  /** The site-local day a DAY view is showing — the weekday every barber lane is
   *  checked against. */
  const dayWeekday = weekdayKeyOf(zonedParts(props.dayStartIso, tz).dayKey);
  const columns: {
    key: string;
    label: string;
    sub?: string;
    initial?: string;
    dayNum?: string;
    isToday?: boolean;
    inactive?: boolean;
    /** The shop doesn't open (week) / this barber doesn't work (day) — the lane is
     *  hatched out and its header greys, so it can't read as bookable whitespace. */
    closed?: boolean;
  }[] = isWeek
    ? weekDays.map((dk) => {
        const n = visible.filter((a) => zonedParts(a.start_at, tz).dayKey === dk).length;
        const [yy, mm, dd] = dk.split("-").map(Number);
        const wd = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay();
        const closed = hasAnyHours(props.openingHours) && !opensOn(props.openingHours, WEEKDAY_KEYS[wd]);
        return {
          key: dk,
          label: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][wd],
          sub: closed ? "Closed" : `${n} appointment${n === 1 ? "" : "(s)"}`,
          dayNum: String(dd),
          isToday: dk === nowParts.dayKey,
          closed,
        };
      })
    : shownStaff.map((st) => {
        // Avatar + name ONLY — repeating the appointment count here crowded the
        // header. No avatar image exists on staff, so the initial IS the avatar.
        // TODO(agenda): swap for a real photo if staff ever gains an avatar_url.
        // An INACTIVE barber still gets a lane (the server only includes them when
        // they have appointments in range) so their history stays reachable.
        const closed = !staffWorksOn(st.workingHours, props.openingHours, dayWeekday);
        return {
          key: st.id,
          label: st.name,
          initial: st.name,
          inactive: !st.active,
          closed,
          sub: closed ? "Closed" : undefined,
        };
      });

  const inColumn = (a: Appt, colKey: string) =>
    isWeek ? zonedParts(a.start_at, tz).dayKey === colKey : a.staff_id === colKey;

  const selected = selectedId ? props.appointments.find((a) => a.id === selectedId) ?? null : null;
  /**
   * COMPACT, STABLE date label: "4 Aug" + a muted "2026".
   *
   * The long form ("Tuesday August 4") swung between ~13 and ~22 characters, so
   * every control to its right slid sideways on each day-step. Three things stop
   * that: the short format (small variance), tabular figures (1 and 30 occupy the
   * same width), and a reserved min-width on the block (see the markup) so even
   * the widest label cannot push its neighbours.
   */
  const labelDate = new Date(`${props.date}T12:00:00Z`);
  const dateLabel = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "short",
    ...(isWeek ? {} : { day: "numeric" }),
  }).format(labelDate);
  const yearLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric" }).format(labelDate);
  /** The weekday moves OUT of the shifting slot — it is context, not the control. */
  const weekdayLabel = isWeek
    ? null
    : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(labelDate);

  if (props.staff.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 flex-col gap-[var(--content-pad)]">
        <div className="rounded-lg border border-dashed border-line-strong bg-surface px-5 py-8">
          {props.canManage ? (
            <p className="text-sm text-muted">
              No staff at this site yet.{" "}
              <Link href={`/clients/${props.clientId}/scheduling/admin`} className="text-accent hover:underline">
                Add staff
              </Link>
              .
            </p>
          ) : (
            // A member can't open the tenant-level Scheduling admin — message only.
            <p className="text-sm text-muted">No staff at this site yet. Ask your administrator to add staff.</p>
          )}
        </div>
      </main>
    );
  }

  return (
    // The gutter comes from the shell (app/layout.tsx); this owns only the rhythm.
    // ONE continuous surface. Every region below is a band inside the same white
    // card, separated by hairlines — not a row of independent boxes floating on the
    // canvas, which made the screen read as five unrelated widgets.
    <main className="flex min-h-0 flex-1 flex-col">
      <PageShell>
      {/* ── PAGE TITLE ── the same band Customers renders. The Agenda had no title at
             all: its date stepper was standing in for one, which left the screen
             unnamed and made the three surfaces disagree about what a title is. */}
      {/* No hairline under the title / control bar / KPI strip: the top of the Agenda
          is ONE object (name it, steer it, read its numbers), and three rules across
          it chopped that into four slabs. The grid below still gets its own rule —
          that seam is real, it separates chrome from the canvas. */}
      <div className="px-[var(--panel-pad)] pt-3">
        <PageTitle
          title="Agenda"
          context={`${currentSite?.name ?? ""}${props.sites.length > 1 ? ` · ${props.sites.length} sites` : " · 1 site"}`}
        />
      </div>

      {/* ── CONTROL BAR ── */}
      <div className="flex flex-wrap items-center gap-2 px-[var(--panel-pad)] py-2.5">
        <button
          type="button"
          onClick={() => navigate({ date: zonedParts(new Date().toISOString(), tz).dayKey })}
          className="inline-flex h-[var(--control-h)] items-center rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover"
        >
          Today
        </button>
        {/* Today → DATE → steppers. The steppers sit after the label because it has a
            RESERVED width, so "1 Sep" → "30 Sept" never drags them sideways. The
            reserve is PER VIEW: week renders only "Sept 2026" (9 chars) against
            day's "30 Sept 2026" (12), and reserving the day width in week mode left
            an obvious dead gap before the arrows. */}
        <h1
          className={`ml-1 text-base tracking-tight tabular-nums ${isWeek ? "min-w-[5.25rem]" : "min-w-[7.5rem]"}`}
        >
          <span className="font-semibold text-foreground">{dateLabel}</span>{" "}
          <span className="font-normal text-faint">{yearLabel}</span>
          {weekdayLabel ? (
            // Fixed width too: "Monday" vs "Wednesday" would otherwise shift the
            // steppers on its own, which the outer min-width cannot absorb.
            <span className="ml-1.5 hidden w-[4.5rem] text-xs font-normal text-faintest xl:inline-block">
              {weekdayLabel}
            </span>
          ) : null}
        </h1>
        <div className="flex items-center gap-1">
          <IconBtn label="Previous" onClick={() => shiftDate(isWeek ? -7 : -1)}>&lsaquo;</IconBtn>
          <IconBtn label="Next" onClick={() => shiftDate(isWeek ? 7 : 1)}>&rsaquo;</IconBtn>
        </div>

        {/* Hairline separator, as in the reference — it also visually pins the start
            of the view controls so the eye has a fixed edge to return to. */}
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />

        {/* Segmented view toggle: a recessed grey track with a RAISED WHITE pill on
            the active item — the pill reads as "lifted out" of the track, which is
            why it needs no drop shadow (a hairline does the same job). Month/Staff
            are disabled — see the TODO above. */}
        <div className="ml-1 flex items-center gap-0.5 rounded-full bg-chip p-0.5">
          <Seg active={!isWeek} onClick={() => navigate({ view: "day" })}>Day</Seg>
          <Seg active={isWeek} onClick={() => navigate({ view: "week" })}>Week</Seg>
          <Seg disabled title="Month view isn't implemented yet">Month</Seg>
        </div>

        <Facet
          icon={<StatusIcon />}
          label="All status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[{ value: "", label: "All status" }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <Facet
          icon={<StaffIcon />}
          label="All staff"
          value={staffFilter}
          onChange={setStaffFilter}
          options={[{ value: "", label: "All staff" }, ...props.staff.map((s) => ({ value: s.id, label: s.name }))]}
        />
        {props.sites.length > 1 ? (
          <Facet
            label="Site"
            value={props.currentSiteId}
            onChange={(v) => navigate({ site: v })}
            options={props.sites.map((s) => ({ value: s.id, label: s.name }))}
          />
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <AutoRefresh intervalSeconds={20} />
          <button
            type="button"
            onClick={() => setModal({ mode: "walkin" })}
            className="inline-flex h-[var(--control-h)] items-center rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover"
          >
            Walk-in
          </button>
          <button
            type="button"
            onClick={() => setModal({ mode: "new" })}
            className="inline-flex h-[var(--control-h)] items-center gap-2 rounded-md bg-brand px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            Add appointment
            <kbd className="u-mono rounded bg-white/20 px-1 text-[0.625rem] font-normal">&#8984;A</kbd>
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-b border-line bg-danger/10 px-[var(--panel-pad)] py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* ── KPI STRIP — three REAL metrics over the loaded range. The design's
             "Avg waitlist time" card and the "vs last week" deltas are omitted
             (no waitlist model, no previous-period query). ── */}
      <div className="grid gap-[var(--content-pad)] border-b border-line px-[var(--panel-pad)] pb-[var(--panel-pad)] pt-1 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Total appointments"
          unit="%"
          caption={rangeCaption}
          value={String(kpis.total)}
          delta={ratioDelta(kpis.total, prev.total)}
          vs={vsCaption}
        />
        <Kpi
          label="Compl. appointments"
          unit="pp"
          caption={rangeCaption}
          value={kpis.completedPct === null ? "—" : `${kpis.completedPct}%`}
          delta={pointDelta(kpis.completedPct, prev.completedPct)}
          vs={vsCaption}
        />
        <Kpi
          label="No show appointments"
          unit="pp"
          caption={rangeCaption}
          value={kpis.noShowPct === null ? "—" : `${kpis.noShowPct}%`}
          delta={pointDelta(kpis.noShowPct, prev.noShowPct)}
          // More no-shows is WORSE, so the delta's colour has to invert.
          higherIsBetter={false}
          vs={vsCaption}
        />
        {/* Replaces the design's "Avg. waitlist time" — no waitlist model exists, and
            this is a number the data can actually answer. */}
        <Kpi
          label="Booked revenue"
          unit="%"
          caption={`${rangeCaption} · excl. cancelled`}
          value={formatMoneyCOP(kpis.revenue) ?? "—"}
          delta={ratioDelta(kpis.revenue, prev.revenue)}
          vs={vsCaption}
        />
      </div>

      {/* ── CALENDAR GRID + DRAWER ── */}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto">
            {/* min-w-full (NOT min-w-max) is what lets the lanes BREATHE: the row is
                at least as wide as the viewport, the lanes divide it evenly, and
                only their own min-width can push the row past it — at which point
                this scroller takes over horizontally. */}
            <div className="flex min-w-full">
              {/* Hour rail */}
              <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-line bg-surface">
                <div className="flex h-12 items-end justify-center border-b border-line pb-1">
                  <span className="u-mono text-[0.625rem] text-faintest">{gmtLabel(tz)}</span>
                </div>
                <div className="relative" style={{ height: bodyHeight }}>
                  {hours.map((h) => (
                    <div key={h} className="absolute right-2 -translate-y-1/2" style={{ top: offsetTop(h * 60) }}>
                      <span className="u-mono text-[0.625rem] text-faint">
                        {/* timeZone: "UTC" is REQUIRED: `h` is already the site's
                            local hour, so formatting the synthetic UTC instant in
                            the BROWSER's zone re-shifted it — the rail read "4 AM"
                            beside a 9 AM card for any viewer outside the site. */}
                        {new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true, timeZone: "UTC" }).format(
                          new Date(Date.UTC(2020, 0, 1, h)),
                        )}
                      </span>
                    </div>
                  ))}
                  {nowVisible ? (
                    <div
                      aria-hidden
                      className="absolute right-0 -translate-y-1/2 rounded-l bg-brand px-1 py-px"
                      style={{ top: offsetTop(minutesOf(nowParts)) }}
                    >
                      <span className="u-mono text-[0.5625rem] font-semibold text-white">
                        {String(nowParts.h).padStart(2, "0")}:{String(nowParts.m).padStart(2, "0")}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Columns */}
              {columns.map((col) => (
                <div
                  key={col.key}
                  // GROW to fill, but never past a comfortable reading width and
                  // never below the min — three barbers spread across the panel,
                  // twelve fall back to the min and scroll. Day lanes carry a
                  // customer name + service so they need more floor than week's.
                  // grow-[999] (vs the tail's grow-1) is what makes the max-width
                  // behave: the lanes take everything up to their cap, and only the
                  // slack they refuse falls through to the empty tail.
                  className={`grow-[999] border-r border-line ${
                    isWeek ? "min-w-[7.5rem] max-w-[20rem]" : "min-w-[13rem] max-w-[34rem]"
                  }`}
                >
                  <div
                    className={`sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-line px-2 ${
                      col.closed ? "bg-closed-bg" : "bg-surface"
                    }`}
                  >
                    {col.dayNum ? (
                      // Today's date sits in a filled badge, as in the reference.
                      <span
                        className={`u-mono flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-semibold ${
                          col.isToday ? "bg-brand text-white" : col.closed ? "text-closed-fg" : "text-foreground"
                        }`}
                      >
                        {col.dayNum}
                      </span>
                    ) : null}
                    {col.initial ? <Initial name={col.initial} muted={col.closed} /> : null}
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span
                        className={`truncate text-xs font-semibold ${col.closed ? "text-closed-fg" : "text-foreground"}`}
                      >
                        {col.label}
                      </span>
                      {col.sub ? (
                        <span className={`truncate text-[0.625rem] ${col.closed ? "text-closed-fg" : "text-faint"}`}>
                          {col.sub}
                        </span>
                      ) : null}
                    </span>
                    {col.inactive ? (
                      <span
                        title="This barber is inactive — existing appointments still show here, but they can't take new bookings. Reactivate in Scheduling settings."
                        className="shrink-0 rounded-full border border-line-strong bg-chip px-1.5 py-0.5 text-[0.625rem] font-medium text-muted"
                      >
                        Inactive
                      </span>
                    ) : null}
                  </div>
                  <div className="relative" style={{ height: bodyHeight }}>
                    {/* CLOSED wash — under the hour lines and under any card, so an
                        appointment booked into a closed day stays fully readable
                        (it exists; it just shouldn't look bookable around it). */}
                    {col.closed ? <div aria-hidden className="u-closed-hatch absolute inset-0" /> : null}
                    {hours.map((h) => (
                      <div
                        key={h}
                        aria-hidden
                        className="absolute inset-x-0 border-t border-line/70"
                        style={{ top: offsetTop(h * 60) }}
                      />
                    ))}
                    {nowVisible ? (
                      <div
                        aria-hidden
                        className="absolute inset-x-0 z-10 border-t-2 border-brand"
                        style={{ top: offsetTop(minutesOf(nowParts)) }}
                      />
                    ) : null}
                    {visible
                      .filter((a) => inColumn(a, col.key))
                      .map((a) => {
                        // Clamp to the operating window so an out-of-hours booking
                        // still renders (at the edge) instead of drawing off-grid.
                        const lo = fromHour * 60;
                        const hi = toHour * 60;
                        const startMin = Math.min(Math.max(minutesOf(zonedParts(a.start_at, tz)), lo), hi);
                        const endMin = Math.min(Math.max(minutesOf(zonedParts(a.service_end_at, tz)), startMin), hi);
                        return (
                          <ApptCard
                            key={a.id}
                            appt={a}
                            tz={tz}
                            top={offsetTop(startMin)}
                            height={Math.max(22, ((endMin - startMin) / 60) * HOUR_PX - 2)}
                            overlapping={overlapIds.has(a.id)}
                            selected={a.id === selectedId}
                            onOpen={() => setSelectedId(a.id)}
                          />
                        );
                      })}
                  </div>
                </div>
              ))}

              {/* EMPTY TAIL. With one or two barbers the lanes hit their max-width
                  and leave slack; this carries the hour lines across it so the
                  remainder reads as empty calendar rather than a torn-off grid. It
                  takes ONLY what the lanes refuse (grow 1 against their 999). */}
              <div aria-hidden className="min-w-0 grow">
                <div className="sticky top-0 z-10 h-12 border-b border-line bg-surface" />
                <div className="relative" style={{ height: bodyHeight }}>
                  {hours.map((h) => (
                    <div
                      key={h}
                      className="absolute inset-x-0 border-t border-line/70"
                      style={{ top: offsetTop(h * 60) }}
                    />
                  ))}
                  {/* The now-line runs to the edge of the grid, not to the edge of
                      the last lane — otherwise it stops mid-panel. */}
                  {nowVisible ? (
                    <div
                      className="absolute inset-x-0 z-10 border-t-2 border-brand"
                      style={{ top: offsetTop(minutesOf(nowParts)) }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>

        {selected ? (
          <ApptDrawer
            appt={selected}
            tz={tz}
            pending={pending}
            contactsBase={props.contactsBase}
            inboxBase={props.inboxBase}
            fromQS={fromQS}
            onClose={() => setSelectedId(null)}
            onReschedule={() => setModal({ mode: "reschedule", appt: selected })}
            onConfirm={() => run(() => confirmAppointmentAction(props.clientId, selected.id))}
            onComplete={() => run(() => completeAppointmentAction(props.clientId, selected.id))}
            onNoShow={() => run(() => noShowAppointmentAction(props.clientId, selected.id))}
            onCancel={() => run(() => cancelAppointmentAction(props.clientId, selected.id))}
          />
        ) : null}
      </div>
      </PageShell>

      {modal ? (
        <AppointmentModal
          {...props}
          modal={modal}
          onClose={() => setModal(null)}
          onError={setError}
          onDone={() => {
            setModal(null);
            // Deep-linked from a contact record → return there so the new/moved
            // appointment is visible in context; otherwise just refresh the agenda.
            if (props.returnContactId) router.push(`/clients/${props.clientId}/contacts/${props.returnContactId}`);
            else router.refresh();
          }}
        />
      ) : null}
    </main>
  );
}

// ── Small presentational pieces ───────────────────────────────────────────────

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-full border border-line text-sm text-muted transition-colors hover:bg-hover hover:text-foreground"
    >
      {children}
    </button>
  );
}

function Seg({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={`rounded-full px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border border-line bg-surface font-semibold text-brand"
          : "font-medium text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/** A native <select> under a styled shell — full keyboard/AT behaviour, no portal. */
function Facet({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  icon?: React.ReactNode;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground">
      {icon ? <span className="pointer-events-none shrink-0 text-faint">{icon}</span> : null}
      <span className="pointer-events-none whitespace-nowrap">{current?.label ?? label}</span>
      <span aria-hidden className="pointer-events-none text-faint">&#9662;</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value || "any"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Check-in-circle — the "status" facet. */
function StatusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8.5 12 2.5 2.5 4.5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
/** Person — the "staff" facet. */
function StaffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Percent CHANGE, for counts and money. null when there is no base to compare to. */
function ratioDelta(now: number, before: number): number | null {
  if (!before) return null; // 0 → n has no meaningful percentage
  return Math.round(((now - before) / before) * 100);
}
/** Percentage-POINT difference, for rates. Comparing 85% to 80% is +5 points, not
 *  +6% — reporting it as a percent change would overstate the move. */
function pointDelta(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  return now - before;
}

/**
 * One headline metric: title, the window it covers, the number, and how it moved
 * against the preceding equivalent window. The delta is a real comparison (the page
 * queries the previous range) — never a decorative figure. `higherIsBetter` flips
 * the colour for metrics where up is bad, e.g. no-shows.
 */
function Kpi({
  label,
  caption,
  value,
  delta,
  vs,
  unit,
  higherIsBetter = true,
}: {
  label: string;
  caption: string;
  value: string;
  delta: number | null;
  vs: string;
  /** "%" for counts/money (percent change), "pp" for rates (point difference). */
  unit: "%" | "pp";
  higherIsBetter?: boolean;
}) {
  const good = delta === null || delta === 0 ? null : higherIsBetter ? delta > 0 : delta < 0;
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-faint">{caption}</p>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="u-mono text-2xl font-medium leading-none text-foreground">{value}</span>
        {delta !== null ? (
          <>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium ${
                good === null
                  ? "bg-chip text-muted"
                  : good
                    ? "bg-success/12 text-success"
                    : "bg-brand-soft text-brand"
              }`}
            >
              {delta > 0 ? "+" : ""}
              {delta}
              {unit}
            </span>
            <span className="text-xs text-faint">{vs}</span>
          </>
        ) : (
          <span className="text-xs text-faintest">no prior data</span>
        )}
      </div>
    </div>
  );
}

/**
 * The staff disc. `on="card"` makes it ride an appointment card, where it takes
 * the CARD's family tones (a light puck with the family's saturated letter)
 * instead of the global purple — so the avatar belongs to its card rather than
 * punching a purple hole in every tint.
 */
function Initial({ name, muted, on }: { name: string | null; muted?: boolean; on?: "card" }) {
  const ch = (name?.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
        on === "card"
          ? "u-appt-avatar size-[1.125rem] text-[0.625rem]"
          : `size-4 text-[0.5625rem] text-white ${muted ? "bg-closed-fg" : "bg-service-purple"}`
      }`}
    >
      {ch}
    </span>
  );
}

/**
 * One appointment, painted by CATEGORY (see lib/agendaCategory.ts): a soft family
 * FILL, a 3px saturated LEFT RULE of the same family, and the service line in that
 * family's ink — a tinted block, not a white box with a stripe. State outranks
 * service: unconfirmed is the one outline card, an overlap/no-show goes red, a
 * cancelled one greys out and strikes through. Never colour alone — every state
 * also spells itself out in the meta line.
 */
function ApptCard({
  appt,
  tz,
  top,
  height,
  overlapping,
  selected,
  onOpen,
}: {
  appt: Appt;
  tz: string;
  top: number;
  height: number;
  overlapping: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const unconfirmed = appt.status === "scheduled";
  const cancelled = appt.status === "cancelled";
  const category: ApptCategory = apptCategory(appt, { attention: overlapping });
  const unassigned = category === "unassigned";
  /** Everything the card says about its STATE, in words — never colour alone. */
  const state =
    (unassigned ? " · no staff assigned" : "") +
    (unconfirmed ? " · unconfirmed" : "") +
    // `completed` no longer owns a colour (the family does), so it says so here —
    // otherwise a done appointment would be indistinguishable.
    (appt.status === "completed" ? " · completed" : "") +
    (overlapping ? " · overlap" : "") +
    (appt.status === "no_show" ? " · no show" : "") +
    (cancelled ? " · cancelled" : "");
  /** A SHORT booking (≈30 min) has room for two lines, not three. Rather than
   *  crop the third mid-glyph, it drops the service line and folds the state onto
   *  the time — the grid already says when it is, and the drawer has the rest. */
  const compact = height < 40;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${fmtTime(appt.start_at, tz)} ${appt.contact_name ?? "Walk-in"} — ${appt.service_name}`}
      // leading-tight is load-bearing: at the default line-height the three lines
      // don't fit a 45-minute card and the service name gets cropped in half.
      className={`u-appt ${apptCategoryClass(category)} absolute inset-x-1 overflow-hidden px-1.5 text-left leading-tight ${
        compact ? "py-0.5" : "py-1"
      } ${selected ? "ring-2 ring-service-purple" : ""}`}
      style={{ top, height }}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="u-appt-ink u-mono truncate text-[0.5625rem]">
          {fmtTime(appt.start_at, tz)} — {fmtTime(appt.service_end_at, tz)}
          {compact ? state : ""}
        </span>
        {unassigned ? (
          // Nobody is on this walk-in: a red "?" disc where the barber would be.
          <span
            aria-hidden
            className="flex size-[1.125rem] shrink-0 items-center justify-center rounded-full bg-brand text-[0.625rem] font-semibold text-white"
          >
            ?
          </span>
        ) : (
          <Initial name={appt.staff_name} on="card" />
        )}
      </span>
      <span className={`block truncate text-[0.6875rem] font-semibold ${cancelled ? "line-through" : ""}`}>
        {appt.contact_name ?? "Walk-in"}
      </span>
      {compact ? null : (
        <span className="u-appt-ink block truncate text-[0.625rem]">
          {appt.service_name}
          {state}
        </span>
      )}
    </button>
  );
}

/**
 * The detail DRAWER — a side panel, never a modal, so the grid stays readable while
 * you act. Only the real lifecycle actions are offered (confirm / complete / no-show /
 * cancel / reschedule); see the TODOs on AgendaView for what the design showed that
 * has no server action behind it.
 */
function ApptDrawer({
  appt,
  tz,
  pending,
  contactsBase,
  inboxBase,
  fromQS,
  onClose,
  onReschedule,
  onConfirm,
  onComplete,
  onNoShow,
  onCancel,
}: {
  appt: Appt;
  tz: string;
  pending: boolean;
  contactsBase: string | null;
  inboxBase: string | null;
  fromQS: string;
  onClose: () => void;
  onReschedule: () => void;
  onConfirm: () => void;
  onComplete: () => void;
  onNoShow: () => void;
  onCancel: () => void;
}) {
  const live = appt.status === "scheduled" || appt.status === "confirmed";
  return (
    <aside
      aria-label="Appointment details"
      className="hidden w-[19rem] shrink-0 flex-col overflow-hidden border-l border-line xl:flex 2xl:w-[21rem]"
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 bg-service-purple px-3">
        <span className="truncate text-xs font-semibold text-white">{STATUS_TITLE[appt.status] ?? appt.status}</span>
        <button type="button" onClick={onClose} aria-label="Close details" className="u-tap text-white/80 hover:text-white">
          &#10005;
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-chip text-xs font-semibold text-foreground"
          >
            {(appt.contact_name?.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{appt.contact_name ?? "Walk-in"}</p>
            {/* The canonical IDENTITY (phone or email) — never the internal
                appointment UUID. Absent identity renders nothing at all. */}
            {appt.primary_identity ? (
              <p className="u-mono truncate text-[0.625rem] text-faint">{appt.primary_identity}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-3 border-t border-line pt-3">
          <p className="u-mono text-sm font-semibold text-foreground">
            {fmtTime(appt.start_at, tz)} &rarr; {fmtTime(appt.service_end_at, tz)}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span className="u-mono">{appt.duration_min} min</span>
            {appt.staff_name ? (
              <>
                <span aria-hidden className="text-faintest">&middot;</span>
                <Initial name={appt.staff_name} />
                <span className="truncate">{appt.staff_name}</span>
              </>
            ) : null}
            {live ? (
              <button
                type="button"
                onClick={onReschedule}
                disabled={pending}
                className="ml-auto text-brand hover:underline disabled:opacity-50"
              >
                Reschedule
              </button>
            ) : null}
          </p>
        </div>

        {live ? (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            {appt.status === "scheduled" ? (
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                Confirm
              </button>
            ) : null}
            <button
              type="button"
              onClick={onComplete}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover disabled:opacity-50"
            >
              Mark as completed
            </button>
            <button
              type="button"
              onClick={onNoShow}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover disabled:opacity-50"
            >
              No show
            </button>
          </div>
        ) : null}

        {/* SERVICES — the model stores exactly ONE service per appointment, with its
            price snapshotted at booking time. The design's multi-service list is not
            representable (see TODO on AgendaView). */}
        <div className="mt-3 border-t border-line pt-3">
          <p className="u-th">Service</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-service-purple" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{appt.service_name}</p>
              <p className="u-mono text-[0.625rem] text-faint">
                {appt.duration_min} min{appt.staff_name ? ` · ${appt.staff_name}` : ""}
              </p>
            </div>
            {formatMoneyCOP(appt.price) ? (
              <span className="u-mono shrink-0 text-sm text-foreground">{formatMoneyCOP(appt.price)}</span>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
          {appt.contact_id && contactsBase ? (
            <Link
              href={`${contactsBase}/${appt.contact_id}${fromQS}`}
              className="inline-flex h-9 items-center justify-center rounded-md bg-brand text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Open contact &#8599;
            </Link>
          ) : null}
          {appt.source_conversation_id && inboxBase ? (
            <Link
              href={`${inboxBase}?c=${encodeURIComponent(appt.source_conversation_id)}`}
              className="inline-flex h-9 items-center justify-center rounded-md border border-line-strong text-sm transition-colors hover:bg-hover"
            >
              View conversation
            </Link>
          ) : null}
          {live ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="inline-flex h-9 items-center justify-center rounded-md text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              Cancel appointment&hellip;
            </button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

/** Modal for new appointment / walk-in / reschedule — fetches real availability. */
function AppointmentModal(props: {
  clientId: string;
  timezone: string;
  currentSiteId: string;
  dayStartIso: string;
  dayEndIso: string;
  staff: StaffOpt[];
  services: ServiceOpt[];
  modal: ModalState;
  onClose: () => void;
  onError: (e: string | null) => void;
  onDone: () => void;
}) {
  const isReschedule = props.modal.mode === "reschedule";
  // Booking for an existing contact (deep-link): lock identity, submit its id.
  const bookingContact = props.modal.mode !== "reschedule" ? props.modal.contact ?? null : null;
  const [serviceId, setServiceId] = useState(props.services[0]?.id ?? "");
  const [staffId, setStaffId] = useState<string>("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotStart, setSlotStart] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();

  const loadSlots = async () => {
    // Reschedule keeps the appointment's own service; "new"/"walk-in" uses the picked one.
    const effectiveServiceId = props.modal.mode === "reschedule" ? props.modal.appt.service_id : serviceId;
    if (!effectiveServiceId) return;
    props.onError(null);
    setLoadingSlots(true);
    setSlots([]);
    setSlotStart("");
    try {
      const params = new URLSearchParams({
        client_id: props.clientId, // the endpoint re-validates module + site↔client
        site_id: props.currentSiteId,
        service_id: effectiveServiceId,
        from: props.dayStartIso,
        to: props.dayEndIso,
      });
      if (staffId) params.set("staff_id", staffId);
      const res = await fetch(`/api/scheduling/internal/availability?${params.toString()}`);
      if (!res.ok) {
        props.onError("Could not load availability.");
        return;
      }
      const data = (await res.json()) as { slots: Slot[] };
      setSlots(data.slots);
    } finally {
      setLoadingSlots(false);
    }
  };

  const submit = () => {
    if (!slotStart) {
      props.onError("Pick a time slot.");
      return;
    }
    props.onError(null);
    startTransition(async () => {
      if (isReschedule) {
        const r = await rescheduleAppointmentAction(
          props.clientId,
          props.modal.mode === "reschedule" ? props.modal.appt.id : "",
          slotStart,
          staffId || null,
        );
        if (!r.ok) return props.onError(r.error);
      } else {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.currentSiteId,
          serviceId,
          staffId: staffId || null,
          startAt: slotStart,
          // Booking for a contact → attach by id (no typed identity). Otherwise the
          // free-text identity path (manual / walk-in) is unchanged.
          ...(bookingContact
            ? { contactId: bookingContact.contactId }
            : {
                customerName: name || undefined,
                customerPhone: phone || undefined,
                customerEmail: email || undefined,
              }),
          walkIn: props.modal.mode === "walkin",
        });
        if (!r.ok) return props.onError(r.error);
      }
      props.onDone();
    });
  };

  const title = isReschedule
    ? "Reschedule appointment"
    : props.modal.mode === "walkin"
      ? "Register walk-in"
      : bookingContact
        ? "Book appointment"
        : "New appointment";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={props.onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-line bg-popover p-5 text-popover-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-4 flex flex-col gap-3 text-sm">
          {!isReschedule ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Service</span>
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5">
                {props.services.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.duration_min}m)</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Barber</span>
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5">
              <option value="">Any</option>
              {/* NEW bookings offer ACTIVE staff only — an inactive barber's lane is visible
                  for history but must not be selectable for a new appointment. */}
              {props.staff.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </label>
          <button onClick={loadSlots} disabled={loadingSlots || (!isReschedule && !serviceId)} className="self-start rounded-lg border border-line px-3 py-1.5 hover:bg-subtle disabled:opacity-50">
            {loadingSlots ? "Loading…" : "Find times"}
          </button>
          {slots.length > 0 ? (
            <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {slots.map((s) => (
                <button
                  key={`${s.start_at}-${s.staff_id}`}
                  onClick={() => {
                    setSlotStart(s.start_at);
                    if (!staffId) setStaffId(s.staff_id);
                  }}
                  className={`rounded border px-2 py-1 text-xs ${slotStart === s.start_at ? "border-accent bg-accent/10 text-accent" : "border-line hover:bg-subtle"}`}
                >
                  {fmtTime(s.start_at, props.timezone)}
                </button>
              ))}
            </div>
          ) : null}
          {!isReschedule && bookingContact ? (
            // Booking for an existing contact — identity is LOCKED to the record, never typed.
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted">Customer</span>
              <div className="rounded-lg border border-line bg-subtle px-2 py-1.5">{bookingContact.contactName}</div>
            </div>
          ) : !isReschedule ? (
            <>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (E.164, e.g. +57300…)" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5" />
            </>
          ) : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={props.onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle">Cancel</button>
          <button onClick={submit} disabled={pending || !slotStart} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {pending ? "Saving…" : isReschedule ? "Reschedule" : "Book"}
          </button>
        </div>
      </div>
    </div>
  );
}
