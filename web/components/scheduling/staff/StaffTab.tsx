"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { avatarColor, avatarToneStyle, staffInitials as initials } from "@/lib/avatarColor";
import { OVERLAY_SCRIM, useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { ACT_PRIMARY } from "@/components/ui/panelChrome";
import {
  addStaffCertificationAction,
  deleteStaffCertificationAction,
  setStaffServiceAction,
  updateStaffAction,
} from "@/lib/schedulingAdminActions";
import { PageShell } from "@/components/ui/PageShell";
import {
  CONTROL_CLS,
  MetricBox,
  MetricCell,
  PanelSection,
  SEARCH_SHELL_CLS,
  SectionHeading,
  SummaryBit,
  TOOLBAR_PRIMARY_CLS,
} from "@/components/ui/primitives";
import {
  IconAssign,
  IconBusiness,
  IconCalendar,
  IconIdentity,
  IconInternal,
  IconPhone,
  IconTask,
} from "@/components/ui/icons";
import { StaffCreateDrawer } from "./StaffCreateDrawer";
import { StaffHeaderCard, type StaffHeaderSlots } from "./StaffHeaderCard";

/** Serializable shapes from the server page. */
export interface StaffSiteOpt { id: string; name: string; timezone: string }
export interface StaffServiceOpt {
  id: string;
  name: string;
  active: boolean;
  durationMin: number;
  description: string | null;
}
export interface StaffCertification {
  id: string;
  name: string;
  issuer: string | null;
  /** yyyy-mm-dd, or null when unknown. */
  issuedOn: string | null;
  expiresOn: string | null;
}
export interface StaffMember {
  id: string;
  name: string;
  /** Still employed. Deactivating keeps their history and their agenda lane. */
  active: boolean;
  siteId: string;
  siteName: string;
  /** weekday → ranges; {} means "inherit the site's opening hours". */
  workingHours: Record<string, { start: string; end: string }[]>;
  serviceIds: string[];
  // ── Profile (staff-fields migration). null = nobody has filled it in. ────────
  title: string | null;
  employmentType: string | null;
  weeklyHours: number | null;
  /** yyyy-mm-dd. Seniority is derived from it — never stored. */
  startDate: string | null;
  skills: string[];
  /** Has a chair. Distinct from `active`: a front-desk hire works here and takes none. */
  takesBookings: boolean;
  // PII. Only this screen receives it (the page uses listStaffAdmin).
  phone: string | null;
  email: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  certifications: StaffCertification[];
}
export interface StaffAppointment {
  id: string;
  staffId: string;
  startAt: string;
  endAt: string;
  serviceName: string;
  contactName: string | null;
  status: string;
}
export interface StaffWindowAppointment {
  staffId: string;
  startAt: string;
  durationMin: number;
  status: string;
  /** The appointment's OWN service-name snapshot — so a service renamed or removed
   *  since still counts under the name it was sold as. */
  serviceName: string;
}
export interface StaffTimeOff {
  staffId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

/**
 * STAFF — the roster: one card per barber, a detail drawer beside it.
 *
 * Every status on a card is DERIVED from data the page already loaded — today's
 * appointments, the barber's weekly hours, their time-off exceptions — never stored
 * and never guessed. That is the whole point of the screen: "who is free right now"
 * is a question the schedule can already answer, it was just never asked.
 *
 * TODO(staff): the model has no ROLE, PHONE or EMAIL for a staff member (`staff` is
 *   id/site/name/working_hours/active). The design shows all three under the name.
 *   They render only when present, which today means never — adding them is a
 *   migration, not a component change.
 * TODO(staff): "N gaps" and "N need attention" on a card need an availability pass
 *   over the day (free slots between appointments, and unconfirmed/overlapping ones).
 *   The engine exists (scheduling/availability) but is per-service; wiring it per
 *   barber per day is its own change, so the footer shows the counts that ARE exact.
 */
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
/** The drawer's tabs, in the reference's order. */
const DETAIL_TABS = ["performance", "details", "services", "hours", "time off"] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

type StatusKey = "with_client" | "available" | "on_shift" | "off_today" | "time_off" | "no_chair";

// ── HOURS DRAFT ──────────────────────────────────────────────────────────────
// The Hours tab edits a LOCAL copy so the unsaved bar has something to compare
// against. `working_hours` already stores an ARRAY of ranges per day, so split
// shifts ("9–13, 15–19") are a real, storable thing — not something to fake.
type HourDraft = Record<string, { start: string; end: string }[]>;

function draftFromWeekly(w: Record<string, { start: string; end: string }[]>): HourDraft {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, (w[d] ?? []).map((r) => ({ ...r }))]));
}
/** How many DAYS differ from what is stored — the number the unsaved bar reports. */
function countDirtyDays(draft: HourDraft, stored: Record<string, { start: string; end: string }[]>): number {
  return WEEKDAYS.filter((d) => JSON.stringify(draft[d] ?? []) !== JSON.stringify(stored[d] ?? [])).length;
}
function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

/**
 * The presence line in the drawer header. For a barber mid-appointment it reports how
 * long they have BEEN in the chair rather than when they get out: on a card you are
 * planning around, "23 min in" is the number that tells you whether to interrupt.
 * The roster row keeps "UNTIL 12:30", which is the number you scan a column for.
 */
