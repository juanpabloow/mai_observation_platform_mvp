"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition, type RefObject } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AttentionChip, Avatar, Button, INPUT, buttonClass } from "./ui/system";
import { MobileAgenda } from "./mobile/MobileAgenda";
import {
  Icon,
  ICON,
  M_CARD,
  M_SMALL,
  MButton,
  MClientAvatar,
  MConfirm,
  MIconButton,
  MPill,
  MRadio,
  MScreen,
  MSegmented,
  MStaffAvatar,
  MStateChip,
  MToast,
  Sheet,
  staffColors,
} from "./mobile/kit";
import { OVERLAY_SCRIM, useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { blockSpanLabel, dayHeadline, dayShort, monthTitle } from "@/lib/siteCalendar";
import { apptCategoryClass, serviceCategory, type ApptCategory } from "@/lib/agendaCategory";
import { apptClientLabel } from "@/lib/apptClientLabel";
import { priceLabelCOP } from "@/lib/money";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  confirmAppointmentAction,
  createManualAppointmentAction,
  noShowAppointmentAction,
  listAppointmentActivityAction,
  getReviewLinkAction,
  rescheduleAppointmentAction,
  searchSchedulingContactsAction,
  recentSchedulingContactsAction,
  type ContactSearchHit,
} from "@/lib/schedulingActions";
import { ChargePanel } from "./agenda/ChargePanel";
import { PendingChargesPanel } from "./agenda/PendingChargesPanel";
import { AppointmentPanel } from "./agenda/AppointmentPanel";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import type { ContactMatch } from "@/lib/walkInContact";
import { RescheduleFlow } from "./agenda/RescheduleFlow";
import { WalkInPanel, type WalkInContext } from "./agenda/WalkInPanel";
import { BlockPanel } from "./agenda/BlockPanel";
import { SeriesPanel } from "./agenda/SeriesPanel";
import { BreakWeekPanel } from "./agenda/BreakWeekPanel";
import { AffectedReschedulePanel } from "./agenda/AffectedReschedulePanel";
import type { AffectedItem } from "./agenda/ScheduleFormParts";
import { adoptLegacyBreakAction } from "@/lib/scheduleSeriesActions";
import { AppointmentPreview } from "./agenda/AppointmentPreview";
import { SidePanel, PanelSection, type SidePanelHandle } from "./agenda/SidePanel";
import { AG_HEAD_CAL, AgAvatar, agTintAt, ALL_STATES, DateTitle, FiltersPopover, GearMenu, STATE_GLYPH, STATE_WORD, StateChip, TB_ICON, TB_PRIMARY, agendaTitle } from "./agenda/AgendaChrome";

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
interface StaffOpt { id: string; name: string; active: boolean; workingHours: WeeklyHours; photoUrl?: string | null }
interface ServiceOpt {
  id: string;
  name: string;
  duration_min: number;
  /** `services.category` — needed so the booking modal previews the SAME colour the
   *  card will actually be drawn with, instead of re-guessing from the name. */
  category: string | null;
  /** The site's EFFECTIVE price (per-site override applied), numeric → string. NULL
   *  when the service has no price; the card then shows only its duration. */
  price: string | null;
}
export interface Appt {
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
  /** Server-computed: may this login act on this appointment (gateAppointment's checks). */
  can_modify: boolean;
  /** PY-2: a completed appointment's charge — 'recorded' or 'pending' («Cobro pendiente»);
   *  null when not tracked (history before tracking started) or the login lacks payments.view. */
  payment_state?: "recorded" | "pending" | null;
  /** A walk-in WITHOUT a linked contact: what was typed (contact_id decides, never a name). */
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  /** «Requiere revisión» reasons (server-derived, independent of status); [] = none. */
  review: string[];
}

/** One occurrence of a usual break or a recurring block (schedule_series), drawn on the
 *  grid. Breaks have no border (routine); blocks do. */
export interface SeriesOcc {
  key: string;
  seriesId: string;
  kind: "break" | "block";
  staffId: string | null;
  date: string;
  startsAt: string;
  endsAt: string;
  /** This date has its own times (an exception of the series). */
  moved: boolean;
  reason: string | null;
  publicReason: string | null;
}

/**
 * A card is painted by its SERVICE, in one of the four families stored on
 * `services.category` (Corte / Barba y cuidado / Color / Tratamiento destacado) —
 * a real, operator-editable column, not a derived index, so the board's colours are
 * stable across sessions and configurable in Catálogo → Servicios. An
 * uncategorised service falls back to keywords in its name (see lib/agendaCategory).
 *
 * `serviceCategory` is used rather than `apptCategory` ON PURPOSE: apptCategory lets
 * STATE outrank the service, which would repaint a whole column red on a single
 * no-show. State is carried in WORDS on the card instead (never colour alone), so the
 * fill can stay a stable answer to "what is this appointment for".
 *
 * PROFESSIONAL identity has not been dropped, only moved: it lives in the initials
 * puck on the card and in the column header, where it no longer competes with the
 * service for the same channel.
 *
 * TODO(agenda): four families means two services in the same family share a fill
 *   (e.g. "Beard sculpt" and "Grooming set"). A per-service colour needs a colour
 *   column on `services`; until then the family IS the unit of colour, and the
 *   service name on the card is what separates them.
 */
function appointmentToneClass(appt: Appt): string {
  if (!appt.staff_name) return "u-appt-unassigned";
  return `u-appt-service ${apptCategoryClass(serviceCategory(appt.service_name, appt.service_category))}`;
}
interface Slot { start_at: string; service_end_at: string; staff_id: string; available_staff_ids: string[] }
/** When booking for an existing contact (C-4.1 deep-link), the modal locks the identity
 *  to this contact and submits its id — staff never retype what's on the record. */
interface ContactPrefill { contactId: string; contactName: string }
/** A Time Off block (schedule exception): staff_id null = a whole-site closure, otherwise
 *  one staff member. `reason` is INTERNAL — only present for roles allowed to see it. */
interface Block {
  id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  /** What a customer may be told (migration 1803); null = nothing. */
  public_reason?: "vacation" | "unavailable" | "site_closed" | null;
}
type BookingModalState =
  | { mode: "new" | "walkin"; contact?: ContactPrefill; staffId?: string; startAt?: string; spanMin?: number; serviceId?: string; done?: boolean }
  | { mode: "reschedule"; appt: Appt };
/** The agenda's modal states — the booking ones plus Time Off (create / edit a block). */
type ModalState =
  | BookingModalState
  | { mode: "block"; staffId?: string | null; date?: string; start?: string; end?: string }
  | { mode: "editBlock"; block: Block }
  /** One occurrence of a usual break / recurring block (schedule_series). */
  | { mode: "series"; occ: SeriesOcc };

/** The calendar body's vertical scale, for the WHOLE day grid (cards, blocks, pauses, the
 *  now line, drag and click hit-testing all derive from it). 88 = the approved «M_AI Agenda»
 *  capture (2026-10-24), so its cards keep the reference's type and line breaks at their real
 *  duration — no card is ever stretched on its own. */
const HOUR_PX = 88;
/**
 * WEEK's vertical scale. The reference week is a BLOCK grid, not a proportional one:
 * seven narrow columns can't carry proportional heights and stay readable, so one hour
 * is one fixed cell that holds AT MOST TWO cards plus a "+N más" chip. 96px is the
 * floor at which two one-line cards and a 20px chip all fit uncropped.
 */
const WEEK_HOUR_PX = 80;
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

/**
 * Where a booking came from, in Spanish. `appointments.origin` is a CHECK-constrained
 * enum ('public' | 'n8n' | 'internal' | 'walk_in') and the record was printing the raw
 * value — staff read "internal" in an otherwise fully translated screen. An unknown
 * value falls through to itself rather than to a guess, so a new origin added to the
 * constraint shows up visibly instead of silently mislabelled.
 */
const ORIGIN_LABEL: Record<string, string> = {
  public: "Reserva en línea",
  n8n: "Agente de reservas",
  internal: "Mostrador",
  walk_in: "Atención sin cita",
};

/** Spanish names for the four storable service families — the agenda's colour key. */
const SERVICE_FAMILY_LABEL: Partial<Record<ApptCategory, string>> = {
  cut: "Corte",
  grooming: "Barba y cuidado",
  color: "Color",
  feature: "Tratamiento destacado",
};


// Spanish date vocabulary, spelled out here rather than pulled from Intl("es") for
// two reasons: it is DETERMINISTIC (no "sept."/"sep" locale-data drift between the
// browser and the build), and every abbreviation is exactly three characters, which
// is what keeps the date label a stable width so the steppers beside it never slide.
const ES_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const ES_WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

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

interface DayLane {
  lane: number;
  laneCount: number;
}

/**
 * DAY overlap resolution: side-by-side lanes, the way a time grid is expected to work.
 *
 * Stacking two overlapping cards at full width painted the later one OVER the earlier,
 * so a real booking's customer name was hidden behind its neighbour with nothing to
 * click. Professional columns are wide enough (13rem floor) to split, so each member of
 * an overlap cluster gets its own lane and stays fully reachable.
 *
 * Lane count is per CLUSTER, not per column: one 3-way overlap at 10:00 must not narrow
 * the untroubled 17:00 booking further down the same column. Uncapped on purpose —
 * a cap would reintroduce exactly the hidden-card problem this removes. WEEK cannot do
 * this at 150px a column, which is why it collapses to "+N citas" instead.
 */
