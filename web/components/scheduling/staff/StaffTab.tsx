"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { staffProfileHref } from "@/lib/staffProfileUrl";
import {
  addStaffCertificationAction,
  deleteStaffCertificationAction,
  listStaffUpcomingAppointmentsAction,
  updateStaffAction,
  type UpcomingApptView,
} from "@/lib/schedulingAdminActions";
import { SectionHeading } from "@/components/ui/primitives";
import {
  IconAssign,
  IconBusiness,
  IconIdentity,
  IconInternal,
  IconPhone,
  IconTask,
} from "@/components/ui/icons";
import { StaffCreateDrawer } from "./StaffCreateDrawer";
import { AgAvatar, AgPageHeader, agTintAt, StateChip, usePopover } from "../agenda/AgendaChrome";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import { updateStaffCommissionAction } from "@/lib/paymentActions";
import { SidePanel } from "../agenda/SidePanel";
import { BreakWeekPanel } from "../agenda/BreakWeekPanel";
import type { OccurrenceRef } from "../agenda/SeriesPanel";
import { expandSeries } from "@worker/scheduling/series.js";
import { Button } from "../ui/system";
import { StaffServicesEditor, StaffServicesList } from "./StaffServicesEditor";
import { StaffAbsences } from "./StaffAbsences";
import { WeeklyScheduleEditor } from "../schedule/WeeklyScheduleEditor";
import { listScheduleSeriesAction, type SeriesView } from "@/lib/scheduleSeriesActions";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { AffectedReschedulePanel } from "../agenda/AffectedReschedulePanel";
import type { AffectedItem } from "../agenda/ScheduleFormParts";
import { StaffPhotoControl } from "./StaffPhotoControl";
import { PUBLIC_BIO_MAX, checkPublicBio, checkPublicTitle, publicProfileMessage } from "@/lib/staffPublicProfile";
import { type StaffHeaderSlots } from "./StaffHeaderCard";
import {
  citas,
  fmtHM,
  inRosterFacet,
  rosterFacetCounts,
  rosterOrder,
  rosterStatus,
  type RosterFacet,
  type RosterStatus,
  type Weekly,
} from "@/components/scheduling/mobile/team/presence";

/** Serializable shapes from the server page. */
export interface StaffSiteOpt { id: string; name: string; timezone: string }
export interface StaffServiceOpt {
  id: string;
  name: string;
  active: boolean;
  durationMin: number;
  description: string | null;
  /** services.category — the colour family on the phone screens (optional). */
  category?: string | null;
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
  /** The member's SITE opening hours — so the Hours footer can show the effective
   *  (inherited) total when the barber has no own shifts. */
  siteOpeningHours: Record<string, { start: string; end: string }[]>;
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
  // PUBLIC profile shown on /book/{slug}. null = not published (initials, no text).
  publicTitle: string | null;
  publicBio: string | null;
  publicPhotoUrl: string | null;
  // PY-1 per-artist commission % (numeric string, e.g. "10.00"). Loaded only for the
  // owner/agency staff page (listStaffAdmin); shown/edited only with payments.settings.
  commissionPctServices: string;
  commissionPctProducts: string;
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
  /** The service row, for its stored category on the phone screens (optional). */
  serviceId?: string;
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
  /** The schedule_exceptions id — needed to edit/delete a block. */
  id: string;
  staffId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  /** What a customer may be told (null = nothing). */
  publicReason?: "vacation" | "unavailable" | "site_closed" | null;
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
/** What each tab is CALLED. The keys above stay as they are: they are also the `?dtab=`
 *  values a deep link carries (AdminPanel), so they are state, not copy. */
const DETAIL_TAB_LABEL: Record<DetailTab, string> = {
  performance: "Resumen",
  details: "Perfil",
  services: "Servicios",
  hours: "Horario",
  "time off": "Ausencias",
};

type StatusKey = RosterStatus;

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

/**
 * The presence words. They describe the AGENDA, not the room: nothing records that a client
 * arrived or that a service began (there is no such event), so an appointment whose time is
 * now reads «Ocupado según agenda · hasta 12:30» — never a claim that the client is seated
 * (finding F). The header and the roster row say the same thing.
 */
function presenceChip(key: StatusKey, appts: StaffAppointment[], now: Date, tz: string): string {
  if (key !== "with_client") return STATUS[key].label;
  const current = appts.find((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now);
  return current ? `${STATUS[key].label} · hasta ${fmtTime(current.endAt, tz)}` : STATUS[key].label;
}

/*
 * The presence vocabulary. SENTENCE CASE and Spanish: these are read together with their
 * dot, so the uppercase added emphasis the colour was already carrying, three or four
 * times per screen. The KEYS stay English because they are state, not copy — `statusFilter`
 * and the facet pills both key off them.
 */
const STATUS: Record<StatusKey, { label: string; dot: string; text: string; chip: string }> = {
  with_client: { label: "Ocupado según agenda", dot: "bg-service-purple", text: "text-service-purple", chip: "border-service-purple/20 bg-service-purple/8" },
  available: { label: "Disponible", dot: "bg-success", text: "text-success", chip: "border-success/25 bg-success/8" },
  on_shift: { label: "En turno", dot: "bg-success/60", text: "text-success", chip: "border-success/25 bg-success/8" },
  off_shift: { label: "Fuera de turno", dot: "bg-faintest", text: "text-faint", chip: "border-line bg-chip" },
  off_today: { label: "Sin turno hoy", dot: "bg-faintest", text: "text-faint", chip: "border-line bg-chip" },
  time_off: { label: "Ausente", dot: "bg-brand", text: "text-brand", chip: "border-brand/20 bg-brand-soft" },
  no_chair: { label: "Sin silla", dot: "bg-faintest", text: "text-faint", chip: "border-line bg-chip" },
  inactive: { label: "Inactivo", dot: "bg-faintest", text: "text-faint", chip: "border-line bg-chip" },
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
  /** The site's opening hours — a professional with no hours of their own inherits them,
   *  and their own hours count only where the site is open (same rule as availability). */
  openingHours: Weekly;
  /** Site-wide closures (exceptions naming no staff) — nobody is on shift during one. */
  closures: StaffTimeOff[];
  /** Recurring blocks of a professional happening today — «away now» for presence only. */
  presenceBlocks?: StaffTimeOff[];
  /** Which drawer tab to open on — `?dtab=` makes a barber's hours or services a
   *  link you can send someone, not a place they have to click to. */
  detailTab?: string;
  /** Object storage is configured, so a public photo can be uploaded. */
  photoUploadEnabled?: boolean;
  /** PY-1 / FIX-1 §3: the viewer may EDIT per-artist commission (payments.settings). */
  canManagePayments?: boolean;
  /** FIX-1 §3: the viewer may READ per-artist commission (commissions.view). When false the
   *  rates are not even serialized to the client, so the block is not shown. */
  canViewCommissions?: boolean;
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
  const query = useSearchParams();
  const [search, setSearch] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [creating, setCreating] = useState(false);

  const tz = props.timezone;
  // The reference's avatar pastel follows the roster order — the same order the calendar uses.
  const rosterIdx = new Map([...props.members].sort((a, b) => a.name.localeCompare(b.name, "es")).map((m, i) => [m.id, i]));
  const tintOf = (id: string) => agTintAt(rosterIdx.get(id) ?? 0);
  const now = new Date(props.todayIso);
  const windowAppointments = props.windowAppointments ?? [];
  const timeOff = props.timeOff ?? [];

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

  /**
   * Status + footer for one barber, entirely derived — through the SAME presence the phone
   * roster uses (presence.ts), so 390, 768 and 1440 agree on who is on shift now. "Has
   * hours today" alone used to read as "Disponible" after the shift had ended.
   */
  const describe = (s: StaffMember) => {
    const appts = byStaff.get(s.id) ?? [];
    const next = appts.find((a) => new Date(a.startAt) > now);
    // NO CHAIR is takes_bookings, NOT active. They are different facts: `active =
    // false` means they no longer work here (and the page does not even load them),
    // while takes_bookings = false is a front-desk hire who works every day and
    // simply has no agenda lane. Deriving this from `active` conflated the two.
    const r = rosterStatus({
      active: s.active,
      takesBookings: s.takesBookings,
      workingHours: s.workingHours,
      siteHours: props.openingHours,
      appts,
      timeOff: [...timeOff, ...(props.presenceBlocks ?? [])].filter((t) => t.staffId === s.id),
      closures: props.closures ?? [],
      now: now.getTime(),
      tz,
    });
    const key: StatusKey = r.status;
    const off = r.away;
    let suffix = "";
    if (key === "time_off" && off) {
      const days = Math.max(1, Math.round((new Date(off.endsAt).getTime() - new Date(off.startsAt).getTime()) / 86_400_000));
      suffix = ` · ${days} ${days === 1 ? "día" : "días"}`;
      // A booking still on her lane is named APART, to review — never as «con cita».
      if (r.presence.review) suffix += ` · cita de las ${fmtTime(r.presence.review, tz)} por revisar`;
    } else if (key === "off_shift" || key === "inactive") {
      // "Entra a las 09:00", "Terminó a las 19:00", "Sede cerrada hasta las …" — the
      // phone's words for why a professional who works today is not on shift now.
      suffix = ` · ${r.presence.sub}`;
    }

    return { key, suffix, appts, next, off, worksToday: r.worksToday, onShift: r.onShift };
  };

  // Inactive professionals are listed (last, labelled) exactly as on the phone.
  const filtered = rosterOrder(props.members).filter((s) => {
    const serviceNames = props.services
      .filter((service) => s.serviceIds.includes(service.id))
      .map((service) => service.name);
    const haystack = [s.name, s.title, s.siteName, ...serviceNames].filter(Boolean).join(" ").toLowerCase();
    if (search && !haystack.includes(search.toLowerCase())) return false;
    if (serviceFilter && !s.serviceIds.includes(serviceFilter)) return false;
    if (statusFilter) {
      const d = describe(s);
      if (!inRosterFacet({ status: d.key, onShift: d.onShift }, statusFilter as RosterFacet)) return false;
    }
    return true;
  });

  // The legend: real counts over the WHOLE roster, not the filtered view.
  const facets = rosterFacetCounts(props.members.map((s) => {
    const d = describe(s);
    return { status: d.key, onShift: d.onShift };
  }));
  const counts = { withClient: facets.with_client, available: facets.available, off: facets.off_today };

  const selected = props.selectedId ? props.members.find((s) => s.id === props.selectedId) ?? null : null;
  // `?s=` — the same parameter the phone detail reads and writes (lib/staffProfileUrl).
  const hrefFor = (id: string | null) => staffProfileHref(query.toString(), id, { siteId: props.currentSiteId });

  // THE FICHA is its own screen (redesign E2): it replaces the list in the same surface,
  // the breadcrumb goes back. `?s=` stays the one parameter (phone and desktop).
  if (selected) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StaffDetail
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
          photoUploadEnabled={props.photoUploadEnabled ?? false}
          canManagePayments={props.canManagePayments ?? false}
          canViewCommissions={props.canViewCommissions ?? false}
          tintFor={tintOf}
        />
      </div>
    );
  }