function presenceChip(key: StatusKey, appts: StaffAppointment[], now: Date, tz: string): string {
  if (key !== "with_client") return STATUS[key].label;
  const current = appts.find((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now);
  if (!current) return STATUS[key].label;
  const mins = Math.max(0, Math.round((now.getTime() - new Date(current.startAt).getTime()) / 60_000));
  return `${mins} MIN IN CHAIR`;
}

const STATUS: Record<StatusKey, { label: string; dot: string; text: string }> = {
  with_client: { label: "WITH CLIENT", dot: "bg-service-purple", text: "text-service-purple" },
  available: { label: "AVAILABLE NOW", dot: "bg-success", text: "text-success" },
  on_shift: { label: "ON SHIFT", dot: "bg-success/60", text: "text-muted" },
  off_today: { label: "OFF TODAY", dot: "bg-faintest", text: "text-faint" },
  time_off: { label: "TIME OFF", dot: "bg-brand", text: "text-brand" },
  no_chair: { label: "NO CHAIR", dot: "bg-faintest", text: "text-faint" },
};

export interface StaffTabProps {
  sites: StaffSiteOpt[];
  currentSiteId?: string;
  services: StaffServiceOpt[];
  members: StaffMember[];
  timezone: string;
  todayIso: string;
  selectedId: string | null;
  todayAppointments: StaffAppointment[];
  windowAppointments: StaffWindowAppointment[];
  timeOff: StaffTimeOff[];
  /** Which drawer tab to open on — `?dtab=` makes a barber's hours or services a
   *  link you can send someone, not a place they have to click to. */
  detailTab?: string;
}

export function StaffTab(
  props: StaffTabProps & {
    clientId: string;
    /** The screen's title pieces and tab strip. They belong to the page, but they are
     *  drawn INSIDE this component's header card so the card is one box, not two. */
    header: StaffHeaderSlots;
  },
) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [creating, setCreating] = useState(false);

  const { header } = props;
  const tz = props.timezone;
  const now = new Date(props.todayIso);
  const windowAppointments = props.windowAppointments ?? [];
  const timeOff = props.timeOff ?? [];

  /** The site-local weekday key of "now" — what the working-hours map is indexed by. */
  const todayKey = WEEKDAYS[weekdayIndex(now, tz)];

  const byStaff = useMemo(() => {
    const map = new Map<string, StaffAppointment[]>();
    for (const a of props.todayAppointments ?? []) {
      if (a.status === "cancelled") continue;
      const list = map.get(a.staffId) ?? [];
      list.push(a);
      map.set(a.staffId, list);
    }
    for (const list of map.values()) list.sort((x, z) => x.startAt.localeCompare(z.startAt));
    return map;
  }, [props.todayAppointments]);

  /** Status + footer for one barber, entirely derived. */
  const describe = (s: StaffMember) => {
    const appts = byStaff.get(s.id) ?? [];
    const off = timeOff.find((t) => t.staffId === s.id && new Date(t.startsAt) <= now && new Date(t.endsAt) > now);
    const worksToday = s.workingHours[todayKey]?.length ? true : Object.keys(s.workingHours).length === 0;
    const inChair = appts.find((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now);
    const next = appts.find((a) => new Date(a.startAt) > now);

    let key: StatusKey;
    let suffix = "";
    // NO CHAIR is takes_bookings, NOT active. They are different facts: `active =
    // false` means they no longer work here (and the page does not even load them),
    // while takes_bookings = false is a front-desk hire who works every day and
    // simply has no agenda lane. Deriving this from `active` conflated the two.
    if (!s.takesBookings) key = "no_chair";
    else if (off) {
      key = "time_off";
      const days = Math.max(1, Math.round((new Date(off.endsAt).getTime() - new Date(off.startsAt).getTime()) / 86_400_000));
      suffix = ` · ${days} ${days === 1 ? "DAY" : "DAYS"}`;
    } else if (inChair) {
      key = "with_client";
      suffix = ` · UNTIL ${fmtTime(inChair.endAt, tz)}`;
    } else if (!worksToday) key = "off_today";
    else if (appts.length > 0 || next) key = "available";
    else key = "on_shift";

    return { key, suffix, appts, next, off, worksToday };
  };

  const filtered = props.members.filter((s) => {
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (serviceFilter && !s.serviceIds.includes(serviceFilter)) return false;
    if (statusFilter && describe(s).key !== statusFilter) return false;
    return true;
  });

  // The legend: real counts over the WHOLE roster, not the filtered view.
  const counts = props.members.reduce(
    (acc, s) => {
      const k = describe(s).key;
      if (k === "with_client") acc.withClient += 1;
      else if (k === "available" || k === "on_shift") acc.available += 1;
      else acc.off += 1;
      return acc;
    },
    { withClient: 0, available: 0, off: 0 },
  );

  const selected = props.selectedId ? props.members.find((s) => s.id === props.selectedId) ?? null : null;
  const hrefFor = (id: string | null) => {
    const p = new URLSearchParams();
    if (props.currentSiteId) p.set("site", props.currentSiteId);
    if (id) p.set("s", id);
    const qs = p.toString();
    return qs ? `?${qs}` : "?";
  };

  return (
    <>
      {/* THREE CARDS ON THE CANVAS — header, roster, detail — as SIBLINGS in a row, the
          same arrangement Contacts uses. The detail panel is a real column here, not a
          drawer floating over a reserved `pr-[452px]` lane: the lane trick meant the
          roster's right edge and the panel's left edge were set by two independent
          numbers that had to be kept in step by hand. As siblings the gap is the
          canvas showing through, and each card keeps its own four corners. */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          <StaffHeaderCard
            slots={header}
            counters={
              // The presence legend, promoted out of the filter row into the title band
              // as Contacts' counters. Real counts over the WHOLE roster, not the
              // filtered view — unchanged from where they came from.
              <>
                <SummaryBit tone="busy" value={counts.withClient} label="with a client" />
                <SummaryBit tone="success" value={counts.available} label="available" />
                <SummaryBit value={counts.off} label="off" />
              </>
            }
            controls={
              <>
                <div className="min-w-0 flex-1">
                  <div className={`${SEARCH_SHELL_CLS} min-w-0 max-w-[280px]`}>
                    <SearchIcon />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search staff"
                      aria-label="Search staff"
                      className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                    />
                  </div>
                </div>
                <Facet
                  label="Service"
                  value={serviceFilter}
                  onChange={setServiceFilter}
                  options={[{ value: "", label: "Service" }, ...props.services.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))]}
                />
                <Facet
                  label="Site"
                  value={props.currentSiteId ?? ""}
                  onChange={(v) => router.push(`?site=${v}`)}
                  options={props.sites.map((s) => ({ value: s.id, label: s.name }))}
                />
                <Facet
                  label="Status"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: "", label: "Status" },
                    { value: "with_client", label: "With a client" },
                    { value: "available", label: "Available" },
                    { value: "off_today", label: "Off today" },
                    { value: "time_off", label: "Time off" },
                  ]}
                />
                {/* THE PRIMARY ACTION, at the far right of the control band — where
                    Contacts puts "Nuevo contacto". It used to sit up on the title line,
                    which is the band that says what you are LOOKING at. This screen is
                    owner/admin only, so everyone who reaches it can manage the roster;
                    there is no second permission check. */}
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className={`ml-auto ${TOOLBAR_PRIMARY_CLS}`}
                >
                  + Add staff member
                </button>
              </>
            }
          />

          {/* THE ROSTER CARD — PageShell, so its corners, hairline, fill and shadow are
              the table card's on Contacts rather than a second hand-rolled set. The
              scroll is INSIDE the card: it used to wrap the card, so the roster's own
              bottom edge scrolled up out of view with the rows. */}
          <PageShell>
            {/* The column header sits on the SAME white as the rows: the roster is
                already its own card on grey, so a tinted strip inside it was a second
                surface doing nothing the hairline below does not. */}
            <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
              <span className="w-[30px] shrink-0" />
              <span className="u-th min-w-0 flex-1">Member</span>
              <span className="u-th hidden w-[190px] shrink-0 lg:block">Presence</span>
              <span className="u-th hidden w-[104px] shrink-0 sm:block">Today</span>
              <span className="u-th hidden w-[146px] shrink-0 lg:block">Next</span>
              <span className="w-5 shrink-0" />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* A card per barber gave every one of them the same visual weight and
                  wasted a screen on six; a row per person puts presence, load and
                  what's next on one scannable line. */}
              {filtered.map((s) => {
                const d = describe(s);
                return (
                  <StaffRow
                    key={s.id}
                    member={s}
                    status={d.key}
                    suffix={d.suffix}
                    appts={d.appts}
                    next={d.next}
                    tz={tz}
                    href={hrefFor(s.id)}
                    selected={s.id === props.selectedId}
                  />
                );
              })}

              {filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-faint">No staff match these filters.</p>
              ) : null}

              {/* The dashed row keeps its place at the end of the list — it is the
                  "next empty row" of the roster, not a second primary action. */}
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="m-3 flex h-[52px] w-[calc(100%-1.5rem)] items-center justify-center gap-2 rounded-table border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-faint hover:text-foreground"
              >
                + Add staff member
              </button>
            </div>
          </PageShell>
        </div>

        {/* THE DETAIL COLUMN — a third sibling card, in flow, so the roster shrinks to
            make room instead of hiding under an overlay.
            ONE instance, two geometries. From `lg` up the wrapper is a plain flex child
            of the row and the panel is a column beside the roster; below it, the SAME
            element goes `fixed` and covers the content, because there is no room for a
            third column on a laptop. Rendering it twice (once per geometry) would give
            the reader two independent copies of the hours and profile drafts, and two
            focus traps. Its width is a token read through a class, not an inline style,
            so it can be breakpoint-scoped at all. */}
        {selected || creating ? (
          <>
            {/* SCRIM — overlay mode only, and only for the READ-ONLY panel: the editor
                brings its own catcher (it must intercept a click on a roster row so a
                stray click cannot navigate away from unsaved edits). A Link and not a
                button, because closing the panel is a navigation: the selection lives in
                the URL. */}
            {selected && !creating ? (
              <Link
                href={hrefFor(null)}
                scroll={false}
                aria-label="Close staff details"
                className={`${OVERLAY_SCRIM} lg:hidden`}
              />
            ) : null}
            {/* THE PANEL REGION. `lg:relative` — in flow as a column, AND the positioning
                context the editor anchors to. That is the whole reason the editor can land
                exactly on the box the read-only panel occupied: same top, same bottom,
                same right edge, same width, contents swapping. `lg:static` would put the
                editor's `absolute` against the page instead. */}
            <div className="pointer-events-none fixed inset-0 z-50 flex items-stretch justify-end lg:pointer-events-auto lg:relative lg:inset-auto lg:z-auto lg:min-h-0 lg:w-[var(--staff-panel-w)] lg:shrink-0 lg:self-stretch">
              {selected ? (
              <StaffDetail
                // Keyed: selecting another barber must reset the hours and profile
                // drafts, not carry one person's unsaved edits onto the next.
                key={selected.id}
                member={selected}
                status={describe(selected)}
                tz={tz}
                now={now}
                clientId={props.clientId}
                services={props.services}
                windowAppointments={windowAppointments.filter((a) => a.staffId === selected.id)}
                timeOff={timeOff.filter((t) => t.staffId === selected.id)}
                closeHref={hrefFor(null)}
                onSaved={() => router.refresh()}
                initialTab={props.detailTab}
              />
              ) : null}
              {/* THE EDITOR, absolutely over the panel it replaces. Both live in the same
                  region, so pressing Edit swaps the contents without moving the frame.
                  When CREATING there is no barber selected and the region holds only this
                  — the roster still shrinks to make its lane, exactly as it would for a
                  selection. */}
              {/* CREATE only. There is no edit drawer any more — a barber who exists is
                  changed in the tabs of their own panel. This one exists because a barber
                  who does NOT exist has no panel to be edited in. */}
              {creating ? (
                <StaffCreateDrawer
                  clientId={props.clientId}
                  siteId={props.currentSiteId}
                  services={props.services}
                  sites={props.sites}
                  onClose={() => setCreating(false)}
                  onSaved={() => {
                    setCreating(false);
                    router.refresh();
                  }}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * One barber, one row. The four columns answer the four questions a manager actually
 * asks the roster: who, are they free, how loaded are they today, and what's next.
 * The narrow columns collapse below `lg` — the name and presence survive, which is
 * the pair that still works on a phone.
 */
function StaffRow({
  member,
  status,
  suffix,
  appts,
  next,
  tz,
  href,
  selected,
}: {
  member: StaffMember;
  status: StatusKey;
  suffix: string;
  appts: StaffAppointment[];
  next?: StaffAppointment;
  tz: string;
  href: string;
  selected: boolean;
}) {
  const s = STATUS[status];
  const attention = status === "time_off" && appts.length > 0;
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "true" : undefined}
      className={`flex h-[56px] shrink-0 items-center gap-3 border-b border-line/70 px-4 transition-colors last:border-0 ${
        selected ? "bg-chip" : "hover:bg-subtle"
      }`}
    >
      <span
        aria-hidden
        className={`u-mono flex size-[30px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${avatarColor(member.name)}`}
      >
        {initials(member.name)}
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-foreground">{member.name}</span>
        {/* The ROLE, now that there is a column for it. The site name is not repeated
            on every row — one site is the common case, and the filter above names it. */}
        <span className="truncate text-[11px] text-muted">{member.title ?? member.siteName}</span>
      </span>

      <span className={`u-mono hidden w-[190px] shrink-0 items-center gap-1.5 whitespace-nowrap text-[9.5px] font-medium uppercase tracking-[0.07em] lg:flex ${s.text}`}>
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
        {s.label}
        {suffix}
      </span>

      <span className="u-mono hidden w-[104px] shrink-0 whitespace-nowrap text-[11.5px] text-foreground sm:block">
        {status === "no_chair" ? "NO CHAIR" : `${appts.length} TODAY`}
      </span>

      <span
        className={`hidden w-[146px] shrink-0 truncate text-[12.5px] lg:block ${
          attention ? "font-medium text-brand" : "text-muted"
        }`}
      >
        {status === "no_chair"
          ? "handles inbox & walk-ins"
          : attention
            ? `${appts.length} to reassign`
            : status === "off_today"
              ? "rest day"
              : next
                ? `${status === "with_client" ? "then" : "next"} ${fmtTime(next.startAt, tz)}`
                : "nothing booked"}
      </span>

      <span aria-hidden className="w-5 shrink-0 text-center text-xs text-faintest">
        &middot;&middot;&middot;
      </span>
    </Link>
  );
}

/** The detail drawer: identity, actions, and the Performance tab. */
function StaffDetail({
  member,
  status,
  tz,
  now,
  clientId,
  services,
  windowAppointments,
  timeOff,
  closeHref,
  onSaved,
  initialTab,
}: {
  member: StaffMember;
  status: { key: StatusKey; appts: StaffAppointment[] };
  tz: string;
  now: Date;
  clientId: string;
  services: StaffServiceOpt[];
  windowAppointments: StaffWindowAppointment[];
  timeOff: StaffTimeOff[];
  closeHref: string;
  onSaved: () => void;
  initialTab?: string;
}) {
  // FIVE tabs, and every one reads something real: the schedule answers performance,
  // the roster row answers details, `staff_services` answers services, `working_hours`
  // answers hours and `schedule_exceptions` answers time off. There is no "Activity"
  // tab — a per-barber activity feed has no source (appointment events are per
  // appointment), so it is not offered rather than shipped empty.
  const [tab, setTab] = useState<DetailTab>(
    (DETAIL_TABS.find((t) => t === initialTab) ?? "performance") as DetailTab,
  );
  const [range, setRange] = useState<14 | 30>(14);
  // HOURS DRAFT — the Hours tab edits a local copy; the unsaved bar commits it.
  const [draft, setDraft] = useState<HourDraft>(() => draftFromWeekly(member.workingHours));
  // PROFILE DRAFT — the Details tab edits a local copy through the same unsaved bar as
  // Hours, so one Save writes the whole panel rather than each field racing the others.
  const [profile, setProfile] = useState<ProfileDraft>(() => profileFromMember(member));
  const [saving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  // Overlay mode only: trapping focus in a panel the reader can see BESIDE the roster
  // would make the rest of the screen unreachable by keyboard for no reason.
  const router = useRouter();
  const overlaying = useIsOverlayWidth();
  const panelRef = useTrappedPanel({ active: overlaying, onClose: () => router.push(closeHref, { scroll: false }) });
  const dirtyDays = countDirtyDays(draft, member.workingHours);
  const dirtyFields = dirtyProfileFields(profile, member);
  const changes = dirtyDays + dirtyFields.length;
  // Mirror the CHECK constraints client-side: the schema already refuses these, this
  // just says so before the round trip.
  const invalid = profileError(profile);
  const s = STATUS[status.key];
  // The header's ONE meta line, the contact panel's "identity · contacto desde" applied
  // to an employee: what they do and how long they have done it. Both facts were already
  // on this screen (the role on the old header's second line, the seniority in Details);
  // neither is new, they are just introduced together now.
  const headerMeta = [member.title, member.startDate ? seniority(member.startDate) : null]
    .filter(Boolean)
    .join(" · ");

  // ── Performance, all computed from the 30-day window this page loaded ──
  const settled = windowAppointments.filter((a) => a.status !== "cancelled");
  const completed = settled.filter((a) => a.status === "completed").length;
  const noShows = settled.filter((a) => a.status === "no_show").length;
  const minutes = settled.reduce((n, a) => n + a.durationMin, 0);
  const completedPct = settled.length === 0 ? null : Math.round((completed / settled.length) * 100);

  /** Appointments per day over the selected window — the sparkline's series. */
  const series = useMemo(() => {
    const days: number[] = [];
    for (let i = range - 1; i >= 0; i--) {
      const from = new Date(now.getTime() - i * 86_400_000);
      const key = dayKey(from, tz);
      days.push(settled.filter((a) => dayKey(new Date(a.startAt), tz) === key).length);
    }
    return days;
  }, [settled, now, tz, range]);

  /** CAPACITY: the hours this barber is rostered for across the window, straight from
   *  their weekly grid — so "booked 46 of 76 h" is two real numbers, not a target. */
  const weeklyMinutes = WEEKDAYS.reduce(
    (n, d) => n + (member.workingHours[d] ?? []).reduce((m, r) => m + minutesBetween(r.start, r.end), 0),
    0,
  );
  const capacityHours = Math.round((weeklyMinutes * (30 / 7)) / 60);

  /** The five services this barber was booked for most in the window, biggest first. */
  const topServices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of settled) {
      const name = a.serviceName?.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, z) => z.count - x.count || x.name.localeCompare(z.name))
      .slice(0, 5);
  }, [settled]);


  return (
    <aside
      ref={panelRef as React.RefObject<HTMLElement>}
      aria-label="Staff details"
      aria-modal={overlaying || undefined}
      role={overlaying ? "dialog" : undefined}
      tabIndex={-1}
      // No drop shadow: in this system elevation is SURFACE CONTRAST, not a blur (see
      // the house rules in components/ui/primitives.tsx). The panel already reads as
      // "on top" from its own fill and hairline against the recessed roster behind it —
      // the shadow the reference used only muddied the edge.
      // No shadow, and the same hairline as the two cards it sits beside: the drawer
      // is part of the screen's card family, not something lifted off it. Depth here
      // is surface contrast against the canvas, as everywhere else in this system.
      // The FRAME is PageShell's, class for class, so this panel is the same card as the
      // header and the roster beside it — 12px radius, --line hairline, --shadow-card.
      // It used to draw its own 16px radius on a --line-strong hairline with no shadow,
      // which is why it read as a different KIND of object next to the two cards it
      // shares a row with. Its WIDTH comes from the wrapper (see --staff-panel-w), which
      // is what lets one element be a column here and a full-bleed overlay below `lg`.
      className="pointer-events-auto flex h-full w-full max-w-full min-h-0 flex-col overflow-hidden bg-surface lg:rounded-xl lg:border lg:border-line lg:shadow-[var(--shadow-card)]"
    >
      {/* HEADER — the contact panel's header, applied to a barber: a faint wash in this
          person's OWN colour, two lines (name + presence chip, then the role/seniority
          meta), and the actions in their own row UNDERNEATH rather than crowded onto the
          name line. That last part is the difference the two panels were reading as: a
          red button beside the name made this header an action bar, while the contact
          panel's header is an introduction with the actions below it.
          Nothing here is new information — the same name, the same presence words, the
          same role and the same "View agenda" link, in the shared arrangement. */}
      <div
        style={avatarToneStyle(member.name) as React.CSSProperties}
        className="u-contact-wash flex shrink-0 flex-col gap-2.5 border-b border-line px-4 pb-3 pt-3.5"
      >
        <div className="flex w-full min-w-0 items-start gap-2.5">
          <span className="relative shrink-0">
            <span
              aria-hidden
              className={`u-mono flex size-[38px] items-center justify-center rounded-full text-[13px] font-semibold ${avatarColor(member.name)}`}
            >
              {initials(member.name)}
            </span>
            <span aria-hidden className={`absolute -bottom-px -right-px size-[11px] rounded-full border-2 border-surface ${s.dot}`} />
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Name + presence as a CHIP on the same line — the shape the contact panel
                uses for name + stage. Presence was a line of mono text below the name,
                which is the same fact wearing a different costume. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
              <h2 className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground">{member.name}</h2>
              <span
                className={`u-mono inline-flex items-center rounded-full border border-line-strong bg-chip px-2 py-[0.1rem] text-[0.625rem] font-medium uppercase leading-4 tracking-wider ${s.text}`}
              >
                {presenceChip(status.key, status.appts, now, tz)}
              </span>
            </div>
            {/* ONE meta line. No chair: there is no chair column and deliberately never
                will be (see the staff-fields migration). */}
            <p className="truncate text-[0.6875rem] leading-4 text-faint" title={headerMeta}>
              {headerMeta}
            </p>
          </div>

          <Link
            href={closeHref}
            scroll={false}
            aria-label="Close staff details"
            className="-mr-1 shrink-0 rounded-md p-1 text-faint transition-colors hover:bg-subtle hover:text-foreground"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Link>
        </div>

        {/* THE ACTION ROW. There is no "Edit" here any more, and that is the point: an
            Edit button implied a SECOND place where a barber gets changed, so the same
            columns had two owners — the drawer wrote name/services/hours/flags while the
            tabs below wrote the profile, and whichever saved last won. Every one of those
            fields now lives in the tabs, behind one unsaved bar. What is left is the one
            action that is not an edit at all, so it takes the whole row. */}
        <div className="flex items-center gap-1.5">
          <Link
            href={`/clients/${clientId}/scheduling/agenda?staff=${member.id}`}
            className={ACT_PRIMARY}
          >
            View agenda
          </Link>
        </div>
      </div>

      {/* THREE ZONES, as on the contact panel: a fixed header, a FIXED tab strip, and one
          scrolling body. The strip used to live inside the scroll container, so scrolling
          the Hours grid carried the tabs off the top of the panel and the reader lost the
          control that got them there. */}
      <div className="flex shrink-0 items-center gap-3.5 border-b border-line px-4" role="tablist">
          {DETAIL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 pt-3 text-[12.5px] font-medium capitalize transition-colors ${
                tab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {t}
              {t === "time off" && timeOff.length > 0 ? (
                <span className="u-mono rounded bg-danger-tint/40 px-1.5 text-[9.5px] font-medium text-brand">
                  {timeOff.length}
                </span>
              ) : null}
              {t === "services" && member.serviceIds.length > 0 ? (
                <span className="u-mono rounded bg-chip px-1.5 text-[9.5px] font-medium text-muted">
                  {member.serviceIds.length}
                </span>
              ) : null}
            </button>
          ))}
      </div>

      {/* THE only scrolling zone. Its `key` sends it back to the top on a tab change:
          without it, opening Hours after scrolling Performance drops the reader into the
          middle of a grid whose first rows they never saw. */}
      <div key={tab} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === "performance" ? (
          // NO wrapper padding. Each section brings its own and closes with a full-width
          // rule, so the column reads as one continuous document — the contact panel's
          // arrangement. This used to be a padded stack of individually bordered cards,
          // which put a second border inside a panel that already has one and broke the
          // tab into floating slabs. That is the single biggest reason the two panels
          // felt like different products with the same tabs.
          <>
            {completedPct !== null && completedPct >= 90 ? (
              <div className="border-b border-line px-4 py-3">
                <div className="flex items-center gap-2.5 rounded-lg border border-brand/35 bg-brand-soft px-3 py-2.5">
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
                  <p className="text-xs text-foreground">
                    Completed {completedPct}% of booked appointments over the last 30 days.
                  </p>
                </div>
              </div>
            ) : null}

            {/* The window toggle drives the sparkline; the KPIs below stay on 30 days,
                which is the window the page actually loaded. It is the heading's
                TRAILING slot now, not a row of standalone buttons above the chart —
                a control that only changes this section belongs to this section. */}
            <PanelSection
              title="Appointments per day"
              icon={<IconCalendar />}
              trailing={
                // TODO(staff): the design puts "CHAIR 3" at the right of this row. There
                // is no chair column and we decided not to add one, so the slot holds the
                // window toggle rather than a number nobody stored.
                <span className="inline-flex items-center gap-0.5 rounded-md bg-chip p-0.5">
                  {([14, 30] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRange(r)}
                      aria-pressed={range === r}
                      className={`inline-flex h-6 items-center whitespace-nowrap rounded px-2 text-[11px] font-medium transition-colors ${
                        range === r ? "bg-surface text-foreground shadow-[var(--shadow-card)]" : "text-muted hover:text-foreground"
                      }`}
                    >
                      Last {r} days
                    </button>
                  ))}
                </span>
              }
            >
              <Sparkline series={series} />
            </PanelSection>

            <PanelSection title="Last 30 days" icon={<IconTask />}>
              {/* ONE divided box, not four floating cards — the same MetricBox the
                  contact panel's CITAS / ÚLTIMA / CANAL strip is built from. 2×2 because
                  "Appointments · 30d" and "Hours booked" cannot share one row at 440px. */}
              <MetricBox cols={2}>
                <MetricCell label="Appointments · 30d" value={settled.length} />
                <MetricCell label="Completed" value={completed} note={completedPct === null ? undefined : `${completedPct}%`} />
                <MetricCell label="No-shows" value={noShows} tone={noShows > 0 ? "brand" : undefined} />
                <MetricCell
                  label="Hours booked"
                  value={Math.round(minutes / 60)}
                  note={weeklyMinutes > 0 ? `of ${capacityHours} h` : "no hours set"}
                />
              </MetricBox>
            </PanelSection>

            <PanelSection
              title={`Today · ${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(now)}`}
              icon={<IconCalendar />}
              trailing={status.appts.length > 0 ? `${status.appts.length} booked` : undefined}
            >
              <div className="flex flex-col gap-2">
                {status.appts.length === 0 ? (
                  <p className="text-xs text-faint">Nothing booked today.</p>
                ) : (
                  <div className="flex flex-col rounded-lg border border-line">
                    {status.appts.map((a) => (
                      <div key={a.id} className="flex items-center gap-2.5 border-b border-line/70 px-3 py-2 last:border-0">
                        <span aria-hidden className="h-6 w-[3px] shrink-0 rounded-sm bg-service-purple" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-xs font-semibold text-foreground">{a.contactName ?? "Walk-in"}</span>
                          <span className="truncate text-[11px] text-faint">{a.serviceName}</span>
                        </span>
                        <span className="u-mono shrink-0 text-[11px] text-muted">{fmtTime(a.startAt, tz)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <Link
                  href={`/clients/${clientId}/scheduling/agenda?staff=${member.id}`}
                  className="self-start text-xs text-accent hover:underline"
                >
                  Open this day in the agenda &#8599;
                </Link>
              </div>
            </PanelSection>

            {/* TOP SERVICES — what this barber actually gets booked for. Counted from
                the SAME 30-day window the KPIs above use, off the appointment's own
                service-name snapshot, so a renamed or deleted service still counts
                under the name it was sold as. Cancelled rows are already excluded. */}
            {topServices.length > 0 ? (
              <PanelSection title="Top services · 30d" icon={<IconTask />}>
                <div className="flex flex-col gap-1.5">
                  {topServices.map((t) => (
                    <div key={t.name} className="flex items-center gap-2.5">
                      <span className="w-[116px] shrink-0 truncate text-xs text-foreground" title={t.name}>
                        {t.name}
                      </span>
                      <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-chip">
                        <span
                          aria-hidden
                          className="block h-full rounded-full bg-service-purple"
                          style={{ width: `${Math.round((t.count / topServices[0].count) * 100)}%` }}
                        />
                      </span>
                      <span className="u-mono w-6 shrink-0 text-right text-[11px] text-muted">{t.count}</span>
                    </div>
                  ))}
                </div>
              </PanelSection>
            ) : null}
          </>
        ) : tab === "details" ? (
          <div className="flex flex-col">
            {/* IDENTITY — the name, and the site it belongs to. This section is why there
                is no longer an "Edit" button above: the name was the last field that lived
                only in a separate editor, so the panel's own tabs are now the ONE write
                path for everything about a barber. Every field here goes through the same
                unsaved bar at the bottom, which means one Save writes the whole person
                instead of two forms racing over the same columns. */}
            <DetailSection title="Identity" icon={<IconIdentity />}>
              <FieldRow
                label="Name"
                value={profile.name}
                onChange={(v) => setProfile((d) => ({ ...d, name: v }))}
                placeholder="Full name"
              />
              {/* SITE is read-only: a barber belongs to exactly one site in V1 and moving
                  them is not an update the repository supports. */}
              <ReadRow label="Site" value={member.siteName} />
            </DetailSection>

            {/* CONTACT — employee PII. It only reaches this component because the page
                used listStaffAdmin behind the owner/admin gate; every other reader of
                `staff` still gets the projection without these columns. */}
            <DetailSection title="Contact" icon={<IconPhone />}>
              <FieldRow
                label="Phone"
                value={profile.phone}
                onChange={(v) => setProfile((d) => ({ ...d, phone: v }))}
                placeholder="Add a phone number"
                type="tel"
              />
              <FieldRow
                label="Email"
                value={profile.email}
                onChange={(v) => setProfile((d) => ({ ...d, email: v }))}
                placeholder="Add an email"
                type="email"
              />
              <FieldRow
                label="Emergency"
                value={profile.emergencyContactName}
                onChange={(v) => setProfile((d) => ({ ...d, emergencyContactName: v }))}
                placeholder="Add a contact name"
              />
              <FieldRow
                label="Emergency phone"
                value={profile.emergencyContactPhone}
                onChange={(v) => setProfile((d) => ({ ...d, emergencyContactPhone: v }))}
                placeholder="Add a phone number"
                type="tel"
              />
            </DetailSection>

            <DetailSection title="Contract" icon={<IconInternal />}>
              <FieldRow
                label="Role"
                value={profile.title}
                onChange={(v) => setProfile((d) => ({ ...d, title: v }))}
                placeholder="e.g. Colour specialist"
              />
              <FieldRow label="Employment">
                <select
                  value={profile.employmentType}
                  onChange={(e) => setProfile((d) => ({ ...d, employmentType: e.target.value }))}
                  className={`${CELL} ${profile.employmentType ? "" : "text-faint"}`}
                >
                  <option value="">Not set</option>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FieldRow>
              <FieldRow label="Weekly hours">
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={profile.weeklyHours}
                  onChange={(e) => setProfile((d) => ({ ...d, weeklyHours: e.target.value }))}
                  placeholder="Not set"
                  className={CELL}
                />
              </FieldRow>
              <FieldRow label="Started">
                <input
                  type="date"
                  value={profile.startDate}
                  onChange={(e) => setProfile((d) => ({ ...d, startDate: e.target.value }))}
                  className={`${CELL} ${profile.startDate ? "" : "text-faint"}`}
                />
              </FieldRow>
              {/* SENIORITY is derived on every render from the date above — storing it
                  would guarantee it is wrong within a year. */}
              <FieldRow label="Seniority">
                <span className="px-1.5 text-sm text-muted">{seniority(profile.startDate) ?? "—"}</span>
              </FieldRow>
              <FieldRow label="Site">
                <span
                  className="px-1.5 text-sm text-muted"
                  title="A barber belongs to one site in V1; moving them is not an update the repository supports"
                >
                  {member.siteName}
                </span>
              </FieldRow>
            </DetailSection>

            {/* STATUS — two DIFFERENT facts, and they used to be one checkbox in a modal.
                Deactivating stays reversible precisely because it is this field: the same
                control that turns it off turns it back on, through the same patch. */}
            <DetailSection title="Status" icon={<IconAssign />}>
              <div className="flex flex-col gap-2.5 px-4 pb-3.5">
                <CheckRow
                  checked={profile.takesBookings}
                  onChange={(v) => setProfile((d) => ({ ...d, takesBookings: v }))}
                  label="Takes bookings"
                  hint="off for front desk or management: they work here, but hold no chair"
                />
                <CheckRow
                  checked={profile.active}
                  onChange={(v) => setProfile((d) => ({ ...d, active: v }))}
                  label="Still works here"
                  hint="off keeps their history and lane, but no new appointments"
                />
              </div>
            </DetailSection>

            <DetailSection title="Skills" icon={<IconTask />}>
              <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                {profile.skills.map((sk) => (
                  <span
                    key={sk}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line-strong bg-surface pl-2.5 pr-1.5 text-xs"
                  >
                    {sk}
                    <button
                      type="button"
                      aria-label={`Remove ${sk}`}
                      onClick={() => setProfile((d) => ({ ...d, skills: d.skills.filter((x) => x !== sk) }))}
                      className="text-faint transition-colors hover:text-danger"
                    >
                      &#10005;
                    </button>
                  </span>
                ))}
                <TagInput
                  onAdd={(v) =>
                    setProfile((d) => (d.skills.includes(v) ? d : { ...d, skills: [...d.skills, v] }))
                  }
                />
              </div>
            </DetailSection>

            {/* TODO(staff): the design ends Details with two more sections, and NEITHER
                is rendered because neither has anything behind it.

                ACCESS (system role, "can see the inbox", last sign-in, "Change role")
                would need a link between a STAFF row and a platform USER. There is
                none: `staff` is a bookable resource (id, site, name, hours) and
                `tenant_members` is a login with a role scoped to a client. They are
                separate populations on purpose — most barbers never log in. Wiring it
                would mean a nullable `staff.user_id` (unique per tenant) plus a
                decision about what happens on unlink, and "last sign-in" needs a
                column better_auth does not expose today.

                INTERNAL NOTES (note + author + date + "Add note") would need its own
                table: staff_notes (tenant_id, staff_id, author_user_id, body,
                created_at), tenant-checked FK like staff_certifications. Nothing here
                can stand in for it — a note is not a skill and not a certification.

                Both are left out rather than shipped as empty shells, so the tab does
                not promise a feature that has no storage. */}

            {/* CERTIFICATIONS are their own rows, so they save immediately rather than
                riding the draft — adding one is a create, not a field edit. */}
            <DetailSection title="Certifications" icon={<IconBusiness />}>
              <div className="flex flex-col gap-1.5 px-4 pb-3">
                {member.certifications.length === 0 ? (
                  <p className="text-xs text-faint">None recorded.</p>
                ) : (
                  member.certifications.map((c) => (
                    <CertificationRow
                      key={c.id}
                      cert={c}
                      now={now}
                      onDelete={() =>
                        startSave(async () => {
                          const r = await deleteStaffCertificationAction(clientId, member.id, c.id);
                          if (!r.ok) setSaveError(r.error);
                          else onSaved();
                        })
                      }
                    />
                  ))
                )}
                <CertificationForm
                  busy={saving}
                  onAdd={(input) =>
                    startSave(async () => {
                      const r = await addStaffCertificationAction({ clientId, staffId: member.id, ...input });
                      if (!r.ok) setSaveError(r.error);
                      else onSaved();
                    })
                  }
                />
              </div>
            </DetailSection>
          </div>
        ) : tab === "services" ? (
          <PanelSection
            title="Services performed"
            icon={<IconTask />}
            trailing={`${member.serviceIds.length} of ${services.length}`}
          >
          <div className="flex flex-col gap-2">
            {services.length === 0 ? (
              <p className="text-sm text-faint">This client has no services yet.</p>
            ) : (
              services.map((sv) => {
                const on = member.serviceIds.includes(sv.id);
                return (
                  // The ROW IS THE CONTROL. It used to be a read-only list under a
                  // "Change services →" link that opened a separate editor — so seeing
                  // what a barber performs and changing it were two different screens.
                  // Toggling writes IMMEDIATELY rather than joining the unsaved bar,
                  // because the action is per-pairing (setStaffServiceAction takes one
                  // service and one boolean), exactly as adding a certification does in
                  // the section below.
                  <button
                    key={sv.id}
                    type="button"
                    role="switch"
                    aria-checked={on}
                    disabled={saving}
                    onClick={() =>
                      startSave(async () => {
                        setSaveError(null);
                        const r = await setStaffServiceAction(clientId, member.id, sv.id, !on);
                        if (!r.ok) setSaveError(r.error);
                        else onSaved();
                      })
                    }
                    className={`u-focus flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      on
                        ? "border-line-strong bg-surface text-foreground hover:bg-hover"
                        : "border-line text-faint hover:border-line-strong hover:text-muted"
                    }`}
                  >
                    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${on ? "bg-success" : "bg-faintest"}`} />
                    <span className="min-w-0 flex-1 truncate">{sv.name}</span>
                    <span className="u-mono shrink-0 text-[10px] uppercase tracking-wider">
                      {on ? "performs" : "not offered"}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          </PanelSection>
        ) : tab === "hours" ? (
          <PanelSection
            title="Weekly hours"
            icon={<IconCalendar />}
            trailing={dirtyDays > 0 ? `${dirtyDays} changed` : undefined}
          >
          <div className="flex flex-col gap-3">
            <p className="text-[11px] text-faint">
              A day with no shift = off. All days off means this barber inherits{" "}
              {member.siteName}&rsquo;s opening hours.
            </p>
            <div className="flex flex-col rounded-lg border border-line">
              {WEEKDAYS.map((d) => {
                const ranges = draft[d] ?? [];
                const on = ranges.length > 0;
                const setDay = (next: { start: string; end: string }[]) =>
                  setDraft((prev) => ({ ...prev, [d]: next }));
                return (
                  <div key={d} className="flex flex-col gap-2 border-b border-line/70 px-3 py-2.5 last:border-0">
                    <div className="flex items-center gap-2">
                      <label className="flex w-24 shrink-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => setDay(e.target.checked ? [{ start: "09:00", end: "18:00" }] : [])}
                          className="size-4"
                        />
                        <span className="u-mono text-[11px] uppercase tracking-wider text-foreground">{d}</span>
                      </label>
                      {on ? (
                        <span className="u-mono ml-auto text-[10px] text-faint">
                          {Math.round(ranges.reduce((n, r) => n + minutesBetween(r.start, r.end), 0) / 60)} h
                        </span>
                      ) : (
                        <span className="ml-auto text-[11px] text-faint">Off</span>
                      )}
                    </div>

                    {ranges.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 pl-[6.5rem]">
                        <input
                          type="time"
                          value={r.start}
                          onChange={(e) =>
                            setDay(ranges.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))
                          }
                          className="rounded-md border border-line-strong bg-transparent px-2 py-1 text-xs"
                        />
                        <span aria-hidden className="text-faint">&rarr;</span>
                        <input
                          type="time"
                          value={r.end}
                          onChange={(e) => setDay(ranges.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))}
                          className="rounded-md border border-line-strong bg-transparent px-2 py-1 text-xs"
                        />
                        {ranges.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => setDay(ranges.filter((_, k) => k !== i))}
                            aria-label="Remove this stretch"
                            className="text-xs text-faint hover:text-danger"
                          >
                            &#10005;
                          </button>
                        ) : null}
                      </div>
                    ))}

                    {on ? (
                      // SPLIT SHIFTS are storable: working_hours is an array per day.
                      <button
                        type="button"
                        onClick={() => setDay([...ranges, { start: "15:00", end: "19:00" }])}
                        className="ml-[6.5rem] w-fit text-[11px] text-accent hover:underline"
                      >
                        + Add a stretch
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="u-mono text-foreground">
                {Math.round(
                  WEEKDAYS.reduce(
                    (n, d) => n + (draft[d] ?? []).reduce((m, r) => m + minutesBetween(r.start, r.end), 0),
                    0,
                  ) / 60,
                )}{" "}
                H
              </span>
              <span aria-hidden className="text-faintest">&middot;</span>
              <span className="u-mono">{WEEKDAYS.filter((d) => (draft[d] ?? []).length > 0).length} DAYS</span>
            </div>
          </div>
          </PanelSection>
        ) : (
          <PanelSection
            title="Time off"
            icon={<IconCalendar />}
            trailing={timeOff.length > 0 ? `${timeOff.length} booked` : undefined}
          >
          <div className="flex flex-col gap-2">
            {timeOff.length === 0 ? (
              <p className="text-sm text-muted">No time off booked.</p>
            ) : (
              timeOff.map((t) => {
                const days = Math.max(
                  1,
                  Math.round((new Date(t.endsAt).getTime() - new Date(t.startsAt).getTime()) / 86_400_000),
                );
                return (
                  <div
                    key={`${t.startsAt}-${t.endsAt}`}
                    className="flex items-center gap-2.5 rounded-lg border border-danger-tint bg-danger-tint/20 px-3 py-2.5"
                  >
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {t.reason?.trim() || "Time off"}
                      </span>
                      <span className="u-mono truncate text-[11px] text-muted">
                        {fmtDay(t.startsAt, tz)} &rarr; {fmtDay(t.endsAt, tz)}
                      </span>
                    </span>
                    <span className="u-mono shrink-0 text-[11px] text-brand">
                      {days} {days === 1 ? "day" : "days"}
                    </span>
                  </div>
                );
              })
            )}
            {/* TODO(staff): time off is `schedule_exceptions` — real, but with no
                approval flow and no way to request one from here. Blocked time is
                created in Scheduling settings. */}
          </div>
          </PanelSection>
        )}
      </div>

      {/* UNSAVED CHANGES — only when there are any. It reports DAYS, which is the unit
          the editor above works in, and saves through the same updateStaffAction the
          settings form always used. */}
      {changes > 0 || saveError ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-4 py-3">
          {/* The SENTENCE is the flexible one: it shrinks and truncates. The two
              buttons never wrap — "Save changes" breaking onto two lines made the bar
              grow a row every time the message got long. */}
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {invalid ?? saveError ?? `${changes} unsaved ${changes === 1 ? "change" : "changes"}`}
          </span>
          <button
            type="button"
            onClick={() => {
              setSaveError(null);
              setDraft(draftFromWeekly(member.workingHours));
              setProfile(profileFromMember(member));
            }}
            className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong bg-surface px-3 text-xs transition-colors hover:bg-hover"
          >
            Discard
          </button>
          <button
            type="button"
            disabled={saving || changes === 0 || invalid !== null}
            onClick={() => {
              setSaveError(null);
              startSave(async () => {
                // ONE patch for everything that changed. Fields that were not touched
                // are absent, so a save never rewrites a column the operator did not
                // look at (and `null` for a cleared field is meaningful, not a no-op).
                const patch: Parameters<typeof updateStaffAction>[2] = {};
                if (dirtyDays > 0) {
                  // Drop empty days: `{}` for a weekday is the model's "off", and an
                  // entirely empty map is its "inherit the site's hours".
                  const weekly: Record<string, { start: string; end: string }[]> = {};
                  for (const d of WEEKDAYS) if ((draft[d] ?? []).length > 0) weekly[d] = draft[d];
                  patch.workingHours = weekly as never;
                }
                Object.assign(patch, profilePatch(profile, dirtyFields));
                const r = await updateStaffAction(clientId, member.id, patch);
                if (!r.ok) setSaveError(r.error);
                else onSaved();
              });
            }}
            className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md bg-brand px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      ) : null}
    </aside>
  );
}


// ── PROFILE DRAFT ────────────────────────────────────────────────────────────
// Everything on the Details tab is a plain string in the draft (that is what an
// <input> gives you); the empty string means "cleared", which maps to NULL on the way
// out — the column's own empty state. Keeping that translation in ONE place is why
// these are functions and not inline ternaries in the JSX.
interface ProfileDraft {
  /** The barber's NAME. It lives in this draft — and so behind the panel's unsaved bar —
   *  rather than in a separate editor, because there is exactly one write path per field
   *  on this screen. */
  name: string;
  title: string;
  employmentType: string;
  weeklyHours: string;
  startDate: string;
  phone: string;
  email: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  skills: string[];
  /** Does this person get an agenda lane? A front-desk hire works every day and takes
   *  none — that is not the same as having left. */
  takesBookings: boolean;
  /** Do they still work here? Deactivating keeps their history and their lane and stops
   *  new bookings, so it is the harder state and it is reversible from the same field. */
  active: boolean;
}

/** The stored employment types — mirrors the staff_employment_type_valid CHECK. */
const EMPLOYMENT_TYPES = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contractor", label: "Contractor" },
] as const;

function profileFromMember(m: StaffMember): ProfileDraft {
  return {
    name: m.name,
    title: m.title ?? "",
    employmentType: m.employmentType ?? "",
    weeklyHours: m.weeklyHours === null ? "" : String(m.weeklyHours),
    startDate: m.startDate ?? "",
    phone: m.phone ?? "",
    email: m.email ?? "",
    emergencyContactName: m.emergencyContactName ?? "",
    emergencyContactPhone: m.emergencyContactPhone ?? "",
    skills: [...m.skills],
    takesBookings: m.takesBookings,
    active: m.active,
  };
}

type ProfileKey = keyof ProfileDraft;

/** Which fields differ from what is stored — the number the unsaved bar reports, and
 *  the exact set the patch will carry. */
function dirtyProfileFields(d: ProfileDraft, m: StaffMember): ProfileKey[] {
  const stored = profileFromMember(m);
  return (Object.keys(d) as ProfileKey[]).filter((k) =>
    k === "skills"
      ? JSON.stringify(d.skills) !== JSON.stringify(stored.skills)
      : d[k] !== stored[k],
  );
}

/** The same rules the CHECK constraints enforce, stated before the round trip.
 *  Returns a sentence to show in the bar, or null when the draft is storable. */
function profileError(d: ProfileDraft): string | null {
  if (d.name.trim() === "") return "A name is required.";
  if (d.weeklyHours !== "") {
    const n = Number(d.weeklyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) return "Weekly hours must be a whole number from 1 to 168.";
  }
  if (d.employmentType !== "" && !EMPLOYMENT_TYPES.some((t) => t.value === d.employmentType)) {
    return "Unknown employment type.";
  }
  return null;
}

/** Only the changed fields, translated to the repository's shape ("" → null). */
function profilePatch(d: ProfileDraft, dirty: ProfileKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const blank = (v: string) => (v.trim() === "" ? null : v.trim());
  for (const k of dirty) {
    if (k === "skills") out.skills = d.skills;
    // NAME is never nulled — an empty one is refused above, not stored as absent.
    else if (k === "name") out.name = d.name.trim();
    else if (k === "takesBookings" || k === "active") out[k] = d[k];
    else if (k === "weeklyHours") out.weeklyHours = d.weeklyHours === "" ? null : Number(d.weeklyHours);
    else if (k === "employmentType") out.employmentType = d.employmentType === "" ? null : d.employmentType;
    else out[k] = blank(d[k] as string);
  }
  return out;
}

/** "Since Mar 2023 · 2y 5m", computed from start_date every render. */
function seniority(startDate: string): string | null {
  if (!startDate) return null;
  const [y, mo, day] = startDate.split("-").map(Number);
  if (!y || !mo || !day) return null;
  const start = new Date(Date.UTC(y, mo - 1, day));
  const now = new Date();
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (mo - 1));
  if (now.getUTCDate() < day) months -= 1;
  if (months < 0) return `Starts ${start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const span = years > 0 ? `${years}y ${rest}m` : `${rest}m`;
  return `Since ${start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} · ${span}`;
}

/** Days until a certification lapses; null when it never does. */
function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
}

const CELL =
  "u-focus min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-right text-sm transition-colors hover:border-line focus:text-left";

/** A titled block inside the drawer. */
/**
 * A titled block in the Details / Services / Hours tabs.
 *
 * It draws the SHARED SectionHeading — icon, mono caps label, hairline running to the
 * edge — rather than a bare `u-th` line. The bare version was a near-miss: same words,
 * same colour, no rule, so a Details tab beside a contact panel read as a rougher draft
 * of the same idea. The rows keep their own edge-to-edge padding, which is why this
 * pads the heading only.
 */
function DetailSection({
  title,
  icon,
  trailing,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-line last:border-0">
      <SectionHeading title={title} icon={icon} trailing={trailing} className="px-4 pb-2 pt-3.5" />
      {children}
    </section>
  );
}

/**
 * One label/value line. The value is an INPUT, not text with a pencil next to it: a
 * field with no data still shows its placeholder and still takes a click, which is
 * what "empty but editable" has to look like for it to be discoverable.
 */
function FieldRow({
  label,
  value,
  onChange,
  placeholder,
  type,
  children,
}: {
  label: string;
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  type?: string;
  children?: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 items-center gap-3 px-4 py-1">
      <span className="w-[104px] shrink-0 truncate text-xs text-muted sm:w-[120px]">{label}</span>
      {children ?? (
        <input
          type={type ?? "text"}
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
          placeholder={placeholder}
          className={`${CELL} placeholder:text-faint`}
        />
      )}
    </label>
  );
}

/**
 * A field row that is NOT editable — same label column and same right-aligned value, so a
 * read-only fact sits in the grid instead of breaking it. Used for Site (a barber belongs
 * to one site in V1) and for anything derived, like Seniority.
 */
function ReadRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-1">
      <span className="w-[104px] shrink-0 truncate text-xs text-muted sm:w-[120px]">{label}</span>
      <span className="min-w-0 flex-1 truncate px-1.5 py-1 text-right text-sm text-muted" title={value}>
        {value}
      </span>
    </div>
  );
}

/**
 * A checkbox over its label and its CONSEQUENCE. The consequence is not decoration: both
 * flags here are easy to confuse with each other and with deleting the person, so each
 * one says what turning it off actually does.
 */
function CheckRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-foreground">{label}</span>
        <span className="text-[11px] leading-4 text-faint">{hint}</span>
      </span>
    </label>
  );
}

/** "New tag" — enter commits, blur discards, so a half-typed tag never sticks. */
function TagInput({ onAdd }: { onAdd: (v: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const v = value.trim();
        if (v) onAdd(v);
        setValue("");
      }}
      onBlur={() => setValue("")}
      placeholder="New tag"
      aria-label="Add a skill"
      className="u-focus h-7 w-[104px] rounded-md border border-dashed border-line-strong bg-transparent px-2 text-xs placeholder:text-faint"
    />
  );
}

function CertificationRow({
  cert,
  now,
  onDelete,
}: {
  cert: StaffCertification;
  now: Date;
  onDelete: () => void;
}) {
  const left = daysUntil(cert.expiresOn, now);
  // Expired / expiring is the whole reason these are rows with dates rather than tags.
  const state =
    left === null ? null : left < 0 ? { label: "EXPIRED", cls: "text-brand" } : left <= 60 ? { label: `${left}D LEFT`, cls: "text-warn" } : null;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${
        state?.label === "EXPIRED" ? "border-danger-tint bg-danger-tint/20" : "border-line"
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-semibold text-foreground">{cert.name}</span>
        <span className="u-mono truncate text-[10.5px] text-muted">
          {[cert.issuer, cert.issuedOn ? `issued ${cert.issuedOn}` : null, cert.expiresOn ? `expires ${cert.expiresOn}` : "no expiry"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {state ? <span className={`u-mono shrink-0 text-[10px] ${state.cls}`}>{state.label}</span> : null}
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Remove ${cert.name}`}
        className="shrink-0 text-xs text-faint transition-colors hover:text-danger"
      >
        &#10005;
      </button>
    </div>
  );
}

/** Collapsed to a link until used — four inputs permanently open would dominate a tab
 *  that is mostly a list of two or three credentials. */
function CertificationForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: { name: string; issuer: string | null; issuedOn: string | null; expiresOn: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  // The CHECK says the same thing; saying it here avoids a round trip to be told off.
  const bad = issuedOn && expiresOn && expiresOn < issuedOn ? "Expiry can’t be before the issue date." : null;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-accent hover:underline">
        + Add certification
      </button>
    );
  }
  const I = "u-focus h-8 min-w-0 rounded-md border border-line-strong bg-transparent px-2 text-xs";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line-strong p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Certification" className={I} autoFocus />
      <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuer (optional)" className={I} />
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="u-th">Issued</span>
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={I} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="u-th">Expires</span>
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={I} />
        </label>
      </div>
      {bad ? <p className="text-[11px] text-danger">{bad}</p> : null}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-7 items-center rounded-md border border-line-strong px-2.5 text-xs hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || bad !== null}
          onClick={() => {
            onAdd({
              name: name.trim(),
              issuer: issuer.trim() || null,
              issuedOn: issuedOn || null,
              expiresOn: expiresOn || null,
            });
            setOpen(false);
            setName("");
            setIssuer("");
            setIssuedOn("");
            setExpiresOn("");
          }}
          className="inline-flex h-7 items-center rounded-md bg-brand px-2.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** A dependency-free sparkline. One series, no axes — the numbers live in the KPIs. */
function Sparkline({ series }: { series: number[] }) {
  const w = 300;
  const h = 64;
  const max = Math.max(1, ...series);
  const step = series.length > 1 ? w / (series.length - 1) : w;
  const points = series.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 8) - 4).toFixed(1)}`);
  const last = points[points.length - 1]?.split(",") ?? ["0", "0"];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-hidden>
      {[0.25, 0.6, 1].map((f) => (
        <line key={f} x1="0" y1={h * f} x2={w} y2={h * f} stroke="var(--line)" strokeWidth="1" />
      ))}
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--service-purple)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r="3" fill="var(--service-purple)" />
    </svg>
  );
}


function Facet({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <div className={`relative ${CONTROL_CLS}`}>
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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-faint" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="m15.8 15.8 3.7 3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}
/** "Thu 6 Aug" in the site's timezone — the time-off range labels. */
function fmtDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(
    new Date(iso),
  );
}
function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** 0=Sunday, in the SITE's timezone — the index into the working-hours map. */
function weekdayIndex(d: Date, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d).toLowerCase().slice(0, 3);
  return Math.max(0, (WEEKDAYS as readonly string[]).indexOf(name));
}