function layoutDayLanes(appointments: Appt[]): Map<string, DayLane> {
  const sorted = [...appointments].sort(
    (a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || Date.parse(a.service_end_at) - Date.parse(b.service_end_at),
  );
  const lanes = new Map<string, DayLane>();
  let cluster: Array<{ appt: Appt; lane: number }> = [];
  let laneEnds: number[] = [];

  const flush = () => {
    for (const { appt, lane } of cluster) lanes.set(appt.id, { lane, laneCount: laneEnds.length });
    cluster = [];
    laneEnds = [];
  };

  for (const appt of sorted) {
    const start = Date.parse(appt.start_at);
    const end = Date.parse(appt.service_end_at);
    // A cluster ends when an appointment starts at or after EVERY open lane's end —
    // merely touching (10:00–10:30 then 10:30–11:00) is not an overlap.
    if (cluster.length > 0 && laneEnds.every((laneEnd) => laneEnd <= start)) flush();
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    cluster.push({ appt, lane });
  }
  flush();
  return lanes;
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
  /** owner/admin, client owner/setter, and staff can all operate the agenda; a staff
   *  login is restricted to its OWN column by the server actions. */
  canOperate: boolean;
  /** When set (a staff login), the booking modal pins the barber picker to this id —
   *  the staff's own column. The server enforces it regardless. */
  lockStaffId: string | null;
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
  /** Time Off blocks in the visible range (site-wide + per-staff), pre-filtered to what
   *  this viewer may see. */
  blocks: Block[];
  /** May create/edit STAFF time off (owner/setter/agency — never a staff login). */
  canBlockStaff: boolean;
  /** May create/edit SITE closures (owner/agency only). */
  canBlockSite: boolean;
  /** PY-2 payment permissions (catalogue keys; the server re-checks every action). */
  canViewPayments?: boolean;
  canRecordPayments?: boolean;
  canVoidPayments?: boolean;
  /** Usual breaks + recurring blocks in the visible range (schedule_series). */
  seriesOccurrences: SeriesOcc[];
  /** May edit a professional's breaks (team.manage) / the site's (settings.sites or hours.manage). */
  canEditStaffBreaks: boolean;
  canEditSiteBreaks: boolean;
  clientName: string;
  /** Appointments per site-local day of the week around `date` (phone day strip). */
  weekCounts: Record<string, number>;
  /** Deep links (validated server-side against the loaded data). */
  initialStaffId: string | null;
  initialApptId: string | null;
}) {
  const router = useRouter();
  const isPhoneWidth = useIsOverlayWidth(767.98);
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
  const [selectedId, setSelectedId] = useState<string | null>(props.initialApptId);
  /**
   * HOVER PREVIEW — which appointment, and where its card is on screen. Shown after a
   * short delay on mouse hover (never on touch: a tap opens the detail), or at once on
   * keyboard focus. The hide is delayed too, so the pointer can travel from the card
   * into the preview without it flickering shut.
   */
  const [preview, setPreview] = useState<{ appt: Appt; rect: DOMRect } | null>(null);
  const previewTimers = useRef<{ show: number | null; hide: number | null }>({ show: null, hide: null });
  /** An appointment just "located" from the detail — flashed so the eye finds it. */
  const [flashId, setFlashId] = useState<string | null>(null);
  /** Appointments intentionally collapsed behind a weekly "+N más" indicator. */
  const [weekOverflow, setWeekOverflow] = useState<Appt[] | null>(null);
  const [weekOverflowTitle, setWeekOverflowTitle] = useState<string | undefined>();
  /** Client-side facets over the ALREADY loaded range (reference: «Filtrar»). Professionals
   *  pick the COLUMNS shown; unticked states and a search DIM the cards — the time they
   *  hold is still taken, so nothing disappears from the board. */
  const [staffSel, setStaffSel] = useState<string[]>(props.initialStaffId ? [props.initialStaffId] : []);
  const [statesOn, setStatesOn] = useState<string[]>([...ALL_STATES]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  /** «Pintar» (the brush): ONLY while it is on does pressing and dragging on the day grid
   *  mark a range to create or block — so a stray click or drag never starts one. */
  const [paint, setPaint] = useState(false);
  /** PY-2: the charge step open for an appointment («Completar cita» / «Registrar cobro»). */
  const [charge, setCharge] = useState<{ apptId: string; mode: "complete" | "record" } | null>(null);
  const [pendingList, setPendingList] = useState(false);
  /**
   * CREATE / BLOCK FROM THE GRID (reference slotPop, plus drag). Press and drag on an empty
   * part of a professional's lane to select a range (15-minute steps; a plain click takes
   * one hour); on a touch screen a long press starts it, so the grid still scrolls. On
   * release a menu offers what this login may do:
   *   Bloquear    the EXACT range selected — a block has any length;
   *   Nueva cita  the START and the professional only — an appointment lasts what its
   *               service lasts. The range is a hint (services that fit are listed first)
   *               and the grid then shows the real size of the draft as it is chosen.
   * Nothing is created until the panel is saved.
   */
  const [slotPop, setSlotPop] = useState<{ staffId: string; from: number; to: number; last: boolean; dragging: boolean; dragged: boolean; /** The clock when the range was released. */ at?: number } | null>(null);
  const dragRef = useRef<{ staffId: string; anchor: number; x: number; y: number; timer: number | null; live: boolean; moved: boolean; el: HTMLElement; touch: boolean; last: boolean; pointerId: number } | null>(null);
  useEffect(() => {
    if (!slotPop || slotPop.dragging) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSlotPop(null);
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-slot-menu]")) setSlotPop(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [slotPop]);
  // While a long-pressed selection is live the finger draws, it does not scroll — a native,
  // non-passive listener (React's touch handlers are passive and cannot prevent it).
  useEffect(() => {
    const f = (e: TouchEvent) => {
      if (dragRef.current?.live) e.preventDefault();
    };
    document.addEventListener("touchmove", f, { passive: false });
    return () => document.removeEventListener("touchmove", f);
  }, []);
  /** The draft the booking panel is building — drawn on the grid at its real size. */
  const [bookingGhost, setBookingGhost] = useState<{ staffId: string; startAt: string; durationMin: number; label: string; past?: boolean } | null>(null);
  // Bring the draft into view beside the panel (the panel overlays the right of the grid).
  const ghostKey = bookingGhost ? `${bookingGhost.staffId}|${bookingGhost.startAt}` : "";
  useEffect(() => {
    if (!ghostKey) return;
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>("[data-booking-ghost]");
      const grid = el?.closest<HTMLElement>("[aria-label='Agenda del día por profesional']");
      if (!el || !grid) return;
      const panelW = 532;
      const r = el.getBoundingClientRect();
      const g = grid.getBoundingClientRect();
      const visibleRight = g.right - panelW;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (r.right > visibleRight) grid.scrollBy({ left: r.right - visibleRight + 16, behavior: reduce ? "auto" : "smooth" });
      if (r.top < g.top + 50 || r.bottom > g.bottom) grid.scrollBy({ top: r.top - g.top - 120, behavior: reduce ? "auto" : "smooth" });
    }, 60);
    return () => window.clearTimeout(t);
  }, [ghostKey]);
  const searchRef = useRef<HTMLInputElement>(null);
  // Esc leaves «Pintar» — unless a grid menu or a panel is open: Esc closes THAT first.
  useEffect(() => {
    if (!paint) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !slotPop && !modal && !e.defaultPrevented) setPaint(false);
    };
    // Capture phase: read what is open BEFORE the menu's or panel's own Esc closes it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paint, slotPop, modal]);
  /** An affected appointment being rescheduled FROM a break/block form: the form stays
   *  mounted (hidden) with everything typed; `holds` discount its unsaved draft. */
  const [formReschedule, setFormReschedule] = useState<{ apptId: string; holds: string[]; item: AffectedItem } | null>(null);
  /** Bumped when coming back from that reschedule → the form recalculates its conflicts. */
  const [recheck, setRecheck] = useState(0);
  /**
   * The legend explains the CARD COLOURS, so it lists the service families actually
   * present in the visible range — showing all four when only one is booked would
   * make the reader hunt for colours that are not on the board.
   */
  const serviceLegend = useMemo(() => {
    const seen = new Map<ApptCategory, string>();
    for (const appt of props.appointments) {
      const family = serviceCategory(appt.service_name, appt.service_category);
      if (!seen.has(family)) seen.set(family, SERVICE_FAMILY_LABEL[family] ?? family);
    }
    return [...seen].map(([family, label]) => ({ family, label }));
  }, [props.appointments]);

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
  /** Professionals + states currently filtered — the counter on the Filtros icon. */
  const activeFilters = (staffSel.length > 0 ? 1 : 0) + (statesOn.length < ALL_STATES.length ? 1 : 0);
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
      setSearchOpen(true);
      window.requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };
    document.addEventListener("keydown", onSearchKey);
    return () => document.removeEventListener("keydown", onSearchKey);
  }, []);

  /** A short confirmation after a successful action (the phone shows it as a toast). */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice]);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success?: string) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo completar la acción.");
      else {
        if (success) setNotice(success);
        router.refresh();
      }
    });
  };

  // ── Hover preview + "locate" ───────────────────────────────────────────────────
  const hidePreviewSoon = useCallback(() => {
    const t = previewTimers.current;
    if (t.show) {
      window.clearTimeout(t.show);
      t.show = null;
    }
    if (t.hide) window.clearTimeout(t.hide);
    t.hide = window.setTimeout(() => setPreview(null), 140);
  }, []);
  const keepPreview = useCallback(() => {
    const t = previewTimers.current;
    if (t.hide) {
      window.clearTimeout(t.hide);
      t.hide = null;
    }
  }, []);
  /** Spread onto every appointment card: hover / focus show the preview, and the
   *  data attribute lets "Localizar en el calendario" find the card again. */
  const previewProps = (appt: Appt) => ({
    "data-appt-id": appt.id,
    "aria-describedby": preview?.appt.id === appt.id ? "appt-preview" : undefined,
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType !== "mouse" || selectedId || modal) return;
      const el = e.currentTarget;
      const t = previewTimers.current;
      keepPreview();
      if (t.show) window.clearTimeout(t.show);
      t.show = window.setTimeout(() => setPreview({ appt, rect: el.getBoundingClientRect() }), 180);
    },
    onPointerLeave: hidePreviewSoon,
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      // Keyboard alternative to hover: a VISIBLE focus shows the preview; Enter opens.
      if (selectedId || modal || !e.currentTarget.matches(":focus-visible")) return;
      keepPreview();
      setPreview({ appt, rect: e.currentTarget.getBoundingClientRect() });
    },
    onBlur: () => setPreview(null),
  });
  // A scrolled or resized grid moves the card out from under its preview — drop it.
  useEffect(() => {
    if (!preview) return;
    const drop = () => setPreview(null);
    window.addEventListener("scroll", drop, true);
    window.addEventListener("resize", drop);
    return () => {
      window.removeEventListener("scroll", drop, true);
      window.removeEventListener("resize", drop);
    };
  }, [preview]);
  const openAppointment = (id: string) => {
    setPreview(null);
    setSelectedId(id);
  };
  /** An appointment a form found in its way (to review or complete it): here if it is on the
   *  day shown, else on its own day (the page opens `?appt=` once it is in range). */
  const openExisting = (id: string, dayKey: string) => {
    if (dayKey === props.date && props.appointments.some((a) => a.id === id)) return openAppointment(id);
    const params = new URLSearchParams({ site: props.currentSiteId, date: dayKey, appt: id });
    if (props.from) params.set("from", props.from);
    router.push(`${props.basePath}?${params.toString()}`);
  };
  const locateAppointment = (id: string) => {
    // Each layout (desktop grid, tablet board, phone timeline) renders its own copy
    // of the card and only one is displayed — scroll to the one actually on screen.
    const el = [...document.querySelectorAll<HTMLElement>(`[data-appt-id="${CSS.escape(id)}"]`)].find(
      (node) => node.getClientRects().length > 0,
    );
    el?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    setFlashId(id);
    window.setTimeout(() => setFlashId((current) => (current === id ? null : current)), 1800);
  };
  const locateAppointmentRef = useRef(locateAppointment);
  useEffect(() => {
    locateAppointmentRef.current = locateAppointment;
  });
  // After "Cambiar fecha y hora": the moved appointment is highlighted on its new day
  // (stored across the navigation; consumed once it is actually drawn).
  useEffect(() => {
    let id: string | null = null;
    try {
      id = window.sessionStorage.getItem(FLASH_KEY);
    } catch {
      return;
    }
    if (!id || !props.appointments.some((a) => a.id === id)) return;
    const moved = id;
    const t = window.setTimeout(() => {
      try {
        window.sessionStorage.removeItem(FLASH_KEY);
      } catch {
        /* ignore */
      }
      locateAppointmentRef.current(moved);
    }, 350);
    return () => window.clearTimeout(t);
  }, [props.appointments]);

  // ── Derived, all from the loaded range ──────────────────────────────────────
  const visible = useMemo(
    () => (staffSel.length === 0 ? props.appointments : props.appointments.filter((a) => staffSel.includes(a.staff_id))),
    [props.appointments, staffSel],
  );
  const searchKey = searchQuery.trim().toLocaleLowerCase("es");
  /** Dimmed, never hidden: an unticked state, or not what the search asks for. */
  const isDimmed = (a: Appt): boolean => {
    if (!statesOn.includes(a.status)) return true;
    if (!searchKey) return false;
    return ![a.contact_name, a.guest_name, a.primary_identity, a.service_name, a.staff_name, a.public_reference]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase("es").includes(searchKey));
  };

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

  // The grid's window: the site's hours (the reference's 10:00–20:00 for a 10–20 site),
  // widened to every professional's own hours and to any appointment booked outside them,
  // so nothing is ever drawn off the grid.
  const { fromHour, toHour } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const take = (h: WeeklyHours | undefined) => {
      for (const ranges of Object.values(h ?? {})) for (const r of ranges ?? []) {
        lo = Math.min(lo, clockMinutes(r.start));
        hi = Math.max(hi, clockMinutes(r.end));
      }
    };
    take(props.openingHours);
    for (const st of props.staff) take(st.workingHours);
    for (const a of props.appointments) {
      const s = zonedParts(a.start_at, tz);
      const e = zonedParts(a.service_end_at, tz);
      lo = Math.min(lo, s.h * 60 + s.m);
      hi = Math.max(hi, e.dayKey === s.dayKey ? e.h * 60 + e.m : 24 * 60);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return { fromHour: GRID_FROM_HOUR, toHour: GRID_TO_HOUR };
    return { fromHour: Math.max(0, Math.floor(lo / 60)), toHour: Math.min(24, Math.ceil(hi / 60)) };
  }, [props.openingHours, props.staff, props.appointments, tz]);
  const hours = Array.from({ length: toHour - fromHour }, (_, i) => fromHour + i);
  /** Week reads in fixed hour BLOCKS, day in proportional minutes — one scale each. */
  const rowHeight = isWeek ? WEEK_HOUR_PX : HOUR_PX;
  const bodyHeight = (toHour - fromHour) * rowHeight;
  const offsetTop = (mins: number) => ((mins - fromHour * 60) / 60) * rowHeight;

  // Appointments that sit INSIDE a Time Off block (kept via the conflict flow) — flagged in
  // the agenda. An appointment conflicts with a block applying to its staff (or a site
  // closure) that overlaps its time.
  const conflictIds = useMemo(() => {
    const out = new Set<string>();
    for (const a of props.appointments) {
      if (a.status === "cancelled") continue;
      const aStart = Date.parse(a.start_at);
      const aEnd = Date.parse(a.service_end_at);
      for (const b of props.blocks) {
        if (b.staff_id !== null && b.staff_id !== a.staff_id) continue;
        if (aStart < Date.parse(b.ends_at) && aEnd > Date.parse(b.starts_at)) {
          out.add(a.id);
          break;
        }
      }
    }
    return out;
  }, [props.appointments, props.blocks]);

  /** The portion of a block inside ONE local day [dayStartIso, dayEndIso] as a positioned
   *  band, or null when it doesn't intersect that day. Clamps to the grid window exactly
   *  like appointment cards, and treats the exclusive end-midnight as the bottom of the grid. */
  const bandForDay = (b: Block, dayStartIso: string, dayEndIso: string) => {
    const dS = Date.parse(dayStartIso);
    const dE = Date.parse(dayEndIso);
    const bS = Date.parse(b.starts_at);
    const bE = Date.parse(b.ends_at);
    if (bE <= dS || bS >= dE) return null;
    const lo = fromHour * 60;
    const hi = toHour * 60;
    const startMin = bS <= dS ? lo : Math.min(Math.max(minutesOf(zonedParts(b.starts_at, tz)), lo), hi);
    const endMin = bE >= dE ? hi : Math.min(Math.max(minutesOf(zonedParts(b.ends_at, tz)), startMin), hi);
    if (endMin <= startMin) return null;
    return { top: offsetTop(startMin), height: Math.max(10, offsetTop(endMin) - offsetTop(startMin)), fullDay: startMin <= lo && endMin >= hi };
  };

  /** The "now" marker — only drawn when today is inside the rendered range. */
  const nowParts = zonedParts(new Date().toISOString(), tz);
  const weekDays = useMemo(() => {
    if (!isWeek) return [];
    const start = zonedParts(props.rangeStartIso, tz).dayKey;
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [isWeek, props.rangeStartIso, tz]);
  const shownDayKeys = isWeek ? weekDays : [zonedParts(props.dayStartIso, tz).dayKey];
  const nowVisible = shownDayKeys.includes(nowParts.dayKey) && nowParts.h >= fromHour && nowParts.h < toHour;
  const teamColors = staffColors(props.staff.map((s) => s.id));
  const weekCountsFromRange: Record<string, number> = {};
  for (const a of props.appointments) {
    if (a.status === "cancelled" || (props.lockStaffId && a.staff_id !== props.lockStaffId)) continue;
    const k = zonedParts(a.start_at, tz).dayKey;
    weekCountsFromRange[k] = (weekCountsFromRange[k] ?? 0) + 1;
  }


  // Picking a barber in the "Todo el equipo" facet collapses the grid to that column —
  // the job the removed chips used to do, using a control that already existed.
  const staffNameById = new Map(props.staff.map((s) => [s.id, s.name]));
  // The reference's avatar pastel follows the roster order (same order on every screen).
  const rosterIndex = new Map([...props.staff].sort((a, b) => a.name.localeCompare(b.name, "es")).map((s, i) => [s.id, i]));
  const tintOf = (id: string) => agTintAt(rosterIndex.get(id) ?? 0);
  /** The lane minute under a pointer on the 15-minute grid: the quarter it is in, or
   *  (`nearest`) the closest quarter-hour line — used for the edge being dragged. */
  const minuteAt = (el: HTMLElement, clientY: number, nearest = false) => {
    const y = clientY - el.getBoundingClientRect().top;
    const q = ((y / HOUR_PX) * 60) / 15;
    const raw = fromHour * 60 + (nearest ? Math.round(q) : Math.floor(q)) * 15;
    return Math.min(Math.max(raw, fromHour * 60), toHour * 60 - (nearest ? 0 : 15));
  };
  const hmOf = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  /** The painted range's start, and whether all of it is already in the past (then it is a
   *  service to RECORD, not a booking — the engine cannot book the past). */
  const slotStartIso = (sp: { from: number }) => new Date(Date.parse(siteMidnightIso(shownDayKeys[0], tz)) + sp.from * 60_000).toISOString();
  const slotEnded = (sp: { to: number; at?: number }) => sp.at !== undefined && Date.parse(siteMidnightIso(shownDayKeys[0], tz)) + sp.to * 60_000 <= sp.at;
  // The grid menu offers only what this login may do; a staff login, its own lane only.
  const canSlotMenu = (staffKey: string) =>
    (props.canOperate || props.canBlockStaff) && (!props.lockStaffId || props.lockStaffId === staffKey);
  const canPaint = props.canOperate || props.canBlockStaff;
  const painting = paint && canPaint && !isWeek;
  const shownStaff = staffSel.length > 0 ? props.staff.filter((s) => staffSel.includes(s.id)) : props.staff;
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
  }[] = shownStaff.map((st) => {
        // Avatar + name + TODAY'S LOAD, which is what the reference's professional
        // column header carries and what a receptionist scans the board for. The avatar
        // is the professional's public photo when Equipo has one, else the initials.
        // An INACTIVE barber still gets a lane (the server only includes them when
        // they have appointments in range) so their history stays reachable.
        const closed = !staffWorksOn(st.workingHours, props.openingHours, dayWeekday);
        const n = visible.filter((a) => a.staff_id === st.id && a.status !== "cancelled").length;
        const dS = Date.parse(props.dayStartIso);
        const dE = Date.parse(props.dayEndIso);
        const away = props.blocks.some((b) => b.staff_id === st.id && Date.parse(b.starts_at) <= dS && Date.parse(b.ends_at) >= dE);
        return {
          key: st.id,
          label: st.name,
          initial: st.name,
          photoUrl: st.photoUrl ?? null,
          inactive: !st.active,
          closed,
          sub: away ? "Ausencia" : closed ? "No trabaja" : `${n} cita${n === 1 ? "" : "s"}`,
        };
  });

  const inColumn = (a: Appt, colKey: string) =>
    isWeek ? zonedParts(a.start_at, tz).dayKey === colKey : a.staff_id === colKey;


  /** Local minutes of an ISO instant on the grid, clamped to the operating window. */
  const gridMin = (iso: string, dayKey: string, isEnd = false) => {
    const p = zonedParts(iso, tz);
    if (p.dayKey > dayKey || (isEnd && p.dayKey !== dayKey && p.h === 0 && p.m === 0)) return toHour * 60;
    if (p.dayKey < dayKey) return fromHour * 60;
    return Math.min(Math.max(minutesOf(p), fromHour * 60), toHour * 60);
  };
  const band = (sMin: number, eMin: number) => ({ top: offsetTop(sMin) + 1, height: Math.max(14, offsetTop(eMin) - offsetTop(sMin) - 2) });
  /** The pixel ranges the lane's appointment cards cover (as ApptCard draws them). */
  const cardRanges = (appts: Appt[]): Array<[number, number]> =>
    appts.map((x) => {
      const lo = fromHour * 60;
      const hi = toHour * 60;
      const sm = Math.min(Math.max(minutesOf(zonedParts(x.start_at, tz)), lo), hi);
      const em = Math.min(Math.max(minutesOf(zonedParts(x.service_end_at, tz)), sm), hi);
      const t = offsetTop(sm);
      return [t, t + Math.max(22, ((em - sm) / 60) * HOUR_PX)] as [number, number];
    });
  const rangesOf = (h: WeeklyHours | undefined, wd: string) =>
    (h?.[wd] ?? []).map((r) => ({ s: clockMinutes(r.start), e: clockMinutes(r.end) })).sort((a, b) => a.s - b.s);
  /** Gaps between ranges of one weekday = usual breaks that still live in the weekly hours. */
  const gapsOf = (h: WeeklyHours | undefined, wd: string) => {
    const r = rangesOf(h, wd);
    const out: Array<{ s: number; e: number }> = [];
    for (let i = 1; i < r.length; i++) if (r[i].s > r[i - 1].e) out.push({ s: r[i - 1].e, e: r[i].s });
    return out;
  };
  const openLegacyBreak = (ownerStaffId: string | null, dayKey: string, g: { s: number; e: number }) => {
    const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const wd = WEEKDAY_KEYS.indexOf(weekdayKeyOf(dayKey) as (typeof WEEKDAY_KEYS)[number]);
    setError(null);
    startTransition(async () => {
      const r = await adoptLegacyBreakAction({ clientId: props.clientId, siteId: props.currentSiteId, staffId: ownerStaffId, weekday: wd, start: hm(g.s), end: hm(g.e) });
      if (!r.ok) return setError(r.error);
      const mid = siteMidnightIso(dayKey, tz);
      setModal({
        mode: "series",
        occ: {
          key: `${r.seriesId}:${dayKey}`,
          seriesId: r.seriesId,
          kind: "break",
          staffId: ownerStaffId,
          date: dayKey,
          startsAt: new Date(Date.parse(mid) + g.s * 60_000).toISOString(),
          endsAt: new Date(Date.parse(mid) + g.e * 60_000).toISOString(),
          moved: false,
          reason: null,
          publicReason: null,
        },
      });
      router.refresh();
    });
  };
  /** Breaks, recurring blocks and out-of-hours for ONE professional's lane on ONE day. */
  const scheduleLayer = (staffKey: string, dayKey: string, laneClosed: boolean, cards: Array<[number, number]> = []) => {
    if (searchQuery.trim()) return null;
    const st = props.staff.find((x) => x.id === staffKey);
    const wd = weekdayKeyOf(dayKey);
    const nodes: React.ReactNode[] = [];
    // Outside this professional's hours the reference draws nothing (the lane is simply
    // not booked there); a day they don't work at all is one «No trabaja» tile (above).
    void laneClosed;
    // Breaks still stored as gaps in the weekly hours (site's apply to everyone).
    const legacy = [
      ...gapsOf(props.openingHours, wd).map((g) => ({ ...g, owner: null as string | null })),
      ...(st && hasAnyHours(st.workingHours) ? gapsOf(st.workingHours, wd).map((g) => ({ ...g, owner: st.id as string | null })) : []),
    ];
    for (const g of legacy) {
      if (g.e <= fromHour * 60 || g.s >= toHour * 60) continue;
      const b = band(Math.max(g.s, fromHour * 60), Math.min(g.e, toHour * 60));
      const editable = (g.owner ? props.canEditStaffBreaks : props.canEditSiteBreaks) && !laneClosed;
      const time = `${String(Math.floor(g.s / 60)).padStart(2, "0")}:${String(g.s % 60).padStart(2, "0")}–${String(Math.floor(g.e / 60)).padStart(2, "0")}:${String(g.e % 60).padStart(2, "0")}`;
      const label = `Pausa habitual · ${time}`;
      const body = <TimeTile title="Pausa habitual" time={time} top={b.top} height={b.height} cards={cards} />;
      nodes.push(
        editable ? (
          <button key={`lg-${g.owner}-${g.s}`} type="button" title={`${label} · Cambiar este día`} aria-label={`${label}. Cambiar este día`} onClick={() => openLegacyBreak(g.owner, dayKey, g)} className={`${TILE_BREAK} u-focus cursor-pointer hover:text-[var(--ag-ink2)]`} style={b}>
            {body}
          </button>
        ) : (
          <div key={`lg-${g.owner}-${g.s}`} title={label} className={TILE_BREAK} style={b}>
            {body}
          </div>
        ),
      );
    }
    for (const o of props.seriesOccurrences) {
      if (o.date !== dayKey || (o.staffId !== null && o.staffId !== staffKey)) continue;
      const sMin = gridMin(o.startsAt, dayKey);
      const eMin = gridMin(o.endsAt, dayKey, true);
      if (eMin <= sMin) continue;
      const b = band(sMin, eMin);
      const isBreak = o.kind === "break";
      const time = `${fmtTime(o.startsAt, tz)}–${fmtTime(o.endsAt, tz) === "00:00" ? "24:00" : fmtTime(o.endsAt, tz)}`;
      const title = isBreak ? "Pausa habitual" : `${o.staffId ? "Bloqueado" : "Sede cerrada"}${o.reason ? ` · ${o.reason}` : ""}`;
      const label = `${title} · ${time}`;
      nodes.push(
        <button
          key={o.key}
          type="button"
          title={o.moved ? `${label} · cambiado solo este día` : label}
          aria-label={`${label}${o.moved ? ", cambiado solo este día" : ""}. Abrir`}
          onClick={() => setModal({ mode: "series", occ: o })}
          className={`${isBreak ? TILE_BREAK : o.staffId ? TILE_BLOCK : TILE_BLOCK.replace("u-sch-block", "u-sch-closed")} u-focus cursor-pointer hover:text-[var(--ag-ink2)]`}
          style={b}
        >
          <TimeTile title={title} time={o.moved ? `${time} · solo este día` : time} top={b.top} height={b.height} cards={cards} />
        </button>,
      );
    }
    return nodes;
  };
  const selected = selectedId ? props.appointments.find((a) => a.id === selectedId) ?? null : null;
  /** md+: «Reagendar» lives inside the appointment's panel; the phone keeps its flow. */
  const deskReschedule = modal?.mode === "reschedule" && !isPhoneWidth ? modal.appt : null;
  const openWeekdays = new Set(Object.entries(props.openingHours).filter(([, r]) => (r?.length ?? 0) > 0).map(([k]) => k));
  const afterReschedule = (dayKey: string, appointmentId: string) => {
    setModal(null);
    setSelectedId(null);
    setNotice("Cita reagendada");
    // Highlight it once it is drawn on its new day (this page or the next one).
    try {
      window.sessionStorage.setItem(FLASH_KEY, appointmentId);
    } catch {
      /* private mode: the highlight is a nicety */
    }
    if (props.returnContactId) return router.push(`/clients/${props.clientId}/contacts/${props.returnContactId}`);
    if (dayKey !== props.date) return navigate({ date: dayKey });
    router.refresh();
  };
  const rescheduleConfig = () => ({
    clientId: props.clientId,
    siteId: props.currentSiteId,
    staff: props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, photoUrl: s.photoUrl, tint: tintOf(s.id) })),
    openWeekdays,
    lockStaffId: props.lockStaffId,
    onDone: ({ dayKey, appointmentId }: { dayKey: string; appointmentId: string }) => afterReschedule(dayKey, appointmentId),
  });

  if (props.staff.length === 0) {
    return (
      <main className="flex min-h-0 flex-1 flex-col gap-[var(--content-pad)]">
        <div className="rounded-lg border border-dashed border-line-strong bg-surface px-5 py-8">
          {props.canManage ? (
            <p className="text-sm text-muted">
              Aún no hay personal en esta sede.{" "}
              <Link href={`/clients/${props.clientId}/scheduling/staff`} className="text-accent hover:underline">
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
    <main className="u-ag flex min-h-0 flex-1 flex-col">
      {/* PHONE (< md) — its own layout, not the grid squeezed (mobile/MobileAgenda). */}
      <div className="-m-[var(--content-pad)] md:hidden">
        <MobileAgenda
          pendingCharges={props.canViewPayments ? { count: props.appointments.filter((x) => x.payment_state === "pending").length, onOpen: () => setPendingList(true) } : undefined}
          title={props.lockStaffId ? "Mi agenda" : "Agenda"}
          subtitle={
            props.lockStaffId
              ? [props.staff.find((s) => s.id === props.lockStaffId)?.name, currentSite?.name].filter(Boolean).join(" · ")
              : currentSite?.name ?? ""
          }
          badge={initialsOf(props.clientName)}
          timezone={tz}
          date={props.date}
          todayKey={nowParts.dayKey}
          view={isWeek ? "week" : "day"}
          appointments={props.appointments}
          weekCounts={isWeek ? weekCountsFromRange : props.weekCounts}
          blocks={[
            ...props.blocks,
            ...props.seriesOccurrences.map((o) => ({ id: o.key, staff_id: o.staffId, starts_at: o.startsAt, ends_at: o.endsAt, reason: o.reason, series: o.kind })),
          ]}
          onOpenSeries={(key) => {
            const occ = props.seriesOccurrences.find((o) => o.key === key);
            if (occ) setModal({ mode: "series", occ });
          }}
          onOpenBlock={(id) => {
            const b = props.blocks.find((x) => x.id === id);
            if (b && (b.staff_id ? props.canBlockStaff : props.canBlockSite)) setModal({ mode: "editBlock", block: b });
          }}
          staff={props.staff}
          openingHours={props.openingHours}
          showTeam={!props.lockStaffId && props.staff.length > 1}
          ownStaffId={props.lockStaffId}
          canBook={props.canOperate}
          initialStaffFilter={props.initialStaffId ? [props.initialStaffId] : []}
          onNavigate={(patch) => navigate(patch)}
          onOpen={openAppointment}
          onNew={() => setModal({ mode: "new" })}
          onBlock={props.canBlockStaff || props.canBlockSite ? () => setModal({ mode: "block" }) : undefined}
        />
      </div>
      {/* Desktop/tablet: the same short confirmation ("Cita reprogramada", "Cita creada"),
          in the Scheduling system's colours. */}
      {notice ? (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[90] hidden min-h-[44px] -translate-x-1/2 items-center gap-2 rounded-sch-control bg-foreground px-4 text-sm text-background shadow-[var(--shadow-float)] md:flex">
          <span aria-hidden>✓</span>
          {notice}
        </div>
      ) : null}
      <div className="md:hidden">
        <MToast message={notice} bottom={84} />
      </div>
      {pendingList && props.canViewPayments ? (
          <PendingChargesPanel
            clientId={props.clientId}
            timezone={tz}
            onClose={() => setPendingList(false)}
            onOpen={({ appointmentId, dayKey }) => {
              setPendingList(false);
              const params = new URLSearchParams({ site: props.currentSiteId, date: dayKey, appt: appointmentId });
              router.push(`${props.basePath}?${params.toString()}`);
            }}
          />
        ) : null}

      {/* ── DESKTOP / TABLET (md+) — the approved reference (E1–E4): ONE surface flush to the
             shell frame. The title IS the date (it opens a month picker); the tools sit on
             its right: Día | Semana, ‹ Hoy ›, «Más opciones de agenda» (filtros, bloqueos,
             ausencias, horarios, equipo) and + Nueva cita. Below, the grid by professional
             (day) or the week board by professional (week). */}
      <div className="u-ag -m-[var(--content-pad)] flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface)] max-md:hidden">
        <div className={`${AG_HEAD_CAL} relative z-30`}>
          <DateTitle
            label={agendaTitle(isWeek ? "week" : "day", props.date, weekDays[0])}
            date={props.date}
            today={nowParts.dayKey}
            onPick={(d) => navigate({ date: d })}
          />
          <span className="min-w-0 flex-1" />
          {searchOpen || searchQuery ? (
            <label className="flex h-[32px] w-[240px] min-w-[44px] shrink items-center gap-2 rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-muted">
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="7" cy="7" r="4.6" />
                <path d="M10.4 10.4L14 14" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                aria-label="Buscar cliente o servicio"
                placeholder="Cliente o servicio"
                value={searchQuery}
                autoFocus={searchOpen && !searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearchQuery("");
                    setSearchOpen(false);
                  }
                }}
                onBlur={() => {
                  if (!searchQuery) setSearchOpen(false);
                }}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted"
              />
            </label>
          ) : (
            <button type="button" aria-label="Buscar cliente o servicio" title="Buscar (⌘F)" onClick={() => setSearchOpen(true)} className={TB_ICON}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.6" />
                <path d="M10.4 10.4L14 14" />
              </svg>
            </button>
          )}
          {canPaint && !isWeek ? (
            <button
              type="button"
              aria-pressed={paint}
              aria-label={paint ? "Dejar de pintar en la agenda" : "Pintar en la agenda: arrastra para crear una cita o bloquear horario"}
              title={paint ? "Dejar de pintar (Esc)" : "Pintar: arrastra en la agenda para crear o bloquear"}
              onClick={() => {
                setPaint((v) => !v);
                setSlotPop(null);
              }}
              className={`${TB_ICON} ${paint ? "!border-[var(--ink)] !bg-[var(--ink)] !text-[var(--ink-fg)]" : ""}`}
            >
              <svg aria-hidden viewBox="0 0 16 16" className="size-[15px]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13.6 2.4a1.2 1.2 0 0 0-1.7 0L7.2 7.1l1.7 1.7 4.7-4.7a1.2 1.2 0 0 0 0-1.7z" />
                <path d="M6.6 8.1c-1.3 0-2.3 1-2.3 2.3 0 1.2-.8 2-1.9 2.2 .7 1 1.8 1.4 3 1.4 1.9 0 3.3-1.4 3.3-3.3L6.6 8.1z" />
              </svg>
            </button>
          ) : null}
          <div role="group" aria-label="Vista" className="flex h-[32px] shrink-0 gap-0.5 rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] p-[2px]">
            {(
              [
                ["day", "D", "Día"],
                ["week", "S", "Semana"],
              ] as const
            ).map(([k, letter, full]) => {
              const on = (k === "week") === isWeek;
              return (
                <button
                  key={k}
                  type="button"
                  aria-label={full}
                  title={full}
                  aria-pressed={on}
                  onClick={() => navigate({ view: k })}
                  className={`u-focus h-full w-[34px] rounded-[6px] text-[13px] transition-colors ${on ? "bg-[var(--ag-segact-bg)] font-medium text-[var(--ag-segact-fg)]" : "text-[var(--ag-ink2)] hover:bg-[var(--subtle)]"}`}
                >
                  {letter}
                </button>
              );
            })}
          </div>
          <div className="flex h-[32px] shrink-0 items-center overflow-hidden rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)]">
            <button type="button" aria-label={isWeek ? "Semana anterior" : "Día anterior"} onClick={() => shiftDate(isWeek ? -7 : -1)} className="u-focus inline-flex h-full w-[32px] items-center justify-center text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
            </button>
            <button type="button" onClick={() => navigate({ date: nowParts.dayKey })} className="u-focus h-full px-2.5 text-[13px] text-foreground hover:bg-[var(--subtle)]">
              Hoy
            </button>
            <button type="button" aria-label={isWeek ? "Semana siguiente" : "Día siguiente"} onClick={() => shiftDate(isWeek ? 7 : 1)} className="u-focus inline-flex h-full w-[32px] items-center justify-center text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
            </button>
          </div>
          <GearMenu
            badge={activeFilters > 0}
            filters={{
              label: activeFilters > 0 ? `Filtros · ${activeFilters} activos` : "Filtrar",
              sub: "Profesionales y estados",
              content: (
                <FiltersPopover
                  value={{ staff: staffSel, states: statesOn }}
                  families={serviceLegend}
                  people={props.staff.map((st) => ({ id: st.id, name: st.name, photoUrl: st.photoUrl ?? null }))}
                  tintOf={tintOf}
                  onChange={(v) => {
                    setStaffSel(v.staff);
                    setStatesOn(v.states);
                  }}
                />
              ),
            }}
            items={[
              ...(props.canBlockStaff || props.canBlockSite
                ? [{ label: "Bloquear horario", sub: "Puntual o recurrente", onSelect: () => setModal({ mode: "block", staffId: staffSel.length === 1 ? staffSel[0] : undefined }) }]
                : []),
              ...(props.canOperate ? [{ label: "Atención sin cita", sub: "Alguien que llegó sin reserva", onSelect: () => setModal({ mode: "walkin" }) }] : []),
              ...(props.canViewPayments ? [{ label: "Cobros pendientes", sub: "Citas completadas sin cobro registrado", onSelect: () => setPendingList(true) }] : []),
              { label: "Horarios y ausencias", sub: "Horario de sede y de cada profesional", onSelect: () => router.push(`/clients/${props.clientId}/scheduling/hours`) },
              { label: "Equipo", sub: "Profesionales y sus servicios", onSelect: () => router.push(`/clients/${props.clientId}/scheduling/staff`) },
              ...(props.sites.length > 1
                ? props.sites
                    .filter((st) => st.id !== props.currentSiteId)
                    .map((st) => ({ label: `Ver ${st.name}`, sub: "Cambiar de sede", onSelect: () => navigate({ site: st.id }) }))
                : []),
            ]}
          />
          {props.canOperate ? (
            <button type="button" onClick={() => setModal({ mode: "new" })} className={TB_PRIMARY}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>
              Nueva cita
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mx-6 mb-3 rounded-[10px] bg-[var(--ag-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ag-danger-ink)]">
            {error}
          </p>
        ) : null}
        {/* The grid sits in its OWN frame (8px from the surface, hairline, 12px radius): that
            frame — not a rule under the bar — separates the tools from the calendar. Día clips
            to the frame; Semana does not (its board scrolls, and rounds its own corners). */}
        <div className={`relative mx-2 mb-2 flex min-h-0 flex-1 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] ${isWeek ? "" : "overflow-hidden"}`}>
          {/* «Pintar» hint: floats over the grid's header row, so turning the brush on moves
              nothing on screen (no reflow, no scroll change). */}
          {painting ? (
            <span role="status" aria-live="polite" className="u-pop-in pointer-events-none absolute left-1/2 top-[7px] z-[30] -translate-x-1/2 whitespace-nowrap rounded-[8px] bg-[var(--ink)] px-3 py-1.5 text-[13px] text-[var(--ink-fg)] shadow-[0_6px_18px_rgba(0,0,0,0.16)]">
              Arrastra sobre la agenda para crear una cita o bloquear horario · Esc para salir
            </span>
          ) : null}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[11px]">
            {isWeek ? (
              <WeekTeamBoard
                days={weekDays}
                staff={shownStaff}
                appointments={visible}
                openingHours={props.openingHours}
                timezone={tz}
                today={nowParts.dayKey}
                selectedId={selectedId}
                flashId={flashId}
                blocks={props.blocks}
                seriesOccurrences={props.seriesOccurrences}
                dimmed={isDimmed}
                conflictIds={conflictIds}
                tintOf={tintOf}
                previewFor={previewProps}
                onOpen={openAppointment}
                onDay={(date) => navigate({ date, view: "day" })}
                onMore={(appointments, title) => {
                  setWeekOverflowTitle(title);
                  setWeekOverflow(appointments);
                }}
              />
            ) : (
              <div className="min-h-0 flex-1 overflow-auto" aria-label="Agenda del día por profesional">
                <div className="flex min-w-full">
                  <div className="sticky left-0 z-20 w-[60px] shrink-0 bg-[var(--surface)]">
                    <div className="sticky top-0 z-10 flex h-[44px] items-end justify-end border-b border-[var(--line)] bg-[var(--surface)] pb-2.5 pr-2.5">
                      <span className="text-[10.5px] text-muted">{gmtLabel(tz)}</span>
                    </div>
                    <div className="relative" style={{ height: bodyHeight }}>
                      {hours.map((h) => (
                        <span key={h} className="absolute right-2.5 text-[11px] tabular-nums text-muted" style={{ top: offsetTop(h * 60) + 6 }}>
                          {`${String(h).padStart(2, "0")}:00`}
                        </span>
                      ))}
                      {nowVisible ? (
                        <>
                          <span aria-hidden className="absolute right-0 left-[52px] z-[6] h-0 shadow-[0_0_0_1px_var(--foreground)]" style={{ top: offsetTop(minutesOf(nowParts)) }} />
                          <span aria-hidden className="absolute left-1 z-[7] flex h-[18px] items-center rounded-[5px] bg-[var(--foreground)] px-[5px] text-[10.5px] tabular-nums text-[var(--surface)]" style={{ top: offsetTop(minutesOf(nowParts)) - 9 }}>
                            {`${String(nowParts.h).padStart(2, "0")}:${String(nowParts.m).padStart(2, "0")}`}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {columns.map((col) => {
                    const columnAppointments = visible.filter((appt) => inColumn(appt, col.key));
                    const dayLanes = layoutDayLanes(columnAppointments);
                    const laneCards = cardRanges(columnAppointments);
                    return (
                      <div key={col.key} className="min-w-[12.5rem] flex-1 border-l border-[var(--line)]">
                        <div className="sticky top-0 z-10 flex h-[44px] items-center gap-2 border-b border-[var(--line)] bg-[var(--surface)] px-3">
                          <AgAvatar name={col.label} id={col.key} size={24} tint={tintOf(col.key)} photoUrl={(col as { photoUrl?: string | null }).photoUrl ?? null} />
                          <span className="flex min-w-0 flex-col leading-tight">
                            <span className="truncate text-[13.5px] font-medium text-foreground">{col.label}</span>
                            <span className="truncate text-[12px] text-muted">{col.sub}</span>
                          </span>
                          {col.inactive ? (
                            <span
                              title="Este profesional está inactivo — sus citas existentes siguen visibles aquí, pero no puede recibir nuevas reservas. Reactívalo en Agenda → Equipo."
                              className="ml-auto shrink-0 rounded-[6px] bg-[var(--chip)] px-2 py-0.5 text-[11.5px] text-[var(--ag-ink2)]"
                            >
                              Inactivo
                            </span>
                          ) : null}
                        </div>
                        <div
                          className={`relative select-none ${painting && canSlotMenu(col.key) ? "cursor-crosshair" : ""}`}
                          style={{ height: bodyHeight }}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || !painting || !canSlotMenu(col.key) || (e.target as Element).closest("button,a,[data-slot-menu]")) return;
                            const el = e.currentTarget;
                            const touch = e.pointerType !== "mouse";
                            const anchor = minuteAt(el, e.clientY);
                            const last = col.key === columns[columns.length - 1]?.key;
                            const begin = () => {
                              const d = dragRef.current;
                              if (!d) return;
                              d.live = true;
                              try {
                                d.el.setPointerCapture(d.pointerId);
                              } catch {
                                /* the pointer is already gone */
                              }
                              if (d.touch) {
                                try {
                                  navigator.vibrate?.(12);
                                } catch {
                                  /* no haptics */
                                }
                              }
                              setSlotPop({ staffId: d.staffId, from: d.anchor, to: d.anchor + 15, last: d.last, dragging: true, dragged: false });
                            };
                            dragRef.current = { staffId: col.key, anchor, x: e.clientX, y: e.clientY, timer: null, live: false, moved: false, el, touch, last, pointerId: e.pointerId };
                            if (touch) dragRef.current.timer = window.setTimeout(begin, 350);
                            else begin();
                          }}
                          onPointerMove={(e) => {
                            const d = dragRef.current;
                            if (!d) return;
                            const far = Math.abs(e.clientY - d.y) > 6 || Math.abs(e.clientX - d.x) > 6;
                            if (!d.live) {
                              // A touch that moves before the long press is a scroll, not a selection.
                              if (far && d.timer) {
                                window.clearTimeout(d.timer);
                                dragRef.current = null;
                              }
                              return;
                            }
                            if (far) d.moved = true;
                            // The far edge follows the pointer to the NEAREST quarter hour, never
                            // shorter than the 15 minutes pressed: 15 min is the shortest selection.
                            const m = minuteAt(d.el, e.clientY);
                            const exact = minuteAt(d.el, e.clientY, true);
                            const from = Math.min(d.anchor, m);
                            const to = Math.min(toHour * 60, m < d.anchor ? d.anchor + 15 : Math.max(d.anchor + 15, exact));
                            setSlotPop((cur) => (cur && cur.dragging && (cur.from !== from || cur.to !== to) ? { ...cur, from, to, dragged: d.moved } : cur));
                          }}
                          onPointerUp={() => {
                            const d = dragRef.current;
                            dragRef.current = null;
                            if (!d) return;
                            if (d.timer) window.clearTimeout(d.timer);
                            if (!d.live) return;
                            // A click marks the quarter hour pressed (15 min); a drag marks what it covers.
                            const at = Date.now();
                            setSlotPop((cur) => (cur ? { ...cur, dragging: false, dragged: d.moved, at } : cur));
                          }}
                          onPointerCancel={() => {
                            const d = dragRef.current;
                            if (d?.timer) window.clearTimeout(d.timer);
                            dragRef.current = null;
                            setSlotPop((cur) => (cur?.dragging ? null : cur));
                          }}
                        >
                          {bookingGhost && bookingGhost.staffId === col.key && siteDayKey(bookingGhost.startAt, tz) === shownDayKeys[0] ? (() => {
                            const p = zonedParts(bookingGhost.startAt, tz);
                            const m0 = p.h * 60 + p.m;
                            const clash = columnAppointments.some((a) => a.status !== "cancelled" && !(bookingGhost.past && a.status === "no_show") && Date.parse(a.start_at) < Date.parse(bookingGhost.startAt) + bookingGhost.durationMin * 60_000 && Date.parse(a.service_end_at) > Date.parse(bookingGhost.startAt));
                            return (
                              <div aria-hidden data-booking-ghost="" className={`u-ag-ghost pointer-events-none absolute inset-x-[3px] z-[7] flex flex-col gap-0.5 overflow-hidden rounded-[10px] border-[1.5px] border-dashed px-3 py-2 text-[12.5px] ${clash ? "border-[var(--danger)] bg-[var(--ag-danger-soft)] text-[var(--ag-danger-ink)]" : "border-[var(--foreground)] bg-[var(--ag-break)] text-foreground"}`} style={{ top: offsetTop(m0) + 1.5, height: Math.max(22, (bookingGhost.durationMin / 60) * HOUR_PX - 3) }}>
                                <span className="truncate font-medium">{bookingGhost.label}</span>
                                <span className="tabular-nums">{hmOf(m0)}–{hmOf(m0 + bookingGhost.durationMin)}{clash ? " · se cruza con otra cita" : ""}</span>
                              </div>
                            );
                          })() : null}
                          {slotPop && slotPop.staffId === col.key ? (
                            <SlotMenu
                              top={offsetTop(slotPop.from)}
                              height={((slotPop.to - slotPop.from) / 60) * HOUR_PX}
                              dragging={slotPop.dragging}
                              alignRight={slotPop.last && columns.length > 1}
                              label={`${hmOf(slotPop.from)} – ${hmOf(slotPop.to)} · ${slotPop.to - slotPop.from} min`}
                              from={hmOf(slotPop.from)}
                              to={hmOf(slotPop.to)}
                              onNew={
                                props.canOperate && !slotEnded(slotPop)
                                  ? () => {
                                      const span = slotPop.dragged ? slotPop.to - slotPop.from : undefined;
                                      setSlotPop(null);
                                      setModal({ mode: "new", staffId: col.key, startAt: slotStartIso(slotPop), spanMin: span });
                                    }
                                  : null
                              }
                              onDone={
                                props.canOperate && slotEnded(slotPop)
                                  ? () => {
                                      setSlotPop(null);
                                      setModal({ mode: "walkin", done: true, staffId: col.key, startAt: slotStartIso(slotPop), spanMin: slotPop.to - slotPop.from });
                                    }
                                  : null
                              }
                              onBlock={
                                props.canBlockStaff
                                  ? () => {
                                      setSlotPop(null);
                                      setModal({ mode: "block", staffId: col.key, date: shownDayKeys[0], start: hmOf(slotPop.from), end: hmOf(slotPop.to) });
                                    }
                                  : null
                              }
                              onClose={() => setSlotPop(null)}
                            />
                          ) : null}
                          {hours.map((h) => (
                            <Fragment key={h}>
                              {h > fromHour ? <div aria-hidden className="absolute inset-x-0 border-t border-[var(--line-soft)]" style={{ top: offsetTop(h * 60) }} /> : null}
                              <div aria-hidden className="absolute inset-x-0 border-t border-[var(--line-soft)]" style={{ top: offsetTop(h * 60 + 30) }} />
                            </Fragment>
                          ))}
                          {col.closed ? (
                            <div className={`${hasAnyHours(props.openingHours) && !opensOn(props.openingHours, dayWeekday) ? "u-sch-closed" : "u-sch-block"} absolute inset-[3px] rounded-[8px] px-2.5 py-1.5 text-[12px] font-medium`}>
                              {hasAnyHours(props.openingHours) && !opensOn(props.openingHours, dayWeekday) ? "Sede cerrada" : "No trabaja"}
                            </div>
                          ) : null}
                          {props.blocks
                            .filter((b) => b.staff_id === col.key || b.staff_id === null)
                            .map((b) => {
                              const bd = bandForDay(b, props.dayStartIso, props.dayEndIso);
                              if (!bd) return null;
                              const siteWide = b.staff_id === null;
                              return (
                                <BlockBand
                                  key={b.id}
                                  top={bd.top}
                                  height={bd.height}
                                  siteWide={siteWide}
                                  fullDay={bd.fullDay}
                                  time={blockSpanLabel(b.starts_at, b.ends_at, tz).text}
                                  reason={b.reason}
                                  editable={siteWide ? props.canBlockSite : props.canBlockStaff}
                                  cards={laneCards}
                                  onOpen={() => setModal({ mode: "editBlock", block: b })}
                                />
                              );
                            })}
                          {scheduleLayer(col.key, shownDayKeys[0], col.closed === true, laneCards)}
                          {nowVisible ? (
                            <div aria-hidden className="pointer-events-none absolute inset-x-0 z-[5] h-0 shadow-[0_0_0_1px_var(--foreground)]" style={{ top: offsetTop(minutesOf(nowParts)) }} />
                          ) : null}
                          {columnAppointments.map((a) => {
                            const lo = fromHour * 60;
                            const hi = toHour * 60;
                            const startMin = Math.min(Math.max(minutesOf(zonedParts(a.start_at, tz)), lo), hi);
                            const endMin = Math.min(Math.max(minutesOf(zonedParts(a.service_end_at, tz)), startMin), hi);
                            return (
                              <ApptCard
                                key={a.id}
                                appt={a}
                                toneClass={appointmentToneClass(a)}
                                tz={tz}
                                top={offsetTop(startMin)}
                                height={Math.max(22, ((endMin - startMin) / 60) * HOUR_PX)}
                                lane={dayLanes.get(a.id)}
                                overlapping={overlapIds.has(a.id)}
                                conflict={conflictIds.has(a.id)}
                                selected={a.id === selectedId}
                                flash={a.id === flashId}
                                dim={isDimmed(a)}
                                previewProps={previewProps(a)}
                                onOpen={() => openAppointment(a.id)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {/* Room for the booking panel: the draft's lane can slide into view beside it. */}
                  {bookingGhost && modal?.mode === "new" ? <div aria-hidden className="w-[532px] shrink-0" /> : null}
                </div>
              </div>
            )}
          </section>

        {(selected || deskReschedule) && !formReschedule ? (() => {
          const appt = (deskReschedule ?? selected) as Appt;
          if (charge && charge.apptId === appt.id && !deskReschedule) {
            return (
              <ChargePanel
                key={`charge:${appt.id}:${charge.mode}`}
                clientId={props.clientId}
                appt={appt}
                timezone={tz}
                mode={charge.mode}
                toneClass={appointmentToneClass(appt)}
                onClose={() => setCharge(null)}
                onDone={(m) => {
                  setCharge(null);
                  setNotice(m);
                  // Highlight the card once the server-confirmed state is drawn.
                  try {
                    window.sessionStorage.setItem(FLASH_KEY, appt.id);
                  } catch {
                    /* nicety */
                  }
                  router.refresh();
                }}
                onCompleteWithout={
                  charge.mode === "complete"
                    ? () => {
                        setCharge(null);
                        run(() => completeAppointmentAction(props.clientId, appt.id), "Cita completada · cobro pendiente");
                      }
                    : undefined
                }
              />
            );
          }
          return (
          <AppointmentPanel
            key={`${appt.id}:${deskReschedule ? "r" : "d"}`}
            appt={appt}
            timezone={tz}
            toneClass={appointmentToneClass(appt)}
            siteName={currentSite?.name ?? "Sede actual"}
            originLabel={ORIGIN_LABEL[appt.origin] ?? (appt.origin || "—")}
            canOperate={props.canOperate}
            canModify={appt.can_modify}
            covered={false}
            pending={pending}
            error={error}
            review={appt.review}
            startInReschedule={Boolean(deskReschedule)}
            reschedule={rescheduleConfig()}
            onContactSaved={(m) => {
              setNotice(m);
              router.refresh();
            }}
            contactHref={appt.contact_id && props.contactsBase ? `${props.contactsBase}/${appt.contact_id}${fromQS}` : null}
            conversationHref={
              appt.source_conversation_id && props.inboxBase
                ? `${props.inboxBase}?c=${encodeURIComponent(appt.source_conversation_id)}`
                : null
            }
            // "Volver a reservar": the existing book-for-contact deep link (the page only
            // honours it with CRM on and the contact in this client).
            bookAgainHref={
              props.canOperate && appt.contact_id && props.contactsBase
                ? `${props.basePath}?site=${encodeURIComponent(props.currentSiteId)}&book=${encodeURIComponent(appt.contact_id)}`
                : null
            }
            onClose={() => {
              setSelectedId(null);
              if (deskReschedule) setModal(null);
              // Focus goes back to the card that opened it (the panel's own opener may be gone,
              // e.g. after «Reagendar» replaced the detail).
              window.requestAnimationFrame(() => {
                const card = [...document.querySelectorAll<HTMLElement>(`[data-appt-card][data-appt-id="${CSS.escape(appt.id)}"]`)].find((n) => n.getClientRects().length > 0);
                card?.focus({ preventScroll: true });
              });
            }}
            onLocate={() => locateAppointment(appt.id)}
            onReschedule={() => setModal({ mode: "reschedule", appt })}
            payment={
              props.canViewPayments
                ? {
                    clientId: props.clientId,
                    canRecord: Boolean(props.canRecordPayments) && appt.can_modify,
                    canVoid: Boolean(props.canVoidPayments),
                    onRecord: () => setCharge({ apptId: appt.id, mode: "record" }),
                    onChanged: (m) => {
                      setNotice(m);
                      router.refresh();
                    },
                  }
                : null
            }
            onStatus={(target, reason) =>
              // «Completar cita» opens the charge step for whoever may record money; anyone else
              // completes as before (the appointment then reads «Cobro pendiente»).
              target === "completed" && props.canRecordPayments
                ? setCharge({ apptId: appt.id, mode: "complete" })
                : run(
                () =>
                  target === "confirmed"
                    ? confirmAppointmentAction(props.clientId, appt.id)
                    : target === "completed"
                      ? completeAppointmentAction(props.clientId, appt.id)
                      : target === "no_show"
                        ? noShowAppointmentAction(props.clientId, appt.id)
                        : cancelAppointmentAction(props.clientId, appt.id, reason),
                target === "confirmed" ? "Cita confirmada" : target === "completed" ? "Cita completada" : target === "no_show" ? "Inasistencia registrada" : "Cita cancelada",
              )
            }
            staffColor={teamColors.get(appt.staff_id)}
            staffTint={tintOf(appt.staff_id)}
            loadActivity={() => listAppointmentActivityAction(props.clientId, appt.id)}
            loadReviewLink={() => getReviewLinkAction(props.clientId, appt.id)}
          />
          );
        })() : null}
        {preview && !selected && !modal ? (
          <AppointmentPreview
            id="appt-preview"
            appt={preview.appt}
            timezone={tz}
            // What a short card cannot spell out: the review reasons (the server's labels, plus
            // the block it sits in when the calendar sees one).
            reviewReasons={[...new Set([...preview.appt.review, ...(conflictIds.has(preview.appt.id) ? ["Dentro de una ausencia o bloqueo"] : [])])]}
            anchor={preview.rect}
            onPointerEnter={keepPreview}
            onPointerLeave={hidePreviewSoon}
          />
        ) : null}
      </div>
        {/* The 20-second refresh keeps running; the reference shows no indicator for it. */}
        <div className="sr-only">
          <AutoRefresh intervalSeconds={20} />
        </div>
      </div>

      {/* PHONE «Cambiar fecha y hora» — the full-screen two-step flow. From md up the same
          move happens INSIDE the appointment's panel (AppointmentPanel → RescheduleInline). */}
      {modal && modal.mode === "reschedule" && props.canOperate && isPhoneWidth ? (
        <RescheduleFlow
          clientId={props.clientId}
          siteId={props.currentSiteId}
          siteName={currentSite?.name ?? ""}
          timezone={tz}
          openWeekdays={openWeekdays}
          appt={modal.appt}
          staff={props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, photoUrl: s.photoUrl, tint: tintOf(s.id) }))}
          lockStaffId={props.lockStaffId}
          onClose={() => setModal(null)}
          onDone={({ dayKey, appointmentId }) => afterReschedule(dayKey, appointmentId)}
        />
      ) : null}

      {modal && modal.mode === "new" && props.canOperate ? (
        <AppointmentModal
          {...props}
          modal={modal}
          onClose={() => setModal(null)}
          onError={setError}
          error={error}
          onNotice={setNotice}
          onWalkIn={(context) => setModal({ mode: "walkin", ...context })}
          onDraft={setBookingGhost}
          onDone={(dayKey, createdId) => {
            setModal(null);
            if (createdId) {
              try {
                window.sessionStorage.setItem(FLASH_KEY, createdId);
              } catch {
                /* private mode: the highlight is a nicety */
              }
            }
            if (dayKey && dayKey !== props.date && !props.returnContactId) return navigate({ date: dayKey });
            // Deep-linked from a contact record → return there so the new/moved
            // appointment is visible in context; otherwise just refresh the agenda.
            if (props.returnContactId) router.push(`/clients/${props.clientId}/contacts/${props.returnContactId}`);
            else router.refresh();
          }}
        />
      ) : null}

      {modal && modal.mode === "walkin" && props.canOperate ? (
        <WalkInPanel
          clientId={props.clientId}
          siteId={props.currentSiteId}
          siteName={currentSite?.name ?? ""}
          timezone={tz}
          staff={props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, photoUrl: s.photoUrl, tint: tintOf(s.id) }))}
          services={props.services}
          lockStaffId={props.lockStaffId}
          viewDate={props.date}
          initial={{ staffId: modal.staffId, startAt: modal.startAt, spanMin: modal.spanMin, serviceId: modal.serviceId, done: modal.done }}
          onClose={() => setModal(null)}
          onSwitchToBooking={(context) => setModal({ mode: "new", ...context, done: undefined })}
          onOpenAppointment={openExisting}
          onDraft={setBookingGhost}
          onDone={({ id, dayKey, message, warning }) => {
            setModal(null);
            setNotice(warning ?? message);
            try {
              window.sessionStorage.setItem(FLASH_KEY, id);
            } catch {
              /* nicety */
            }
            if (dayKey !== props.date) return navigate({ date: dayKey });
            router.refresh();
          }}
        />
      ) : null}

      {/* Blocks / absences — puntual or recurring, one panel (agenda/BlockPanel). Kept
          mounted (hidden) while one of its affected appointments is rescheduled. */}
      {modal && (modal.mode === "block" || modal.mode === "editBlock") && (props.canBlockStaff || props.canBlockSite) ? (
        <BlockPanel
          clientId={props.clientId}
          siteId={props.currentSiteId}
          siteName={currentSite?.name ?? ""}
          timezone={tz}
          staff={props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))}
          canSiteClosure={props.canBlockSite}
          canStaffTimeOff={props.canBlockStaff}
          fixedStaffId={modal.mode === "block" ? props.lockStaffId ?? null : null}
          initialStaffId={modal.mode === "block" ? modal.staffId ?? null : null}
          initialDate={modal.mode === "block" ? modal.date ?? props.date : undefined}
          initialStart={modal.mode === "block" ? modal.start : undefined}
          initialEnd={modal.mode === "block" ? modal.end : undefined}
          edit={modal.mode === "editBlock" ? modal.block : undefined}
          hidden={Boolean(formReschedule)}
          recheck={recheck}
          onReschedule={(item, holds) => setFormReschedule({ apptId: item.id, holds, item })}
          onClose={() => setModal(null)}
          onSaved={(m) => {
            setModal(null);
            setNotice(m);
            router.refresh();
          }}
        />
      ) : null}

      {modal && modal.mode === "series" && modal.occ.kind === "break" ? (
        <BreakWeekPanel
          key={modal.occ.key}
          clientId={props.clientId}
          siteId={props.currentSiteId}
          timezone={tz}
          occ={modal.occ}
          ownerName={modal.occ.staffId ? staffNameById.get(modal.occ.staffId) ?? null : null}
          ownerNote={modal.occ.staffId ? `${staffNameById.get(modal.occ.staffId) ?? "Profesional"} · ${hasAnyHours(props.staff.find((x) => x.id === modal.occ.staffId)?.workingHours) ? "horario propio" : "horario de la sede"}` : `${currentSite?.name ?? "La sede"} · toda la sede`}
          canEdit={modal.occ.staffId ? props.canEditStaffBreaks : props.canEditSiteBreaks}
          hidden={Boolean(formReschedule)}
          recheck={recheck}
          onReschedule={(item, holds) => setFormReschedule({ apptId: item.id, holds, item })}
          onClose={() => setModal(null)}
          onChanged={() => router.refresh()}
        />
      ) : null}
      {modal && modal.mode === "series" && modal.occ.kind !== "break" ? (
        <SeriesPanel
          key={modal.occ.key}
          clientId={props.clientId}
          siteId={props.currentSiteId}
          timezone={tz}
          occ={modal.occ}
          ownerName={modal.occ.staffId ? staffNameById.get(modal.occ.staffId) ?? null : null}
          canEdit={modal.occ.staffId ? props.canBlockStaff : props.canBlockSite}
          hidden={Boolean(formReschedule)}
          recheck={recheck}
          onReschedule={(item, holds) => setFormReschedule({ apptId: item.id, holds, item })}
          onClose={() => setModal(null)}
          onSaved={(m) => {
            setModal(null);
            setNotice(m);
            router.refresh();
          }}
        />
      ) : null}

      {formReschedule ? (
        <AffectedReschedulePanel
          clientId={props.clientId}
          siteId={props.currentSiteId}
          timezone={tz}
          item={formReschedule.item}
          holds={formReschedule.holds}
          staff={props.staff.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, photoUrl: s.photoUrl, tint: tintOf(s.id) }))}
          openWeekdays={openWeekdays}
          lockStaffId={props.lockStaffId}
          returnLabel={modal?.mode === "series" ? (modal.occ.kind === "break" ? "la pausa" : "el bloqueo") : "el bloqueo"}
          onBack={(moved) => {
            setFormReschedule(null);
            setRecheck((n) => n + 1);
            if (moved) {
              setNotice("Cita reagendada");
              router.refresh();
            }
          }}
        />
      ) : null}

      {weekOverflow ? (
        <WeekOverflowDialog
          appointments={weekOverflow}
          title={weekOverflowTitle}
          timezone={tz}
          overlapIds={overlapIds}
          onClose={() => { setWeekOverflow(null); setWeekOverflowTitle(undefined); }}
          onSelect={(appointmentId) => {
            setWeekOverflow(null);
            setWeekOverflowTitle(undefined);
            setSelectedId(appointmentId);
          }}
        />
      ) : null}
    </main>
  );
}


