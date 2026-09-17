"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type RefObject } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PageShell } from "@/components/ui/PageShell";
import { PageHeading } from "@/components/ui/PageTitle";
import { CONTROL_CLS, MODULE_SEARCH_CLS, OUTLINE_CLS } from "@/components/ui/primitives";
import { OVERLAY_SCRIM, useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { apptCategory } from "@/lib/agendaCategory";
import { priceLabelCOP } from "@/lib/money";
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
  /** `services.category` — the stored colour family, NULL when unset (see
   *  lib/agendaCategory.ts, which then falls back to the service name). */
  service_category: string | null;
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

/**
 * The reference calendar gives each PROFESSIONAL a quiet, persistent pastel —
 * service and lifecycle state do not repaint the whole block. Keep the class
 * names explicit (rather than building them dynamically) so CSS and production
 * builds always see the complete palette. The roster assigns the palette in order:
 * unlike a hash, that guarantees the first five visible professionals do not collide.
 */
const STAFF_APPT_TONES = [
  "u-appt-staff-slate",
  "u-appt-staff-lilac",
  "u-appt-staff-sage",
  "u-appt-staff-sand",
  "u-appt-staff-blue",
] as const;

type StaffTone = (typeof STAFF_APPT_TONES)[number];

function appointmentToneClass(appt: Appt, staffTones: ReadonlyMap<string, StaffTone>): string {
  if (!appt.staff_name) return "u-appt-unassigned";
  return `u-appt-staff ${staffTones.get(appt.staff_id) ?? STAFF_APPT_TONES[0]}`;
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
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "Inasistencia",
};
/** Drawer header copy, mirroring the design's "Appointment confirmed". */
const STATUS_TITLE: Record<string, string> = {
  scheduled: "Cita sin confirmar",
  confirmed: "Cita confirmada",
  completed: "Cita completada",
  cancelled: "Cita cancelada",
  no_show: "Marcada como inasistencia",
};

// Spanish date vocabulary, spelled out here rather than pulled from Intl("es") for
// two reasons: it is DETERMINISTIC (no "sept."/"sep" locale-data drift between the
// browser and the build), and every abbreviation is exactly three characters, which
// is what keeps the date label a stable width so the steppers beside it never slide.
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const ES_WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const ES_WEEKDAYS_UPPER = ["DOM", "LUN", "MAR", "MIÉ", "JUE", "VIE", "SÁB"];

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
/** 24-hour wall-clock in the SITE's timezone, e.g. "09:00", "15:05" — never AM/PM. */
function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
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
const clockMinutes = (clock: string) => {
  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
};
/** YYYY-MM-DD arithmetic that never touches the local timezone. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Local midnight for a YYYY-MM-DD in an IANA timezone, returned as a UTC ISO.
 * Two passes cover DST boundaries without making this client component depend on
 * the worker package. */
function siteMidnightIso(dayKey: string, timeZone: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant;
  };
  const first = naive - offsetAt(naive);
  return new Date(naive - offsetAt(first)).toISOString();
}

function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** YYYY-MM-DD for an instant as seen at the scheduling site. Availability is
 * returned as UTC instants, while every calendar bucket is a site-local day. */
function siteDayKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function todayAtSite(timeZone: string): string {
  return siteDayKey(new Date().toISOString(), timeZone);
}