  const PRES: Record<StatusKey, { glyph: string; ink: string }> = {
    with_client: { glyph: "◐", ink: "text-[var(--warn)]" },
    available: { glyph: "●", ink: "text-[var(--success)]" },
    on_shift: { glyph: "●", ink: "text-[var(--success)]" },
    off_shift: { glyph: "○", ink: "text-muted" },
    off_today: { glyph: "○", ink: "text-muted" },
    time_off: { glyph: "○", ink: "text-muted" },
    no_chair: { glyph: "○", ink: "text-muted" },
    inactive: { glyph: "⊘", ink: "text-muted" },
  };
  const COLS = "grid grid-cols-[minmax(0,1.5fr)_96px_minmax(0,1.5fr)_76px_64px_76px_128px_76px] items-center";
  const presence = [
    { key: "", label: "Todos", n: props.members.length },
    { key: "with_client", label: "Con cita ahora", n: counts.withClient },
    { key: "available", label: "En turno", n: counts.available },
    { key: "off_today", label: "Fuera", n: counts.off },
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Reference E1 (Equipo): the title, then ONE tool row — search, «Opciones» (presence,
          service, site) and «Añadir» — then the table, flush. Presence words describe the
          agenda (finding F). */}
      <AgPageHeader title="Equipo" />
      <div className="relative flex shrink-0 items-center gap-2.5 px-6 pb-3.5">
        <label className="flex h-[40px] min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-[var(--chip)] px-2.5 text-muted">
          <SearchIcon />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar profesional"
            aria-label="Buscar profesional"
            className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted"
          />
        </label>
        <TeamOptions
          presence={presence}
          statusFilter={statusFilter}
          onStatus={setStatusFilter}
          services={props.services.filter((sv) => sv.active).map((sv) => ({ id: sv.id, name: sv.name }))}
          serviceFilter={serviceFilter}
          onService={setServiceFilter}
          sites={props.sites}
          siteId={props.currentSiteId ?? ""}
          onSite={(v) => router.push(`?site=${v}`)}
        />
        <button type="button" onClick={() => setCreating(true)} className="u-focus inline-flex h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] bg-[var(--ink)] px-4 text-[14px] font-medium text-[var(--ink-fg)] hover:bg-[var(--ink-hover)]">
          Añadir
          <svg aria-hidden viewBox="0 0 16 16" className="size-[11px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6l4 4 4-4" /></svg>
        </button>
      </div>

      <div role="table" aria-label="Profesionales de la sede" className="min-h-0 flex-1 overflow-y-auto">
        <div role="row" className={`${COLS} sticky top-0 z-[1] h-[34px] bg-[var(--surface)] px-6 text-[12px] text-muted shadow-[inset_0_-1px_0_var(--line)]`}>
          <span role="columnheader" className="pr-3">Profesional</span>
          <span role="columnheader" className="px-3 shadow-[inset_1px_0_0_var(--line-soft)]">Rol</span>
          <span role="columnheader" className="px-3 shadow-[inset_1px_0_0_var(--line-soft)]">Ahora</span>
          <span role="columnheader" className="px-3 text-right shadow-[inset_1px_0_0_var(--line-soft)]">Citas hoy</span>
          <span role="columnheader" className="px-3 text-right shadow-[inset_1px_0_0_var(--line-soft)]">Horas</span>
          <span role="columnheader" className="px-3 text-right shadow-[inset_1px_0_0_var(--line-soft)]">Servicios</span>
          <span role="columnheader" className="px-3 shadow-[inset_1px_0_0_var(--line-soft)]">Horario</span>
          <span role="columnheader" className="sr-only">Agenda</span>
        </div>
        {filtered.map((member) => {
          const d = describe(member);
          const pr = PRES[d.key];
          const booked = d.appts.reduce((n, a) => n + (Date.parse(a.endAt) - Date.parse(a.startAt)) / 3_600_000, 0);
          const n = d.appts.length;
          return (
            <div
              key={member.id}
              role="row"
              tabIndex={0}
              aria-label={`Abrir ficha de ${member.name}`}
              onClick={() => router.push(hrefFor(member.id), { scroll: false })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(hrefFor(member.id), { scroll: false });
                }
              }}
              className={`${COLS} u-focus h-[44px] cursor-pointer px-6 text-left shadow-[inset_0_-1px_0_var(--line-soft)] hover:bg-[var(--subtle)] ${member.active ? "" : "opacity-60"}`}
            >
              <span role="cell" className="flex min-w-0 items-center gap-2.5 pr-3">
                <AgAvatar name={member.name} id={member.id} size={28} radius={8} tint={tintOf(member.id)} photoUrl={member.publicPhotoUrl ?? null} />
                <span className="truncate text-[13.5px]" title={member.name}>{member.name}</span>
                {!member.active ? <span className="shrink-0 rounded-[6px] bg-[var(--chip)] px-1.5 text-[11.5px] text-muted">Inactivo</span> : null}
              </span>
              <span role="cell" className="truncate px-3 text-[13px] text-[var(--ag-ink2)]">{member.title ?? "—"}</span>
              <span role="cell" className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] ${pr.ink}`}>
                <span aria-hidden>{pr.glyph}</span>
                <span className="truncate">{presenceChip(d.key, d.appts, now, tz)}{d.suffix}</span>
              </span>
              <span role="cell" className={`px-3 text-right text-[13px] tabular-nums ${n ? "text-foreground" : "text-muted"}`}>{n}</span>
              <span role="cell" className="px-3 text-right text-[13px] tabular-nums text-[var(--ag-ink2)]">{booked > 0 ? `${String(Math.round(booked * 10) / 10).replace(".", ",")} h` : "—"}</span>
              <span role="cell" className="px-3 text-right text-[13px] tabular-nums text-[var(--ag-ink2)]">{member.serviceIds.length}</span>
              <span role="cell" className="truncate px-3 text-[13px] text-[var(--ag-ink2)]">{Object.keys(member.workingHours).length === 0 ? "Horario de la sede" : "Horario propio"}</span>
              <span role="cell" className="flex justify-end">
                <Link
                  href={`/clients/${props.clientId}/scheduling/agenda?staff=${member.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="u-focus inline-flex h-[28px] items-center rounded-[6px] px-2.5 text-[13px] text-foreground underline decoration-[var(--line)] underline-offset-[3px] hover:bg-[var(--chip)]"
                >
                  Agenda
                </Link>
              </span>
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-12 text-center">
            <span className="text-[15px] font-medium">Sin resultados</span>
            <span className="text-[12.5px] text-muted">Ningún profesional coincide con la búsqueda o el filtro.</span>
          </div>
        ) : null}
      </div>