/**
 * A weekly day never shrinks beyond two readable lanes. Extra simultaneous
 * appointments live here: the "+N más" marker opens this compact chooser and a
 * choice continues into the ordinary appointment drawer.
 */
/** WEEK (reference E3): one row per professional, one cell per day. A cell lists its
 *  appointments as 32px chips (time · client · state glyph) edged in the service family;
 *  blocks are off-white chips; a day the professional doesn't work — or the site is closed,
 *  or a whole-day absence — is an off-white cell that says so. Clicking a day opens it. */
function WeekTeamBoard({
  days, staff, appointments, openingHours, timezone, today, selectedId, flashId, blocks, seriesOccurrences, dimmed, conflictIds, tintOf, previewFor,
  onOpen, onDay, onMore,
}: {
  days: string[];
  staff: StaffOpt[];
  appointments: Appt[];
  openingHours: WeeklyHours;
  timezone: string;
  today: string;
  selectedId: string | null;
  flashId: string | null;
  blocks: Block[];
  seriesOccurrences: SeriesOcc[];
  dimmed: (a: Appt) => boolean;
  /** Kept inside a block / absence — flagged on the chip, never silent. */
  conflictIds: Set<string>;
  tintOf: (id: string) => "1" | "2" | "3" | "4";
  previewFor: (appt: Appt) => Record<string, unknown>;
  onOpen: (id: string) => void;
  onDay: (date: string) => void;
  onMore: (appointments: Appt[], title: string) => void;
}) {
  const byCell = new Map<string, Appt[]>();
  const rows = [...staff];
  const knownStaff = new Set(staff.map((person) => person.id));
  for (const appt of [...appointments].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const key = `${appt.staff_id}/${zonedParts(appt.start_at, timezone).dayKey}`;
    const cell = byCell.get(key) ?? [];
    cell.push(appt);
    byCell.set(key, cell);
    if (!knownStaff.has(appt.staff_id)) {
      rows.push({ id: appt.staff_id, name: appt.staff_name ?? "Sin profesional", active: false, workingHours: {} });
      knownStaff.add(appt.staff_id);
    }
  }
  const shortName = (name: string | null) => {
    const w = (name ?? "").trim().split(/\s+/).filter(Boolean);
    return w.length > 1 ? `${w[0]} ${w[1].slice(0, 1)}.` : w[0] ?? "Sin contacto";
  };
  const GRID = "grid grid-cols-[112px_repeat(7,minmax(0,1fr))]";
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-[11px]" aria-label="Semana por profesional">
      <div className="min-w-[1000px]">
        <div className={`${GRID} sticky top-0 z-20 bg-[var(--surface)] shadow-[inset_0_-1px_0_var(--line)]`}>
          <div className="flex items-center px-4 text-[12.5px] text-muted">Equipo</div>
          {days.map((day) => {
            const [year, month, date] = day.split("-").map(Number);
            const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
            const isToday = day === today;
            return (
              <button
                key={day}
                type="button"
                title="Ver el día"
                onClick={() => onDay(day)}
                aria-label={`Ver el ${ES_WEEKDAYS[weekday]} ${date} de ${ES_MONTHS[month - 1]}`}
                className={`u-focus flex h-[52px] items-center justify-center gap-2 px-3 text-[14px] shadow-[inset_1px_0_0_var(--line)] hover:bg-[var(--subtle)] ${isToday ? "bg-[var(--subtle)] text-foreground" : "text-muted"}`}
              >
                <span className={`inline-flex h-[30px] min-w-[30px] items-center justify-center rounded-full text-[15px] font-medium tabular-nums ${isToday ? "bg-[var(--ink)] text-[var(--ink-fg)]" : "text-foreground"}`}>{date}</span>
                <span className="capitalize">{ES_WEEKDAYS[weekday]}</span>
              </button>
            );
          })}
        </div>
        {rows.map((person) => {
          const total = days.reduce((count, day) => count + (byCell.get(`${person.id}/${day}`) ?? []).filter((a) => a.status !== "cancelled").length, 0);
          return (
            <div key={person.id} className={GRID}>
              <div className="flex flex-col items-center justify-center gap-2 px-2.5 py-4 text-center shadow-[inset_0_-1px_0_var(--line)]">
                <AgAvatar name={person.name} id={person.id} size={36} tint={tintOf(person.id)} photoUrl={person.photoUrl ?? null} className="shadow-[0_0_0_2px_var(--surface),0_0_0_3px_var(--line)]" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-foreground [overflow-wrap:anywhere]">{person.name.split(" ")[0]}</span>
                  <span className="text-[12.5px] text-muted">{person.active ? `${total} ${total === 1 ? "cita" : "citas"}` : "Inactivo"}</span>
                </span>
              </div>
              {days.map((day) => {
                const cell = byCell.get(`${person.id}/${day}`) ?? [];
                const siteClosed = hasAnyHours(openingHours) && !opensOn(openingHours, weekdayKeyOf(day));
                const off = !staffWorksOn(person.workingHours, openingHours, weekdayKeyOf(day));
                const dayStart = Date.parse(siteMidnightIso(day, timezone));
                const dayEnd = Date.parse(siteMidnightIso(addDays(day, 1), timezone));
                const dayBlocksHere = blocks.filter((b) => (b.staff_id === null || b.staff_id === person.id) && Date.parse(b.starts_at) < dayEnd && Date.parse(b.ends_at) > dayStart);
                const allDay = dayBlocksHere.find((b) => Date.parse(b.starts_at) <= dayStart && Date.parse(b.ends_at) >= dayEnd);
                const series = seriesOccurrences.filter((o) => o.kind === "block" && o.date === day && (o.staffId === null || o.staffId === person.id));
                const note = siteClosed ? "Sede cerrada" : allDay ? (allDay.staff_id === null ? "Sede cerrada" : "Ausencia") : off ? "No trabaja" : null;
                const chips = [
                  ...(note ? [] : dayBlocksHere.map((b) => ({ key: b.id, at: b.starts_at, kind: "block" as const }))),
                  ...(note ? [] : series.map((o) => ({ key: o.key, at: o.startsAt, kind: "block" as const }))),
                  ...cell.map((a) => ({ key: a.id, at: a.start_at, kind: "appt" as const, a })),
                ].sort((x, y) => x.at.localeCompare(y.at));
                const shown = chips.slice(0, 6);
                const rest = chips.slice(6).filter((c) => c.kind === "appt");
                return (
                  <div
                    key={day}
                    className={`flex min-h-[150px] min-w-0 flex-col justify-center gap-1.5 px-1.5 py-3 shadow-[inset_1px_0_0_var(--line),inset_0_-1px_0_var(--line)] ${note ? "bg-[var(--ag-off)]" : day === today ? "bg-[var(--ag-today)]" : ""}`}
                  >
                    {note ? <span className="text-center text-[13px] text-muted">{note}</span> : null}
                    {shown.map((c) =>
                      c.kind === "block" ? (
                        <span key={c.key} className="flex h-[32px] min-w-0 shrink-0 items-center gap-[5px] rounded-[9px] bg-[var(--ag-off)] px-[7px] text-[13px] text-muted shadow-[inset_0_0_0_1px_var(--line)]">
                          <span className="shrink-0 text-[12px] tabular-nums opacity-[0.62]">{fmtTime(c.at, timezone)}</span>
                          <span className="min-w-0 flex-1 truncate font-medium">Bloqueado</span>
                        </span>
                      ) : (
                        <button
                          key={c.key}
                          type="button"
                          onClick={() => onOpen(c.a.id)}
                          {...previewFor(c.a)}
                          data-appt-card=""
                          aria-label={`${fmtTime(c.a.start_at, timezone)} ${apptClientLabel(c.a)} ${STATE_WORD[c.a.status] ?? c.a.status}${c.a.payment_state === "pending" ? ", cobro pendiente" : ""}${c.a.review.length > 0 || conflictIds.has(c.a.id) ? ", requiere revisión" : ""}`}
                          className={`u-appt2 ${appointmentToneClass(c.a)} u-focus flex h-[32px] min-w-0 shrink-0 items-center gap-1 overflow-hidden px-[8px] text-left text-[13px] transition-[background,opacity] ${selectedId === c.a.id || flashId === c.a.id ? "shadow-[0_0_0_2px_var(--foreground)]" : ""} ${flashId === c.a.id ? "u-ag-flash" : ""}`}
                          data-status={c.a.status}
                          data-marked={c.a.status !== "cancelled" && (c.a.payment_state === "pending" || c.a.review.length > 0 || conflictIds.has(c.a.id)) ? "" : undefined}
                          data-selected={selectedId === c.a.id || flashId === c.a.id ? "" : undefined}
                          style={{ opacity: dimmed(c.a) ? 0.28 : 1 }}
                        >
                          {/* Week chip, drawn like the day card (the approved capture): the time, the
                              short name, then the small notices (! review · $ pending charge) and the
                              state glyph (a red ⊘ for a no-show). Marks never shrink the time. */}
                          <span className="shrink-0 text-[12px] tabular-nums text-[var(--ag-ink2)] opacity-80">{fmtTime(c.a.start_at, timezone)}</span>
                          <span className={`min-w-0 flex-1 truncate font-medium ${c.a.status === "cancelled" ? "line-through" : ""}`}>{shortName(c.a.contact_name ?? c.a.guest_name)}</span>
                          {c.a.status !== "cancelled" && (c.a.review.length > 0 || conflictIds.has(c.a.id)) ? (
                            <span title="Requiere revisión" aria-hidden data-kind="rev" className="u-ag-mk">
                              !
                            </span>
                          ) : null}
                          {c.a.status !== "cancelled" && c.a.payment_state === "pending" ? (
                            <span title="Cobro pendiente" aria-hidden data-kind="pay" className="u-ag-mk">
                              $
                            </span>
                          ) : null}
                          <span aria-hidden data-glyph="" className={`shrink-0 text-[11px] ${c.a.status === "no_show" ? "u-ag-noshow" : "text-[var(--ag-ink2)]"}`}>{STATE_GLYPH[c.a.status] ?? ""}</span>
                        </button>
                      ),
                    )}
                    {rest.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => onMore(cell, `${person.name} · ${Number(day.slice(-2))} ${ES_MONTHS[Number(day.slice(5, 7)) - 1]}`)}
                        aria-label={`Ver las ${cell.length} citas de ${person.name} el ${day} (${rest.length} más)`}
                        className="u-focus min-h-[28px] rounded-[8px] text-[12.5px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]"
                      >
                        +{rest.length} más
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekOverflowDialog({
  appointments,
  title: customTitle,
  timezone,
  overlapIds,
  onClose,
  onSelect,
}: {
  appointments: Appt[];
  title?: string;
  timezone: string;
  overlapIds: Set<string>;
  onClose: () => void;
  onSelect: (appointmentId: string) => void;
}) {
  const panelRef = useTrappedPanel({ active: true, onClose });
  const start = appointments[0]?.start_at;
  // Named after the HOUR BLOCK the chip sat in, not after the first appointment's
  // exact time — the rows below each print their own, and the block is what was clicked.
  const title = customTitle ?? (start
    ? `Citas de las ${String(zonedParts(start, timezone).h).padStart(2, "0")}:00`
    : "Citas");

  return (
    <>
      <button type="button" aria-label="Cerrar lista de citas" className={OVERLAY_SCRIM} onClick={onClose} />
      <section
        ref={panelRef as RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby="week-overflow-title"
        tabIndex={-1}
        className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(32rem,80vh)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-sch-card border border-line bg-popover shadow-[var(--shadow-float)] sm:rounded-sch-modal"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 id="week-overflow-title" className="truncate text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {appointments.length} cita{appointments.length === 1 ? "" : "s"} en total
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar" className={buttonClass({ variant: "tertiary", size: "sm", className: "w-[44px] px-0 lg:w-[36px]" })}>
            <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
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
                className={`u-appt ${appointmentToneClass(appt)} flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:-translate-y-px hover:shadow-sm`}
              >
                <Initial name={appt.staff_name} on="card" />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-foreground">{appt.service_name}</strong>
                  <span className="block truncate text-xs text-muted">{apptClientLabel(appt)}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="u-mono block text-xs font-semibold text-foreground">{fmtTime(appt.start_at, timezone)}</span>
                  <span className="mt-0.5 block">{overlapping ? <AttentionChip size="sm" /> : <StateChip status={appt.status} size="sm" toneClass={appointmentToneClass(appt)} />}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
/** Percentage-POINT difference, for rates. Comparing 85% to 80% is +5 points, not
 *  +6% — reporting it as a percent change would overstate the move. */

/**
 * The staff disc. `on="card"` makes it ride an appointment card, where it takes
 * the CARD's family tones (a light puck with the family's saturated letter)
 * instead of the global purple — so the avatar belongs to its card rather than
 * punching a purple hole in every tint.
 */
/**
 * Initials for an avatar puck, the way the reference writes them: the first letter of
 * each of the first two words ("Daniela Ríos" → "DR").
 *
 * The leading-bracket strip is load-bearing, not cosmetic. Seeded and sandbox records
 * are prefixed with an environment tag ("[DEV] Daniela Ríos"), and taking the first
 * alphanumeric character turned EVERY avatar on the board into the same "D" — the
 * colour was then the only thing telling two professionals apart. The tag is display
 * noise, so it is dropped before the initials are taken; the stored name is untouched.
 */
function initialsOf(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/^\s*[[(][^\])]*[\])]\s*/, "").trim();
  const initials = clean
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .join("")
    .toLocaleUpperCase("es");
  return initials || "?";
}

/** A professional's initials — the shared circular Avatar. On a pastel card it takes the
 *  card's own avatar tone; elsewhere the neutral chip (muted = a closed/inactive lane). */
function Initial({ name, muted, on, photoUrl }: { name: string | null; muted?: boolean; on?: "card"; photoUrl?: string | null }) {
  if (on === "card") return <Avatar name={name} size="xs" tone="card" photoUrl={photoUrl} />;
  return (
    <span className={muted ? "opacity-60" : ""}>
      <Avatar name={name} size="sm" photoUrl={photoUrl} />
    </span>
  );
}

/**
 * One appointment inside a WEEK hour block. Unlike the day card it is IN FLOW — it
 * grows to fill whatever the block's "+N citas" chip leaves — so the two can never
 * overlap. Two lines only: the service, then the exact start time beside the client,
 * because the block only says which hour it falls in.
 */
/**
 * A Time Off band inside a DAY column — a warm hatched region that reads as "not bookable",
 * visually distinct from an appointment card, a free slot, and the grey "closed" wash. It
 * carries a "Fuera" label (+ the internal reason for roles allowed to see it). A site closure
 * uses the stronger hatch. Clickable to edit/delete when the viewer may; otherwise a read-only
 * marker. Rendered under the cards so a kept conflicting appointment stays legible on top.
 */
/** The reference's slot popover: the dashed selection with its live time, then a menu. */
function SlotMenu(props: { top: number; height: number; dragging: boolean; alignRight: boolean; label: string; from: string; to: string; onNew: (() => void) | null; onDone?: (() => void) | null; onBlock: (() => void) | null; onClose: () => void }) {
  // The MENU takes focus when it opens (not its first item): a pointer user sees no focus
  // ring, a keyboard user goes on with ↓/↑ (or Tab) to the items, Escape closes.
  const menu = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.dragging) menu.current?.focus({ preventScroll: true });
  }, [props.dragging]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return props.onClose();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    if (items.length === 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
    items[next].focus();
  };
  const item = "u-focus flex min-h-[48px] w-full items-center justify-between gap-2.5 rounded-[8px] px-3 py-1.5 text-left hover:bg-[var(--subtle)]";
  return (
    <>
      <div
        aria-hidden
        className={`u-ag-select pointer-events-none absolute inset-x-[3px] z-[8] rounded-[10px] border-[1.5px] border-dashed border-[var(--ag-ink2)] bg-[var(--ag-break)] ${props.dragging ? "u-ag-select-live" : ""}`}
        style={{ top: props.top + 1.5, height: Math.max(18, props.height - 3) }}
      >
        <span className="absolute -top-3 left-2 flex h-[22px] items-center rounded-[6px] bg-[var(--ink)] px-2 text-[12px] tabular-nums text-[var(--ink-fg)]">{props.label}</span>
      </div>
      {!props.dragging ? (
        <div
          ref={menu}
          tabIndex={-1}
          data-slot-menu=""
          role="menu"
          aria-label={`Horario ${props.label}`}
          className={`u-pop-in absolute z-[9] flex w-[296px] flex-col outline-none rounded-[12px] bg-[var(--surface)] p-1.5 shadow-[0_0_0_1px_var(--line),0_14px_36px_rgba(0,0,0,0.14)] ${props.alignRight ? "right-2" : "left-[3px]"}`}
          style={{ top: props.top + Math.max(18, props.height) + 6 }}
          onKeyDown={onKeyDown}
        >
          {props.onNew ? (
            <button type="button" role="menuitem" onClick={props.onNew} className={item}>
              <span className="flex flex-col">
                <span className="text-[14px] text-foreground">Nueva cita</span>
                <span className="text-[12px] text-muted">Desde las {props.from} · dura lo que dure el servicio</span>
              </span>
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 3v10M3 8h10" /></svg>
            </button>
          ) : null}
          {props.onDone ? (
            <button type="button" role="menuitem" onClick={props.onDone} className={item}>
              <span className="flex flex-col">
                <span className="text-[14px] text-foreground">Registrar atención realizada</span>
                <span className="text-[12px] tabular-nums text-muted">Ya terminó · desde las {props.from}, con este profesional</span>
              </span>
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3.5 8.5l3 3 6-7" /></svg>
            </button>
          ) : null}
          {props.onBlock ? (
            <button type="button" role="menuitem" onClick={props.onBlock} className={item}>
              <span className="flex flex-col">
                <span className="text-[14px] text-foreground">Bloquear horario</span>
                <span className="text-[12px] tabular-nums text-muted">{props.from} – {props.to}, tal como lo marcaste</span>
              </span>
              <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5" /><path d="M4.2 11.8l7.6-7.6" /></svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** The reference's break (pausa: the lane's full width, no edge) and block (inset 3px,
 *  off-white with a hairline) tiles; title then time, the time only where it fits. */
const TILE_BREAK = "u-sch-break absolute inset-x-0 flex flex-col items-start gap-0.5 overflow-hidden px-2.5 py-1.5 text-left";
const TILE_BLOCK = "u-sch-block absolute inset-x-[3px] flex flex-col items-start gap-0.5 overflow-hidden rounded-[8px] px-2.5 py-1.5 text-left";
/**
 * Where a pause / block tile can print its label when appointment cards sit on top of it
 * (audit 23 Oct: «Pausa habitual» and a 15-min «Valoración» shared the same 19px). The label
 * moves to the FIRST stretch of the tile no card covers — never under a card — and shows its
 * time only where both lines fit. With no room left the tile has no visible label (its title
 * and accessible name still say it); its HATCH still shows wherever no card covers it.
 * Nothing is lengthened to make room.
 */
function tileLabel(top: number, height: number, cards: Array<[number, number]>): { offset: number; lines: 0 | 1 | 2; covered: boolean } {
  const end = top + height;
  const over = cards.filter(([a, b]) => b > top && a < end).sort((x, y) => x[0] - y[0]);
  if (over.length === 0) return { offset: 0, lines: height >= 34 ? 2 : 1, covered: false };
  let cursor = top;
  for (const [a, b] of [...over, [end, end] as [number, number]]) {
    const gap = Math.min(a, end) - cursor;
    if (gap >= 20) return { offset: cursor - top, lines: gap >= 36 ? 2 : 1, covered: true };
    cursor = Math.max(cursor, b);
    if (cursor >= end) break;
  }
  return { offset: 0, lines: 0, covered: true };
}
function TimeTile({ title, time, top, height, cards = [] }: { title: string; time: string; top: number; height: number; cards?: Array<[number, number]> }) {
  const at = tileLabel(top, height, cards);
  return (
    <>
      {at.lines > 0 ? <span className="w-full truncate text-[12px] font-medium" style={at.offset ? { marginTop: at.offset } : undefined}>{title}</span> : null}
      {at.lines === 2 ? <span className="w-full truncate text-[12px] tabular-nums">{time}</span> : null}
    </>
  );
}

function BlockBand({
  top,
  height,
  siteWide,
  fullDay,
  time,
  reason,
  editable,
  cards = [],
  onOpen,
}: {
  top: number;
  height: number;
  siteWide: boolean;
  fullDay: boolean;
  time: string;
  reason: string | null;
  editable: boolean;
  /** The lane's appointment cards (pixel ranges): the label avoids them. */
  cards?: Array<[number, number]>;
  onOpen: () => void;
}) {
  // The reference's block (blockItem): an off-white tile with a hairline, inset 3px —
  // "Bloqueado" / "Sede cerrada" and its time; a whole day reads «Ausencia · todo el día».
  const base = siteWide ? (fullDay ? "Sede cerrada · todo el día" : "Sede cerrada") : fullDay ? "Ausencia · todo el día" : "Bloqueado";
  const label = reason?.trim() ? `${base} · ${reason.trim()}` : base;
  // «Todo el día» is already in the label; keep only the dates of a several-day absence.
  const when = time.startsWith("Todo el día") ? time.replace(/^Todo el día(?: · )?/, "") : time;
  const named = when ? `${label} · ${when}` : label;
  const cls = `${siteWide ? "u-sch-closed" : "u-sch-block"} absolute inset-x-[3px] flex flex-col items-start gap-0.5 overflow-hidden rounded-[8px] px-2.5 py-1.5 text-left`;
  const style = { top: top + 1, height: Math.max(18, height - 2) };
  const at = tileLabel(style.top, style.height, cards);
  const inner = (
    <>
      {at.lines > 0 ? <span className="w-full truncate text-[12px] font-medium" style={at.offset ? { marginTop: at.offset } : undefined}>{label}</span> : null}
      {!fullDay && at.lines === 2 ? <span className="text-[12px] tabular-nums">{time}</span> : null}
    </>
  );
  return editable ? (
    <button type="button" onClick={onOpen} title={named} aria-label={`${named}. Abrir`} className={`${cls} u-focus cursor-pointer hover:text-[var(--ag-ink2)]`} style={style}>
      {inner}
    </button>
  ) : (
    <div title={named} className={cls} style={style}>
      {inner}
    </div>
  );
}


/**
 * One appointment in the DAY grid, positioned and sized by its real duration, painted
 * by PROFESSIONAL: each barber keeps a stable muted pastel across dates and layouts.
 * State never repaints the whole card; it is written in the meta line, so a no-show or
 * conflict remains legible without turning the board into a field of red.
 *
 * WEEK uses WeekBlockCard instead — see bucketWeekAppointments for why the two views
 * need different card geometry.
 */
function ApptCard({
  appt,
  toneClass,
  tz,
  top,
  height,
  lane,
  overlapping,
  conflict,
  selected,
  flash,
  dim = false,
  previewProps,
  onOpen,
}: {
  appt: Appt;
  toneClass: string;
  tz: string;
  top: number;
  height: number;
  /** Its slot in an overlap cluster — absent when nothing overlaps it. */
  lane?: DayLane;
  overlapping: boolean;
  /** Kept despite falling inside a block / break / outside hours — «Requiere revisión». */
  conflict?: boolean;
  selected: boolean;
  /** Just "located" from the detail panel — a brief ring so the eye finds it. */
  flash: boolean;
  /** Filtered out by state or search: still drawn (the time is taken), faded. */
  dim?: boolean;
  /** Hover / focus preview handlers + the data-appt-id the locate action looks for. */
  previewProps: Record<string, unknown>;
  onOpen: () => void;
}) {
  const cancelled = appt.status === "cancelled";
  const review = conflict || appt.review.length > 0;
  // Drawn as the approved «M_AI Agenda» capture. Its height IS its duration (HOUR_PX), so the
  // content adapts to the real space — nothing is grown to fit. At 88 px/h the breaks are the
  // capture's own:
  //   < 56px (< 40 min)   one line: name · range + the glyph (12.5px name under 30px)
  //   < 68px (40–48 min)  name / ● service
  //   ≥ 68px (≥ 49 min)   name / ● service / range   (no duration: the range says it)
  // The notices «!» (review) and «$» (pending charge) stay small, after the name. A narrow lane
  // drops the range first and keeps only the highest-priority mark, so nothing covers the name.
  // Everything else is in the preview (hover / keyboard focus) and the accessible label.
  const h = height - 3;
  const client = apptClientLabel(appt);
  const stateWord = STATE_WORD[appt.status] ?? appt.status;
  const range = `${fmtTime(appt.start_at, tz)}–${fmtTime(appt.service_end_at, tz)}`;
  const n = lane?.laneCount ?? 1;
  const rev = review && !cancelled;
  const pay = appt.payment_state === "pending" && !cancelled;
  const one = h < 56;
  const three = h >= 68;
  // The capture's 10px of breathing room, less only when the real height is tighter.
  const textH = three ? 53 : 35;
  const padY = one ? 0 : Math.max(4, Math.min(10, Math.floor((h - textH) / 2)));
  const glyph = (
    <span key="st" aria-hidden title={stateWord} className={`u-ag-c-glyph ${appt.status === "no_show" ? "u-ag-noshow" : ""}`}>
      {STATE_GLYPH[appt.status] ?? ""}
    </span>
  );
  // Priority order: the first one is the one a narrow lane keeps.
  const marks = [
    ...(rev
      ? [
          <span key="rev" aria-hidden title="Requiere revisión" data-kind="rev" className="u-ag-mk">
            !
          </span>,
        ]
      : []),
    ...(pay
      ? [
          <span key="pay" aria-hidden title="Cobro pendiente" data-kind="pay" className="u-ag-mk">
            $
          </span>,
        ]
      : []),
    glyph,
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-appt-card=""
      {...previewProps}
      aria-label={`${client}, ${fmtTime(appt.start_at, tz)} a ${fmtTime(appt.service_end_at, tz)}, ${appt.service_name}, ${stateWord}${appt.payment_state === "pending" ? ", cobro pendiente" : ""}${review ? ", requiere revisión" : ""}${overlapping ? ", solapamiento" : ""}`}
      className={`u-appt2 ${toneClass} absolute flex flex-col items-stretch overflow-hidden text-left text-foreground transition-[opacity,background,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-edge)] ${
        one ? "justify-center pl-3 pr-2.5" : "justify-start gap-[3px] pl-3 pr-2.5"
      } ${selected || flash ? "shadow-[0_0_0_2px_var(--foreground)]" : ""} ${flash ? "u-ag-flash" : ""}`}
      data-status={appt.status}
      data-marked={rev || pay ? "" : undefined}
      data-selected={selected || flash ? "" : undefined}
      style={{
        top: top + 1.5,
        height: h,
        left: `calc(${((lane?.lane ?? 0) / n) * 100}% + 3px)`,
        width: `calc(${100 / n}% - 6px)`,
        opacity: dim ? 0.28 : 1,
        paddingTop: padY,
        paddingBottom: padY,
      }}
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className={`u-ag-c-name min-w-0 flex-1 truncate ${one && h < 30 ? "u-ag-c-name-sm" : ""} ${cancelled ? "line-through" : ""}`}>{client}</span>
        {one ? (
          <span data-drop-sm="" className="u-ag-c-sub shrink-0 tabular-nums">
            {range}
          </span>
        ) : null}
        <span className="u-ag-marks flex shrink-0 items-center gap-1">{marks}</span>
      </span>
      {!one ? (
        <span className="u-ag-c-sub flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={`${toneClass} u-appt2-dot size-[6px] shrink-0 bg-[var(--appt-rule)]`} />
          <span className="truncate">{appt.service_name}</span>
        </span>
      ) : null}
      {three ? (
        <span data-drop="" className="u-ag-c-sub truncate tabular-nums">
          {range}
        </span>
      ) : null}
    </button>
  );
}

/** sessionStorage key: the appointment to highlight after "Cambiar fecha y hora". */
const FLASH_KEY = "mai:agenda:flash";

/** Modal for new appointment / walk-in — fetches real availability. (Reschedule has its
 *  own flow: agenda/RescheduleFlow.) */
function AppointmentModal(props: {
  clientId: string;
  timezone: string;
  date: string;
  sites: SiteOpt[];
  currentSiteId: string;
  openingHours: WeeklyHours;
  dayStartIso: string;
  dayEndIso: string;
  staff: StaffOpt[];
  services: ServiceOpt[];
  modal: BookingModalState;
  /** Staff login → pin the barber to this id (its own column). */
  lockStaffId: string | null;
  onClose: () => void;
  onError: (e: string | null) => void;
  /** `dayKey` = the site day the appointment landed on (phone returns to it). */
  /** After the server confirmed: the day to show and, for a new booking, its id (highlighted). */
  onDone: (dayKey?: string, createdId?: string) => void;
  /** The current error (the phone flow shows it in its own footer). */
  error?: string | null;
  /** A short confirmation for the phone's toast ("Cita creada"). */
  onNotice?: (message: string) => void;
  /** «Sin cita · ahora» / «Registrar atención realizada»: switch to the one-step walk-in
   *  panel, carrying what is already chosen here (never asked again). */
  onWalkIn?: (context: WalkInContext) => void;
  /** The draft (professional, start, real duration) — the calendar draws it at its size. */
  onDraft?: (d: { staffId: string; startAt: string; durationMin: number; label: string } | null) => void;
}) {
  const isReschedule = props.modal.mode === "reschedule";
  // Booking for an existing contact (deep-link): lock identity, submit its id.
  const bookingContact = props.modal.mode !== "reschedule" ? props.modal.contact ?? null : null;
  const [serviceId, setServiceId] = useState(
    props.modal.mode === "reschedule"
      ? props.modal.appt.service_id
      : props.modal.serviceId && props.services.some((sv) => sv.id === (props.modal as { serviceId?: string }).serviceId)
        ? props.modal.serviceId
        : "",
  );
  // A staff login starts (and stays) on its own column; the server refuses any other.
  const presetStaff = props.modal.mode !== "reschedule" ? props.modal.staffId : undefined;
  const presetStartAt = props.modal.mode !== "reschedule" ? props.modal.startAt ?? null : null;
  /** The start painted on the grid still drives the flow: it is offered as THE time (step 2
   *  skipped) until the operator picks another time, day or professional. */
  const [presetActive, setPresetActive] = useState(Boolean(presetStartAt));
  /** It was tried and is not free for this service/professional — step 2 says so. */
  const [presetMiss, setPresetMiss] = useState(false);
  /** A painted start already in the past cannot be booked — it may be a service to RECORD. */
  const [presetPast] = useState(() => Boolean(presetStartAt && Date.parse(presetStartAt) <= Date.now()));
  /** The range dragged on the grid: a HINT for the service (an appointment lasts what its
   *  service lasts), never a duration. */
  const spanMin = props.modal.mode !== "reschedule" ? props.modal.spanMin ?? null : null;
  const [staffId, setStaffId] = useState<string>(props.lockStaffId ?? presetStaff ?? "");
  const [step, setStep] = useState<1 | 2 | 3>(isReschedule ? 2 : 1);
  const [selectedDate, setSelectedDate] = useState(props.modal.mode !== "reschedule" && props.modal.startAt ? siteDayKey(props.modal.startAt, props.timezone) : props.date);
  const [calendarMonth, setCalendarMonth] = useState(props.date.slice(0, 7));
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotStart, setSlotStart] = useState<string>("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  /** Whether a search has completed — the difference between "not searched yet" (show
   *  nothing) and "searched, nothing came back" (say so, out loud). */
  const [, setSearched] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  /**
   * HOW the customer is being identified in step 1 — the reference's three routes, in
   * the order it offers them:
   *   "search"    look them up in the CRM and attach the booking to that contact;
   *   "new"       they aren't on record yet, so type a name/phone and create them;
   *   "anonymous" nobody's details at all (a walk-in), which stores no contact.
   * Deep-linked bookings arrive with the contact already decided and skip all three.
   */
  const [customerMode, setCustomerMode] = useState<"search" | "new" | "anonymous">("search");
  /** A typed phone/email that already belongs to a contact: offered to LINK (never duplicated). */
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [contactHits, setContactHits] = useState<ContactSearchHit[]>([]);
  const [contactSearching, setContactSearching] = useState(false);
  const [contactSearched, setContactSearched] = useState(false);
  const [pickedContact, setPickedContact] = useState<ContactSearchHit | null>(null);
  /** Step 1's service-catalogue filters — client-side over the services already loaded. */
  const [serviceQuery, setServiceQuery] = useState("");
  /** «Recientes» (reference E4): the client's latest contacts, asked once on open. */
  const [recents, setRecents] = useState<ContactSearchHit[] | null>(null);
  const deskPanel = useRef<SidePanelHandle | null>(null);
  const rosterTint = (id: string) => agTintAt([...props.staff].sort((a, b) => a.name.localeCompare(b.name, "es")).findIndex((x) => x.id === id));
  const [serviceFamily, setServiceFamily] = useState<"all" | ApptCategory>("all");
  /** Step 2's professional picker is a popover, so the month keeps the full column. */
  const [pending, startTransition] = useTransition();
  // A modal COVERS the calendar, so it owes the reader the overlay contract: focus in
  // on open, Escape to close, focus back on close (Overlay.tsx). The backdrop click is
  // wired separately below.
  // Below md the booking is the phone's full-screen flow (its own layer), same state.
  const isPhone = useIsOverlayWidth(767.98);
  const [phoneSheet, setPhoneSheet] = useState<"month" | "contact" | "discard" | null>(null);
  /** "Estado inicial" (phone step 3): confirmed = create, then the real confirm. */
  const [initialStatus, setInitialStatus] = useState<"scheduled" | "confirmed">("scheduled");
  /** One key per open form: a retried submit replays instead of booking twice. */
  const [idemKey] = useState(() => crypto.randomUUID());
  /**
   * The browser's / system's BACK inside the phone flow (Android back, iOS swipe) must
   * not throw the booking away. Opening the flow adds one same-URL history entry (the
   * native History API, which Next's router integrates); Back then acts on the FLOW —
   * closes an open sheet, else goes back a step, else asks before discarding choices,
   * else closes — and re-arms the entry. Closing from the UI removes it, so the next
   * Back is a normal one.
   */
  const backGuard = useRef<{ onBack: () => boolean }>({ onBack: () => false });
  const leavingHistory = useRef(false);
  useEffect(() => {
    if (!isPhone) return;
    const mark = () => window.history.pushState({ ...window.history.state, mBooking: true }, "");
    mark();
    const onPop = () => {
      if (leavingHistory.current) return;
      if (backGuard.current.onBack()) mark();
      else leavingHistory.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!leavingHistory.current && window.history.state?.mBooking) {
        leavingHistory.current = true;
        window.history.back();
      }
    };
  }, [isPhone]);
  /** Drop the guard entry BEFORE navigating elsewhere (after a successful create). */
  const dropBackGuard = () =>
    new Promise<void>((done) => {
      if (!isPhone || !window.history.state?.mBooking) return done();
      leavingHistory.current = true;
      const settle = () => {
        window.removeEventListener("popstate", settle);
        done();
      };
      window.addEventListener("popstate", settle);
      window.history.back();
    });

  /**
   * Customer lookup, debounced. The action is client-scoped server-side; this only
   * decides WHEN to ask. `cancelled` guards the classic out-of-order finish: type
   * "luc", then "lucia", and the slower first response must not overwrite the second.
   */
  useEffect(() => {
    if (customerMode !== "search" || bookingContact || isReschedule) return;
    const term = contactQuery.trim();
    if (term.length < 2) {
      setContactHits([]);
      setContactSearched(false);
      return;
    }
    let cancelled = false;
    setContactSearching(true);
    const timer = setTimeout(async () => {
      const r = await searchSchedulingContactsAction(props.clientId, term);
      if (cancelled) return;
      setContactHits(r.ok ? r.hits : []);
      setContactSearched(true);
      setContactSearching(false);
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setContactSearching(false);
      clearTimeout(timer);
    };
  }, [contactQuery, customerMode, bookingContact, isReschedule, props.clientId]);

  /** Any change to what we'd search for invalidates the slots already on screen — a
   *  time found for a 30-min cut must not linger when the service becomes a 60-min one. */
  const resetSlots = () => {
    setSlots([]);
    setSlotStart("");
    setSearched(false);
  };

  const loadSlots = async (nextDate = selectedDate): Promise<Slot[] | null> => {
    // Reschedule keeps the appointment's own service; "new"/"walk-in" uses the picked one.
    const effectiveServiceId = props.modal.mode === "reschedule" ? props.modal.appt.service_id : serviceId;
    if (!effectiveServiceId) return null;
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
        return null;
      }
      const data = (await res.json()) as { slots: Slot[] };
      setSlots(data.slots);
      // A completed search — now an empty result can say "nothing available" rather
      // than staying silent and looking broken.
      setSearched(true);
      return data.slots;
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
      // A thrown action (offline, server unreachable) must not escape the transition:
      // that unmounts the form and loses every choice. Say so and keep the form as is —
      // the idempotency key makes the retry safe even if the first request did land.
      let createdId: string | undefined;
      try {
      if (isReschedule) {
        const r = await rescheduleAppointmentAction(
          props.clientId,
          props.modal.mode === "reschedule" ? props.modal.appt.id : "",
          slotStart,
          staffId || null,
        );
        if (!r.ok) return props.onError(r.error);
        props.onNotice?.("Cita reprogramada");
      } else {
        const r = await createManualAppointmentAction(props.clientId, {
          siteId: props.currentSiteId,
          serviceId,
          staffId: staffId || null,
          startAt: slotStart,
          // Booking for a contact → attach by id (no typed identity). Otherwise the
          // free-text identity path (manual / walk-in) is unchanged.
          // A contact chosen in step 1 (deep-linked OR found by search) attaches by
          // id. The typed route sends the identity it typed. "Atención sin cita"
          // sends neither, which is what stores an appointment with no contact.
          ...(customer.contactId
            ? { contactId: customer.contactId }
            : customerMode === "anonymous"
              ? {}
              : {
                  customerName: name || undefined,
                  customerPhone: phone || undefined,
                  customerEmail: email || undefined,
                  // A contact needs a phone or an email; a name alone stays on the cita.
                  contactMode: phone.trim() || email.trim() ? ("create" as const) : ("guest" as const),
                }),
          walkIn: props.modal.mode === "walkin",
          idempotencyKey: idemKey,
          initialStatus: isPhone ? initialStatus : undefined,
        });
        if (!r.ok) {
          setContactMatches(r.matches ?? []);
          return props.onError(r.fieldErrors ? Object.values(r.fieldErrors).join(" ") : r.error);
        }
        props.onNotice?.(r.warning ?? "Cita creada");
        createdId = r.id;
      }
      await dropBackGuard();
      // Only after the server confirmed it: go to its day and highlight it once drawn.
      props.onDone(siteDayKey(slotStart, props.timezone), createdId);
      } catch {
        props.onError("No se pudo guardar: revisa la conexión e inténtalo de nuevo. Tus datos se conservan.");
      }
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
  const selectedService = props.services.find((service) => service.id === (rescheduleAppt?.service_id ?? serviceId));
  const selectedSlot = slots.find((slot) => slot.start_at === slotStart);
  const effectiveStaffId = staffId || selectedSlot?.staff_id || rescheduleAppt?.staff_id || "";
  const selectedStaff = props.staff.find((staff) => staff.id === effectiveStaffId);
  const selectedSite = props.sites.find((site) => site.id === props.currentSiteId);
  const activeStaff = props.staff.filter((staff) => staff.active);
  /** What the grid marked (day · start – end · professional), said from step 1 on. */
  const presetStaffFirst = presetStaff ? props.staff.find((st) => st.id === presetStaff)?.name.split(" ")[0] ?? null : null;
  const paintedLabel =
    presetStartAt && !isReschedule
      ? [
          dayShort(siteDayKey(presetStartAt, props.timezone)),
          `${fmtTime(presetStartAt, props.timezone)}${spanMin ? ` – ${fmtTime(new Date(Date.parse(presetStartAt) + spanMin * 60_000).toISOString(), props.timezone)}` : ""}`,
          presetStaffFirst,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;
  /** What «Atención sin cita» receives from here — the same professional, start and service. */
  const walkContext = (done?: boolean): WalkInContext => ({
    staffId: staffId || presetStaff || undefined,
    startAt: slotStart || presetStartAt || undefined,
    spanMin: spanMin ?? undefined,
    serviceId: serviceId || undefined,
    ...(done ? { done: true } : {}),
  });
  /** The chosen time's REAL length with that professional (their own duration for it). */
  const slotMinutes = selectedSlot ? Math.round((Date.parse(selectedSlot.service_end_at) - Date.parse(selectedSlot.start_at)) / 60_000) : null;
  /** The painted range and the service's length differ: say which end the cita keeps. */
  const spanNote =
    spanMin && presetStartAt && slotStart === presetStartAt && selectedSlot && slotMinutes !== null && slotMinutes !== spanMin
      ? `Marcaste hasta las ${fmtTime(new Date(Date.parse(presetStartAt) + spanMin * 60_000).toISOString(), props.timezone)} (${spanMin} min); ${selectedService?.name ?? "el servicio"}${selectedStaff ? ` con ${selectedStaff.name.split(" ")[0]}` : ""} dura ${slotMinutes} min, así que la cita termina a las ${fmtTime(selectedSlot.service_end_at, props.timezone)}.`
      : null;
  /**
   * The colour this booking will wear on the board — decided by the chosen SERVICE,
   * so the preview in step 3 matches the card that gets drawn. Before a service is
   * picked there is no colour to promise, hence the null.
   */
  const draftStaff = staffId || presetStaff || "";
  const draftStart = slotStart || presetStartAt;
  const draftMin = selectedService?.duration_min ?? spanMin ?? null;
  const onDraft = props.onDraft;
  useEffect(() => {
    if (!onDraft) return;
    onDraft(draftStaff && draftStart && draftMin ? { staffId: draftStaff, startAt: draftStart, durationMin: draftMin, label: selectedService ? `Nueva cita · ${selectedService.name}` : "Nueva cita · elige el servicio" } : null);
  }, [onDraft, draftStaff, draftStart, draftMin, selectedService]);
  useEffect(() => () => onDraft?.(null), [onDraft]);
  const bookingFamily: ApptCategory | null = selectedService
    ? serviceCategory(selectedService.name, selectedService.category)
    : null;

  /**
   * WHO the booking is for, resolved from whichever of step 1's three routes is in
   * play. `contactId` is what actually gets submitted when it is set; everything else
   * is display. A null `label` means step 1 is not satisfied yet — the footer and the
   * Continue button both read that, so an un-chosen customer can never look chosen.
   */
  const customer: { contactId: string | null; label: string | null; identity: string | null } =
    bookingContact
      ? { contactId: bookingContact.contactId, label: bookingContact.contactName, identity: null }
      : isReschedule
        ? { contactId: null, label: rescheduleAppt ? apptClientLabel(rescheduleAppt) : "Sin contacto", identity: rescheduleAppt?.primary_identity ?? null }
        : customerMode === "anonymous"
          ? { contactId: null, label: "Atención sin cita", identity: null }
          : pickedContact
            ? { contactId: pickedContact.id, label: pickedContact.name ?? pickedContact.identity ?? "Contacto sin nombre", identity: pickedContact.identity }
            : customerMode === "new" && name.trim()
              ? { contactId: null, label: name.trim(), identity: phone.trim() || email.trim() || null }
              : { contactId: null, label: null, identity: null };

  /** Step 1 is done when we know WHO and WHAT. Both, or Continue stays disabled. */
  const step1Ready = Boolean(serviceId) && customer.label !== null;

  /** The service catalogue, filtered by step 1's search box and family chips. */
  const filteredServices = props.services.filter((service) => {
    const term = serviceQuery.trim().toLocaleLowerCase("es");
    const matchesTerm = !term || service.name.toLocaleLowerCase("es").includes(term);
    const matchesFamily =
      serviceFamily === "all" || serviceCategory(service.name, service.category) === serviceFamily;
    return matchesTerm && matchesFamily;
  });
  /** Only the families actually present — chips for empty ones are dead controls. */
  const serviceFamilies = [...new Set(props.services.map((s) => serviceCategory(s.name, s.category)))];
  const visibleSlots = staffId
    ? slots.filter((slot) => siteDayKey(slot.start_at, props.timezone) === selectedDate && slot.available_staff_ids.includes(staffId))
    : slots
        .filter((slot) => siteDayKey(slot.start_at, props.timezone) === selectedDate)
        .filter((slot, index, all) => all.findIndex((candidate) => candidate.start_at === slot.start_at) === index);
  const dateValue = (() => {
    const [year, month, day] = selectedDate.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  })();
  const shortDateLabel = new Intl.DateTimeFormat("es-CO", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(dateValue).replaceAll(".", "").replace(",", "").replaceAll(" de ", " ").replace(/\bsept\b/i, "sep");
  const monthDays = calendarDays(calendarMonth);
  const availabilityCount = (dayKey: string, forStaffId = staffId): number => {
    const daySlots = slots.filter((slot) => siteDayKey(slot.start_at, props.timezone) === dayKey);
    const eligible = forStaffId ? daySlots.filter((slot) => slot.available_staff_ids.includes(forStaffId)) : daySlots;
    return new Set(eligible.map((slot) => slot.start_at)).size;
  };
  /**
   * The day's free times, split the way a receptionist reads a day: morning and
   * afternoon. Only AVAILABLE slots appear — the availability endpoint returns exactly
   * those, and inventing a struck-through "taken" row would mean guessing which of the
   * missing times are booked and which are simply outside anyone's shift.
   * TODO(agenda): show occupied times struck through, as the reference does, once the
   *   availability endpoint also reports the occupied grid.
   */
  const slotGroups = (() => {
    const morning: Slot[] = [];
    const afternoon: Slot[] = [];
    for (const slot of visibleSlots) {
      (zonedParts(slot.start_at, props.timezone).h < 12 ? morning : afternoon).push(slot);
    }
    return [
      { key: "am", label: "Mañana", slots: morning },
      { key: "pm", label: "Tarde", slots: afternoon },
    ].filter((group) => group.slots.length > 0);
  })();

  /** How many of the roster can actually take this service on the chosen day. Real:
   *  it counts staff the availability endpoint returned at least one slot for. */
  /**
   * A contact's date, in the SITE's timezone and the project's own three-letter month
   * abbreviations (ES_MONTHS) rather than Intl's — same reason the toolbar uses them:
   * Intl's es-CO "short" month is "sept." on some runtimes and "sep" on others, and a
   * width that shifts between browsers moves everything beside it.
   */
  const contactDateLabel = (iso: string, withTime: boolean): string => {
    const parts = zonedParts(iso, props.timezone);
    const [, month, day] = parts.dayKey.split("-").map(Number);
    const date = `${day} ${ES_MONTHS[month - 1]}`;
    return withTime ? `${date}, ${String(parts.h).padStart(2, "0")}:${String(parts.m).padStart(2, "0")}` : date;
  };
  const todayKey = todayAtSite(props.timezone);
  /**
   * The RUNNING SUMMARY the reference keeps in the header and the footer, so what has
   * been chosen so far is legible without going back a step. Each part appears only
   * once it is real — an unchosen field is absent, never a placeholder standing in for
   * a decision the operator has not made.
   */
  const summaryParts = (extra: Array<string | null>) =>
    [customer.label, selectedService?.name, ...extra].filter(Boolean).join(" · ");
  const timeRangeLabel = slotStart
    ? `${fmtTime(slotStart, props.timezone)}${selectedSlot ? ` – ${fmtTime(selectedSlot.service_end_at, props.timezone)}` : ""}`
    : null;
  /** The header's second line: the site+day you're booking into, then the choices. */

  const changeStaff = (nextStaffId: string) => {
    setStaffId(nextStaffId);
    setSlotStart("");
    setPresetActive(false);
    setPresetMiss(false);
  };

  const changeDate = (nextDate: string) => {
    setPresetActive(false);
    setPresetMiss(false);
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
      setPresetMiss(false);
      void loadSlots().then((list) => {
        // The painted start, if it is still free with that professional for THIS service,
        // is the time: straight to «Confirmar» — it is not asked again. Otherwise step 2 says
        // so and offers the others.
        if (!list || !presetActive || !presetStartAt || presetPast) return;
        const hit = list.find((sl) => sl.start_at === presetStartAt && (!staffId || sl.available_staff_ids.includes(staffId)));
        if (!hit) return setPresetMiss(true);
        setSlotStart(presetStartAt);
        if (!staffId) setStaffId(hit.staff_id);
        setStep(3);
      });
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

  const phoneHasChoices = Boolean(customer.label || serviceId || slotStart) && !isReschedule;
  // A link elsewhere in the app (the sidebar stays usable beside the panel) asks first.
  // Phone only: from md up the SidePanel guards its own links / X / Escape (one dialog).
  const leaveNav = useNavigationGuard({ dirty: phoneHasChoices && isPhone, onAsk: () => setPhoneSheet("discard") });
  const wantRecents = !isPhone && !bookingContact && !isReschedule;
  useEffect(() => {
    if (!wantRecents) return;
    let alive = true;
    recentSchedulingContactsAction(props.clientId)
      .then((r) => alive && setRecents(r.ok ? r.hits : []))
      .catch(() => alive && setRecents([]));
    return () => {
      alive = false;
    };
  }, [wantRecents, props.clientId]);
  useEffect(() => {
    backGuard.current.onBack = () => {
      // An open sheet (month, new contact, or the discard question itself — where Back
      // means "Seguir editando") is the top layer: Back closes only it.
      if (phoneSheet) {
        setPhoneSheet(null);
        return true;
      }
      if (step === 3 || (step === 2 && !isReschedule)) {
        goBack();
        return true;
      }
      if (phoneHasChoices) {
        setPhoneSheet("discard");
        return true;
      }
      props.onClose();
      return false;
    };
  });

  // ── The reference's 3-step flow (§03) on the SAME state and actions: full screen on
  // the phone, inside the agenda's 520 px side-panel frame from md up (MScreen framed).
  {
    const stepName = step === 1 ? "Cliente y servicio" : step === 2 ? "Profesional, fecha y hora" : "Confirmar";
    const dayState = (dayKey: string): "ok" | "full" | "closed" | "past" | "unknown" => {
      if (dayKey < todayKey) return "past";
      if (hasAnyHours(props.openingHours) && !opensOn(props.openingHours, weekdayKeyOf(dayKey))) return "closed";
      if (loadingSlots || dayKey.slice(0, 7) !== calendarMonth) return "unknown";
      return availabilityCount(dayKey) > 0 ? "ok" : "full";
    };
    const stripStart = selectedDate < todayKey ? selectedDate : addDays(selectedDate, -3) < todayKey ? todayKey : addDays(selectedDate, -3);
    const strip = Array.from({ length: 7 }, (_, i) => addDays(stripStart, i));
    const wdShort = (dayKey: string) => ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"][new Date(`${dayKey}T00:00:00Z`).getUTCDay()];
    const nextWith = (from: string, ok: (d: string) => boolean) => {
      for (let i = 1; i <= 31; i++) {
        const d = addDays(from, i);
        if (d.slice(0, 7) !== calendarMonth) break;
        if (ok(d)) return d;
      }
      return null;
    };
    const selState = dayState(selectedDate);
    const nextOk = nextWith(selectedDate, (d) => dayState(d) === "ok");
    const hasChoices = Boolean(customer.label || serviceId || slotStart) && !isReschedule;
    const requestClose = () => (hasChoices ? setPhoneSheet("discard") : props.onClose());
    const staffChoices = props.lockStaffId ? activeStaff.filter((s) => s.id === props.lockStaffId) : activeStaff;
    const teamColors = staffColors(props.staff.map((s) => s.id));
    const ready = step === 1 ? step1Ready : step === 2 ? Boolean(slotStart) : Boolean(slotStart);
    const summary =
      step === 1
        ? step1Ready
          ? summaryParts([selectedService ? `${selectedService.duration_min} min` : null])
          : customer.label
            ? "Falta el servicio"
            : serviceId
              ? "Falta el cliente"
              : "Elige un cliente y un servicio"
        : step === 2
          ? slotStart
            ? [shortDateLabel, timeRangeLabel, selectedStaff?.name?.split(" ").filter((w) => !/^\[/.test(w))[0]].filter(Boolean).join(" · ")
            : "Elige un horario"
          : "Nada se guarda hasta que confirmes";
    const pickFamily = (f: "all" | ApptCategory) => setServiceFamily(f);
    const fam = (f: ApptCategory) => ({ cut: "u-m-cut", grooming: "u-m-grooming", color: "u-m-color", feature: "u-m-feature" } as Partial<Record<ApptCategory, string>>)[f] ?? "u-m-neutral";
    const heroFamily = bookingFamily ? fam(bookingFamily) : "u-m-neutral";
    const confirmRows: [string, string][] = [
      ["Cliente", customer.label ?? "—"],
      ["Contacto", customer.identity ?? "—"],
      ["Servicio", selectedService?.name ?? "—"],
      ["Precio", priceLabelCOP(selectedService?.price ?? null) ?? "A consultar"],
      ["Duración", selectedService ? `${slotMinutes ?? selectedService.duration_min} min` : "—"],
      ["Profesional", selectedStaff?.name ?? "Cualquiera"],
      ["Sede", selectedSite?.name ?? "—"],
    ];
    const tzLabel = (() => {
      const name = new Intl.DateTimeFormat("es", { timeZone: props.timezone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value;
      const raw = props.timezone.split("/").pop() ?? "";
      const CITY: Record<string, string> = { Bogota: "Bogotá", Mexico_City: "Ciudad de México", Panama: "Panamá", Asuncion: "Asunción", Sao_Paulo: "São Paulo" };
      const city = CITY[raw] ?? raw.replace(/_/g, " ");
      return `Hora de ${city}${name ? ` (${name})` : ""}`;
    })();
    const resultsLabel =
      contactQuery.trim().length < 2 ? "Escribe al menos dos letras para buscar" : contactSearching ? "Buscando…" : `${contactHits.length} resultado${contactHits.length === 1 ? "" : "s"}`;
    const hitHint = (hit: ContactSearchHit) =>
      hit.nextAppointmentAt
        ? `Ya tiene cita el ${contactDateLabel(hit.nextAppointmentAt, true)}`
        : hit.lastVisitAt
          ? `Última visita: ${contactDateLabel(hit.lastVisitAt, false)}`
          : "Sin citas próximas";
    const newPhoneDigits = phone.replace(/\D/g, "").length;
    const newContactValid = name.trim().length > 0 && (phone.trim() === "" || newPhoneDigits >= 7);

    if (!isPhone) {
      // ── DESKTOP (reference E4): the same three steps inside the agenda's side panel —
      // never the phone screen framed. Steps 2 and 3 keep V2's content, in this panel's
      // language. Same state, same actions, same guard.
      const stepsRow = (
        <ol aria-label="Pasos" className="flex flex-wrap items-center gap-2 text-[13px]">
          {(["Cliente y servicio", "Profesional y hora", "Confirmar"] as const).map((label, i) => {
            const n = (i + 1) as 1 | 2 | 3;
            const on = n === step;
            return (
              <li key={label} className="flex items-center gap-2" aria-current={on ? "step" : undefined}>
                {i > 0 ? <span aria-hidden className="text-muted">—</span> : null}
                <span className={`inline-flex size-[20px] items-center justify-center rounded-full text-[11.5px] tabular-nums ${on ? "bg-[var(--ink)] font-medium text-[var(--ink-fg)]" : n < step ? "bg-[var(--chip)] text-foreground" : "text-muted"}`}>
                  {n < step ? "✓" : n}
                </span>
                <span className={on ? "text-foreground" : "text-[var(--ag-ink2)]"}>{label}</span>
              </li>
            );
          })}
        </ol>
      );
      const SEARCH = "flex h-[38px] items-center gap-2 rounded-[10px] bg-[var(--chip)] px-3 text-muted";
      const SMALL = "u-focus inline-flex h-[32px] items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] text-foreground hover:bg-[var(--subtle)]";
      const personRow = (hit: ContactSearchHit, onPick: () => void, sub?: string) => (
        <button key={hit.id} type="button" onClick={onPick} className="u-focus flex min-h-[48px] w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-[var(--subtle)] max-md:min-h-[56px]">
          <span aria-hidden className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-[var(--chip)] text-[12px] font-medium text-[var(--ag-ink2)]">{initialsOf(hit.name)}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[14px] text-foreground">{hit.name ?? "Contacto sin nombre"}</span>
            {hit.phone ? <span className="truncate text-[12.5px] tabular-nums text-muted">{hit.phone}</span> : null}
            {hit.email ? <span className="truncate text-[12.5px] text-muted">{hit.email}</span> : null}
            {!hit.phone && !hit.email && hit.identity ? <span className="truncate text-[12.5px] text-muted">{hit.identity}</span> : null}
            {sub ? <span className="truncate text-[12.5px] text-muted">{sub}</span> : null}
          </span>
        </button>
      );
      const visibleServices = filteredServices
        .filter((sv) => !serviceQuery.trim() || sv.name.toLocaleLowerCase("es").includes(serviceQuery.trim().toLocaleLowerCase("es")))
        // A range dragged on the grid: what fits in it first (stable otherwise).
        .map((sv, i) => ({ sv, i, fits: spanMin === null || sv.duration_min <= spanMin }))
        .sort((x, y) => (x.fits === y.fits ? x.i - y.i : x.fits ? -1 : 1))
        .map((x) => x.sv);
      const footer = (
        <div className="flex items-center gap-2">
          <div aria-live="polite" className="flex min-w-0 flex-1 flex-col">
            <span className="text-[12.5px] text-muted">Paso {step} de 3</span>
            <span className="truncate text-[14px] font-medium text-foreground">{step === 1 && !step1Ready && !customer.label && !serviceId ? "Aún no has elegido nada" : summary}</span>
          </div>
          {step > 1 && !(isReschedule && step === 2) ? (
            <Button onClick={goBack}>Volver</Button>
          ) : (
            <Button onClick={() => deskPanel.current?.requestClose()}>Cancelar</Button>
          )}
          {step === 3 ? (
            <Button variant="primary" disabled={!slotStart} loading={pending} loadingLabel={isReschedule ? "Guardando…" : "Creando…"} onClick={submit}>
              {isReschedule ? "Confirmar cambio" : "Crear cita"}
            </Button>
          ) : (
            <Button variant="primary" disabled={(step === 1 && !step1Ready) || (step === 2 && !slotStart)} onClick={advance}>
              Continuar
            </Button>
          )}
        </div>
      );
      return (
        <SidePanel
          name="booking"
          title={isReschedule ? "Reprogramar cita" : "Nueva cita"}
          subtitle={`${selectedSite?.name ?? ""} · ${shortDateLabel}`}
          headerRule={false}
          headerBelow={stepsRow}
          dirty={hasChoices}
          onClose={props.onClose}
          handleRef={deskPanel}
          footer={footer}
        >
          {props.error ? (
            <p role="alert" className="mb-3 rounded-[10px] bg-[var(--ag-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ag-danger-ink)]">
              {props.error}
            </p>
          ) : null}
          {step === 1 ? (
            <>
              {paintedLabel ? (
                <div className="mb-1 flex flex-col gap-2 rounded-[10px] bg-[var(--chip)] px-3 py-2 text-[12.5px] leading-[1.45] text-[var(--ag-ink2)]">
                  <span>
                    <span className="font-medium text-foreground">Marcaste {paintedLabel}.</span>{" "}
                    {presetPast
                      ? "Esa hora ya pasó: no se puede reservar. Si la atención ya se hizo, regístrala como realizada."
                      : `${spanMin !== null ? "La cita dura lo que dure el servicio con ese profesional; primero van los que caben. " : ""}Al continuar se usa esa hora si sigue libre.`}
                  </span>
                  {presetPast && props.onWalkIn ? (
                    <button type="button" className={`${SMALL} self-start`} onClick={() => props.onWalkIn?.(walkContext(true))}>
                      Registrar atención realizada
                    </button>
                  ) : null}
                </div>
              ) : null}
              <PanelSection title="Cliente" id="nv-client" size="lg">
                {customer.label ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3 rounded-[12px] px-3 py-2.5 shadow-[inset_0_0_0_1.5px_var(--foreground)]">
                      <span aria-hidden className="inline-flex size-[36px] shrink-0 items-center justify-center rounded-full bg-[var(--chip)] text-[12px] font-medium text-[var(--ag-ink2)]">{initialsOf(customer.label)}</span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[14px] font-medium">{customer.label}</span>
                        <span className="truncate text-[12.5px] tabular-nums text-muted">
                          {customer.identity ?? (customerMode === "new" && !pickedContact ? "Contacto nuevo · se crea al confirmar la cita" : "")}
                        </span>
                      </span>
                      {!bookingContact ? (
                        <button
                          type="button"
                          className={SMALL}
                          onClick={() => {
                            setPickedContact(null);
                            setCustomerMode("search");
                            setName("");
                            setPhone("");
                            setEmail("");
                          }}
                        >
                          Cambiar
                        </button>
                      ) : null}
                    </div>
                    {pickedContact?.nextAppointmentAt ? (
                      <p role="status" className="flex gap-2 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--warn)]">
                        <span aria-hidden>!</span>Ya tiene cita el {contactDateLabel(pickedContact.nextAppointmentAt, true)}. Revisa que no sea un duplicado.
                      </p>
                    ) : null}
                  </div>
                ) : customerMode === "new" ? (
                  <div className="flex flex-col gap-2.5">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-[13px] font-medium">Nombre</span>
                      <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} />
                    </label>
                    <div className="grid grid-cols-2 gap-2.5">
                      <label className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-[13px] font-medium">Teléfono</span>
                        <input className={INPUT} type="tel" inputMode="tel" placeholder="+57 300 000 0000" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="off" />
                      </label>
                      <label className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-[13px] font-medium">Correo</span>
                        <input className={INPUT} type="email" inputMode="email" placeholder="nombre@correo.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
                      </label>
                    </div>
                    <p className="text-[12.5px] text-muted">Para guardar el contacto basta un teléfono o un correo; con solo el nombre queda en esta cita, sin contacto.</p>
                    <button type="button" className="u-focus self-start text-[13px] text-[var(--ag-ink2)] underline underline-offset-2" onClick={() => setCustomerMode("search")}>
                      Buscar un contacto existente
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <label className={SEARCH}>
                      <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></svg>
                      <input type="search" aria-label="Buscar cliente" placeholder="Nombre o teléfono" value={contactQuery} onChange={(e) => setContactQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted" />
                    </label>
                    {contactQuery.trim().length < 2 ? (
                      <>
                        {recents && recents.length > 0 ? <span className="pt-1 text-[12.5px] text-muted">Recientes</span> : null}
                        {recents === null ? <div aria-busy="true" aria-label="Cargando recientes" className="h-[48px] rounded-[10px] bg-[var(--chip)]" /> : null}
                        <div className="flex flex-col">{(recents ?? []).map((h) => personRow(h, () => setPickedContact(h)))}</div>
                      </>
                    ) : (
                      <div className="flex flex-col">
                        <span className="text-[12.5px] text-muted">{resultsLabel}</span>
                        {contactHits.map((h) => personRow(h, () => { setPickedContact(h); setContactQuery(""); }, hitHint(h)))}
                        {contactSearched && contactHits.length === 0 ? <p className="px-2.5 py-2 text-[13px] text-muted">Sin resultados para «{contactQuery.trim()}».</p> : null}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 pt-1 text-[13px]">
                      <button
                        type="button"
                        className="u-focus text-[var(--ag-ink2)] underline underline-offset-2"
                        onClick={() => {
                          if (/^[+\d\s()-]{7,}$/.test(contactQuery.trim())) setPhone(contactQuery.trim());
                          else if (contactQuery.trim()) setName(contactQuery.trim());
                          setCustomerMode("new");
                        }}
                      >
                        {contactQuery.trim().length >= 2 ? `Nuevo cliente «${contactQuery.trim()}»` : "Nuevo cliente"}
                      </button>
                      {props.onWalkIn ? (
                        <button type="button" className="u-focus text-[var(--ag-ink2)] underline underline-offset-2" onClick={() => props.onWalkIn?.(walkContext())}>
                          ¿Llegó sin cita? Registrar ahora
                        </button>
                      ) : null}
                    </div>
                  </div>
                )}
                {contactMatches.length > 0 ? (
                  <div role="alert" className="flex flex-col gap-2 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] text-[var(--warn)]">
                    <span>Ya existe un contacto con ese teléfono o correo. Vincúlalo en lugar de crear otro.</span>
                    {contactMatches.map((m) => (
                      <button
                        key={m.contactId}
                        type="button"
                        className={`${SMALL} self-start`}
                        onClick={() => {
                          setPickedContact({ id: m.contactId, name: m.name, identity: m.matchedValue, phone: null, email: null, isCustomer: false, appointmentCount: 0, lastVisitAt: null, nextAppointmentAt: null });
                          setCustomerMode("search");
                          setContactMatches([]);
                          props.onError(null);
                        }}
                      >
                        Vincular a {m.name ?? m.matchedValue}
                      </button>
                    ))}
                  </div>
                ) : null}
              </PanelSection>
              <PanelSection title="Servicio" id="nv-service" size="lg">
                <label className={SEARCH}>
                  <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></svg>
                  <input type="search" aria-label="Buscar servicio" placeholder="Buscar servicio" value={serviceQuery} onChange={(e) => setServiceQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-muted" />
                </label>
                <div role="radiogroup" aria-labelledby="nv-service" className="grid grid-cols-2 gap-2">
                  {visibleServices.map((service) => {
                    const sel = service.id === serviceId;
                    const family = serviceCategory(service.name, service.category);
                    return (
                      <button
                        key={service.id}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => {
                          setServiceId(service.id);
                          resetSlots();
                        }}
                        className={`u-focus flex min-h-[56px] items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-shadow ${sel ? "shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--subtle)]"}`}
                      >
                        <span aria-hidden className={`u-appt-service ${apptCategoryClass(family)} mt-[6px] size-2 shrink-0 rounded-full bg-[var(--appt-rule)]`} />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px]">{service.name}</span>
                          <span className="block text-[12.5px] tabular-nums text-muted">
                            {service.duration_min} min{priceLabelCOP(service.price) ? ` · ${priceLabelCOP(service.price)}` : ""}
                          </span>
                          {spanMin !== null ? (
                            <span className={`mt-1 inline-flex h-[20px] items-center rounded-[6px] px-1.5 text-[11.5px] ${service.duration_min <= spanMin ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--warn-soft)] text-[var(--warn)]"}`}>
                              {service.duration_min <= spanMin ? "Cabe" : `Dura ${service.duration_min} min`}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                  {visibleServices.length === 0 ? <p className="col-span-2 text-[13px] text-muted">Ningún servicio coincide con «{serviceQuery.trim()}».</p> : null}
                </div>
              </PanelSection>
            </>
          ) : null}
          {step === 2 ? (
            <>
              <PanelSection title="Profesional" id="nv-staff">
                <div role="radiogroup" aria-labelledby="nv-staff" className="flex flex-wrap gap-1.5">
                  {[...(props.lockStaffId ? [] : [{ id: "", name: "Cualquiera" }]), ...staffChoices].map((st) => {
                    const sel = staffId === st.id;
                    return (
                      <button
                        key={st.id || "any"}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => changeStaff(st.id)}
                        className={`u-focus inline-flex h-[36px] items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[13.5px] ${sel ? "font-medium shadow-[inset_0_0_0_1.5px_var(--foreground)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--subtle)]"}`}
                      >
                        {st.id ? <AgAvatar name={st.name} id={st.id} size={24} tint={rosterTint(st.id)} /> : <span aria-hidden className="inline-flex size-[24px] items-center justify-center rounded-full bg-[var(--chip)] text-[11px]">∗</span>}
                        {st.id ? st.name.split(" ")[0] : "Cualquiera"}
                      </button>
                    );
                  })}
                </div>
              </PanelSection>
              <PanelSection
                title="Día"
                id="nv-day"
                action={
                  <span className="flex items-center gap-1">
                    <span className="mr-1 text-[12.5px] capitalize text-muted">{monthTitle(calendarMonth)}</span>
                    <button type="button" aria-label="Semana anterior" onClick={() => changeDate(addDays(selectedDate, -7) < todayKey ? todayKey : addDays(selectedDate, -7))} className="u-focus inline-flex size-[32px] items-center justify-center rounded-[9px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">‹</button>
                    <button type="button" aria-label="Semana siguiente" onClick={() => changeDate(addDays(selectedDate, 7))} className="u-focus inline-flex size-[32px] items-center justify-center rounded-[9px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">›</button>
                  </span>
                }
              >
                <div role="group" aria-labelledby="nv-day" className="grid grid-cols-7 gap-1">
                  {strip.map((d) => {
                    const sel = d === selectedDate;
                    const av = dayState(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={sel}
                        aria-label={`${wdShort(d)} ${Number(d.slice(8))} · ${({ ok: "con horas libres", full: "sin horas libres", closed: "cerrado", past: "pasado", unknown: "sin datos" } as const)[av]}`}
                        disabled={av === "past"}
                        onClick={() => changeDate(d)}
                        className={`u-focus flex h-[52px] flex-col items-center justify-center gap-0.5 rounded-[10px] ${sel ? "bg-[var(--ink)] text-[var(--ink-fg)]" : av === "ok" || av === "unknown" ? "bg-[var(--chip)] text-foreground hover:bg-[var(--subtle)]" : "text-muted"} disabled:opacity-50`}
                      >
                        <span className="text-[11.5px] opacity-80">{wdShort(d)}</span>
                        <span className={`text-[15px] font-medium ${av === "closed" ? "line-through" : ""}`}>{Number(d.slice(8))}</span>
                      </button>
                    );
                  })}
                </div>
              </PanelSection>
              <PanelSection title={<>Hora libre <span className="font-normal text-muted">· {selectedService ? `${selectedService.duration_min} min` : ""}</span></>} id="nv-time">
                {presetMiss && presetStartAt && !loadingSlots ? (
                  <p role="status" className="rounded-[10px] bg-[var(--warn-soft)] px-3 py-2 text-[12.5px] leading-[1.45] text-[var(--warn)]">
                    Las {fmtTime(presetStartAt, props.timezone)} que marcaste{presetStaffFirst ? ` con ${presetStaffFirst}` : ""} no están libres para {selectedService?.name ?? "este servicio"}: se cruza con otra cita, una pausa o un bloqueo, o no cabe en su horario. Elige otra hora.
                  </p>
                ) : null}
                {loadingSlots ? (
                  <div role="status" aria-live="polite" className="flex flex-col gap-2">
                    <p className="flex items-center gap-2 text-[13px] text-muted">
                      <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-[var(--ag-ink2)]" />
                      Buscando horas libres…
                    </p>
                    <div aria-hidden className="grid grid-cols-6 gap-1.5">
                      {Array.from({ length: 12 }, (_, i) => <span key={i} className="h-[36px] animate-pulse rounded-[10px] bg-[var(--chip)]" />)}
                    </div>
                  </div>
                ) : visibleSlots.length === 0 ? (
                  <div className="flex flex-col gap-2 rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">
                    <span>
                      {selState === "closed" ? `${selectedSite?.name ?? "La sede"} no abre este día.` : selState === "past" ? "Esa fecha ya pasó." : staffId && selectedStaff ? `No quedan horas libres con ${selectedStaff.name.split(" ")[0]} este día.` : "No quedan horas libres este día."}
                    </span>
                    {nextOk ? (
                      <button type="button" className={`${SMALL} self-start`} onClick={() => changeDate(nextOk)}>
                        Próximo con horas libres: {wdShort(nextOk).toLowerCase()} {Number(nextOk.slice(8))}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <div role="radiogroup" aria-labelledby="nv-time" className="grid grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-1.5">
                    {visibleSlots.map((slot) => {
                      const sel = slot.start_at === slotStart;
                      return (
                        <button
                          key={slot.start_at}
                          type="button"
                          role="radio"
                          aria-checked={sel}
                          onClick={() => {
                            setSlotStart(slot.start_at);
                            setPresetActive(false);
                            if (!staffId) setStaffId(slot.staff_id);
                          }}
                          className={`u-focus h-[36px] rounded-[10px] text-[14px] tabular-nums ${sel ? "bg-[var(--ink)] font-medium text-[var(--ink-fg)]" : "shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-[var(--subtle)]"}`}
                        >
                          {fmtTime(slot.start_at, props.timezone)}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[12.5px] text-muted">{tzLabel}</p>
              </PanelSection>
            </>
          ) : null}
          {step === 3 ? (
            <div className="flex flex-col">
              {[...confirmRows.slice(0, 3), ["Fecha", dayHeadline(selectedDate)] as [string, string], ["Hora", timeRangeLabel ?? "—"] as [string, string], ...confirmRows.slice(3)].map(([k, v], i, all) => (
                <div key={k} className={`grid grid-cols-[170px_minmax(0,1fr)] gap-3 py-[11px] text-[13.5px] ${i < all.length - 1 ? "shadow-[inset_0_-1px_0_var(--line-soft)]" : ""}`}>
                  <span className="text-muted">{k}</span>
                  <span className="min-w-0 tabular-nums [overflow-wrap:anywhere]">{v}</span>
                </div>
              ))}
              {spanNote ? <p className="mt-3 rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--ag-ink2)]">{spanNote}</p> : null}
              <p className="mt-3 rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">Nada se guarda hasta que confirmes. No se avisa al cliente automáticamente.</p>
            </div>
          ) : null}
        </SidePanel>
      );
    }

    return (
      <MScreen
        label={title}
        framed={!isPhone}
        onEscape={() => (phoneSheet ? setPhoneSheet(null) : requestClose())}
        header={
          <div className="flex flex-col gap-[10px]">
            <div className="flex min-h-[44px] items-center gap-1.5">
              <MIconButton label="Cerrar" onClick={requestClose}>
                <Icon d={ICON.close} size={18} width={1.6} />
              </MIconButton>
              <div className="-ml-1 flex min-w-0 flex-1 flex-col">
                <h2 className="m-0 truncate text-[17px] font-semibold leading-[1.25]">{isReschedule ? "Reprogramar cita" : props.modal.mode === "walkin" ? "Atención sin cita" : "Nueva cita"}</h2>
                <span className="text-[13px] text-m-tx3">
                  Paso {step} de 3 · {stepName}
                </span>
              </div>
            </div>
            <div aria-hidden className="grid grid-cols-3 gap-1.5">
              {[1, 2, 3].map((i) => (
                <span key={i} className={`block h-1 rounded-[2px] ${i <= step ? "bg-m-tx" : "bg-m-bd"}`} />
              ))}
            </div>
          </div>
        }
        footer={
          <div className="flex flex-col gap-[10px]">
            {props.error ? (
              <p role="alert" className="rounded-[12px] bg-m-dnbg px-3 py-2 text-[14px] text-m-dn">
                {props.error}
              </p>
            ) : null}
            <div aria-live="polite" className="flex min-h-5 items-center gap-2">
              <span aria-hidden className={`size-2 flex-none rounded-full ${ready && step < 3 ? "bg-m-ok" : "bg-m-tx3"}`} />
              <span className={`min-w-0 truncate text-[14px] ${step === 2 && slotStart ? "font-semibold" : ""} ${ready || step === 3 ? "text-m-tx" : "text-m-tx3"}`}>{summary}</span>
            </div>
            <div className="flex gap-2">
              {step > 1 && !(isReschedule && step === 2) ? <MButton onClick={goBack}>Volver</MButton> : null}
              {step === 3 ? (
                <MButton kind="primary" grow disabled={!slotStart} loading={pending} loadingLabel={isReschedule ? "Guardando…" : "Creando…"} onClick={submit}>
                  {isReschedule ? "Confirmar cambio" : "Crear cita"}
                </MButton>
              ) : (
                <MButton kind="primary" grow disabled={(step === 1 && !step1Ready) || (step === 2 && !slotStart)} onClick={advance}>
                  Continuar
                </MButton>
              )}
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-[22px]">
          {step === 1 ? (
            <>
              {paintedLabel ? (
                <div className="flex flex-col gap-2 rounded-[12px] bg-m-sf2 px-3 py-[10px] text-[14px] leading-[1.4] text-m-tx2">
                  <span>
                    <span className="font-semibold text-m-tx">Marcaste {paintedLabel}.</span>{" "}
                    {presetPast ? "Esa hora ya pasó: no se puede reservar. Si la atención ya se hizo, regístrala como realizada." : "Al continuar se usa esa hora si sigue libre."}
                  </span>
                  {presetPast && props.onWalkIn ? (
                    <button type="button" onClick={() => props.onWalkIn?.(walkContext(true))} className={`${M_SMALL} self-start`}>
                      Registrar atención realizada
                    </button>
                  ) : null}
                </div>
              ) : null}
              <section className="flex flex-col gap-[10px]">
                <h2 className="m-0 text-[15px] font-semibold">Cliente</h2>
                {customer.label ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-3 rounded-[16px] border-[1.5px] border-m-tx bg-m-sf py-[10px] pl-[14px] pr-[10px]">
                      <MClientAvatar name={customerMode === "anonymous" ? null : customer.label} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="break-words text-[16px] font-semibold leading-[1.3]">{customer.label}</span>
                        {customerMode === "anonymous" && !bookingContact ? (
                          <span className="text-[14px] text-m-tx3">Cliente presente, sin datos de contacto</span>
                        ) : customer.identity ? (
                          <span className="u-tnum text-[14px] text-m-tx3">{customer.identity}</span>
                        ) : customerMode === "new" && !pickedContact ? (
                          <span className="text-[14px] text-m-tx3">Contacto nuevo · se crea al confirmar la cita</span>
                        ) : null}
                      </div>
                      {!bookingContact ? (
                        <button
                          type="button"
                          onClick={() => {
                            setPickedContact(null);
                            setCustomerMode("search");
                            setName("");
                            setPhone("");
                            setEmail("");
                          }}
                          className={M_SMALL}
                        >
                          Cambiar
                        </button>
                      ) : null}
                    </div>
                    {pickedContact?.nextAppointmentAt ? (
                      <div role="status" className="flex gap-2 rounded-[12px] bg-m-warnbg px-3 py-[10px] text-[14px] leading-[1.4] text-m-warn">
                        <span aria-hidden>!</span>
                        <span>Ya tiene cita el {contactDateLabel(pickedContact.nextAppointmentAt, true)}. Revisa que no sea un duplicado.</span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="flex flex-col gap-[10px]">
                    <label className="u-focus flex h-[48px] items-center gap-2 rounded-[12px] border border-m-bd bg-m-sf px-3 text-m-tx3">
                      <Icon d={ICON.search} size={18} />
                      <input
                        type="search"
                        value={contactQuery}
                        onChange={(e) => setContactQuery(e.target.value)}
                        placeholder="Nombre o teléfono"
                        aria-label="Buscar cliente"
                        className="h-[44px] min-w-0 flex-1 border-0 bg-transparent text-[16px] text-m-tx outline-none placeholder:text-m-tx3"
                      />
                    </label>
                    <span className="text-[13px] text-m-tx3">{resultsLabel}</span>
                    <div className={M_CARD}>
                      {contactHits.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          onClick={() => {
                            setPickedContact(hit);
                            setContactQuery("");
                          }}
                          className="flex min-h-[64px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent py-[10px] pl-[14px] pr-3 text-left text-m-tx first:border-t-0"
                        >
                          <MClientAvatar name={hit.name} size={40} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="break-words text-[16px] leading-[1.3]">{hit.name ?? "Contacto sin nombre"}</span>
                            <span className="u-tnum text-[13px] text-m-tx3">{[hit.identity, hitHint(hit)].filter(Boolean).join(" · ")}</span>
                          </span>
                        </button>
                      ))}
                      {contactSearched && contactHits.length === 0 ? (
                        <div className="flex flex-col gap-1 px-[14px] py-4">
                          <span className="text-[15px] font-semibold">Sin resultados para «{contactQuery.trim()}»</span>
                          <span className="text-[14px] text-m-tx3">Revisa el nombre o el número, o crea el contacto.</span>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          if (/^[+\d\s()-]{7,}$/.test(contactQuery.trim())) setPhone(contactQuery.trim());
                          else if (contactQuery.trim()) setName(contactQuery.trim());
                          setPhoneSheet("contact");
                        }}
                        className="flex min-h-[56px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent px-[14px] text-left text-[15px] text-m-tx first:border-t-0"
                      >
                        <span aria-hidden className="flex size-[40px] flex-none items-center justify-center rounded-full border-[1.5px] border-dashed border-m-tx3 text-[18px]">
                          +
                        </span>
                        {contactQuery.trim().length >= 2 ? `Crear contacto «${contactQuery.trim()}»` : "Crear contacto"}
                      </button>
                      <button
                        type="button"
                        onClick={() => (props.onWalkIn ? props.onWalkIn(walkContext()) : setCustomerMode("anonymous"))}
                        className="flex min-h-[56px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent px-[14px] text-left text-[15px] text-m-tx"
                      >
                        <span aria-hidden className="flex size-[40px] flex-none items-center justify-center rounded-full bg-m-sf2 text-[15px]">
                          →
                        </span>
                        <span className="flex flex-col">
                          <span>Sin cita · ahora</span>
                          <span className="text-[13px] text-m-tx3">Alguien que llegó sin reserva: un solo paso</span>
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
              <section className="flex flex-col gap-[10px]">
                <h2 className="m-0 text-[15px] font-semibold">Servicio</h2>
                {serviceFamilies.length > 1 ? (
                  <div role="group" aria-label="Categorías" className="flex flex-wrap gap-2">
                    <MPill selected={serviceFamily === "all"} onClick={() => pickFamily("all")}>
                      Todos
                    </MPill>
                    {serviceFamilies.map((f) => (
                      <MPill key={f} selected={serviceFamily === f} onClick={() => pickFamily(f)} dot={fam(f)}>
                        {SERVICE_FAMILY_LABEL[f] ?? f}
                      </MPill>
                    ))}
                  </div>
                ) : null}
                <div role="radiogroup" aria-label="Servicio" className={M_CARD}>
                  {filteredServices.map((service) => {
                    const sel = service.id === serviceId;
                    const f = fam(serviceCategory(service.name, service.category));
                    return (
                      <button
                        key={service.id}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => {
                          setServiceId(service.id);
                          resetSlots();
                        }}
                        className="flex min-h-[64px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent py-[10px] pl-[14px] pr-3 text-left text-m-tx first:border-t-0"
                      >
                        <MRadio on={sel} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="flex items-center gap-2 text-[16px] leading-[1.3]">
                            <span aria-hidden className={`${f} size-[10px] flex-none rounded-full bg-[var(--m-dot)]`} />
                            <span className="break-words">{service.name}</span>
                          </span>
                          <span className="pl-[18px] text-[13px] text-m-tx3">{service.duration_min} min</span>
                        </span>
                        <span className="u-tnum whitespace-nowrap text-[15px]">{priceLabelCOP(service.price) ?? "A consultar"}</span>
                      </button>
                    );
                  })}
                  {filteredServices.length === 0 ? <p className="px-[14px] py-4 text-[14px] text-m-tx3">No hay servicios en esta categoría.</p> : null}
                </div>
              </section>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <section className="flex flex-col gap-[10px]">
                <h2 className="m-0 text-[15px] font-semibold">Profesional</h2>
                <div role="radiogroup" aria-label="Profesional" className="grid grid-cols-4 gap-2">
                  {[...(props.lockStaffId ? [] : [{ id: "", name: "Cualquiera" }]), ...staffChoices].map((s) => {
                    const sel = staffId === s.id;
                    return (
                      <button
                        key={s.id || "any"}
                        type="button"
                        role="radio"
                        aria-checked={sel}
                        onClick={() => changeStaff(s.id)}
                        className={`flex min-h-[84px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-[12px] bg-m-sf px-0.5 py-2 text-m-tx ${sel ? "border border-m-tx shadow-[inset_0_0_0_1px_var(--m-tx)]" : "border border-m-bd"}`}
                      >
                        <MStaffAvatar id={s.id || null} name={s.name} size={44} color={s.id ? teamColors.get(s.id) : undefined} />
                        <span className={`max-w-full truncate text-[13px] ${sel ? "font-semibold" : ""}`}>{s.id ? s.name.replace(/^\s*[[(][^\])]*[\])]\s*/, "").split(/\s+/)[0] : "Cualquiera"}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
              <section className="flex flex-col gap-[10px]">
                <div className="flex items-center gap-2">
                  <h2 className="m-0 text-[15px] font-semibold">Fecha</h2>
                  <span className="whitespace-nowrap text-[14px] capitalize text-m-tx3">{monthTitle(calendarMonth)}</span>
                  <button type="button" onClick={() => setPhoneSheet("month")} className="ml-auto flex h-[44px] flex-none items-center gap-1.5 whitespace-nowrap rounded-[12px] border border-m-bd bg-m-sf px-3 text-[14px] text-m-tx">
                    <Icon d={ICON.calendar} size={16} width={1.4} />
                    Ver mes
                  </button>
                </div>
                <div className="flex gap-[2px]">
                  {strip.map((d) => {
                    const sel = d === selectedDate;
                    const av = dayState(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-label={`${wdShort(d)} ${Number(d.slice(8))} · ${({ ok: "con cupos", full: "sin cupos", closed: "cerrado", past: "pasado", unknown: "sin datos" } as const)[av]}`}
                        aria-pressed={sel}
                        disabled={av === "past"}
                        onClick={() => changeDate(d)}
                        className={`flex min-h-[68px] min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-[12px] border p-0 disabled:opacity-50 ${
                          sel ? "border-m-pri bg-m-pri" : av === "closed" ? "border-m-bd bg-m-sf2" : "border-m-bd bg-m-sf"
                        }`}
                      >
                        <span className={`text-[12px] ${sel ? "text-m-onpri" : "text-m-tx3"}`}>{wdShort(d)}</span>
                        <span className={`text-[17px] font-semibold ${sel ? "text-m-onpri" : av === "ok" || av === "unknown" ? "text-m-tx" : "text-m-tx3"} ${av === "closed" ? "line-through" : ""}`}>{Number(d.slice(8))}</span>
                        <span
                          aria-hidden
                          className={`size-1.5 rounded-full ${av === "ok" ? (sel ? "bg-m-onpri" : "bg-m-ok") : "bg-transparent"} ${av === "full" ? (sel ? "shadow-[inset_0_0_0_1.5px_var(--m-onpri)]" : "shadow-[inset_0_0_0_1.5px_var(--m-tx3)]") : ""}`}
                        />
                      </button>
                    );
                  })}
                </div>
                <Legend />
              </section>
              <section className="flex flex-col gap-[10px]">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="m-0 text-[15px] font-semibold">{dayHeadline(selectedDate)}</h2>
                  <span className="text-[13px] text-m-tx3">{tzLabel}</span>
                </div>
                {presetMiss && presetStartAt && !loadingSlots ? (
                  <p role="status" className="rounded-[12px] bg-m-warnbg px-3 py-[10px] text-[14px] leading-[1.4] text-m-warn">
                    Las {fmtTime(presetStartAt, props.timezone)} que marcaste{presetStaffFirst ? ` con ${presetStaffFirst}` : ""} no están libres para {selectedService?.name ?? "este servicio"}. Elige otra hora.
                  </p>
                ) : null}
                {loadingSlots ? (
                  <div role="status" aria-label="Cargando disponibilidad" className="flex flex-col gap-2">
                    <span className="text-[13px] text-m-tx3">Buscando horarios disponibles…</span>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
                      {Array.from({ length: 8 }, (_, i) => (
                        <span key={i} className="h-[48px] animate-pulse rounded-[12px] bg-m-sk" />
                      ))}
                    </div>
                  </div>
                ) : slotGroups.length === 0 ? (
                  <div className="flex flex-col gap-1.5 rounded-[16px] border border-m-bd bg-m-sf px-4 py-[18px]">
                    <span className="text-[16px] font-semibold">
                      {selState === "closed" ? "Cerrado" : selState === "past" ? "Fecha pasada" : staffId && selectedStaff ? `Sin cupos con ${selectedStaff.name.replace(/^\s*[[(][^\])]*[\])]\s*/, "").split(/\s+/)[0]}` : "Sin cupos este día"}
                    </span>
                    <span className="text-[14px] leading-[1.45] text-m-tx3">
                      {selState === "closed"
                        ? `${selectedSite?.name ?? "La sede"} no abre este día.`
                        : selState === "past"
                          ? "Elige hoy o un día posterior."
                          : staffId
                            ? "Prueba con otro profesional o elige otro día."
                            : "Elige otro día."}
                    </span>
                    {selState === "past" ? (
                      <button type="button" onClick={() => changeDate(todayKey)} className={`${M_SMALL} mt-1.5 self-start`}>
                        Ir a hoy
                      </button>
                    ) : nextOk ? (
                      <button type="button" onClick={() => changeDate(nextOk)} className={`${M_SMALL} mt-1.5 self-start`}>
                        {selState === "closed" ? `Ir al ${wdShort(nextOk).toLowerCase()} ${Number(nextOk.slice(8))}` : `Próximo con cupos: ${wdShort(nextOk).toLowerCase()} ${Number(nextOk.slice(8))}`}
                      </button>
                    ) : null}
                  </div>
                ) : (
                  slotGroups.map((group) => (
                    <div key={group.key} className="flex flex-col gap-2 pb-1.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[14px] font-semibold text-m-tx2">{group.label}</span>
                        <span className="text-[13px] text-m-tx3">
                          {group.slots.length} horario{group.slots.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div role="radiogroup" aria-label={group.label} className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-2">
                        {group.slots.map((slot) => {
                          const sel = slot.start_at === slotStart;
                          return (
                            <button
                              key={slot.start_at}
                              type="button"
                              role="radio"
                              aria-checked={sel}
                              onClick={() => {
                                setSlotStart(slot.start_at);
                                setPresetActive(false);
                                if (!staffId) setStaffId(slot.staff_id);
                              }}
                              className={`u-tnum flex min-h-[48px] items-center justify-center rounded-[12px] border p-0 text-[15px] ${sel ? "border-m-pri bg-m-pri font-semibold text-m-onpri" : "border-m-bd bg-m-sf text-m-tx"}`}
                            >
                              {fmtTime(slot.start_at, props.timezone)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </section>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <div className={`${heroFamily} flex flex-col gap-0.5 rounded-[16px] bg-[var(--m-fill)] px-4 py-[14px]`}>
                <span className="text-[15px] text-m-tx2">{dayHeadline(selectedDate)}</span>
                <span className="u-tnum text-[30px] font-semibold leading-[1.15] tracking-[-0.02em]">{timeRangeLabel ?? "—"}</span>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="text-[14px] text-m-tx2">{[selectedService ? `${slotMinutes ?? selectedService.duration_min} min` : null, selectedService?.name].filter(Boolean).join(" · ")}</span>
                  {!isReschedule ? <MStateChip status={initialStatus} /> : null}
                </div>
              </div>
              {spanNote ? <p className="rounded-[12px] bg-m-sf2 px-3 py-[10px] text-[14px] leading-[1.4] text-m-tx2">{spanNote}</p> : null}
              {contactMatches.length > 0 ? (
                <div role="status" className="flex flex-col gap-2 rounded-[16px] border border-m-bd bg-m-sf px-[14px] py-3">
                  <span className="text-[15px] font-semibold">Ya existe un contacto con ese teléfono o correo</span>
                  {contactMatches.map((m) => (
                    <div key={m.contactId} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold">{m.name ?? "Sin nombre"}</span>
                        <span className="u-mono block truncate text-[13px] text-m-tx3">{m.matchedValue}</span>
                      </span>
                      <MButton
                        onClick={() => {
                          setPickedContact({ id: m.contactId, name: m.name, identity: m.matchedValue, phone: null, email: null, isCustomer: false, appointmentCount: 0, lastVisitAt: null, nextAppointmentAt: null });
                          setCustomerMode("search");
                          setContactMatches([]);
                          props.onError(null);
                        }}
                      >
                        Vincular
                      </MButton>
                    </div>
                  ))}
                  <span className="text-[13px] text-m-tx3">Vincúlalo para no crear un contacto duplicado.</span>
                </div>
              ) : null}
              <div className={M_CARD}>
                {confirmRows.map(([k, v]) => (
                  <div key={k} className="flex min-h-[48px] items-start gap-3 border-t border-m-dv px-[14px] py-3 first:border-t-0">
                    <span className="w-24 flex-none text-[14px] text-m-tx3">{k}</span>
                    <span className="u-tnum min-w-0 flex-1 break-words text-right text-[15px] leading-[1.35]">{v}</span>
                  </div>
                ))}
              </div>
              {!isReschedule ? (
                <section className="flex flex-col gap-[10px]">
                  <h2 className="m-0 text-[15px] font-semibold">Estado inicial</h2>
                  <MSegmented
                    label="Estado inicial"
                    stretch
                    value={initialStatus}
                    options={[
                      { value: "scheduled", label: "○ Sin confirmar" },
                      { value: "confirmed", label: "✓ Confirmada" },
                    ]}
                    onChange={setInitialStatus}
                  />
                </section>
              ) : null}
              <section className="flex flex-col gap-[10px]">
                <h2 className="m-0 text-[15px] font-semibold">Color en la agenda</h2>
                <div className="flex min-h-[64px] items-center gap-3 rounded-[16px] border border-m-bd bg-m-sf py-[10px] pl-[14px] pr-3">
                  <span aria-hidden className={`${heroFamily} flex size-[40px] flex-none items-center justify-center rounded-full bg-[var(--m-fill)] shadow-[inset_0_0_0_1px_var(--m-bd)]`}>
                    <span className="size-3.5 rounded-full bg-[var(--m-dot)]" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px]">Automático · {bookingFamily ? SERVICE_FAMILY_LABEL[bookingFamily] ?? "Sin categoría" : "Sin categoría"}</span>
                    <span className="text-[13px] text-m-tx3">Según la categoría del servicio</span>
                  </span>
                </div>
              </section>
            </>
          ) : null}
        </div>

        <Sheet open={phoneSheet === "month"} onClose={() => setPhoneSheet(null)} label="Elegir fecha" bodyClassName="flex flex-col gap-3 px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-1">
            <span className="flex-1 text-[18px] font-semibold capitalize">{monthTitle(calendarMonth)}</span>
            <button type="button" aria-label="Mes anterior" disabled={calendarMonth <= todayKey.slice(0, 7)} onClick={() => changeMonth(-1)} className="flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-m-tx disabled:text-m-tx3">
              <Icon d={ICON.back} size={18} width={1.6} />
            </button>
            <button type="button" aria-label="Mes siguiente" onClick={() => changeMonth(1)} className="flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-m-tx">
              <Icon d={ICON.next} size={18} width={1.6} />
            </button>
          </div>
          <div aria-hidden className="grid grid-cols-7 text-center text-[12px] text-m-tx3">
            {["L", "M", "X", "J", "V", "S", "D"].map((l, i) => (
              <span key={`${l}${i}`}>{l}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-[2px]">
            {monthDays.map((day) => {
              if (!day.inMonth) return <span key={day.key} />;
              const av = dayState(day.key);
              const sel = day.key === selectedDate;
              return (
                <button
                  key={day.key}
                  type="button"
                  aria-label={`${day.day} · ${({ ok: "con cupos", full: "sin cupos", closed: "cerrado", past: "pasado", unknown: "sin datos" } as const)[av]}`}
                  aria-pressed={sel}
                  disabled={av === "past" || av === "closed"}
                  onClick={() => {
                    changeDate(day.key);
                    setPhoneSheet(null);
                  }}
                  className={`flex min-h-[48px] flex-col items-center justify-center gap-[3px] rounded-[12px] border-0 p-0 text-[16px] ${av === "past" ? "opacity-50" : ""} ${
                    sel ? "bg-m-pri font-semibold text-m-onpri" : `bg-transparent ${av === "closed" ? "text-m-tx3 line-through" : av === "full" ? "text-m-tx3" : "text-m-tx"}`
                  }`}
                >
                  <span>{day.day}</span>
                  <span
                    aria-hidden
                    className={`size-[5px] rounded-full ${av === "ok" ? (sel ? "bg-m-onpri" : "bg-m-ok") : "bg-transparent"} ${av === "full" ? "shadow-[inset_0_0_0_1.2px_var(--m-tx3)]" : ""}`}
                  />
                </button>
              );
            })}
          </div>
          <Legend />
          <MButton className="w-full" onClick={() => setPhoneSheet(null)}>
            Cerrar
          </MButton>
        </Sheet>

        <Sheet open={phoneSheet === "contact"} onClose={() => setPhoneSheet(null)} label="Crear contacto" bodyClassName="flex flex-col gap-[14px] px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          <span className="text-[18px] font-semibold">Crear contacto</span>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nc-name" className="text-[14px] font-semibold">
              Nombre
            </label>
            <input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="h-[48px] rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nc-phone" className="text-[14px] font-semibold">
              Teléfono <span className="font-normal text-m-tx3">(opcional)</span>
            </label>
            <input id="nc-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+57 300 000 0000" className="u-tnum h-[48px] rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx" />
            {phone.trim() && newPhoneDigits < 7 ? (
              <span role="alert" className="text-[13px] text-m-dn">
                Escribe al menos 7 dígitos.
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="nc-email" className="text-[14px] font-semibold">
              Correo <span className="font-normal text-m-tx3">(opcional)</span>
            </label>
            <input id="nc-email" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-[48px] rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx" />
          </div>
          <span className="text-[13px] text-m-tx3">
            {phone.trim() || email.trim()
              ? "El contacto se crea al confirmar la cita. Si ya existe uno con ese teléfono o correo, te propondremos vincularlo."
              : "Sin teléfono ni correo no se crea un contacto: el nombre queda solo en esta cita."}
          </span>
          <div className="flex gap-2">
            <MButton onClick={() => setPhoneSheet(null)}>Cancelar</MButton>
            <MButton
              kind="primary"
              grow
              disabled={!newContactValid}
              onClick={() => {
                setPickedContact(null);
                setCustomerMode("new");
                setPhoneSheet(null);
              }}
            >
              Usar este contacto
            </MButton>
          </div>
        </Sheet>

        <Sheet open={phoneSheet === "discard"} onClose={() => setPhoneSheet(null)} alert label="¿Descartar la cita?" bodyClassName="pb-[max(20px,env(safe-area-inset-bottom))]">
          <MConfirm title="¿Descartar la cita?" body="Se perderán el cliente, el servicio y el horario elegidos. No se ha guardado nada.">
            <div className="flex flex-col gap-2 pt-1">
              <MButton data-autofocus className="w-full font-semibold" onClick={() => { leaveNav.forget(); setPhoneSheet(null); }}>
                Seguir editando
              </MButton>
              <MButton kind="danger" className="w-full" onClick={() => { const go = leaveNav.hasPending(); props.onClose(); if (go) leaveNav.follow(); }}>
                Descartar cambios
              </MButton>
            </div>
          </MConfirm>
        </Sheet>
      </MScreen>
    );
  }

}

/** Availability legend of the phone booking (strip + month): dot / ring / struck. */
function Legend() {
  return (
    <div className="flex flex-wrap gap-[14px] text-[12.5px] text-m-tx3">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-m-ok" />
        Con cupos
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full shadow-[inset_0_0_0_1.5px_var(--m-tx3)]" />
        Sin cupos
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="line-through">
          12
        </span>
        Cerrado
      </span>
    </div>
  );
}