function calendarDays(monthKey: string): Array<{ key: string; day: number; inMonth: boolean }> {
  const first = `${monthKey}-01`;
  const [year, month] = monthKey.split("-").map(Number);
  const sundayIndex = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const mondayOffset = (sundayIndex + 6) % 7;
  const start = addDays(first, -mondayOffset);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cellCount = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  return Array.from({ length: cellCount }, (_, index) => {
    const key = addDays(start, index);
    return { key, day: Number(key.slice(8, 10)), inMonth: key.startsWith(monthKey) };
  });
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

interface WeekLane {
  lane: number;
  laneCount: number;
}

interface WeekOverflow {
  key: string;
  startAt: string;
  appointments: Appt[];
}

interface WeekLayout {
  lanes: Map<string, WeekLane>;
  overflow: WeekOverflow[];
}

/**
 * Split appointments that collide inside ONE day into horizontal lanes. The old
 * weekly grid positioned every card at inset-x-1, so simultaneous bookings painted
 * directly on top of each other. Connected overlap clusters share a lane count;
 * appointments that merely touch (one ends exactly when the next starts) do not.
 */
function layoutWeekAppointments(appointments: Appt[]): WeekLayout {
  const sorted = [...appointments].sort(
    (a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || Date.parse(a.service_end_at) - Date.parse(b.service_end_at),
  );
  const lanes = new Map<string, WeekLane>();
  const overflow: WeekOverflow[] = [];
  let cluster: Appt[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const assignments: Array<{ appt: Appt; lane: number }> = [];
    for (const appt of cluster) {
      const start = Date.parse(appt.start_at);
      const end = Date.parse(appt.service_end_at);
      let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = end;
      assignments.push({ appt, lane });
    }
    const visibleLaneCount = Math.min(2, laneEnds.length);
    const hiddenByStart = new Map<string, Appt[]>();
    for (const assignment of assignments) {
      if (assignment.lane < 2) {
        lanes.set(assignment.appt.id, { lane: assignment.lane, laneCount: visibleLaneCount });
        continue;
      }
      const hidden = hiddenByStart.get(assignment.appt.start_at) ?? [];
      hidden.push(assignment.appt);
      hiddenByStart.set(assignment.appt.start_at, hidden);
    }
    for (const [startAt, hidden] of hiddenByStart) {
      overflow.push({
        key: hidden.map((appt) => appt.id).join(":"),
        startAt,
        appointments: hidden,
      });
    }
    cluster = [];
    clusterEnd = Number.NEGATIVE_INFINITY;
  };

  for (const appt of sorted) {
    const start = Date.parse(appt.start_at);
    const end = Date.parse(appt.service_end_at);
    if (cluster.length > 0 && start >= clusterEnd) flush();
    cluster.push(appt);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();
  return { lanes, overflow };
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
 * TODO(agenda): Month and Staff views are not implemented -- the toggle now OMITS them
 *   entirely rather than showing a permanently-disabled control that promises a view the
 *   product can't deliver. Restore the option here once a real month grid exists.
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
  /** Owner/admin/reception/legacy member. Staff schedule logins are read-only. */
  canOperate: boolean;
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
  /** Appointments intentionally collapsed behind a weekly "+N más" indicator. */
  const [weekOverflow, setWeekOverflow] = useState<Appt[] | null>(null);
  /** Client-side facets over the ALREADY loaded range. */
  const [statusFilter, setStatusFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  // Day view opens in the staff-column layout: it is the fastest way for reception
  // to see each professional's availability. The compact row list remains one click away.
  const [desktopLayout, setDesktopLayout] = useState<"rows" | "columns">("columns");
  const searchRef = useRef<HTMLInputElement>(null);
  const staffTones = useMemo(
    () => new Map<string, StaffTone>(props.staff.map((staff, index) => [staff.id, STAFF_APPT_TONES[index % STAFF_APPT_TONES.length]])),
    [props.staff],
  );

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
    if (!props.canOperate) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "a") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (modal || weekOverflow) return;
      e.preventDefault();
      setModal({ mode: "new" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modal, props.canOperate, weekOverflow]);

  useEffect(() => {
    const onSearchKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onSearchKey);
    return () => document.removeEventListener("keydown", onSearchKey);
  }, []);

  // Escape closes the detail drawer. The OVERLAY variant (below xl) traps focus and
  // handles Escape itself in the capture phase (stopping it before it reaches here), so
  // this only ever fires for the INLINE desktop panel — where nothing else would close
  // it from the keyboard.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo completar la acción.");
      else router.refresh();
    });
  };

  // ── Derived, all from the loaded range ──────────────────────────────────────
  const visible = useMemo(
    () => {
      const query = searchQuery.trim().toLocaleLowerCase("es");
      return props.appointments.filter((a) => {
        if (statusFilter && a.status !== statusFilter) return false;
        if (staffFilter && a.staff_id !== staffFilter) return false;
        if (!query) return true;
        return [a.contact_name, a.primary_identity, a.service_name, a.staff_name, a.public_reference]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLocaleLowerCase("es").includes(query));
      });
    },
    [props.appointments, searchQuery, statusFilter, staffFilter],
  );
  const mobileRows = useMemo(
    () => [...visible].sort((a, b) => a.start_at.localeCompare(b.start_at)),
    [visible],
  );
  const mobileDayKeys = useMemo(
    () => Array.from(new Set(mobileRows.map((appt) => zonedParts(appt.start_at, tz).dayKey))),
    [mobileRows, tz],
  );
  const nextMobileAppointment = useMemo(() => {
    return mobileRows.find(
      (appt) => appt.status !== "cancelled" && appt.status !== "completed",
    ) ?? null;
  }, [mobileRows]);
  const mobileCompleted = mobileRows.filter((appt) => appt.status === "completed").length;
  const kpis = props.kpis;
  const prev = props.previousKpis;
  const rangeCaption = isWeek ? "Esta semana" : "Hoy";
  const vsCaption = isWeek ? "vs. semana anterior" : "vs. ayer";

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

  // Picking a barber in the "Todo el equipo" facet collapses the grid to that column —
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
          label: ES_WEEKDAYS_UPPER[wd],
          sub: closed ? "Cerrado" : `${n} cita${n === 1 ? "" : "s"}`,
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
          sub: closed ? "Cerrado" : undefined,
        };
      });

  const inColumn = (a: Appt, colKey: string) =>
    isWeek ? zonedParts(a.start_at, tz).dayKey === colKey : a.staff_id === colKey;

  let weeklyOccupancy: number | null = null;
  if (isWeek && hasAnyHours(props.openingHours)) {
    const capacityMinutes = shownStaff
      .filter((staff) => staff.active)
      .reduce((total, staff) => {
        const schedule = hasAnyHours(staff.workingHours) ? staff.workingHours : props.openingHours;
        return total + weekDays.reduce((dayTotal, dayKey) => {
          const ranges = schedule[weekdayKeyOf(dayKey)] ?? [];
          return dayTotal + ranges.reduce(
            (rangeTotal, range) => rangeTotal + Math.max(0, clockMinutes(range.end) - clockMinutes(range.start)),
            0,
          );
        }, 0);
      }, 0);
    const bookedMinutes = visible
      .filter((appt) => appt.status !== "cancelled")
      .reduce((total, appt) => total + appt.duration_min, 0);
    if (capacityMinutes > 0) weeklyOccupancy = Math.min(100, Math.round((bookedMinutes / capacityMinutes) * 100));
  }

  const selected = selectedId ? props.appointments.find((a) => a.id === selectedId) ?? null : null;
  /**
   * The date label — what window is open, in Spanish. It names the WEEK, not just the
   * month: "Sept 2026" never said which of the month's weeks you were looking at, so
   * the week view now reads "31 ago – 6 sep 2026" and the day view "sáb, 5 sep 2026".
   *
   * It is NAVIGATION TEXT, not a heading — the screen's one heading is "Agenda" (see the
   * title band). A STABLE width keeps the steppers from sliding on each step: the
   * three-character weekday/month abbreviations (ES_WEEKDAYS/ES_MONTHS) barely vary,
   * tabular figures make 1 and 30 the same width, and a per-view min-width on the block
   * (see the markup) absorbs the rest.
   */
  let dateMain: string;
  let yearLabel: string | null;
  if (isWeek && weekDays.length === 7) {
    const [ya, ma, da] = weekDays[0].split("-").map(Number);
    const [yb, mb, db] = weekDays[6].split("-").map(Number);
    if (ya === yb && ma === mb) {
      dateMain = `${da} – ${db} ${ES_MONTHS[mb - 1]}`;
      yearLabel = String(yb);
    } else if (ya === yb) {
      dateMain = `${da} ${ES_MONTHS[ma - 1]} – ${db} ${ES_MONTHS[mb - 1]}`;
      yearLabel = String(yb);
    } else {
      // A week that straddles New Year prints both years; the muted trailing one is
      // then already inside the label, so nothing is appended after it.
      dateMain = `${da} ${ES_MONTHS[ma - 1]} ${ya} – ${db} ${ES_MONTHS[mb - 1]} ${yb}`;
      yearLabel = null;
    }
  } else {
    const [y, m, d] = props.date.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    dateMain = `${ES_WEEKDAYS[wd]}, ${d} ${ES_MONTHS[m - 1]}`;
    yearLabel = String(y);
  }

  if (props.staff.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 flex-col gap-[var(--content-pad)]">
        <div className="rounded-lg border border-dashed border-line-strong bg-surface px-5 py-8">
          {props.canManage ? (
            <p className="text-sm text-muted">
              Aún no hay personal en esta sede.{" "}
              <Link href={`/clients/${props.clientId}/scheduling/admin`} className="text-accent hover:underline">
                Agregar personal
              </Link>
              .
            </p>
          ) : (
            // A member can't open the tenant-level Scheduling admin — message only.
            <p className="text-sm text-muted">Aún no hay personal en esta sede. Pide a tu administrador que lo agregue.</p>
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
      <PageShell surface="canvas" className="gap-3">
      {/* ── PAGE TITLE ── the same band Customers renders, now carrying the screen's
             two ACTIONS on its right. The Agenda used to spend a whole row on a title
             with nothing but empty space beside it, and a SECOND row whose only real
             weight was the two buttons pushed to the far edge — so the actions come up
             here where the title's white space already was, and the row below becomes
             purely the tools that STEER the calendar. */}
      {/* No hairline under the title / control bar / KPI strip: the top of the Agenda
          is ONE object (name it, steer it, read its numbers), and three rules across
          it chopped that into four slabs. The grid below still gets its own rule —
          that seam is real, it separates chrome from the canvas. */}
      <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]">
        <div className="px-4 pb-3 pt-4 md:px-[var(--panel-pad)] md:pb-0 md:pt-3 xl:p-[14px]">
          <div className="flex items-start justify-between gap-3 md:items-center xl:gap-[14px]">
            <div className="min-w-0 shrink-0 md:flex md:items-center md:gap-2">
              <p className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-faint">
                <span className="md:hidden">
                  {props.canOperate ? currentSite?.name ?? "Agenda" : `Mi agenda · ${currentSite?.name ?? ""}`}
                </span>
              </p>
              <div className="mt-0.5 [&_h1]:text-[1.55rem] [&_h1]:font-semibold [&_h1]:leading-tight [&_h1]:tracking-[-0.03em] md:mt-0 md:[&_h1]:text-[19px]">
                <PageHeading title="Agenda" />
              </div>
              <span className="hidden text-xs text-muted md:inline xl:hidden">
                {`${currentSite?.name ?? ""}${props.sites.length > 1 ? ` · ${props.sites.length} sedes` : " · 1 sede"}`}
              </span>
            </div>
            <label className={`relative hidden min-w-[14rem] flex-1 xl:flex ${MODULE_SEARCH_CLS}`}>
              <span className="sr-only">Buscar en la agenda</span>
              <svg aria-hidden viewBox="0 0 24 24" fill="none" className="pointer-events-none size-4 shrink-0 text-faint">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Buscar cliente, servicio o profesional…"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
              />
              <kbd className="u-mono pointer-events-none ml-auto shrink-0 rounded border border-line bg-surface px-1.5 py-0.5 text-[0.625rem] text-faint">
                ⌘F
              </kbd>
            </label>
            <button
              type="button"
              onClick={() => navigate({ date: zonedParts(new Date().toISOString(), tz).dayKey })}
              className="inline-flex h-9 shrink-0 items-center rounded-lg border border-line-strong bg-surface px-3 text-xs font-semibold text-foreground md:hidden"
            >
              Hoy
            </button>
            {props.canOperate ? (
              <div className="ml-auto hidden items-center gap-2 md:flex xl:hidden">
                <button type="button" onClick={() => setModal({ mode: "walkin" })} className={OUTLINE_CLS}>
                  Atención sin cita
                </button>
                <button
                  type="button"
                  onClick={() => setModal({ mode: "new" })}
                  className="inline-flex h-[var(--control-h)] shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-ink px-3.5 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover"
                >
                  Agendar cita
                  <kbd className="u-mono rounded bg-white/20 px-1 text-[0.625rem] font-normal">&#8984;A</kbd>
                </button>
              </div>
            ) : null}
            <div className="hidden shrink-0 items-center gap-2 xl:flex">
              <div className="flex h-[34px] items-center gap-0.5 rounded-[9px] bg-chip p-[3px]">
                <DesktopSeg active={!isWeek} onClick={() => navigate({ view: "day" })}>Día</DesktopSeg>
                <DesktopSeg active={isWeek} onClick={() => navigate({ view: "week" })}>Semana</DesktopSeg>
              </div>
              <div className="flex h-[34px] items-center rounded-[9px] border border-line bg-surface p-0.5">
                <DesktopStep label="Anterior" onClick={() => shiftDate(isWeek ? -7 : -1)} direction="left" />
                <button
                  type="button"
                  onClick={() => navigate({ date: zonedParts(new Date().toISOString(), tz).dayKey })}
                  className="h-7 min-w-[7.5rem] rounded-[7px] px-2 text-[12.5px] font-semibold tabular-nums text-foreground hover:bg-chip"
                >
                  {dateMain}{yearLabel ? <span className="ml-1 font-normal text-faint">{yearLabel}</span> : null}
                </button>
                <DesktopStep label="Siguiente" onClick={() => shiftDate(isWeek ? 7 : 1)} direction="right" />
              </div>
              <details className="group relative">
                <summary
                  aria-label="Filtrar agenda"
                  title="Filtros de profesional y estado"
                  className="relative flex size-[34px] cursor-pointer list-none items-center justify-center rounded-[9px] border border-line bg-surface text-muted transition hover:bg-chip hover:text-foreground [&::-webkit-details-marker]:hidden"
                >
                  <svg aria-hidden viewBox="0 0 16 16" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
                  </svg>
                  <span className="u-mono absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-foreground px-1 text-[9px] font-semibold text-surface">
                    {props.staff.filter((staff) => staff.active).length}
                  </span>
                </summary>
                <div className="absolute right-0 top-10 z-40 w-64 rounded-xl border border-line bg-surface p-3 shadow-[var(--shadow-card)]">
                  <label className="block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-faint">
                    Profesional
                    <select
                      value={staffFilter}
                      onChange={(event) => setStaffFilter(event.target.value)}
                      className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm normal-case tracking-normal text-foreground"
                    >
                      <option value="">Todo el equipo</option>
                      {props.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}</option>)}
                    </select>
                  </label>
                  <label className="mt-3 block text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-faint">
                    Estado
                    <select
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value)}
                      className="mt-1.5 h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-sm normal-case tracking-normal text-foreground"
                    >
                      <option value="">Todos los estados</option>
                      {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
                    </select>
                  </label>
                </div>
              </details>
              {props.canOperate ? (
                <button
                  type="button"
                  onClick={() => setModal({ mode: "new" })}
                  className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-[9px] bg-ink px-[14px] text-[13px] font-semibold text-ink-fg transition-colors hover:bg-ink-hover"
                >
                  <span aria-hidden className="text-[15px] font-normal">＋</span>
                  Nueva cita
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-[2.5rem_1fr_2.5rem] items-center rounded-xl bg-chip p-1 md:hidden">
            <button
              type="button"
              aria-label="Día anterior"
              onClick={() => shiftDate(isWeek ? -7 : -1)}
              className="flex size-10 items-center justify-center rounded-lg text-xl text-muted active:bg-surface"
            >
              &lsaquo;
            </button>
            <div className="min-w-0 text-center">
              <p className="truncate text-sm font-semibold capitalize text-foreground">{dateMain}</p>
              {yearLabel ? <p className="u-mono text-[0.625rem] text-faint">{yearLabel}</p> : null}
            </div>
            <button
              type="button"
              aria-label="Día siguiente"
              onClick={() => shiftDate(isWeek ? 7 : 1)}
              className="flex size-10 items-center justify-center rounded-lg text-xl text-muted active:bg-surface"
            >
              &rsaquo;
            </button>
          </div>

          <label className="relative mt-3 block md:hidden">
            <span className="sr-only">Buscar en la agenda</span>
            <svg aria-hidden viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Buscar cliente, servicio o profesional…"
              className="h-10 w-full rounded-xl border border-line bg-chip pl-9 pr-3 text-sm text-foreground outline-none focus:border-line-strong focus:bg-chip"
            />
          </label>

          <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-0.5 md:hidden">
            <div className="flex h-8 shrink-0 items-center rounded-lg bg-chip p-0.5">
              <Seg active={!isWeek} onClick={() => navigate({ view: "day" })}>Día</Seg>
              <Seg active={isWeek} onClick={() => navigate({ view: "week" })}>Semana</Seg>
            </div>
            {props.canOperate ? (
              <>
                <label className="sr-only" htmlFor="mobile-agenda-status">Estado</label>
                <select
                  id="mobile-agenda-status"
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="h-8 min-w-[7.25rem] shrink-0 rounded-lg border border-line bg-surface px-2 text-xs text-foreground"
                >
                  <option value="">Todos los estados</option>
                  {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
                </select>
                {props.staff.length > 1 ? (
                  <>
                    <label className="sr-only" htmlFor="mobile-agenda-staff">Profesional</label>
                    <select
                      id="mobile-agenda-staff"
                      value={staffFilter}
                      onChange={(event) => setStaffFilter(event.target.value)}
                      className="h-8 min-w-[7.25rem] shrink-0 rounded-lg border border-line bg-surface px-2 text-xs text-foreground"
                    >
                      <option value="">Todo el equipo</option>
                      {props.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.name}</option>)}
                    </select>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-11 items-center gap-3 border-t border-line bg-surface px-4 py-2 md:hidden">
          <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
            <strong className="u-mono text-xs font-semibold text-foreground">{mobileRows.length}</strong>
            <span className="text-xs text-muted">{mobileRows.length === 1 ? "cita" : "citas"}</span>
          </span>
          <span aria-hidden className="h-4 w-px bg-line" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {mobileCompleted} completadas
          </span>
          <span className="min-w-0 shrink truncate text-right text-xs text-muted">
            <span className="text-faint">Próxima </span>
            <strong className="u-mono font-semibold text-foreground">
              {nextMobileAppointment ? fmtTime(nextMobileAppointment.start_at, tz) : "—"}
            </strong>
          </span>
        </div>

        {props.canOperate ? (
          <div className="grid grid-cols-2 gap-2 border-t border-line px-4 py-3 md:hidden">
            <button type="button" onClick={() => setModal({ mode: "walkin" })} className={OUTLINE_CLS}>
              Sin cita
            </button>
            <button
              type="button"
              onClick={() => setModal({ mode: "new" })}
              className="inline-flex h-[var(--control-h)] items-center justify-center rounded-lg bg-ink px-3 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover"
            >
              Agendar cita
            </button>
          </div>
        ) : null}
      </div>

      {/* ── CONTROL BAR ── the tools that steer the calendar: where you are (date +
             steppers), what you see (Día/Semana), and the two facets. It wraps as one
             deliberate second band on intermediate widths rather than compressing. */}
      <div className="hidden flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-[var(--panel-pad)] py-2.5 shadow-[var(--shadow-card)] md:flex xl:hidden">
        <label className="relative order-first w-full lg:w-auto lg:min-w-[17rem] lg:flex-1">
          <span className="sr-only">Buscar en la agenda</span>
          <svg aria-hidden viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint">
            <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Buscar cliente, servicio o profesional…"
            className="h-[var(--control-h)] w-full rounded-lg border border-line bg-chip pl-9 pr-3 text-sm text-foreground outline-none focus:border-line-strong focus:bg-chip"
          />
        </label>
        <button
          type="button"
          onClick={() => navigate({ date: zonedParts(new Date().toISOString(), tz).dayKey })}
          className={CONTROL_CLS}
        >
          Hoy
        </button>
        {/* Hoy → DATE → steppers. The steppers sit after the label because it has a
            RESERVED width (per view), so a day-step never drags them sideways. */}
        <div
          className={`ml-1 text-sm font-semibold tracking-tight tabular-nums text-foreground ${
            isWeek ? "min-w-[10rem]" : "min-w-[8.5rem]"
          }`}
        >
          <span>{dateMain}</span>
          {yearLabel ? <span className="ml-1 font-normal text-faint">{yearLabel}</span> : null}
        </div>
        <div className="flex items-center gap-1">
          <IconBtn label="Anterior" onClick={() => shiftDate(isWeek ? -7 : -1)}>&lsaquo;</IconBtn>
          <IconBtn label="Siguiente" onClick={() => shiftDate(isWeek ? 7 : 1)}>&rsaquo;</IconBtn>
        </div>

        {/* Hairline separator, as in the reference — it also visually pins the start
            of the view controls so the eye has a fixed edge to return to. */}
        <span aria-hidden className="mx-1 hidden h-5 w-px bg-line sm:block" />

        {/* Segmented view toggle: a recessed grey track (control height, 11px radius)
            with a RAISED WHITE pill (9px) on the active item — the pill reads as
            "lifted out" of the track, which is why it needs no drop shadow (a hairline
            does the same job). Month is NOT offered — see the TODO above; a permanently
            disabled control only promises something the product can't do. */}
        <div className="ml-1 flex h-[var(--control-h)] items-center gap-0.5 rounded-lg bg-chip p-1">
          <Seg active={!isWeek} onClick={() => navigate({ view: "day" })}>Día</Seg>
          <Seg active={isWeek} onClick={() => navigate({ view: "week" })}>Semana</Seg>
        </div>

        <Facet
          icon={<StatusIcon />}
          label="Todos los estados"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[{ value: "", label: "Todos los estados" }, ...STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
        <Facet
          icon={<StaffIcon />}
          label="Todo el equipo"
          value={staffFilter}
          onChange={setStaffFilter}
          options={[{ value: "", label: "Todo el equipo" }, ...props.staff.map((s) => ({ value: s.id, label: s.name }))]}
        />
        {props.sites.length > 1 ? (
          <Facet
            label="Sede"
            value={props.currentSiteId}
            onChange={(v) => navigate({ site: v })}
            options={props.sites.map((s) => ({ value: s.id, label: s.name }))}
          />
        ) : null}

        {/* The refresh indicator is secondary chrome, not an action — it rides the far
            end of the tool row, well clear of the red "Agendar cita" above it. */}
        <div className="ml-auto flex items-center">
          <AutoRefresh intervalSeconds={20} />
        </div>
      </div>

      {error ? (
        <p role="alert" className="border-b border-line bg-danger/10 px-[var(--panel-pad)] py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {/* ── KPI STRIP — three REAL metrics over the loaded range. The design's
             "Avg waitlist time" card and the "vs last week" deltas are omitted
             (no waitlist model, no previous-period query).

             The four cards go in ONE row as soon as the content is ~1024px wide
             (grid-cols-2 lg:grid-cols-4), so on a 1159px screen they stop stacking
             2×2 and pushing the calendar — the page's real work — below the fold.
             Below that they fall back to 2×2. The vertical padding is deliberately
             tight for the same reason: give the grid the height. ── */}
      <div className="hidden">
        <Kpi
          label="Total de citas"
          unit="%"
          caption={rangeCaption}
          value={String(kpis.total)}
          delta={ratioDelta(kpis.total, prev.total)}
          vs={vsCaption}
        />
        <Kpi
          label="Citas completadas"
          unit="pp"
          caption={rangeCaption}
          value={kpis.completedPct === null ? "—" : `${kpis.completedPct}%`}
          delta={pointDelta(kpis.completedPct, prev.completedPct)}
          vs={vsCaption}
        />
        <Kpi
          label="Inasistencias"
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
          label="Ingresos reservados"
          unit="%"
          caption={`${rangeCaption} · sin canceladas`}
          value={priceLabelCOP(kpis.revenue) ?? "—"}
          delta={ratioDelta(kpis.revenue, prev.revenue)}
          vs={vsCaption}
        />
      </div>

      {/* ── CALENDAR GRID + DRAWER ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="hidden h-10 shrink-0 items-center gap-3 border-b border-line px-3.5 md:flex">
            <span className="u-mono text-xs font-semibold text-foreground">{visible.length}</span>
            <span className="text-xs text-muted">{visible.length === 1 ? "cita" : "citas"}</span>
            <div className="ml-2 flex min-w-0 items-center gap-3 overflow-hidden">
              {shownStaff.slice(0, 6).map((staff) => (
                <span key={staff.id} className="inline-flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-muted">
                  {isWeek ? (
                    <span
                      aria-hidden
                      className={`u-appt-swatch ${staffTones.get(staff.id) ?? STAFF_APPT_TONES[0]} size-3 rounded-[3px]`}
                    />
                  ) : (
                    <Initial name={staff.name} />
                  )}
                  <span className="max-w-24 truncate">{staff.name}</span>
                </span>
              ))}
            </div>
            <span className="ml-auto text-[0.6875rem] text-faint">
              {isWeek && weeklyOccupancy !== null ? `Ocupación semanal ${weeklyOccupancy}% · ` : ""}
              {overlapIds.size > 0 ? `${overlapIds.size} citas con solapamiento` : "Sin solapamientos"}
            </span>
            {!isWeek ? (
              <div className="hidden items-center rounded-lg border border-line p-0.5 xl:flex">
                <button
                  type="button"
                  onClick={() => setDesktopLayout("rows")}
                  aria-pressed={desktopLayout === "rows"}
                  aria-label="Agrupar por hora"
                  className={`flex size-7 items-center justify-center rounded-md ${desktopLayout === "rows" ? "bg-foreground text-surface" : "text-muted hover:bg-chip"}`}
                >
                  <RowsIcon />
                </button>
                <button
                  type="button"
                  onClick={() => setDesktopLayout("columns")}
                  aria-pressed={desktopLayout === "columns"}
                  aria-label="Una columna por profesional"
                  className={`flex size-7 items-center justify-center rounded-md ${desktopLayout === "columns" ? "bg-foreground text-surface" : "text-muted hover:bg-chip"}`}
                >
                  <ColumnsIcon />
                </button>
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-canvas px-3 pb-8 pt-3 md:hidden">
            {mobileRows.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
                <span aria-hidden className="mx-auto flex size-11 items-center justify-center rounded-xl bg-chip text-xl text-muted">✓</span>
                <p className="mt-3 text-sm font-semibold text-foreground">No hay citas en esta vista</p>
                <p className="mx-auto mt-1 max-w-[16rem] text-xs leading-relaxed text-muted">
                  Cuando se agende una cita aparecerá aquí en orden cronológico.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {mobileDayKeys.map((dayKey) => {
                  const [year, month, day] = dayKey.split("-").map(Number);
                  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
                  const dayAppointments = mobileRows.filter((appt) => zonedParts(appt.start_at, tz).dayKey === dayKey);
                  return (
                    <section key={dayKey} className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]">
                      <div className="flex items-center justify-between border-b border-line-row bg-card px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="u-mono flex size-8 items-center justify-center rounded-lg border border-line bg-chip text-xs font-semibold text-foreground">
                            {day}
                          </span>
                          <span>
                            <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
                              {ES_WEEKDAYS_UPPER[weekday]}
                            </h2>
                            <span className="block text-[0.625rem] capitalize text-muted">{ES_MONTHS[month - 1]} {year}</span>
                          </span>
                        </div>
                        <span className="u-mono rounded-md bg-chip px-2 py-1 text-[0.625rem] text-muted">
                          {dayAppointments.length} {dayAppointments.length === 1 ? "cita" : "citas"}
                        </span>
                      </div>
                      <div className="space-y-2 p-2.5">
                        {dayAppointments.map((appt) => {
                          const isNext = nextMobileAppointment?.id === appt.id;
                          return (
                            <MobileAppointmentCard
                              key={appt.id}
                              appt={appt}
                              toneClass={appointmentToneClass(appt, staffTones)}
                              timezone={tz}
                              attention={overlapIds.has(appt.id)}
                              next={isNext}
                              showStaff={props.canOperate}
                              onOpen={() => setSelectedId(appt.id)}
                            />
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
                <div className="flex items-center justify-center gap-2 py-2 text-[0.6875rem] text-faint">
                  <span className="size-1.5 rounded-full bg-success" />
                  Actualización automática cada 20 segundos
                </div>
              </div>
            )}
          </div>

          {/* TABLET — a touch-first board. It deliberately is neither the phone
              timeline stretched wide nor the dense desktop hour grid squeezed into
              an iPad. Cards keep a 44px+ target and use the same real appointment
              data/detail drawer as both neighbouring layouts. */}
          <div className="hidden min-h-0 flex-1 overflow-y-auto bg-canvas p-4 md:block xl:hidden">
            {mobileRows.length === 0 ? (
              <div className="flex min-h-[22rem] items-center justify-center rounded-2xl border border-dashed border-line-strong bg-surface">
                <div className="max-w-xs text-center">
                  <span aria-hidden className="mx-auto flex size-12 items-center justify-center rounded-xl bg-chip text-xl text-muted">✓</span>
                  <p className="mt-3 text-sm font-semibold text-foreground">No hay citas en esta vista</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted">Cambia la fecha, el estado o el profesional para consultar otro turno.</p>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                {mobileDayKeys.map((dayKey) => {
                  const [year, month, day] = dayKey.split("-").map(Number);
                  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
                  const dayAppointments = mobileRows.filter((appt) => zonedParts(appt.start_at, tz).dayKey === dayKey);
                  return (
                    <section key={dayKey} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(18,21,27,0.04)]">
                      <div className="flex items-center justify-between border-b border-line bg-canvas/50 px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="u-mono flex size-10 items-center justify-center rounded-xl bg-foreground text-sm font-semibold text-surface">{day}</span>
                          <span>
                            <h2 className="text-sm font-semibold text-foreground">{ES_WEEKDAYS_UPPER[weekday]}</h2>
                            <span className="text-xs capitalize text-muted">{ES_MONTHS[month - 1]} {year}</span>
                          </span>
                        </div>
                        <span className="u-mono rounded-full bg-chip px-2.5 py-1 text-[0.6875rem] text-muted">
                          {dayAppointments.length} {dayAppointments.length === 1 ? "cita" : "citas"}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 p-3">
                        {dayAppointments.map((appt) => {
                          const isNext = nextMobileAppointment?.id === appt.id;
                          return (
                            <MobileAppointmentCard
                              key={appt.id}
                              appt={appt}
                              toneClass={appointmentToneClass(appt, staffTones)}
                              timezone={tz}
                              attention={overlapIds.has(appt.id)}
                              next={isNext}
                              showStaff={props.canOperate}
                              roomy
                              onOpen={() => setSelectedId(appt.id)}
                            />
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
                <div className="flex items-center justify-center gap-2 py-1 text-[0.6875rem] text-faint">
                  <span className="size-1.5 rounded-full bg-success" />
                  Actualización automática cada 20 segundos
                </div>
              </div>
            )}
          </div>

          {!isWeek && desktopLayout === "rows" ? (
            <DesktopHourRows
              appointments={mobileRows}
              staffTones={staffTones}
              hours={hours}
              timezone={tz}
              overlapIds={overlapIds}
              canOperate={props.canOperate}
              onOpen={setSelectedId}
              onBook={() => setModal({ mode: "new" })}
            />
          ) : null}

          {isWeek || desktopLayout === "columns" ? (
          <div className="hidden min-h-0 flex-1 overflow-auto xl:block">
            {/* min-w-full (NOT min-w-max) is what lets the lanes BREATHE: the row is
                at least as wide as the viewport, the lanes divide it evenly, and
                only their own min-width can push the row past it — at which point
                this scroller takes over horizontally. */}
            <div className="flex min-w-full">
              {/* DAY keeps the time rail at the left, beside the professional lanes.
                  WEEK mirrors the reference and puts it on the right (below). */}
              {!isWeek ? (
              <div className="sticky left-0 z-20 w-14 shrink-0 border-r border-line bg-surface">
                <div className="flex h-12 items-end justify-center border-b border-line pb-1">
                  <span className="u-mono text-[0.625rem] text-faintest">{gmtLabel(tz)}</span>
                </div>
                <div className="relative" style={{ height: bodyHeight }}>
                  {hours.map((h) => (
                    <div key={h} className="absolute right-2 -translate-y-1/2" style={{ top: offsetTop(h * 60) }}>
                      <span className="u-mono text-[0.625rem] text-faint">
                        {/* `h` is already the site's LOCAL hour (see zonedParts/nowParts),
                            so it prints directly as 24-hour HH:00 — no Intl reshift into
                            the browser's zone, and no AM/PM to mix with the cards. */}
                        {`${String(h).padStart(2, "0")}:00`}
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
              ) : null}

              {/* Columns */}
              {columns.map((col) => {
                const columnAppointments = visible.filter((appt) => inColumn(appt, col.key));
                const weekLayout = isWeek ? layoutWeekAppointments(columnAppointments) : null;
                const renderedAppointments = weekLayout
                  ? columnAppointments.filter((appt) => weekLayout.lanes.has(appt.id))
                  : columnAppointments;
                return (
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
                    className={`sticky top-0 z-10 flex h-12 items-center border-b border-line px-2 ${
                      col.closed ? "bg-closed-bg" : col.isToday && isWeek ? "bg-chip/70" : "bg-surface"
                    } ${isWeek ? "justify-center" : "gap-2"}`}
                  >
                    {isWeek && col.dayNum ? (
                      <span className="flex min-w-0 flex-col items-center justify-center leading-none">
                        <span className={`text-[0.6875rem] font-medium capitalize ${col.closed ? "text-closed-fg" : "text-muted"}`}>
                          {col.label.toLocaleLowerCase("es")}
                        </span>
                        <span
                          className={`u-mono mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-sm font-semibold ${
                            col.isToday ? "bg-foreground text-surface" : col.closed ? "text-closed-fg" : "text-foreground"
                          }`}
                        >
                          {col.dayNum}
                        </span>
                        {col.sub ? (
                          <span className={`mt-0.5 truncate text-[0.5625rem] ${col.closed ? "text-closed-fg" : "text-faint"}`}>
                            {col.sub}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <>
                        {col.initial ? <Initial name={col.initial} muted={col.closed} /> : null}
                        <span className="flex min-w-0 flex-col leading-tight">
                          <span className={`truncate text-xs font-semibold ${col.closed ? "text-closed-fg" : "text-foreground"}`}>
                            {col.label}
                          </span>
                          {col.sub ? (
                            <span className={`truncate text-[0.625rem] ${col.closed ? "text-closed-fg" : "text-faint"}`}>
                              {col.sub}
                            </span>
                          ) : null}
                        </span>
                      </>
                    )}
                    {col.inactive ? (
                      <span
                        title="Este profesional está inactivo — sus citas existentes siguen visibles aquí, pero no puede recibir nuevas reservas. Reactívalo en la configuración de Agenda."
                        className="shrink-0 rounded-full border border-line-strong bg-chip px-1.5 py-0.5 text-[0.625rem] font-medium text-muted"
                      >
                        Inactivo
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
                    {renderedAppointments.map((a) => {
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
                            toneClass={appointmentToneClass(a, staffTones)}
                            tz={tz}
                            top={offsetTop(startMin)}
                            height={Math.max(22, ((endMin - startMin) / 60) * HOUR_PX - 2)}
                            week={isWeek}
                            weekLane={weekLayout?.lanes.get(a.id)}
                            overlapping={overlapIds.has(a.id)}
                            selected={a.id === selectedId}
                            onOpen={() => setSelectedId(a.id)}
                          />
                        );
                      })}
                    {weekLayout?.overflow.map((group) => {
                      const startMin = Math.min(
                        Math.max(minutesOf(zonedParts(group.startAt, tz)), fromHour * 60),
                        toHour * 60,
                      );
                      return (
                        <button
                          key={group.key}
                          type="button"
                          aria-label={`Ver ${group.appointments.length} cita${group.appointments.length === 1 ? "" : "s"} adicional${group.appointments.length === 1 ? "" : "es"} a las ${fmtTime(group.startAt, tz)}`}
                          onClick={() => setWeekOverflow(group.appointments)}
                          className="absolute right-1 z-20 inline-flex h-6 items-center rounded-full bg-foreground px-2 text-[0.625rem] font-semibold text-background shadow-sm transition hover:-translate-y-px hover:shadow-md"
                          style={{ top: offsetTop(startMin) + 3 }}
                        >
                          +{group.appointments.length} más
                        </button>
                      );
                    })}
                  </div>
                </div>
                );
              })}

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

              {isWeek ? (
                <div className="sticky right-0 z-20 w-14 shrink-0 border-l border-line bg-surface">
                  <div className="h-12 border-b border-line" />
                  <div className="relative" style={{ height: bodyHeight }}>
                    {hours.map((hour) => (
                      <div key={hour} className="absolute left-2 -translate-y-1/2" style={{ top: offsetTop(hour * 60) }}>
                        <span className="u-mono text-[0.625rem] text-faint">{`${String(hour).padStart(2, "0")}:00`}</span>
                      </div>
                    ))}
                    {nowVisible ? (
                      <div
                        aria-hidden
                        className="absolute left-0 -translate-x-full -translate-y-1/2 rounded-l bg-brand px-1.5 py-px"
                        style={{ top: offsetTop(minutesOf(nowParts)) }}
                      >
                        <span className="u-mono text-[0.5625rem] font-semibold text-white">
                          {String(nowParts.h).padStart(2, "0")}:{String(nowParts.m).padStart(2, "0")}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          ) : null}
        </section>

        {selected ? (
          <ApptDrawer
            appt={selected}
            tz={tz}
            pending={pending}
            contactsBase={props.contactsBase}
            inboxBase={props.inboxBase}
            fromQS={fromQS}
            canOperate={props.canOperate}
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

      {modal && props.canOperate ? (
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

      {weekOverflow ? (
        <WeekOverflowDialog
          appointments={weekOverflow}
          timezone={tz}
          staffTones={staffTones}
          overlapIds={overlapIds}
          onClose={() => setWeekOverflow(null)}
          onSelect={(appointmentId) => {
            setWeekOverflow(null);
            setSelectedId(appointmentId);
          }}
        />
      ) : null}
    </main>
  );
}

// ── Small presentational pieces ───────────────────────────────────────────────

function DesktopHourRows({
  appointments,
  staffTones,
  hours,
  timezone,
  overlapIds,
  canOperate,
  onOpen,
  onBook,
}: {
  appointments: Appt[];
  staffTones: ReadonlyMap<string, StaffTone>;
  hours: number[];
  timezone: string;
  overlapIds: Set<string>;
  canOperate: boolean;
  onOpen: (id: string) => void;
  onBook: () => void;
}) {
  return (
    <div className="hidden min-h-0 flex-1 overflow-y-auto bg-surface xl:block">
      {hours.map((hour) => {
        const inHour = appointments.filter((appt) => zonedParts(appt.start_at, timezone).h === hour);
        return (
          <div key={hour} className="grid min-h-[6.1rem] grid-cols-[minmax(0,1fr)_4.75rem] border-b border-line last:border-b-0">
            <div className="min-w-0 p-2.5">
              {inHour.length > 0 ? (
                <div className="grid h-full grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2">
                  {inHour.map((appt) => {
                    const overlapping = overlapIds.has(appt.id);
                    return (
                      <button
                        key={appt.id}
                        type="button"
                        onClick={() => onOpen(appt.id)}
                        className={`u-appt ${appointmentToneClass(appt, staffTones)} group flex min-h-[4.9rem] min-w-0 items-stretch overflow-hidden rounded-lg text-left transition hover:-translate-y-px hover:shadow-sm ${
                          appt.status === "cancelled" ? "opacity-75" : ""
                        }`}
                      >
                        <span className="flex min-w-0 flex-1 flex-col justify-center px-3 py-2.5">
                          <span className="flex items-center gap-2">
                            <Initial name={appt.staff_name} on="card" />
                            <span className="truncate text-sm font-semibold text-foreground">
                              {appt.contact_name ?? "Atención sin cita"}
                            </span>
                            <span className="u-mono ml-auto shrink-0 text-[0.6875rem] tabular-nums text-muted">
                              {fmtTime(appt.start_at, timezone)}
                            </span>
                          </span>
                          <span className="u-appt-ink mt-1 truncate text-xs">
                            {appt.service_name} · {appt.duration_min} min
                          </span>
                          <span className="mt-1 flex items-center gap-2">
                            <span className="truncate text-[0.6875rem] text-muted">{appt.staff_name ?? "Sin profesional"}</span>
                            <span className="ml-auto"><MobileStatus status={appt.status} attention={overlapping} /></span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : canOperate ? (
                <button
                  type="button"
                  onClick={onBook}
                  className="flex h-full min-h-[4.9rem] w-full items-center justify-center gap-2 rounded-lg border border-dashed border-line text-xs text-faint transition hover:border-line-strong hover:bg-canvas/50 hover:text-foreground"
                >
                  <span aria-hidden className="text-base">＋</span>
                  Agendar en esta hora
                </button>
              ) : (
                <div className="flex h-full min-h-[4.9rem] items-center px-3 text-xs text-faint">Sin citas en esta hora</div>
              )}
            </div>
            <div className="u-mono flex items-start justify-center border-l border-line pt-3 text-[0.6875rem] tabular-nums text-faint">
              {String(hour).padStart(2, "0")}:00
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RowsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 2.5v11M8 2.5v11M12 2.5v11" />
    </svg>
  );
}

/**
 * A weekly day never shrinks beyond two readable lanes. Extra simultaneous
 * appointments live here: the "+N más" marker opens this compact chooser and a
 * choice continues into the ordinary appointment drawer.
 */
function WeekOverflowDialog({
  appointments,
  timezone,
  staffTones,
  overlapIds,
  onClose,
  onSelect,
}: {
  appointments: Appt[];
  timezone: string;
  staffTones: ReadonlyMap<string, StaffTone>;
  overlapIds: Set<string>;
  onClose: () => void;
  onSelect: (appointmentId: string) => void;
}) {
  const panelRef = useTrappedPanel({ active: true, onClose });
  const start = appointments[0]?.start_at;
  const title = start ? `Más citas a las ${fmtTime(start, timezone)}` : "Más citas";

  return (
    <>
      <button type="button" aria-label="Cerrar lista de citas" className={OVERLAY_SCRIM} onClick={onClose} />
      <section
        ref={panelRef as RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="week-overflow-title"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(32rem,80vh)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 id="week-overflow-title" className="truncate text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {appointments.length} cita{appointments.length === 1 ? "" : "s"} adicional{appointments.length === 1 ? "" : "es"}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="u-tap text-muted hover:text-foreground">
            &#10005;
          </button>
        </header>
        <div className="min-h-0 space-y-2 overflow-y-auto p-3">
          {appointments.map((appt) => {
            const overlapping = overlapIds.has(appt.id);
            return (
              <button
                key={appt.id}
                type="button"
                onClick={() => onSelect(appt.id)}
                className={`u-appt ${appointmentToneClass(appt, staffTones)} flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:-translate-y-px hover:shadow-sm`}
              >
                <Initial name={appt.staff_name} on="card" />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-foreground">{appt.service_name}</strong>
                  <span className="block truncate text-xs text-muted">{appt.contact_name ?? "Atención sin cita"}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="u-mono block text-xs font-semibold text-foreground">{fmtTime(appt.start_at, timezone)}</span>
                  <span className="block text-[0.625rem] text-muted">
                    {overlapping ? "Revisar" : STATUS_LABEL[appt.status] ?? appt.status}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

/**
 * Phone and tablet deliberately share the desktop appointment grammar: the same
 * professional pastel, hairline, avatar, typography and lifecycle chip. Only the
 * density changes. That keeps a barber oriented when moving between a front-desk
 * tablet and their own phone instead of teaching them a second visual language.
 */
function MobileAppointmentCard({
  appt,
  toneClass,
  timezone,
  attention,
  next,
  showStaff,
  roomy = false,
  onOpen,
}: {
  appt: Appt;
  toneClass: string;
  timezone: string;
  attention: boolean;
  next: boolean;
  showStaff: boolean;
  roomy?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={next ? "step" : undefined}
      className={`u-appt ${toneClass} relative flex w-full items-stretch overflow-hidden rounded-lg text-left transition active:scale-[0.995] ${
        roomy ? "min-h-[6.75rem]" : "min-h-[5.75rem]"
      } ${next ? "ring-2 ring-brand/20" : ""} ${appt.status === "cancelled" ? "opacity-65" : ""}`}
    >
      <span className={`u-mono flex w-[4.4rem] shrink-0 flex-col border-r border-current/10 px-3 ${roomy ? "py-3.5" : "py-3"}`}>
        <strong className="text-sm font-semibold tabular-nums text-foreground">{fmtTime(appt.start_at, timezone)}</strong>
        <span className="mt-0.5 text-[0.625rem] tabular-nums text-muted">{fmtTime(appt.service_end_at, timezone)}</span>
        <span className="mt-auto text-[0.625rem] text-faint">{appt.duration_min} min</span>
      </span>

      <span className={`flex min-w-0 flex-1 flex-col ${roomy ? "px-3.5 py-3.5" : "px-3 py-3"}`}>
        <span className="flex min-w-0 items-center gap-2">
          <Initial name={appt.staff_name} on="card" />
          <strong className="min-w-0 flex-1 truncate text-[0.875rem] font-semibold text-foreground">
            {appt.contact_name ?? "Atención sin cita"}
          </strong>
          <span aria-hidden className="shrink-0 text-sm text-muted">›</span>
        </span>
        <span className="u-appt-ink mt-1 truncate text-xs">{appt.service_name}</span>
        <span className="mt-auto flex min-w-0 items-center gap-2 pt-2">
          {showStaff ? <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">{appt.staff_name ?? "Sin asignar"}</span> : <span className="flex-1" />}
          <MobileStatus status={appt.status} attention={attention} />
        </span>
        {next ? (
          <span className="mt-2 border-t border-current/10 pt-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-brand">
            Próxima cita
          </span>
        ) : null}
      </span>
    </button>
  );
}

function MobileStatus({ status, attention }: { status: string; attention: boolean }) {
  const label = attention ? "Revisar" : STATUS_LABEL[status] ?? status;
  const tone = attention
    ? "border-warn/30 bg-warn/10 text-warn"
    : status === "completed"
      ? "border-success/30 bg-success/10 text-success"
      : status === "cancelled" || status === "no_show"
        ? "border-danger/30 bg-danger/10 text-danger"
        : status === "confirmed"
          ? "border-success/25 bg-success/8 text-success"
          : "border-line bg-surface/70 text-muted";

  return (
    <span className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[0.625rem] font-semibold ${tone}`}>
      {label}
    </span>
  );
}

function DesktopSeg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-7 items-center rounded-[7px] px-3 text-[12.5px] font-medium transition-colors ${
        active ? "bg-foreground text-surface" : "text-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function DesktopStep({
  label,
  onClick,
  direction,
}: {
  label: string;
  onClick: () => void;
  direction: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-7 items-center justify-center rounded-[7px] text-muted transition-colors hover:bg-chip hover:text-foreground"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d={direction === "left" ? "M9.8 3.5 5.3 8l4.5 4.5" : "M6.2 3.5 10.7 8l-4.5 4.5"} />
      </svg>
    </button>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      // 38px tall to sit level with the toolbar controls, 36px wide so the interactive
      // target clears the 36×36 minimum on its own — no u-tap padding hack needed.
      className="inline-flex h-[var(--control-h)] w-9 items-center justify-center rounded-lg border border-line-strong text-lg leading-none text-muted transition-colors hover:bg-subtle hover:text-foreground"
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
      className={`rounded-md px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "bg-foreground font-semibold text-surface"
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
    <div className="relative inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle">
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
    <div className="rounded-lg border border-line px-3.5 py-2.5">
      <p className="text-sm font-semibold text-foreground">{label}</p>
      <p className="mt-0.5 text-xs text-faint">{caption}</p>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-2">
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
          <span className="text-xs text-faintest">sin datos anteriores</span>
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
 * One appointment, painted by PROFESSIONAL: each barber keeps a stable muted
 * pastel across dates and layouts. State never repaints the whole card; it is
 * written in the meta line (and in the larger layouts' status chip), so a no-show
 * or conflict remains legible without turning the board into a field of red.
 */
function ApptCard({
  appt,
  toneClass,
  tz,
  top,
  height,
  week = false,
  weekLane,
  overlapping,
  selected,
  onOpen,
}: {
  appt: Appt;
  toneClass: string;
  tz: string;
  top: number;
  height: number;
  week?: boolean;
  weekLane?: WeekLane;
  overlapping: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const unconfirmed = appt.status === "scheduled";
  const cancelled = appt.status === "cancelled";
  const category = apptCategory(appt, { attention: overlapping });
  const unassigned = category === "unassigned";
  /** Everything the card says about its STATE, in words — never colour alone. */
  const state =
    (unassigned ? " · sin profesional" : "") +
    (unconfirmed ? " · sin confirmar" : "") +
    // `completed` no longer owns a colour (the family does), so it says so here —
    // otherwise a done appointment would be indistinguishable.
    (appt.status === "completed" ? " · completada" : "") +
    (overlapping ? " · traslape" : "") +
    (appt.status === "no_show" ? " · inasistencia" : "") +
    (cancelled ? " · cancelada" : "");
  /** A SHORT booking has room for two lines, not three. Rather than crop the third
   *  mid-glyph, it drops the service line and folds the state onto the time — the grid
   *  already says when it is, and the drawer has the rest. The threshold rose with the
   *  larger, more legible type (time 10px / name 12px / service 11px): three of those
   *  lines only fit once the card is ~48px (≈50 min) tall. */
  const compact = height < 48;
  const weekCompact = height < 44;
  const lane = weekLane?.lane ?? 0;
  const laneCount = weekLane?.laneCount ?? 1;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${fmtTime(appt.start_at, tz)} ${appt.contact_name ?? "Sin cita"} — ${appt.service_name} — ${STATUS_LABEL[appt.status] ?? appt.status}${overlapping ? " — solapamiento" : ""}`}
      // leading-tight is load-bearing: at the default line-height the three lines
      // don't fit a short card and the service name gets cropped in half.
      className={`u-appt ${toneClass} absolute overflow-hidden px-1.5 text-left leading-tight ${
        compact ? "py-0.5" : "py-1"
      } ${selected ? "ring-2 ring-service-purple" : ""}`}
      style={{
        top,
        height,
        left: week ? `calc(${(lane / laneCount) * 100}% + 3px)` : "4px",
        width: week ? `calc(${100 / laneCount}% - 6px)` : "calc(100% - 8px)",
      }}
    >
      {week ? (
        <span className="flex h-full min-w-0 flex-col">
          <strong className={`block truncate text-[11px] font-semibold ${cancelled ? "line-through" : ""}`}>
            {appt.service_name}
          </strong>
          <span className="block truncate text-[10px] text-muted">{appt.contact_name ?? "Atención sin cita"}</span>
          {!weekCompact ? (
            <span className="mt-auto flex min-w-0 items-center gap-1 pt-0.5">
              {unassigned ? (
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-semibold text-white">?</span>
              ) : (
                <Initial name={appt.staff_name} on="card" />
              )}
              <span className="u-appt-ink u-mono min-w-0 truncate text-[9px]">
                {fmtTime(appt.start_at, tz)}{state}
              </span>
            </span>
          ) : null}
        </span>
      ) : (
        <>
          <span className="flex items-start justify-between gap-1">
            <span className="u-appt-ink u-mono truncate text-[10px]">
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
          <span className={`block truncate text-[12px] font-semibold ${cancelled ? "line-through" : ""}`}>
            {appt.contact_name ?? "Sin cita"}
          </span>
          {compact ? null : (
            <span className="u-appt-ink block truncate text-[11px]">
              {appt.service_name}
              {state}
            </span>
          )}
        </>
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
  canOperate,
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
  canOperate: boolean;
  onClose: () => void;
  onReschedule: () => void;
  onConfirm: () => void;
  onComplete: () => void;
  onNoShow: () => void;
  onCancel: () => void;
}) {
  const live = appt.status === "scheduled" || appt.status === "confirmed";

  // Below xl the calendar owns the full width, so the detail can't sit BESIDE it —
  // it comes in as an overlay from the right instead. The SAME body renders in both
  // modes; only the frame changes. The trap (focus in on open, Escape to close, focus
  // back to the card on close) runs only for the overlay, exactly as Overlay.tsx
  // prescribes: a desktop panel you can see beside the grid must not trap the keyboard.
  const overlay = useIsOverlayWidth(1279.98); // Tailwind's `xl` — the beside/overlay line
  const panelRef = useTrappedPanel({ active: overlay, onClose });

  const body = (
    <>
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 bg-service-purple px-3">
        <span className="truncate text-xs font-semibold text-white">{STATUS_TITLE[appt.status] ?? appt.status}</span>
        <button type="button" onClick={onClose} aria-label="Cerrar detalle" className="u-tap text-white/80 hover:text-white">
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
            <p className="truncate text-sm font-semibold text-foreground">{appt.contact_name ?? "Sin cita"}</p>
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
            {live && canOperate ? (
              <button
                type="button"
                onClick={onReschedule}
                disabled={pending}
                className="ml-auto text-brand hover:underline disabled:opacity-50"
              >
                Reagendar
              </button>
            ) : null}
          </p>
        </div>

        {live && canOperate ? (
          <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
            {appt.status === "scheduled" ? (
              <button
                type="button"
                onClick={onConfirm}
                disabled={pending}
                className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                Confirmar
              </button>
            ) : null}
            <button
              type="button"
              onClick={onComplete}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover disabled:opacity-50"
            >
              Marcar como completada
            </button>
            <button
              type="button"
              onClick={onNoShow}
              disabled={pending}
              className="inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover disabled:opacity-50"
            >
              Inasistencia
            </button>
          </div>
        ) : null}

        {/* SERVICES — the model stores exactly ONE service per appointment, with its
            price snapshotted at booking time. The design's multi-service list is not
            representable (see TODO on AgendaView). */}
        <div className="mt-3 border-t border-line pt-3">
          <p className="u-th">Servicio</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-service-purple" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{appt.service_name}</p>
              <p className="u-mono text-[0.625rem] text-faint">
                {appt.duration_min} min{appt.staff_name ? ` · ${appt.staff_name}` : ""}
              </p>
            </div>
            {priceLabelCOP(appt.price) ? (
              <span className="u-mono shrink-0 text-sm text-foreground">{priceLabelCOP(appt.price)}</span>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-1.5 border-t border-line pt-3">
          {appt.contact_id && contactsBase ? (
            <Link
              href={`${contactsBase}/${appt.contact_id}${fromQS}`}
              className="inline-flex h-9 items-center justify-center rounded-md bg-ink text-sm font-medium text-ink-fg transition-colors hover:bg-ink-hover"
            >
              Abrir contacto &#8599;
            </Link>
          ) : null}
          {appt.source_conversation_id && inboxBase ? (
            <Link
              href={`${inboxBase}?c=${encodeURIComponent(appt.source_conversation_id)}`}
              className="inline-flex h-9 items-center justify-center rounded-md border border-line-strong text-sm transition-colors hover:bg-hover"
            >
              Ver conversación
            </Link>
          ) : null}
          {live && canOperate ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="inline-flex h-9 items-center justify-center rounded-md text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              Cancelar cita&hellip;
            </button>
          ) : null}
        </div>
      </div>
    </>
  );

  if (overlay) {
    return (
      <>
        {/* The scrim IS the click-outside close — a button so it is reachable and named. */}
        <button type="button" aria-label="Cerrar detalle" className={OVERLAY_SCRIM} onClick={onClose} />
        <aside
          ref={panelRef as RefObject<HTMLElement>}
          aria-label="Detalle de la cita"
          className="u-drawer-in fixed inset-y-0 right-0 z-50 flex w-[min(360px,90vw)] flex-col overflow-hidden border-l border-line bg-surface shadow-[var(--shadow-card)]"
        >
          {body}
        </aside>
      </>
    );
  }

  return (
    <aside
      aria-label="Detalle de la cita"
      className="hidden w-[19rem] shrink-0 flex-col overflow-hidden border-l border-line xl:flex 2xl:w-[21rem]"
    >
      {body}
    </aside>
  );
}

/** Modal for new appointment / walk-in / reschedule — fetches real availability. */
function AppointmentModal(props: {
  clientId: string;
  timezone: string;
  date: string;
  sites: SiteOpt[];
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
  const [serviceId, setServiceId] = useState(props.modal.mode === "reschedule" ? props.modal.appt.service_id : "");
  const [staffId, setStaffId] = useState<string>("");
  const [step, setStep] = useState<1 | 2 | 3>(isReschedule ? 2 : 1);
  const [selectedDate, setSelectedDate] = useState(props.date);
  const [calendarMonth, setCalendarMonth] = useState(props.date.slice(0, 7));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotStart, setSlotStart] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  /** Whether a search has completed — the difference between "not searched yet" (show
   *  nothing) and "searched, nothing came back" (say so, out loud). */
  const [searched, setSearched] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  // A modal COVERS the calendar, so it owes the reader the overlay contract: focus in
  // on open, Escape to close, focus back on close (Overlay.tsx). The backdrop click is
  // wired separately below.
  const dialogRef = useTrappedPanel({ active: true, onClose: props.onClose });

  /** Any change to what we'd search for invalidates the slots already on screen — a
   *  time found for a 30-min cut must not linger when the service becomes a 60-min one. */
  const resetSlots = () => {
    setSlots([]);
    setSlotStart("");
    setSearched(false);
  };

  const loadSlots = async (nextDate = selectedDate) => {
    // Reschedule keeps the appointment's own service; "new"/"walk-in" uses the picked one.
    const effectiveServiceId = props.modal.mode === "reschedule" ? props.modal.appt.service_id : serviceId;
    if (!effectiveServiceId) return;
    props.onError(null);
    setLoadingSlots(true);
    setSlots([]);
    setSlotStart("");
    setSearched(false);
    try {
      const nextMonth = nextDate.slice(0, 7);
      const monthStart = `${nextMonth}-01`;
      const monthEnd = `${shiftMonth(nextMonth, 1)}-01`;
      const params = new URLSearchParams({
        client_id: props.clientId, // the endpoint re-validates module + site↔client
        site_id: props.currentSiteId,
        service_id: effectiveServiceId,
        from: siteMidnightIso(monthStart, props.timezone),
        to: siteMidnightIso(monthEnd, props.timezone),
      });
      const res = await fetch(`/api/scheduling/internal/availability?${params.toString()}`);
      if (!res.ok) {
        props.onError("No se pudo cargar la disponibilidad.");
        return;
      }
      const data = (await res.json()) as { slots: Slot[] };
      setSlots(data.slots);
      // A completed search — now an empty result can say "nothing available" rather
      // than staying silent and looking broken.
      setSearched(true);
    } finally {
      setLoadingSlots(false);
    }
  };

  const submit = () => {
    if (!slotStart) {
      props.onError("Selecciona un horario.");
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

  const title = step === 3
    ? isReschedule ? "Confirmar el cambio" : "Confirmar la cita"
    : isReschedule
      ? "Reagendar cita"
      : props.modal.mode === "walkin"
        ? "Registrar atención sin cita"
        : bookingContact
          ? "Agendar cita"
          : "Nueva cita";

  const rescheduleAppt = props.modal.mode === "reschedule" ? props.modal.appt : null;
  const inputCls = "u-focus h-11 rounded-xl border border-line-strong bg-surface px-3 text-sm outline-none placeholder:text-faint";
  const selectedService = props.services.find((service) => service.id === (rescheduleAppt?.service_id ?? serviceId));
  const selectedSlot = slots.find((slot) => slot.start_at === slotStart);
  const effectiveStaffId = staffId || selectedSlot?.staff_id || rescheduleAppt?.staff_id || "";
  const selectedStaff = props.staff.find((staff) => staff.id === effectiveStaffId);
  const selectedSite = props.sites.find((site) => site.id === props.currentSiteId);
  const activeStaff = props.staff.filter((staff) => staff.active);
  const toneForStaff = (id: string): StaffTone => {
    const index = activeStaff.findIndex((staff) => staff.id === id);
    return STAFF_APPT_TONES[(index < 0 ? 0 : index) % STAFF_APPT_TONES.length];
  };
  const visibleSlots = staffId
    ? slots.filter((slot) => siteDayKey(slot.start_at, props.timezone) === selectedDate && slot.available_staff_ids.includes(staffId))
    : slots
        .filter((slot) => siteDayKey(slot.start_at, props.timezone) === selectedDate)
        .filter((slot, index, all) => all.findIndex((candidate) => candidate.start_at === slot.start_at) === index);
  const dateValue = (() => {
    const [year, month, day] = selectedDate.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  })();
  const dateHeadlineRaw = new Intl.DateTimeFormat("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(dateValue).replace(",", "");
  const dateHeadline = dateHeadlineRaw.charAt(0).toUpperCase() + dateHeadlineRaw.slice(1);
  const shortDateLabel = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(dateValue).replaceAll(".", "").replace(",", "").replaceAll(" de ", " ").replace(/\bsept\b/i, "sep");
  const monthLabel = new Intl.DateTimeFormat("es-CO", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${calendarMonth}-01T00:00:00Z`)).replace(" de ", " ");
  const monthDays = calendarDays(calendarMonth);
  const selectedDaySlots = slots.filter((slot) => siteDayKey(slot.start_at, props.timezone) === selectedDate);
  const availabilityCount = (dayKey: string, forStaffId = staffId): number => {
    const daySlots = slots.filter((slot) => siteDayKey(slot.start_at, props.timezone) === dayKey);
    const eligible = forStaffId ? daySlots.filter((slot) => slot.available_staff_ids.includes(forStaffId)) : daySlots;
    return new Set(eligible.map((slot) => slot.start_at)).size;
  };
  const staffAvailabilityCount = (candidateStaffId: string): number =>
    new Set(
      selectedDaySlots
        .filter((slot) => slot.available_staff_ids.includes(candidateStaffId))
        .map((slot) => slot.start_at),
    ).size;
  const todayKey = todayAtSite(props.timezone);
  const clientLabel = rescheduleAppt
    ? rescheduleAppt.contact_name ?? "Atención sin cita"
    : (bookingContact?.contactName ?? name.trim()) || (props.modal.mode === "walkin" ? "Atención sin cita" : "");
  const originLabel = isReschedule ? "Reagendación" : props.modal.mode === "walkin" ? "Atención sin cita" : "Mostrador";
  const phoneLabel = (rescheduleAppt?.primary_identity ?? phone.trim()) || "—";
  const staffInitials = (selectedStaff?.name ?? "?")
    .replace(/^\[[^\]]+\]\s*/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  const stepItems = [
    { value: 1 as const, label: "Cliente y servicio" },
    { value: 2 as const, label: "Profesional y hora" },
    { value: 3 as const, label: "Confirmar" },
  ];

  const changeStaff = (nextStaffId: string) => {
    setStaffId(nextStaffId);
    setSlotStart("");
  };

  const changeDate = (nextDate: string) => {
    setSelectedDate(nextDate);
    const nextMonth = nextDate.slice(0, 7);
    const monthChanged = nextMonth !== calendarMonth;
    setCalendarMonth(nextMonth);
    setSlotStart("");
    if (monthChanged) void loadSlots(nextDate);
  };

  const changeMonth = (delta: number) => {
    const nextMonth = shiftMonth(calendarMonth, delta);
    setCalendarMonth(nextMonth);
    setSlotStart("");
    void loadSlots(`${nextMonth}-01`);
  };

  const advance = () => {
    if (step === 1) {
      if (!serviceId) {
        props.onError("Selecciona un servicio.");
        return;
      }
      setStep(2);
      void loadSlots();
      return;
    }
    if (step === 2) {
      if (!slotStart) {
        props.onError("Selecciona un horario.");
        return;
      }
      setStep(3);
    }
  };

  const goBack = () => {
    props.onError(null);
    setStep((current) => {
      if (current === 3) return 2;
      if (current === 2) return isReschedule ? 2 : 1;
      return current;
    });
  };

  return (
    <div className="u-module-modal z-50 flex items-center justify-center bg-black/45 p-2 sm:p-4" onClick={props.onClose}>
      <div
        ref={dialogRef as RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={MODAL_TITLE_ID}
        className={`flex max-h-[calc(100vh-1rem)] flex-col overflow-hidden rounded-2xl border border-line bg-popover text-popover-foreground shadow-2xl sm:max-h-[calc(100vh-2rem)] ${step === 2 ? "w-[min(94rem,calc(100vw-1rem))] sm:h-[min(52rem,calc(100vh-2rem))] sm:w-[min(94rem,calc(100vw-2rem))]" : "w-[min(70rem,calc(100vw-1rem))] sm:w-[min(70rem,calc(100vw-2rem))]"}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex min-h-16 shrink-0 items-start gap-3 border-b border-line px-4 py-3 sm:items-center sm:px-6">
          <h2 id={MODAL_TITLE_ID} className="shrink-0 text-lg font-semibold">{title}</h2>
          <nav aria-label="Pasos para crear la cita" className="min-w-0 flex-1 overflow-x-auto">
            <ol className="flex w-max items-center gap-1.5">
              {stepItems.map((item) => {
                const complete = item.value < step;
                const current = item.value === step;
                return (
                  <li key={item.value}>
                    <button
                      type="button"
                      aria-current={current ? "step" : undefined}
                      onClick={() => {
                        if (item.value <= step || (item.value === 3 && !!slotStart)) setStep(item.value);
                      }}
                      className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs transition-colors ${current ? "bg-ink font-medium text-ink-fg" : complete ? "bg-subtle text-foreground" : "text-faint"}`}
                    >
                      <span className={`inline-flex size-5 items-center justify-center rounded-full text-[0.6875rem] ${complete ? "bg-success/15 text-success" : current ? "bg-ink-fg text-ink" : "bg-subtle text-faint"}`}>
                        {complete ? "✓" : item.value}
                      </span>
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <button type="button" aria-label="Cerrar" onClick={props.onClose} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-xl text-muted hover:bg-subtle hover:text-foreground">×</button>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-y-auto lg:overflow-hidden">
          <main className={step === 2 ? "min-h-[32rem] lg:min-h-0 lg:overflow-hidden" : "min-h-[25rem] px-4 py-4 sm:px-6 lg:overflow-y-auto"}>
            {step === 1 ? (
              <section aria-labelledby="booking-client-heading" className="mx-auto max-w-5xl">
                <p className="u-th">Paso 1 de 3</p>
                <h3 id="booking-client-heading" className="mt-1.5 text-xl font-semibold">Cliente y servicio</h3>
                <p className="mt-1 text-sm text-muted">Identifica al cliente y elige qué servicio desea reservar.</p>
                <div className="mt-5 grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
                  <div>
                    <p className="u-th">Cliente</p>
                    <div className="mt-3">
                      {bookingContact ? (
                        <div className="rounded-2xl border border-line-strong bg-subtle p-4">
                          <span className="u-th">Cliente seleccionado</span>
                          <p className="mt-2 text-base font-semibold">{bookingContact.contactName}</p>
                          <p className="mt-1 text-sm text-muted">La cita quedará vinculada a este contacto.</p>
                        </div>
                      ) : isReschedule ? (
                        <div className="rounded-2xl border border-line-strong bg-subtle p-4">
                          <span className="u-th">Cliente de la cita</span>
                          <p className="mt-2 text-base font-semibold">{clientLabel}</p>
                        </div>
                      ) : (
                        <div className="grid gap-4">
                          <label className="flex flex-col gap-1.5">
                            <span className="text-sm font-medium">Nombre del cliente</span>
                            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={props.modal.mode === "walkin" ? "Opcional para atención sin cita" : "Ej. Lucía Ferrer"} className={inputCls} autoFocus />
                          </label>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <label className="flex flex-col gap-1.5">
                              <span className="text-sm font-medium">Teléfono</span>
                              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+57 300 000 0000" className={inputCls} inputMode="tel" />
                            </label>
                            <label className="flex flex-col gap-1.5">
                              <span className="text-sm font-medium">Correo electrónico</span>
                              <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Opcional" className={inputCls} inputMode="email" />
                            </label>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-line pt-5 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
                    <p className="u-th">Servicio</p>
                    <div className="mt-3 grid max-h-[22rem] gap-2.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      {props.services.map((service) => {
                        const selected = service.id === serviceId;
                        return (
                          <button
                            key={service.id}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => {
                              setServiceId(service.id);
                              resetSlots();
                            }}
                            className={`flex min-h-16 items-center justify-between rounded-xl border p-3.5 text-left transition-colors ${selected ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface hover:bg-subtle"}`}
                          >
                            <span className="font-semibold">{service.name}</span>
                            <span className={`u-mono ml-3 text-xs ${selected ? "text-ink-fg/70" : "text-muted"}`}>{service.duration_min} min</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {step === 2 ? (
              <section aria-labelledby="booking-slot-heading" className="grid h-full min-h-0 lg:grid-cols-[minmax(0,2.08fr)_minmax(21rem,1fr)]">
                <h3 id="booking-slot-heading" className="sr-only">Profesional y hora</h3>

                <div className="min-h-0 p-4 sm:p-6 lg:pr-7">
                  <div className="flex h-full min-h-[31rem] flex-col overflow-hidden rounded-2xl border border-line bg-surface">
                    <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-line px-5">
                      <div className="min-w-0">
                        <strong className="text-lg capitalize">{monthLabel}</strong>
                        <span className="ml-4 hidden truncate text-sm text-muted sm:inline">{selectedSite?.name ?? "Sede actual"}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button type="button" onClick={() => changeDate(todayKey)} className="h-9 rounded-lg border border-line-strong px-3 text-sm hover:bg-subtle">Hoy</button>
                        <button type="button" aria-label="Mes anterior" onClick={() => changeMonth(-1)} className="inline-flex size-9 items-center justify-center rounded-lg border border-line-strong text-lg text-muted hover:bg-subtle hover:text-foreground">‹</button>
                        <button type="button" aria-label="Mes siguiente" onClick={() => changeMonth(1)} className="inline-flex size-9 items-center justify-center rounded-lg border border-line-strong text-lg text-muted hover:bg-subtle hover:text-foreground">›</button>
                      </div>
                    </div>

                    <div className="grid h-11 shrink-0 grid-cols-7 border-b border-line bg-subtle/35 text-center text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted">
                      {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((label) => <span key={label} className="flex items-center justify-center">{label}</span>)}
                    </div>

                    <div
                      className="grid min-h-0 flex-1 grid-cols-7 gap-x-1 px-2 py-1"
                      style={{ gridTemplateRows: `repeat(${monthDays.length / 7}, minmax(4.5rem, 1fr))` }}
                    >
                      {monthDays.map((day) => {
                        const freeCount = day.inMonth ? availabilityCount(day.key) : 0;
                        const selected = selectedDate === day.key;
                        return (
                          <button
                            key={day.key}
                            type="button"
                            aria-label={`Seleccionar ${day.key}${freeCount ? ", hay cupos" : ""}`}
                            aria-pressed={selected}
                            onClick={() => changeDate(day.key)}
                            className={`group flex min-h-0 flex-col items-center justify-center rounded-2xl px-1 text-center transition-colors ${day.inMonth ? "hover:bg-subtle/60" : "text-faint hover:bg-subtle/35"}`}
                          >
                            <span className={`inline-flex size-11 items-center justify-center rounded-full text-base tabular-nums transition-colors ${selected ? "bg-ink font-semibold text-ink-fg shadow-sm" : day.inMonth ? "font-medium text-foreground group-hover:bg-chip" : "text-faint"}`}>{day.day}</span>
                            {freeCount > 0 ? <span className="mt-1 text-[0.6875rem] font-medium text-muted">Hay cupos</span> : <span className="mt-1 h-4" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="flex min-h-0 flex-col border-t border-line bg-subtle/25 lg:border-l lg:border-t-0">
                  <fieldset className="shrink-0 px-5 py-5">
                    <legend className="u-th">Profesional</legend>
                    <div className="mt-3 grid gap-2">
                      <button type="button" aria-pressed={!staffId} onClick={() => changeStaff("")} className={`flex min-h-14 items-center gap-3 rounded-xl border bg-surface px-3.5 text-left transition-colors ${!staffId ? "border-ink shadow-sm" : "border-line hover:border-line-strong"}`}>
                        <span className="size-6 shrink-0 rounded-md border border-dashed border-line-strong bg-subtle" />
                        <span className="min-w-0 flex-1"><strong className="block text-sm">Cualquier profesional</strong><span className="block truncate text-xs text-muted">{availabilityCount(selectedDate, "") > 0 ? "Hay cupos" : "Sin cupos"}</span></span>
                        {!staffId ? <span className="inline-flex size-5 items-center justify-center rounded-full bg-ink text-xs text-ink-fg">✓</span> : null}
                      </button>

                      {/* NEW bookings offer ACTIVE staff only — an inactive barber's lane is visible
                          for history but must not be selectable for a new appointment. */}
                      {activeStaff.map((candidate) => {
                        const count = staffAvailabilityCount(candidate.id);
                        const selected = staffId === candidate.id;
                        return (
                          <button key={candidate.id} type="button" aria-pressed={selected} disabled={count === 0} onClick={() => changeStaff(candidate.id)} className={`flex min-h-14 items-center gap-3 rounded-xl border bg-surface px-3.5 text-left transition-colors ${selected ? "border-ink shadow-sm" : "border-line hover:border-line-strong"} disabled:cursor-not-allowed disabled:opacity-45`}>
                            <span className={`u-appt-swatch ${toneForStaff(candidate.id)} size-6 shrink-0 rounded-md`} />
                            <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{candidate.name}</strong><span className="block text-xs text-muted">{count > 0 ? "Hay cupos" : "Sin cupos"}</span></span>
                            {selected ? <span className="inline-flex size-5 items-center justify-center rounded-full bg-ink text-xs text-ink-fg">✓</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>

                  <div className="min-h-0 flex-1 border-t border-line px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm"><strong className="capitalize">{shortDateLabel}</strong><span className="ml-2 text-muted">{visibleSlots.length > 0 ? "Hay cupos" : "Sin cupos"}</span></p>
                      <span className="rounded-lg bg-subtle px-2.5 py-1 text-xs font-semibold">24h</span>
                    </div>

                    {loadingSlots ? (
                      <div className="mt-3 grid grid-cols-3 gap-2 overflow-hidden">
                        {Array.from({ length: 9 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-xl bg-subtle" />)}
                        <p className="sr-only">Buscando…</p>
                      </div>
                    ) : searched && visibleSlots.length === 0 ? (
                      <p className="mt-3 rounded-xl border border-line bg-surface px-3 py-3 text-xs text-muted">No hay horarios disponibles para esta combinación.</p>
                    ) : visibleSlots.length > 0 ? (
                      <div className="mt-3 grid max-h-[15.5rem] grid-cols-3 gap-2 overflow-y-auto pr-1">
                        {visibleSlots.map((slot) => (
                          <button
                            key={`${slot.start_at}-${slot.staff_id}`}
                            type="button"
                            aria-pressed={slotStart === slot.start_at}
                            onClick={() => {
                              setSlotStart(slot.start_at);
                              if (!staffId) setStaffId(slot.staff_id);
                            }}
                            className={`u-mono h-12 rounded-xl border text-sm transition-colors ${slotStart === slot.start_at ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface hover:border-ink hover:bg-subtle"}`}
                          >
                            {fmtTime(slot.start_at, props.timezone)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!slotStart ? <p className="mt-3 text-xs text-faint">Selecciona un horario para continuar.</p> : null}
                  </div>
                </div>
              </section>
            ) : null}

            {step === 3 ? (
              <section aria-labelledby="booking-confirm-heading" aria-label="Resumen de la cita" className="mx-auto max-w-5xl py-1 sm:py-2">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-4">
                    <span className={`u-appt-swatch ${selectedStaff ? toneForStaff(selectedStaff.id) : "u-appt-staff-slate"} size-16 shrink-0 overflow-hidden rounded-2xl`} aria-hidden>
                      <span className="flex size-full items-center justify-center text-base font-semibold">{staffInitials}</span>
                    </span>
                    <div className="min-w-0">
                      <h3 id="booking-confirm-heading" className="truncate text-2xl font-semibold sm:text-3xl">{dateHeadline}, {slotStart ? fmtTime(slotStart, props.timezone) : "—"}</h3>
                      <p className="mt-1 truncate text-sm text-muted sm:text-base">{clientLabel || "Atención sin cita"} · {selectedService?.name ?? "Servicio"} con {selectedStaff?.name ?? "cualquier profesional"}</p>
                    </div>
                  </div>
                  <span className="w-fit shrink-0 rounded-xl border border-line bg-subtle px-3 py-2 text-sm font-medium">Horario libre</span>
                </div>

                <dl className="mt-7 grid overflow-hidden rounded-2xl border border-line bg-surface text-sm sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Cliente", clientLabel || "Atención sin cita"],
                    ["Teléfono", phoneLabel],
                    ["Servicio", selectedService?.name ?? "Servicio"],
                    ["Duración", `${selectedService?.duration_min ?? 0} min`],
                    ["Profesional", selectedStaff?.name ?? "Cualquier profesional"],
                    ["Sede", selectedSite?.name ?? "Sede actual"],
                    ["Estado inicial", "Sin confirmar"],
                    ["Origen", originLabel],
                  ].map(([label, value], index) => (
                    <div key={label} className={`min-w-0 px-4 py-3.5 ${index >= 4 ? "border-t border-line" : ""} ${index % 4 !== 0 ? "lg:border-l lg:border-line" : ""} ${index % 2 !== 0 ? "sm:border-l sm:border-line" : ""}`}>
                      <dt className="text-xs text-muted">{label}</dt>
                      <dd className={`mt-1 truncate font-semibold ${label === "Teléfono" || label === "Duración" ? "u-mono" : ""}`}>{value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-5 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 text-sm">
                    <span className={`u-appt-swatch ${selectedStaff ? toneForStaff(selectedStaff.id) : "u-appt-staff-slate"} size-6 shrink-0 rounded-lg`} />
                    <span>Color de {selectedStaff?.name ?? "la cita"}</span>
                    <span className="text-muted">Automático</span>
                  </div>
                  <p className="text-xs text-muted">Termina a las {selectedSlot ? fmtTime(selectedSlot.service_end_at, props.timezone) : "—"}</p>
                </div>
              </section>
            ) : null}
          </main>

          <footer className={`flex min-h-16 items-center gap-2 border-t border-line px-5 py-3 ${step === 3 ? "justify-between bg-subtle/45" : "justify-end bg-popover"}`}>
            {step === 3 ? <p className="hidden text-sm text-muted sm:block">Nada se guarda hasta que confirmes.</p> : <button type="button" onClick={props.onClose} className="h-10 rounded-xl px-4 text-sm text-muted transition-colors hover:bg-subtle hover:text-foreground">Cancelar</button>}
            <div className="flex items-center justify-end gap-2">
            {step > 1 && !(isReschedule && step === 2) ? (
              <button type="button" onClick={goBack} className="h-10 rounded-xl border border-line-strong px-5 text-sm transition-colors hover:bg-subtle">Volver</button>
            ) : null}
            {step === 3 ? (
              <button type="button" onClick={submit} disabled={pending || !slotStart} className="h-10 rounded-xl bg-ink px-6 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50">
                {pending ? "Guardando…" : isReschedule ? "Confirmar cambio" : "Crear cita"}
              </button>
            ) : (
              <button type="button" onClick={advance} disabled={(step === 1 && !serviceId) || (step === 2 && !slotStart)} className="h-10 rounded-xl bg-ink px-6 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-40">
                Continuar
              </button>
            )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

/** Stable id linking the dialog to its heading — only one modal is ever mounted. */
const MODAL_TITLE_ID = "agenda-appt-modal-title";