      {creating ? (
        <StaffCreateDrawer
          clientId={props.clientId}
          siteId={props.currentSiteId}
          services={props.services}
          sites={props.sites}
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            if (id) router.push(hrefFor(id), { scroll: false });
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function useDesktopTree(): boolean {
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return desktop;
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
  photoUploadEnabled,
  canManagePayments,
  canViewCommissions,
  tintFor,
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
  photoUploadEnabled: boolean;
  canManagePayments: boolean;
  canViewCommissions: boolean;
  tintFor: (id: string) => "1" | "2" | "3" | "4";
}) {
  // FIVE tabs, and every one reads something real: the schedule answers performance,
  // the roster row answers details, `staff_services` answers services, `working_hours`
  // answers hours and `schedule_exceptions` answers time off. There is no "Activity"
  // tab — a per-barber activity feed has no source (appointment events are per
  // appointment), so it is not offered rather than shipped empty.
  const [tab, setTab] = useState<DetailTab>(
    (DETAIL_TABS.find((t) => t === initialTab) ?? "performance") as DetailTab,
  );
  // HOURS DRAFT — the Hours tab edits a local copy; the unsaved bar commits it.
  const [draft] = useState<HourDraft>(() => draftFromWeekly(member.workingHours));
  // PROFILE DRAFT — the Details tab edits a local copy through the same unsaved bar as
  // Hours, so one Save writes the whole panel rather than each field racing the others.
  const [profile, setProfile] = useState<ProfileDraft>(() => profileFromMember(member));
  const [saving, startSave] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  // Deactivation guard: the future appointments a deactivation would affect — shown for an
  // explicit confirmation. NEVER auto-cancelled; deactivating only stops NEW bookings.
  const [deactivateConfirm, setDeactivateConfirm] = useState<UpcomingApptView[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [seriesState, setSeriesState] = useState<SeriesView[] | null | "error">(null);
  const loadSeries = useCallback(() => {
    listScheduleSeriesAction(clientId, member.siteId)
      .then((r) => setSeriesState(r.ok ? r.series : "error"))
      .catch(() => setSeriesState("error"));
  }, [clientId, member.siteId]);
  // The hours tab's data: asked when that tab is shown (a deep link may open on it).
  const needsSeries = tab === "hours" && seriesState === null;
  useEffect(() => {
    if (needsSeries) loadSeries();
  }, [needsSeries, loadSeries]);
  const [hoursResched, setHoursResched] = useState<AffectedItem | null>(null);
  const [hoursRecheck, setHoursRecheck] = useState(0);
  const [leaveAsk, setLeaveAsk] = useState(false);
  // TAB GUARD (finding C): Horario and Servicios keep their draft inside the tab, so
  // leaving the tab would drop it. They report it here, and a tab change asks first
  // («Seguir editando / Descartar cambios»). Perfil's draft lives in this component and
  // survives a tab change, so it never needs to ask. Nothing is saved on its own.
  const [tabDirty, setTabDirtyState] = useState<{ tab: DetailTab; dirty: boolean }>({ tab, dirty: false });
  const editorDirty = tabDirty.tab === tab && tabDirty.dirty;
  const reportHoursDirty = useCallback((d: boolean) => setTabDirtyState({ tab: "hours", dirty: d }), []);
  const [tabAsk, setTabAsk] = useState<DetailTab | null>(null);
  const requestTab = (t: DetailTab) => {
    if (t === tab) return;
    if (editorDirty) setTabAsk(t);
    else setTab(t);
  };
  const leaveNav = useNavigationGuard({ dirty: dirtyProfileFields(profile, member).length > 0, onAsk: () => setLeaveAsk(true) });
  // The phone tree reads the same `?s=`, so on a phone this drawer is mounted too — inside
  // the desktop tree, hidden below md. Its trap (focus, Tab, Escape → close) runs only
  // where the drawer can be seen; otherwise Escape on the phone screen would close it.
  // The ficha is its OWN screen now (no overlay, no trap): leaving it with unsaved profile
  // changes asks first — the breadcrumb, the sidebar, any link (useNavigationGuard).
  // Weekly hours, services and absences each have their own editor and guard.
  const dirtyDays = 0;
  void draft;
  void countDirtyDays;
  void useDesktopTree;
  const dirtyFields = dirtyProfileFields(profile, member);
  // Mirror the CHECK constraints client-side: the schema already refuses these, this
  // just says so before the round trip.
  const invalid = profileError(profile);

  /** Commit the whole panel in ONE patch — untouched fields stay absent, so a save never
   *  rewrites a column the operator didn't look at. Deactivation here only flips active; it
   *  never cancels an appointment. */
  const commitSave = () => {
    setSaveError(null);
    setDeactivateConfirm(null);
    startSave(async () => {
      const patch: Parameters<typeof updateStaffAction>[2] = {};
      if (dirtyDays > 0) {
        const weekly: Record<string, { start: string; end: string }[]> = {};
        for (const d of WEEKDAYS) if ((draft[d] ?? []).length > 0) weekly[d] = draft[d];
        patch.workingHours = weekly as never;
      }
      Object.assign(patch, profilePatch(profile, dirtyFields));
      const r = await updateStaffAction(clientId, member.id, patch);
      if (!r.ok) setSaveError(r.error);
      else {
        setEditingProfile(false);
        setNotice("Perfil guardado");
        onSaved();
      }
    });
  };

  /** Save, but if this save DEACTIVATES a member with future appointments, surface them
   *  first and require an explicit confirmation (the appointments are kept either way). */
  const requestSave = () => {
    setSaveError(null);
    const deactivating = member.active && !profile.active;
    if (!deactivating) {
      commitSave();
      return;
    }
    startSave(async () => {
      const res = await listStaffUpcomingAppointmentsAction(clientId, member.id);
      const appts = res.ok ? res.appointments : [];
      if (appts.length > 0) setDeactivateConfirm(appts);
      else commitSave();
    });
  };

  const s = STATUS[status.key];
  void s;
  const tint = tintFor(member.id);
  const presGlyph = status.key === "with_client" ? "◐" : status.key === "available" || status.key === "on_shift" ? "●" : "○";
  const presInk = status.key === "with_client" ? "text-[var(--warn)]" : status.key === "available" || status.key === "on_shift" ? "text-[var(--success)]" : "text-muted";
  const [editingProfile, setEditingProfile] = useState(false);
  const [editingServices, setEditingServices] = useState(false);
  /** «Cambiar la pausa de una fecha»: the next break of this professional, on its week. */
  const [oneDate, setOneDate] = useState<OccurrenceRef | null>(null);
  const nextBreak = (): OccurrenceRef | null => {
    if (!Array.isArray(seriesState)) return null;
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const own = seriesState.filter((x) => x.kind === "break" && x.staffId === member.id);
    const rows = own.map((x) => ({ id: x.id, site_id: member.siteId, staff_id: x.staffId, kind: x.kind, weekdays: x.weekdays, start_min: toMin(x.start), end_min: toMin(x.end), starts_on: x.startsOn, ends_on: x.endsOn, reason: x.reason, public_reason: null }));
    const ovs = own.flatMap((x) => x.overrides.map((o) => ({ series_id: x.id, occurrence_date: o.date, action: o.action, start_min: o.start ? toMin(o.start) : null, end_min: o.end ? toMin(o.end) : null })));
    const from = dayKey(now, tz);
    const to = dayKey(new Date(now.getTime() + 21 * 86_400_000), tz);
    const o = expandSeries(rows, ovs, from, to, tz).find((x) => x.from.getTime() > now.getTime());
    return o ? { seriesId: o.series_id, kind: "break", staffId: o.staff_id, date: o.date, startsAt: o.from.toISOString(), endsAt: o.until.toISOString(), moved: o.moved } : null;
  };

  // ── Performance, all computed from the 30-day window this page loaded ──
  const settled = windowAppointments.filter((a) => a.status !== "cancelled");
  const completed = settled.filter((a) => a.status === "completed").length;
  const noShows = settled.filter((a) => a.status === "no_show").length;
  const minutes = settled.reduce((n, a) => n + a.durationMin, 0);

  return (
    <section aria-label={`Ficha de ${member.name}`} className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[var(--surface)]">
      {/* HEADER (reference E2): breadcrumb, the person (88px pastel tile), role · site,
          presence in words (finding F) with where the schedule comes from and how many
          services, and the two actions. The ficha is its own screen. */}
      <div className="flex shrink-0 flex-col gap-5 px-6 pb-4 pt-5">
        <nav aria-label="Ruta" className="flex items-center gap-1.5 text-[13px] text-[var(--ag-ink2)]">
          <Link href={closeHref} scroll={false} className="u-focus inline-flex items-center gap-1.5 rounded hover:text-foreground">
            <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
            Equipo
          </Link>
          <span aria-hidden className="text-muted">/</span>
          <span aria-current="page" className="truncate text-foreground">{member.name}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-5">
          <AgAvatar name={member.name} id={member.id} size={72} radius={16} tint={tint} photoUrl={member.publicPhotoUrl ?? null} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate text-[20px] font-semibold leading-[26px] tracking-[-0.015em]">{member.name}</h2>
            <p className="truncate text-[14px] text-[var(--ag-ink2)]">{[member.title, member.siteName].filter(Boolean).join(" · ")}</p>
            <p className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px]">
              <span className={`inline-flex items-center gap-1.5 ${presInk}`}>
                <span aria-hidden>{presGlyph}</span>
                {presenceChip(status.key, status.appts, now, tz)}
              </span>
              <span className="text-muted">{Object.keys(member.workingHours).length === 0 ? "Usa el horario de la sede" : "Horario propio"}</span>
              <span className="text-muted">{member.serviceIds.length} {member.serviceIds.length === 1 ? "servicio" : "servicios"}</span>
              {!member.active ? <span className="rounded-[6px] bg-[var(--chip)] px-2 py-0.5 text-[11.5px] text-muted">Inactivo</span> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => setEditingProfile(true)} className="u-focus inline-flex h-[40px] items-center rounded-[12px] border border-[var(--line-strong)] bg-[var(--surface)] px-4 text-[14px] font-medium hover:bg-[var(--subtle)]">
              Editar perfil
            </button>
            <Link href={`/clients/${clientId}/scheduling/agenda?staff=${member.id}`} className="u-focus inline-flex h-[40px] items-center rounded-[12px] bg-[var(--ink)] px-4 text-[14px] font-medium text-[var(--ink-fg)] hover:bg-[var(--ink-hover)]">
              Ver su agenda
            </Link>
          </div>
        </div>
      </div>

      <div className="flex shrink-0 gap-5 overflow-x-auto px-6 shadow-[inset_0_-1px_0_var(--line)]" role="tablist">
        {DETAIL_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => requestTab(t)}
            className={`u-focus flex h-[40px] items-center gap-1.5 whitespace-nowrap border-b-2 text-[14px] transition-colors ${
              tab === t ? "border-[var(--foreground)] text-foreground" : "border-transparent text-[var(--ag-ink2)] hover:text-foreground"
            }`}
          >
            {DETAIL_TAB_LABEL[t]}
            {t === "time off" ? <span className="text-[12px] tabular-nums text-muted">{timeOff.filter((x) => Date.parse(x.endsAt) > now.getTime()).length}</span> : null}
            {t === "services" ? <span className="text-[12px] tabular-nums text-muted">{member.serviceIds.length}</span> : null}
          </button>
        ))}
      </div>

