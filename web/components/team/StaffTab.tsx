"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { avatarColor } from "@/lib/avatarColor";
import {
  addStaffCertificationAction,
  deleteStaffCertificationAction,
  updateStaffAction,
} from "@/lib/schedulingAdminActions";
import { StaffEditDialog } from "./StaffEditDialog";

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

export function StaffTab(props: StaffTabProps & { clientId: string }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [creating, setCreating] = useState(false);

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
            {/* FILTERS + the status legend. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-[var(--panel-pad)] py-3">
              <div className="flex h-9 min-w-0 max-w-[280px] flex-1 items-center gap-2 rounded-md border border-line-strong px-3">
                <SearchIcon />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search staff"
                  aria-label="Search staff"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                />
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
              <div className="ml-auto flex items-center gap-2 text-xs text-muted">
                <Legend dot="bg-service-purple" n={counts.withClient} label="with a client" />
                <span aria-hidden className="text-faintest">·</span>
                <Legend dot="bg-success" n={counts.available} label="available" />
                <span aria-hidden className="text-faintest">·</span>
                <Legend dot="bg-faintest" n={counts.off} label="off" />
              </div>
            </div>

            {/* DRAWER WIDTH is fluid and lives in ONE variable, because two numbers have
                to agree: the panel's own width and the padding that keeps the roster
                from sliding under it. Hard-coding 440 left the panel cramped on a wide
                monitor while the roster sat on dead space beside it; clamping to a
                third of the viewport lets it grow with the screen and still keeps a
                floor on a laptop and a ceiling on an ultrawide. */}
            <div
              className="relative flex min-h-0 flex-1"
              style={{ "--drawer-w": "clamp(420px, 33vw, 640px)" } as React.CSSProperties}
            >
              <div
                className={`min-h-0 flex-1 overflow-y-auto bg-background p-3 ${
                  selected ? "xl:pr-[calc(var(--drawer-w)+0.75rem)]" : ""
                }`}
              >
                {/* THE ROSTER, as a list. Cards gave every barber the same visual
                    weight and wasted a screen on six of them; a row per person puts
                    presence, load and what's next on one scannable line. */}
                <div className="flex flex-col overflow-hidden rounded-xl border border-line-strong bg-surface">
                  <div className="flex h-9 shrink-0 items-center gap-3.5 border-b border-line bg-thead-bg px-4">
                    <span className="w-[38px] shrink-0" />
                    <span className="u-th min-w-0 flex-1">Member</span>
                    <span className="u-th hidden w-[190px] shrink-0 lg:block">Presence</span>
                    <span className="u-th hidden w-[104px] shrink-0 sm:block">Today</span>
                    <span className="u-th hidden w-[146px] shrink-0 lg:block">Next</span>
                    <span className="w-5 shrink-0" />
                  </div>

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
                </div>

                {/* The Team screen is owner/admin only, so everyone who reaches this
                    tab can manage the roster — no second permission check. */}
                <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="mt-3 flex h-[52px] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-faint hover:text-foreground"
                  >
                  + Add staff member
                </button>
              </div>

              {selected ? (
                // FLOATING: the drawer sits over the list rather than butting against
                // it as a column, so the roster keeps its full width and the panel reads
                // as "opened on top of" what you were scanning. Under xl there is not
                // enough width to reserve room for it, so it simply covers the roster —
                // it used to not render at all below 1280, which meant clicking a barber
                // on a laptop appeared to do nothing whatsoever.
                <div className="pointer-events-none absolute inset-y-0 right-0 flex max-w-full items-stretch p-3">
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
                    onEdit={() => setEditing(selected)}
                    onSaved={() => router.refresh()}
                    initialTab={props.detailTab}
                  />
                </div>
              ) : null}
            </div>

      {editing || creating ? (
        <StaffEditDialog
          clientId={props.clientId}
          member={editing}
          siteId={props.currentSiteId}
          services={props.services}
          sites={props.sites}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            router.refresh();
          }}
        />
      ) : null}
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
      className={`flex h-[74px] shrink-0 items-center gap-3.5 border-b border-line/70 px-4 transition-colors last:border-0 ${
        selected ? "bg-chip" : "hover:bg-subtle"
      }`}
    >
      <span
        aria-hidden
        className={`u-mono flex size-[38px] shrink-0 items-center justify-center rounded-full text-[13px] font-semibold ${avatarColor(member.name)}`}
      >
        {initials(member.name)}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-foreground">{member.name}</span>
        {/* TODO(staff): no `role` column — the design shows "Senior stylist · Chair 3"
            here, so the site name stands in until that migration lands. */}
        <span className="truncate text-xs text-muted">{member.siteName}</span>
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
  onEdit,
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
  onEdit: () => void;
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
  const dirtyDays = countDirtyDays(draft, member.workingHours);
  const dirtyFields = dirtyProfileFields(profile, member);
  const changes = dirtyDays + dirtyFields.length;
  // Mirror the CHECK constraints client-side: the schema already refuses these, this
  // just says so before the round trip.
  const invalid = profileError(profile);
  const s = STATUS[status.key];

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


  return (
    <aside
      aria-label="Staff details"
      // No drop shadow: in this system elevation is SURFACE CONTRAST, not a blur (see
      // the house rules in components/ui/primitives.tsx). The panel already reads as
      // "on top" from its own fill and hairline against the recessed roster behind it —
      // the shadow the reference used only muddied the edge.
      className="pointer-events-auto flex h-full w-[var(--drawer-w,420px)] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-surface"
    >
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold">Staff details</h2>
        <Link
          href={closeHref}
          scroll={false}
          aria-label="Close staff details"
          className="inline-flex size-8 items-center justify-center rounded-md border border-line-strong text-xs text-muted transition-colors hover:bg-hover hover:text-foreground"
        >
          &#10005;
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col items-center gap-2 border-b border-line bg-panel-hero px-4 pb-4 pt-5 text-center">
          <span className="relative">
            <span
              aria-hidden
              className={`u-mono flex size-[58px] items-center justify-center rounded-full text-[19px] font-semibold ${avatarColor(member.name)}`}
            >
              {initials(member.name)}
            </span>
            <span aria-hidden className={`absolute bottom-px right-px size-[13px] rounded-full border-[2.5px] border-panel-hero ${s.dot}`} />
          </span>
          <span className="text-[16.5px] font-semibold tracking-[-0.015em] text-foreground">{member.name}</span>
          {/* The subtitle is the ROLE, per the design — no chair, because there is no
              chair column and deliberately never will be (see the migration). */}
          <span className="text-xs text-muted">
            {member.title ? `${member.title} · ${member.siteName}` : member.siteName}
          </span>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            <button
              type="button"
              disabled
              title="Staff have no messaging identity yet — no phone or email column"
              className="inline-flex h-8 cursor-not-allowed items-center rounded-md border border-line px-3 text-xs text-faint"
            >
              Message
            </button>
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex h-8 items-center rounded-md border border-line-strong bg-surface px-3 text-xs transition-colors hover:bg-hover"
            >
              Edit profile
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3.5 border-b border-line px-4" role="tablist">
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

        {tab === "performance" ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            {completedPct !== null && completedPct >= 90 ? (
              <div className="flex items-center gap-2.5 rounded-xl border border-danger-tint bg-danger-tint/25 px-3 py-2.5">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-brand" />
                <p className="text-xs text-foreground">
                  Completed {completedPct}% of booked appointments over the last 30 days.
                </p>
              </div>
            ) : null}

            {/* The window toggle drives the sparkline; the KPIs below stay on 30 days,
                which is the window the page actually loaded. */}
            <div className="flex items-center gap-2">
              {([14, 30] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  aria-pressed={range === r}
                  className={`inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors ${
                    range === r
                      ? "bg-foreground text-background"
                      : "border border-line-strong text-muted hover:bg-hover"
                  }`}
                >
                  Last {r} days
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-2.5 rounded-xl border border-line p-3">
              <div className="flex items-baseline gap-2">
                <span className="u-th">Appointments per day</span>
                <span className="ml-auto text-[11px] text-faint">last {range} days</span>
              </div>
              <Sparkline series={series} />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <Kpi label="Appointments · 30d" value={settled.length} />
              <Kpi label="Completed" value={completed} note={completedPct === null ? undefined : `${completedPct}%`} />
              <Kpi label="No-shows" value={noShows} tone={noShows > 0 ? "brand" : undefined} />
              <Kpi
                label="Hours booked"
                value={Math.round(minutes / 60)}
                note={weeklyMinutes > 0 ? `of ${capacityHours} h` : "no hours set"}
              />
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <span className="u-th">Today · {new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(now)}</span>
              {status.appts.length === 0 ? (
                <p className="rounded-xl border border-line px-3 py-4 text-center text-xs text-faint">Nothing booked today.</p>
              ) : (
                <div className="flex flex-col rounded-xl border border-line">
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
                className="text-xs text-accent hover:underline"
              >
                Open this day in the agenda &#8599;
              </Link>
            </div>
          </div>
        ) : tab === "details" ? (
          <div className="flex flex-col">
            {/* CONTACT — employee PII. It only reaches this component because the page
                used listStaffAdmin behind the owner/admin gate; every other reader of
                `staff` still gets the projection without these columns. */}
            <DetailSection title="Contact">
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

            <DetailSection title="Contract">
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

            <DetailSection title="Skills">
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

            {/* CERTIFICATIONS are their own rows, so they save immediately rather than
                riding the draft — adding one is a create, not a field edit. */}
            <DetailSection title="Certifications">
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
          <div className="flex flex-col gap-2 px-4 py-4">
            {services.length === 0 ? (
              <p className="text-sm text-faint">This client has no services yet.</p>
            ) : (
              services.map((sv) => {
                const on = member.serviceIds.includes(sv.id);
                return (
                  <div
                    key={sv.id}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                      on ? "border-line-strong bg-surface text-foreground" : "border-line text-faint"
                    }`}
                  >
                    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${on ? "bg-success" : "bg-faintest"}`} />
                    <span className="min-w-0 flex-1 truncate">{sv.name}</span>
                    <span className="u-mono shrink-0 text-[10px] uppercase tracking-wider">
                      {on ? "performs" : "not offered"}
                    </span>
                  </div>
                );
              })
            )}
            <button
              type="button"
              onClick={onEdit}
              className="mt-1 self-start text-xs text-accent hover:underline"
            >
              Change services &rarr;
            </button>
          </div>
        ) : tab === "hours" ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            <p className="text-[11px] text-faint">
              A day with no shift = off. All days off means this barber inherits{" "}
              {member.siteName}&rsquo;s opening hours.
            </p>
            <div className="flex flex-col rounded-xl border border-line">
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
        ) : (
          <div className="flex flex-col gap-2 px-4 py-4">
            {timeOff.length === 0 ? (
              <p className="rounded-lg border border-line px-3 py-3 text-sm text-muted">
                No time off booked.
              </p>
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
        )}
      </div>

      {/* UNSAVED CHANGES — only when there are any. It reports DAYS, which is the unit
          the editor above works in, and saves through the same updateStaffAction the
          settings form always used. */}
      {changes > 0 || saveError ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel-hero px-4 py-3">
          <span className="min-w-0 truncate text-xs text-muted">
            {invalid ?? saveError ?? `${changes} unsaved ${changes === 1 ? "change" : "changes"}`}
          </span>
          {invalid || saveError ? null : null}
          <button
            type="button"
            onClick={() => {
              setSaveError(null);
              setDraft(draftFromWeekly(member.workingHours));
              setProfile(profileFromMember(member));
            }}
            className="ml-auto inline-flex h-8 items-center rounded-md border border-line-strong px-3 text-xs transition-colors hover:bg-hover"
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
            className="inline-flex h-8 items-center rounded-md bg-brand px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
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
  title: string;
  employmentType: string;
  weeklyHours: string;
  startDate: string;
  phone: string;
  email: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  skills: string[];
}

/** The stored employment types — mirrors the staff_employment_type_valid CHECK. */
const EMPLOYMENT_TYPES = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contractor", label: "Contractor" },
] as const;

function profileFromMember(m: StaffMember): ProfileDraft {
  return {
    title: m.title ?? "",
    employmentType: m.employmentType ?? "",
    weeklyHours: m.weeklyHours === null ? "" : String(m.weeklyHours),
    startDate: m.startDate ?? "",
    phone: m.phone ?? "",
    email: m.email ?? "",
    emergencyContactName: m.emergencyContactName ?? "",
    emergencyContactPhone: m.emergencyContactPhone ?? "",
    skills: [...m.skills],
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
  "min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-right text-sm outline-none transition-colors hover:border-line focus:border-brand focus:text-left";

/** A titled block inside the drawer. */
function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line last:border-0">
      <h3 className="u-th px-4 pb-1.5 pt-3.5">{title}</h3>
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
    <label className="flex items-center gap-3 px-4 py-1">
      <span className="w-[120px] shrink-0 text-xs text-muted">{label}</span>
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
      className="h-7 w-[104px] rounded-md border border-dashed border-line-strong bg-transparent px-2 text-xs outline-none placeholder:text-faint focus:border-brand"
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
  const I = "h-8 min-w-0 rounded-md border border-line-strong bg-transparent px-2 text-xs outline-none focus:border-brand";
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

function Kpi({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "brand" }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2.5">
      <span className="u-th truncate">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className={`text-xl font-semibold tracking-tight ${tone === "brand" ? "text-brand" : "text-foreground"}`}>
          {value}
        </span>
        {note ? <span className="u-mono text-[11px] text-faint">{note}</span> : null}
      </span>
    </div>
  );
}

function Legend({ dot, n, label }: { dot: string; n: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={`size-[7px] rounded-full ${dot}`} />
      {n} {label}
    </span>
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
    <div className="relative inline-flex h-9 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm">
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
function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return w.length === 0 ? "?" : w.slice(0, 2).map((x) => x[0]).join("").toUpperCase();
}
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