      {/* THE only scrolling zone. Its `key` sends it back to the top on a tab change:
          without it, opening Hours after scrolling Performance drops the reader into the
          middle of a grid whose first rows they never saw. */}
      <div key={tab} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {tab === "performance" ? (
          // RESUMEN (reference E2): today's appointments, the last 30 days (agenda data —
          // not billing) with the next absences, and the weekly schedule.
          <div className="grid w-full content-start gap-8 px-6 py-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <section aria-labelledby="fr-today" className="flex min-w-0 flex-col">
              <div className="flex items-baseline gap-2 pb-3">
                <h3 id="fr-today" className="min-w-0 flex-1 text-[15px] font-medium">Hoy · {fmtDayLong(now.toISOString(), tz)}</h3>
                <span className="text-[13px] tabular-nums text-muted">
                  {citas(status.appts.length)}
                  {status.appts.length ? ` · ${String(Math.round((status.appts.reduce((n, x) => n + (Date.parse(x.endAt) - Date.parse(x.startAt)), 0) / 3_600_000) * 10) / 10).replace(".", ",")} h` : ""}
                </span>
              </div>
              {status.appts.length === 0 ? (
                <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">No hay citas hoy.</p>
              ) : (
                <ul className="flex flex-col">
                  {status.appts.map((x) => (
                    <li key={x.id} className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-center gap-3 py-2.5 shadow-[inset_0_-1px_0_var(--line-soft)]">
                      <span className="text-[14px] tabular-nums">{fmtTime(x.startAt, tz)}</span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[14px]">{x.contactName ?? "Sin contacto"}</span>
                        <span className="truncate text-[12.5px] text-muted">{x.serviceName}</span>
                      </span>
                      <StateChip status={x.status} size="sm" toneClass={`u-appt-service ${apptCategoryClass(serviceCategory(x.serviceName, services.find((sv) => sv.id === x.serviceId)?.category))}`} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="fr-30" className="flex min-w-0 flex-col gap-3">
              <h3 id="fr-30" className="text-[15px] font-medium">Últimos 30 días</h3>
              <dl className="grid grid-cols-2 overflow-hidden rounded-[12px] shadow-[inset_0_0_0_1px_var(--line)]">
                {([
                  ["Citas", settled.length],
                  ["Completadas", completed],
                  ["Inasistencias", noShows],
                  ["Horas reservadas", `${Math.round(minutes / 60)} h`],
                ] as const).map(([k, v], i) => (
                  <div key={k} className={`flex flex-col gap-0.5 px-3.5 py-3 ${i % 2 ? "shadow-[inset_1px_0_0_var(--line)]" : ""} ${i > 1 ? "border-t border-[var(--line)]" : ""}`}>
                    <dt className="text-[13px] text-muted">{k}</dt>
                    <dd className="text-[19px] font-medium tabular-nums">{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-[12.5px] leading-[1.45] text-muted">Datos de la agenda. No representan facturación ni dinero cobrado.</p>
              <div className="flex items-baseline gap-2 pt-3">
                <h3 className="min-w-0 flex-1 text-[15px] font-medium">Próximas ausencias</h3>
                <button type="button" onClick={() => requestTab("time off")} className="u-focus rounded text-[13px] text-[var(--ag-ink2)] hover:underline">
                  Ver todas
                </button>
              </div>
              {(() => {
                const next = timeOff.filter((x) => Date.parse(x.endsAt) > now.getTime()).sort((x, y) => x.startsAt.localeCompare(y.startsAt)).slice(0, 2);
                return next.length === 0 ? (
                  <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] text-[var(--ag-ink2)]">No hay ausencias en este periodo.</p>
                ) : (
                  <ul className="flex flex-col">
                    {next.map((x) => (
                      <li key={x.id} className="flex flex-col py-2 shadow-[inset_0_-1px_0_var(--line-soft)]">
                        <span className="text-[13.5px]">{fmtDay(x.startsAt, tz)} → {fmtDay(new Date(Date.parse(x.endsAt) - 1).toISOString(), tz)}</span>
                        {x.reason ? <span className="text-[12.5px] text-muted">{x.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </section>
            <section aria-labelledby="fr-week" className="flex min-w-0 flex-col gap-3">
              <div className="flex items-baseline gap-2">
                <h3 id="fr-week" className="min-w-0 flex-1 text-[15px] font-medium">Horario semanal</h3>
                <button type="button" onClick={() => requestTab("hours")} className="u-focus rounded text-[13px] text-[var(--ag-ink2)] hover:underline">
                  Editar
                </button>
              </div>
              <span className="self-start rounded-[6px] bg-[var(--chip)] px-2 py-0.5 text-[12px] text-[var(--ag-ink2)]">
                {Object.keys(member.workingHours).length === 0 ? "Usa el horario de la sede" : "Horario propio"}
              </span>
              <ul className="flex flex-col">
                {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => {
                  const inherits = Object.keys(member.workingHours).length === 0;
                  const ranges = (inherits ? member.siteOpeningHours : member.workingHours)[d] ?? [];
                  return (
                    <li key={d} className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 py-2 text-[13px] shadow-[inset_0_-1px_0_var(--line-soft)]">
                      <span>{DAY_LONG[d]}</span>
                      <span className={`tabular-nums ${ranges.length ? (inherits ? "text-[var(--ag-ink2)]" : "") : "text-muted"}`}>
                        {ranges.length ? ranges.map((r) => `${r.start} – ${r.end}`).join(" · ") : inherits ? "Sede cerrada" : "No trabaja"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        ) : tab === "details" ? (
          <>
            <ProfileView member={member} onEdit={() => setEditingProfile(true)} />
            {canViewCommissions ? <CommissionBlock clientId={clientId} member={member} canEdit={canManagePayments} onSaved={onSaved} /> : null}
          </>
        ) : tab === "services" ? (
          <div className="w-full px-6 py-5">
            <StaffServicesList services={services} assigned={member.serviceIds} canEdit onEdit={() => setEditingServices(true)} />
          </div>
        ) : tab === "hours" ? (
          <div className="w-full px-6 py-5">
            {seriesState === "error" ? (
              <p className="text-[13px] text-muted">No pudimos cargar las pausas. <button type="button" className="underline" onClick={() => void loadSeries()}>Reintentar</button></p>
            ) : seriesState === null ? (
              <div aria-busy="true" className="h-64 rounded-[14px] bg-subtle" />
            ) : (
              <WeeklyScheduleEditor
                clientId={clientId}
                siteId={member.siteId}
                staffId={member.id}
                ownerLabel={member.name}
                siteName={member.siteName}
                timezone={tz}
                today={dayKey(now, tz)}
                hours={member.workingHours}
                siteHours={member.siteOpeningHours}
                series={seriesState.filter((x) => x.kind === "break" && x.staffId === member.id)}
                siteSeries={seriesState.filter((x) => x.kind === "break" && x.staffId === null)}
                canEdit
                recheck={hoursRecheck}
                onDirtyChange={reportHoursDirty}
                onChangeOneDate={() => setOneDate(nextBreak())}
                onReschedule={(item) => setHoursResched(item)}
                onSaved={(m) => {
                  setNotice(m);
                  void loadSeries();
                  onSaved();
                }}
              />
            )}
          </div>
        ) : (
          <div className="w-full px-6 py-5">
            <StaffAbsences
              clientId={clientId}
              siteId={member.siteId}
              siteName={member.siteName}
              timezone={tz}
              staffId={member.id}
              staffName={member.name}
              timeOff={timeOff}
              canEdit
              onChanged={(m) => {
                setNotice(m);
                onSaved();
              }}
            />
          </div>
        )}
      </div>
      {editingServices ? (
        <StaffServicesEditor
          clientId={clientId}
          staffId={member.id}
          staffName={member.name}
          services={services}
          assigned={member.serviceIds}
          canEdit
          onClose={() => setEditingServices(false)}
          onSaved={(m) => {
            setEditingServices(false);
            setNotice(m);
            onSaved();
          }}
        />
      ) : null}
      {oneDate ? (
        <BreakWeekPanel
          clientId={clientId}
          siteId={member.siteId}
          timezone={tz}
          occ={oneDate}
          ownerName={member.name}
          ownerNote={`${member.name} · ${Object.keys(member.workingHours).length ? "horario propio" : "horario de la sede"}`}
          canEdit
          recheck={hoursRecheck}
          onReschedule={(item) => setHoursResched(item)}
          onClose={() => setOneDate(null)}
          onChanged={() => {
            void loadSeries();
            onSaved();
          }}
        />
      ) : null}
      {editingProfile ? (
        <SidePanel
          name="staff-profile"
          title="Editar perfil"
          subtitle={`${member.name} · ${member.siteName}`}
          dirty={dirtyFields.length > 0}
          onClose={() => {
            setProfile(profileFromMember(member));
            setSaveError(null);
            setDeactivateConfirm(null);
            setEditingProfile(false);
          }}
          footer={
            <div className="flex items-center gap-2">
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${invalid || saveError ? "text-danger" : "text-muted"}`}>
                {invalid ?? saveError ?? (dirtyFields.length ? `${dirtyFields.length} ${dirtyFields.length === 1 ? "cambio sin guardar" : "cambios sin guardar"}` : "Sin cambios")}
              </span>
              <Button
                onClick={() => {
                  setProfile(profileFromMember(member));
                  setSaveError(null);
                  setEditingProfile(false);
                }}
                disabled={saving}
              >
                Cancelar
              </Button>
              <Button variant="primary" disabled={saving || dirtyFields.length === 0 || invalid !== null} loading={saving} loadingLabel="Guardando…" onClick={requestSave}>
                {saveError ? "Reintentar" : "Guardar cambios"}
              </Button>
            </div>
          }
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col">
            {/* IDENTITY — the name, and the site it belongs to. This section is why there
                is no longer an "Edit" button above: the name was the last field that lived
                only in a separate editor, so the panel's own tabs are now the ONE write
                path for everything about a barber. Every field here goes through the same
                unsaved bar at the bottom, which means one Save writes the whole person
                instead of two forms racing over the same columns. */}
            <DetailSection title="Identidad" icon={<IconIdentity />}>
              <FieldRow
                label="Nombre"
                value={profile.name}
                onChange={(v) => setProfile((d) => ({ ...d, name: v }))}
                placeholder="Nombre completo"
              />
              {/* SITE is read-only: a barber belongs to exactly one site in V1 and moving
                  them is not an update the repository supports. */}
              <ReadRow label="Sede" value={member.siteName} />
            </DetailSection>

            {/* PUBLIC PROFILE — the only part of a professional the booking page shows
                besides the name (and only for someone who takes bookings). It is its own
                set of fields on purpose: the internal Role and the contact details below
                are never published. The photo saves immediately; title and presentation
                ride the unsaved bar with everything else. */}
            <DetailSection title="Perfil público" icon={<IconIdentity />}>
              <p className="px-4 pb-2 text-[11px] text-faint">
                Se muestra en la página de reservas. No incluyas teléfonos, correos ni enlaces.
              </p>
              <div className="px-4 pb-2">
                <StaffPhotoControl
                  clientId={clientId}
                  staffId={member.id}
                  name={member.name}
                  photoUrl={member.publicPhotoUrl}
                  enabled={photoUploadEnabled}
                  lang="es"
                  onChanged={onSaved}
                />
              </div>
              <FieldRow
                label="Título público"
                value={profile.publicTitle}
                onChange={(v) => setProfile((d) => ({ ...d, publicTitle: v }))}
                placeholder="Ej.: Barbero profesional"
              />
              <label className="flex min-w-0 flex-col gap-1 px-4 pb-3 pt-1">
                <span className="flex items-baseline justify-between text-xs text-muted">
                  Presentación
                  <span className="u-tnum text-[11px] text-faint">
                    {profile.publicBio.trim().length}/{PUBLIC_BIO_MAX}
                  </span>
                </span>
                <textarea
                  value={profile.publicBio}
                  onChange={(e) => setProfile((d) => ({ ...d, publicBio: e.target.value }))}
                  rows={4}
                  maxLength={PUBLIC_BIO_MAX + 40}
                  placeholder="Una presentación breve que el cliente lee antes de elegir."
                  className="u-focus min-h-[96px] w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm leading-relaxed placeholder:text-faint"
                />
              </label>
            </DetailSection>

            {/* CONTACT — employee PII. It only reaches this component because the page
                used listStaffAdmin behind the owner/admin gate; every other reader of
                `staff` still gets the projection without these columns. */}
            <DetailSection title="Contacto" icon={<IconPhone />}>
              <FieldRow
                label="Teléfono"
                value={profile.phone}
                onChange={(v) => setProfile((d) => ({ ...d, phone: v }))}
                placeholder="Agrega un teléfono"
                type="tel"
              />
              <FieldRow
                label="Correo"
                value={profile.email}
                onChange={(v) => setProfile((d) => ({ ...d, email: v }))}
                placeholder="Agrega un correo"
                type="email"
              />
              <p className="px-4 pb-1 text-[11px] text-faint">
                Es solo un dato de contacto. No cambia cómo ni si esta persona inicia sesión: el
                acceso es una cuenta aparte, que se gestiona en Usuarios y accesos.
              </p>
              <FieldRow
                label="Emergencia"
                value={profile.emergencyContactName}
                onChange={(v) => setProfile((d) => ({ ...d, emergencyContactName: v }))}
                placeholder="Agrega un nombre de contacto"
              />
              <FieldRow
                label="Teléfono de emergencia"
                value={profile.emergencyContactPhone}
                onChange={(v) => setProfile((d) => ({ ...d, emergencyContactPhone: v }))}
                placeholder="Agrega un teléfono"
                type="tel"
              />
            </DetailSection>

            <DetailSection title="Contrato" icon={<IconInternal />}>
              <FieldRow
                label="Cargo"
                value={profile.title}
                onChange={(v) => setProfile((d) => ({ ...d, title: v }))}
                placeholder="Ej.: Colorista"
              />
              <FieldRow label="Tipo de contrato">
                <select
                  value={profile.employmentType}
                  onChange={(e) => setProfile((d) => ({ ...d, employmentType: e.target.value }))}
                  className={`${CELL} ${profile.employmentType ? "" : "text-faint"}`}
                >
                  <option value="">Sin definir</option>
                  {EMPLOYMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </FieldRow>
              <FieldRow label="Horas semanales">
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={profile.weeklyHours}
                  onChange={(e) => setProfile((d) => ({ ...d, weeklyHours: e.target.value }))}
                  placeholder="Sin definir"
                  className={CELL}
                />
              </FieldRow>
              <FieldRow label="Fecha de inicio">
                <input
                  type="date"
                  value={profile.startDate}
                  onChange={(e) => setProfile((d) => ({ ...d, startDate: e.target.value }))}
                  className={`${CELL} ${profile.startDate ? "" : "text-faint"}`}
                />
              </FieldRow>
              {/* SENIORITY is derived on every render from the date above — storing it
                  would guarantee it is wrong within a year. */}
              <FieldRow label="Antigüedad">
                <span className="px-1.5 text-sm text-muted">{seniority(profile.startDate) ?? "—"}</span>
              </FieldRow>
              <FieldRow label="Sede">
                <span
                  className="px-1.5 text-sm text-muted"
                  title="Un profesional pertenece a una sola sede; por ahora no se puede cambiar de sede."
                >
                  {member.siteName}
                </span>
              </FieldRow>
            </DetailSection>

            {/* STATUS — two DIFFERENT facts, and they used to be one checkbox in a modal.
                Deactivating stays reversible precisely because it is this field: the same
                control that turns it off turns it back on, through the same patch. */}
            <DetailSection title="Estado" icon={<IconAssign />}>
              <div className="flex flex-col gap-2.5 px-4 pb-3.5">
                <CheckRow
                  checked={profile.takesBookings}
                  onChange={(v) => setProfile((d) => ({ ...d, takesBookings: v }))}
                  label="Recibe citas"
                  hint="desactívalo para recepción o administración: trabajan aquí, pero no tienen silla"
                />
                <CheckRow
                  checked={profile.active}
                  onChange={(v) => setProfile((d) => ({ ...d, active: v }))}
                  label="Sigue trabajando aquí"
                  hint="desactivarlo conserva su historial y su columna en la agenda, pero no recibe citas nuevas"
                />
              </div>
            </DetailSection>

            <DetailSection title="Habilidades" icon={<IconTask />}>
              <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
                {profile.skills.map((sk) => (
                  <span
                    key={sk}
                    className="inline-flex h-[28px] items-center gap-1.5 rounded-md border border-line-strong bg-surface pl-2.5 pr-1.5 text-xs"
                  >
                    {sk}
                    <button
                      type="button"
                      aria-label={`Quitar ${sk}`}
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
            <DetailSection title="Certificaciones" icon={<IconBusiness />}>
              <div className="flex flex-col gap-1.5 px-4 pb-3">
                {member.certifications.length === 0 ? (
                  <p className="text-xs text-faint">Ninguna registrada.</p>
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
          {deactivateConfirm ? (
            <div role="alert" className="mt-4 flex flex-col gap-2 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] text-[var(--warn)]">
              <p className="font-medium">
                {member.name} tiene {citas(deactivateConfirm.length)} {deactivateConfirm.length === 1 ? "próxima" : "próximas"}
              </p>
              <p>Al desactivar se detienen las reservas nuevas. Estas citas se conservan: no se cancela ninguna.</p>
              <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto tabular-nums">
                {deactivateConfirm.map((x) => (
                  <li key={x.id} className="truncate">
                    {fmtDay(x.start_at, x.site_timezone)} · {x.service_name}
                    {x.contact_name ? ` · ${x.contact_name}` : ""}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" onClick={() => setDeactivateConfirm(null)}>Volver</Button>
                <Button size="sm" variant="destructive" disabled={saving} onClick={commitSave}>Desactivar de todos modos</Button>
              </div>
            </div>
          ) : null}
        </SidePanel>
      ) : null}
      {notice ? (
        <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 z-[90] flex min-h-[44px] -translate-x-1/2 items-center gap-2 rounded-sch-control bg-foreground px-4 text-sm text-background shadow-[var(--shadow-float)]">
          <span aria-hidden>✓</span>
          {notice}
        </div>
      ) : null}

      {hoursResched ? (
        <AffectedReschedulePanel
          clientId={clientId}
          siteId={member.siteId}
          timezone={tz}
          item={hoursResched}
          holds={[]}
          staff={[]}
          openWeekdays={new Set()}
          lockStaffId={null}
          returnLabel="el horario"
          onBack={() => {
            setHoursResched(null);
            setHoursRecheck((n) => n + 1);
          }}
        />
      ) : null}
      {tabAsk ? (
        <DiscardChanges
          confirmLabel="Descartar cambios"
          onKeep={() => setTabAsk(null)}
          onDiscard={() => {
            const next = tabAsk;
            setTabAsk(null);
            setTabDirtyState({ tab: next, dirty: false });
            setTab(next);
          }}
        />
      ) : null}
      {leaveAsk ? (
        <DiscardChanges
          confirmLabel="Descartar cambios"
          onKeep={() => {
            setLeaveAsk(false);
            leaveNav.forget();
          }}
          onDiscard={() => {
            setLeaveAsk(false);
            setProfile(profileFromMember(member));
            leaveNav.follow();
          }}
        />
      ) : null}
    </section>
  );
}


// ── PROFILE DRAFT ────────────────────────────────────────────────────────────
// Everything on the Details tab is a plain string in the draft (that is what an
// <input> gives you); the empty string means "cleared", which maps to NULL on the way
// out — the column's own empty state. Keeping that translation in ONE place is why
// these are functions and not inline ternaries in the JSX.
export interface ProfileDraft {
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
  /** Public profile (booking page). "" = not published. */
  publicTitle: string;
  publicBio: string;
}

/** The stored employment types — mirrors the staff_employment_type_valid CHECK. */
const EMPLOYMENT_TYPES = [
  { value: "full_time", label: "Tiempo completo" },
  { value: "part_time", label: "Medio tiempo" },
  { value: "contractor", label: "Contratista" },
] as const;

export function profileFromMember(m: StaffMember): ProfileDraft {
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
    publicTitle: m.publicTitle ?? "",
    publicBio: m.publicBio ?? "",
  };
}

export type ProfileKey = keyof ProfileDraft;

/** Which fields differ from what is stored — the number the unsaved bar reports, and
 *  the exact set the patch will carry. */
export function dirtyProfileFields(d: ProfileDraft, m: StaffMember): ProfileKey[] {
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
  if (d.name.trim() === "") return "El nombre es obligatorio.";
  if (d.weeklyHours !== "") {
    const n = Number(d.weeklyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) return "Las horas semanales deben ser un número entero de 1 a 168.";
  }
  if (d.employmentType !== "" && !EMPLOYMENT_TYPES.some((t) => t.value === d.employmentType)) {
    return "Tipo de contrato desconocido.";
  }
  return publicProfileError(d, "es");
}

/** The public-profile rules (web/lib/staffPublicProfile.ts), for both editors. */
export function publicProfileError(d: Pick<ProfileDraft, "publicTitle" | "publicBio">, lang: "es" | "en"): string | null {
  const title = checkPublicTitle(d.publicTitle);
  if (!title.ok) return publicProfileMessage(title.error, lang === "es" ? "Título público" : "Public title", title.max, lang);
  const bio = checkPublicBio(d.publicBio);
  if (!bio.ok) return publicProfileMessage(bio.error, lang === "es" ? "Presentación" : "Presentation", bio.max, lang);
  return null;
}

/** Only the changed fields, translated to the repository's shape ("" → null). */
export function profilePatch(d: ProfileDraft, dirty: ProfileKey[]): Record<string, unknown> {
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

/** "Desde mar 2023 · 2 a 5 m" — the phone's words (seniorityEs), computed from
 *  start_date every render. */
function seniority(startDate: string): string | null {
  if (!startDate) return null;
  const [y, mo, day] = startDate.split("-").map(Number);
  if (!y || !mo || !day) return null;
  const now = new Date();
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() - (mo - 1));
  if (now.getUTCDate() < day) months -= 1;
  const since = `${MONTHS_SHORT[mo - 1]} ${y}`;
  if (months < 0) return `Empieza en ${since}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `Desde ${since} · ${years > 0 ? `${years} a ${rest} m` : `${rest} m`}`;
}
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

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
      <span className="w-[104px] shrink-0 truncate text-xs text-muted sm:w-[8.5rem]">{label}</span>
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
      <span className="w-[104px] shrink-0 truncate text-xs text-muted sm:w-[8.5rem]">{label}</span>
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
      placeholder="Nueva habilidad"
      aria-label="Añadir una habilidad"
      className="u-focus h-[28px] w-[104px] rounded-md border border-dashed border-line-strong bg-transparent px-2 text-xs placeholder:text-faint"
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
    left === null ? null : left < 0 ? { label: "VENCIDA", cls: "text-brand", expired: true } : left <= 60 ? { label: `QUEDAN ${left} D`, cls: "text-warn", expired: false } : null;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 ${
        state?.expired ? "border-danger-tint bg-danger-tint/20" : "border-line"
      }`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-xs font-semibold text-foreground">{cert.name}</span>
        <span className="u-mono truncate text-[10.5px] text-muted">
          {[cert.issuer, cert.issuedOn ? `emitida ${cert.issuedOn}` : null, cert.expiresOn ? `vence ${cert.expiresOn}` : "sin vencimiento"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      {state ? <span className={`u-mono shrink-0 text-[10px] ${state.cls}`}>{state.label}</span> : null}
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Eliminar ${cert.name}`}
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
  const bad = issuedOn && expiresOn && expiresOn < issuedOn ? "La fecha de vencimiento no puede ser anterior a la de emisión." : null;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-accent hover:underline">
        + Añadir certificación
      </button>
    );
  }
  const I = "u-focus h-[32px] min-w-0 rounded-md border border-line-strong bg-transparent px-2 text-xs";
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-line-strong p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Certificación" className={I} autoFocus />
      <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Entidad emisora (opcional)" className={I} />
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="u-th">Emitida</span>
          <input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={I} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="u-th">Vence</span>
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={I} />
        </label>
      </div>
      {bad ? <p className="text-[11px] text-danger">{bad}</p> : null}
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="inline-flex h-[28px] items-center rounded-md border border-line-strong px-2.5 text-xs hover:bg-hover"
        >
          Cancelar
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
          className="inline-flex h-[28px] items-center rounded-md bg-ink px-2.5 text-xs font-medium text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50"
        >
          Añadir
        </button>
      </div>
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
/** "14:30" in the site's timezone — the same 24-hour clock as the phone (presence.ts). */
function fmtTime(iso: string, tz: string): string {
  return fmtHM(iso, tz);
}
/** "jue, 6 ago" in the site's timezone — the time-off range labels, as on the phone. */
function fmtDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "short", day: "numeric", month: "short" })
    .format(new Date(iso))
    .replace(/\./g, "");
}
function dayKey(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** «Opciones» (reference E1): the presence filter, and — real facets the roster already
 *  had — service and site. One popover; Escape closes it and returns focus. */
function TeamOptions(props: {
  presence: Array<{ key: string; label: string; n: number }>;
  statusFilter: string;
  onStatus: (k: string) => void;
  services: Array<{ id: string; name: string }>;
  serviceFilter: string;
  onService: (id: string) => void;
  sites: Array<{ id: string; name: string }>;
  siteId: string;
  onSite: (id: string) => void;
}) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const current = props.presence.find((p) => p.key === props.statusFilter) ?? props.presence[0];
  const label = props.statusFilter || props.serviceFilter ? `${current.label}${props.serviceFilter ? " · 1 servicio" : ""}` : "Opciones";
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="u-focus inline-flex h-[40px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3.5 text-[14px] hover:bg-[var(--chip)]"
      >
        {label}
        <svg aria-hidden viewBox="0 0 16 16" className="size-[11px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      {open ? (
        <div ref={panelRef} role="menu" aria-label="Filtrar el equipo" className="u-pop-in absolute right-0 top-[46px] z-20 flex min-w-[220px] flex-col rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.10)]">
          <span className="px-2.5 pb-1 pt-1.5 text-[12px] text-muted">Presencia</span>
          {props.presence.map((p) => (
            <button
              key={p.key || "all"}
              type="button"
              role="menuitemradio"
              aria-checked={p.key === props.statusFilter}
              onClick={() => {
                props.onStatus(p.key);
                close(true);
              }}
              className={`u-focus flex h-[34px] items-center gap-2 rounded-[8px] px-2.5 text-left text-[14px] hover:bg-[var(--chip)] ${p.key === props.statusFilter ? "bg-[var(--chip)]" : ""}`}
            >
              <span className="flex-1">{p.label}</span>
              <span className="text-[12px] tabular-nums text-muted">{p.n}</span>
            </button>
          ))}
          {props.services.length > 0 ? (
            <label className="mt-1 flex flex-col gap-1 border-t border-[var(--line)] px-2.5 pb-1.5 pt-2">
              <span className="text-[12px] text-muted">Servicio</span>
              <select value={props.serviceFilter} onChange={(e) => props.onService(e.target.value)} className="u-focus h-[34px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-2 text-[13.5px]">
                <option value="">Todos los servicios</option>
                {props.services.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          {props.sites.length > 1 ? (
            <label className="flex flex-col gap-1 px-2.5 pb-1.5 pt-1">
              <span className="text-[12px] text-muted">Sede</span>
              <select value={props.siteId} onChange={(e) => props.onSite(e.target.value)} className="u-focus h-[34px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-2 text-[13.5px]">
                {props.sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const DAY_LONG: Record<string, string> = { mon: "Lunes", tue: "Martes", wed: "Miércoles", thu: "Jueves", fri: "Viernes", sat: "Sábado", sun: "Domingo" };
/** "miércoles 21 oct" — the reference's day heading. */
function fmtDayLong(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "long", day: "numeric", month: "short" })
    .format(new Date(iso))
    .replace(/\./g, "")
    .replace(",", "");
}

/**
 * PERFIL (reference f13): what is stored about the person, read-only, in four blocks.
 * Editing happens in the «Editar perfil» panel (same fields). Contact and emergency data
 * are internal: never on the booking page. A professional is NOT a user account.
 */
/**
 * PY-1 COMMISSIONS (main's data + action, in the redesign's ficha). The per-artist % over what
 * is CHARGED — shown and editable only with payments.settings. It saves on its own through
 * updateStaffCommissionAction (gated server-side), never through the profile panel: it is money
 * configuration with its own permission. A change applies to FUTURE charges only — every
 * recorded payment line keeps the commission it was charged with.
 */
function CommissionBlock({ clientId, member, canEdit, onSaved }: { clientId: string; member: StaffMember; canEdit: boolean; onSaved: () => void }) {
  const [svc, setSvc] = useState(member.commissionPctServices);
  const [prod, setProd] = useState(member.commissionPctProducts);
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = Number(svc) !== Number(member.commissionPctServices) || Number(prod) !== Number(member.commissionPctProducts);
  const save = () => {
    if (saving || !canEdit) return; // the action re-checks payments.settings; this just avoids a doomed call
    setError(null);
    setSaved(false);
    const s = Number(svc);
    const p = Number(prod);
    if (svc.trim() === "" || prod.trim() === "" || !Number.isFinite(s) || !Number.isFinite(p) || s < 0 || p < 0 || s > 100 || p > 100) {
      setError("La comisión debe estar entre 0 y 100.");
      return;
    }
    startSave(async () => {
      try {
        const r = await updateStaffCommissionAction(clientId, member.id, s, p);
        if (!r.ok) setError(r.error);
        else {
          setSaved(true);
          onSaved();
        }
      } catch {
        setError("No se pudo guardar: revisa la conexión. Tus valores se conservan.");
      }
    });
  };
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label className="grid grid-cols-[170px_minmax(0,140px)_auto] items-center gap-3 py-[9px] text-[13.5px] shadow-[inset_0_-1px_0_var(--line-soft)]">
      <span className="text-muted">{label}</span>
      <input type="number" inputMode="decimal" min={0} max={100} step={0.01} value={value} disabled={!canEdit} onChange={(e) => { set(e.target.value); setSaved(false); }} aria-label={`Comisión de ${label.toLowerCase()} (%)`} className="u-focus h-[34px] rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-2.5 text-right tabular-nums disabled:opacity-60" />
      <span className="text-muted">%</span>
    </label>
  );
  return (
    <section aria-labelledby="commission-title" className="flex w-full flex-col px-6 pb-6">
      <h3 id="commission-title" className="pb-1 text-[15px] font-medium">Comisiones</h3>
      <p className="pb-1 text-[12.5px] text-muted">Porcentaje sobre lo cobrado. Un cambio aplica a los cobros nuevos: los ya registrados conservan su comisión.{canEdit ? "" : " Solo lectura."}</p>
      {field("Servicios", svc, setSvc)}
      {field("Productos", prod, setProd)}
      {canEdit ? (
        <div className="flex items-center gap-3 pt-3">
          <span role="status" aria-live="polite" className={`min-w-0 flex-1 text-[13px] ${error ? "text-danger" : "text-muted"}`}>
            {error ?? (saving ? "Guardando…" : saved ? "Comisiones guardadas" : dirty ? "Cambios sin guardar" : "")}
          </span>
          <Button variant="primary" onClick={save} disabled={!dirty || saving} loading={saving} loadingLabel="Guardando…">
            Guardar comisiones
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ProfileView({ member, onEdit }: { member: StaffMember; onEdit: () => void }) {
  const NONE = "Sin registrar";
  const employment = EMPLOYMENT_TYPES.find((t) => t.value === member.employmentType)?.label ?? NONE;
  const block = (title: string, rows: Array<[string, React.ReactNode]>) => (
    <section className="flex min-w-0 flex-col">
      <h3 className="pb-1 text-[15px] font-medium">{title}</h3>
      <dl className="flex flex-col">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[170px_minmax(0,1fr)] gap-3 py-[11px] text-[13.5px] shadow-[inset_0_-1px_0_var(--line-soft)]">
            <dt className="text-muted">{k}</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
  return (
    <div className="flex w-full flex-col gap-8 px-6 py-5">
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        {block("Identidad", [
          ["Nombre", member.name],
          ["Sede", member.siteName],
          ["Rol en la agenda", member.takesBookings ? "Profesional · recibe citas" : "Sin agenda propia"],
        ])}
        {block("Perfil público", [
          ["Título público", member.publicTitle || NONE],
          ["Presentación", member.publicBio || "Sin presentación"],
        ])}
        {block("Contacto (interno)", [
          ["Teléfono", member.phone ? <span className="tabular-nums">{member.phone}</span> : NONE],
          ["Email", member.email || NONE],
          ["Contacto de emergencia", member.emergencyContactName ? `${member.emergencyContactName}${member.emergencyContactPhone ? ` · ${member.emergencyContactPhone}` : ""}` : NONE],
        ])}
        {block("Vinculación", [
          ["Cargo", member.title || NONE],
          ["Tipo de contrato", employment],
          ["Horas semanales", member.weeklyHours ? `${member.weeklyHours} h` : NONE],
          ["Fecha de inicio", member.startDate ? `${new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${member.startDate}T00:00:00Z`)).replace(/\./g, "")}${seniority(member.startDate) ? ` · ${seniority(member.startDate)}` : ""}` : NONE],
          ["Recibe citas", member.takesBookings ? "Sí" : "No"],
          ["Sigue trabajando", member.active ? "Sí" : "No"],
          ["Habilidades", member.skills.length ? member.skills.join(", ") : NONE],
          ["Certificaciones", member.certifications.length ? member.certifications.map((c) => c.name).join(", ") : NONE],
        ])}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[12.5px] leading-[1.45] text-muted">
          Teléfono, email y emergencia son internos: no se muestran en la reserva pública. Un profesional no es una cuenta de usuario; los accesos se gestionan en Usuarios y accesos.
        </p>
        <button type="button" onClick={onEdit} className="u-focus inline-flex h-[40px] shrink-0 items-center rounded-[12px] border border-[var(--line-strong)] bg-[var(--surface)] px-4 text-[14px] font-medium hover:bg-[var(--subtle)]">
          Editar perfil
        </button>
      </div>
    </div>
  );
}
