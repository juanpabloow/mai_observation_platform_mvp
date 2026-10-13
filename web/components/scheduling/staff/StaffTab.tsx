"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { avatarColor, avatarToneStyle, staffInitials as initials } from "@/lib/avatarColor";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { ACT_PRIMARY } from "@/components/ui/panelChrome";
import {
  addStaffCertificationAction,
  deleteStaffCertificationAction,
  listStaffUpcomingAppointmentsAction,
  setStaffServiceAction,
  updateStaffAction,
  type UpcomingApptView,
} from "@/lib/schedulingAdminActions";
import { deleteTimeOffAction } from "@/lib/timeOffActions";
import { TimeOffForm } from "@/components/scheduling/timeoff/TimeOffForm";
import { PageShell } from "@/components/ui/PageShell";
import {
  CONTROL_CLS,
  MetricBox,
  MetricCell,
  PanelSection,
  MODULE_SEARCH_CLS,
  SectionHeading,
  FacetPills,
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
import { StaffPhotoControl } from "./StaffPhotoControl";
import { PUBLIC_BIO_MAX, checkPublicBio, checkPublicTitle, publicProfileMessage } from "@/lib/staffPublicProfile";
import { StaffHeaderCard, type StaffHeaderSlots } from "./StaffHeaderCard";
import {
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
function presenceChip(key: StatusKey, appts: StaffAppointment[], now: Date): string {
  if (key !== "with_client") return STATUS[key].label;
  const current = appts.find((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now);
  if (!current) return STATUS[key].label;
  const mins = Math.max(0, Math.round((now.getTime() - new Date(current.startAt).getTime()) / 60_000));
  return `${mins} min en silla`;
}

/*
 * The presence vocabulary. SENTENCE CASE and Spanish: these are read together with their
 * dot, so the uppercase added emphasis the colour was already carrying, three or four
 * times per screen. The KEYS stay English because they are state, not copy — `statusFilter`
 * and the facet pills both key off them.
 */
const STATUS: Record<StatusKey, { label: string; dot: string; text: string; chip: string }> = {
  with_client: { label: "Con cliente", dot: "bg-service-purple", text: "text-service-purple", chip: "border-service-purple/20 bg-service-purple/8" },
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
  /** Which drawer tab to open on — `?dtab=` makes a barber's hours or services a
   *  link you can send someone, not a place they have to click to. */
  detailTab?: string;
  /** Object storage is configured, so a public photo can be uploaded. */
  photoUploadEnabled?: boolean;
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
      timeOff: timeOff.filter((t) => t.staffId === s.id),
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
    } else if (key === "with_client") {
      const inChair = appts.find((a) => new Date(a.startAt) <= now && new Date(a.endAt) > now);
      if (inChair) suffix = ` · hasta ${fmtTime(inChair.endAt, tz)}`;
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
  const hrefFor = (id: string | null) => {
    const p = new URLSearchParams();
    if (props.currentSiteId) p.set("site", props.currentSiteId);
    if (id) p.set("s", id);
    const qs = p.toString();
    return qs ? `?${qs}` : "?";
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <StaffHeaderCard
        slots={header}
        center={
            <div className={`${MODULE_SEARCH_CLS} w-full min-w-0`}>
              <SearchIcon />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nombre, servicio o sede…"
                aria-label="Buscar en el equipo"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
              />
            </div>
        }
        actions={
            <button type="button" onClick={() => setCreating(true)} className={TOOLBAR_PRIMARY_CLS}>
              + Nuevo miembro
            </button>
        }
      />

      <PageShell clip={false}>
        <div className="flex shrink-0 flex-col gap-2 border-b border-line-row px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:px-4">
          <div className="min-w-0 overflow-x-auto pb-0.5 sm:pb-0">
            <FacetPills
              label="Filtrar el equipo por presencia"
              items={[
                { key: "all", label: "Todos", count: props.members.length, active: statusFilter === "" },
                { key: "with_client", label: "Con cliente", count: counts.withClient, active: statusFilter === "with_client" },
                { key: "available", label: "En turno", count: counts.available, active: statusFilter === "available" },
                { key: "off_today", label: "Fuera", count: counts.off, active: statusFilter === "off_today" },
              ]}
              onPick={(key: string) => setStatusFilter(key === "all" ? "" : key)}
            />
          </div>
          <span className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto sm:shrink-0">
            <Facet
              label="Servicio"
              value={serviceFilter}
              onChange={setServiceFilter}
              options={[{ value: "", label: "Servicio" }, ...props.services.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name }))]}
            />
            <Facet
              label="Sede"
              value={props.currentSiteId ?? ""}
              onChange={(v) => router.push(`?site=${v}`)}
              options={props.sites.map((s) => ({ value: s.id, label: s.name }))}
            />
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {filtered.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((member) => {
                const d = describe(member);
                return (
                  <StaffCard
                    key={member.id}
                    member={member}
                    status={d.key}
                    suffix={d.suffix}
                    appts={d.appts}
                    next={d.next}
                    tz={tz}
                    services={props.services}
                    href={hrefFor(member.id)}
                    selected={member.id === props.selectedId}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[14rem] items-center justify-center px-4 text-center">
              <div>
                <p className="text-sm font-medium text-foreground">No encontramos miembros</p>
                <p className="mt-1 text-xs text-faint">Cambia la búsqueda o limpia los filtros.</p>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mt-3 flex min-h-[54px] w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-sm text-muted transition-colors hover:border-faint hover:bg-chip hover:text-foreground"
          >
            + Agregar miembro
          </button>
        </div>
      </PageShell>

      {selected ? (
        <>
          <Link href={hrefFor(null)} scroll={false} aria-label="Cerrar perfil" className={OVERLAY_SCRIM} />
          <div className="pointer-events-none fixed inset-0 z-50 flex items-stretch justify-end sm:p-3 sm:pl-16">
            <div className="pointer-events-auto h-full w-full sm:w-[var(--staff-panel-w)]">
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
              />
            </div>
          </div>
        </>
      ) : null}

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
  );
}

/**
 * The reference's roster card, backed only by real scheduling data. Desktop shows
 * three columns, tablet two, and phone one; opening the profile no longer reserves a
 * permanent side lane and therefore never squeezes these cards.
 */
function StaffCard({
  member,
  status,
  suffix,
  appts,
  next,
  tz,
  services,
  href,
  selected,
}: {
  member: StaffMember;
  status: StatusKey;
  suffix: string;
  appts: StaffAppointment[];
  next?: StaffAppointment;
  tz: string;
  services: StaffServiceOpt[];
  href: string;
  selected: boolean;
}) {
  const s = STATUS[status];
  const offered = services.filter((service) => member.serviceIds.includes(service.id));
  const bookedMinutes = appts.reduce(
    (total, appt) => total + Math.max(0, Math.round((new Date(appt.endAt).getTime() - new Date(appt.startAt).getTime()) / 60_000)),
    0,
  );
  const bookedLabel = bookedMinutes === 0 ? "0 h" : `${Math.round((bookedMinutes / 60) * 10) / 10} h`;
  return (
    <article className={`flex min-h-[188px] flex-col overflow-hidden rounded-xl border bg-surface transition-colors sm:min-h-[218px] xl:min-h-[238px] ${selected ? "border-foreground" : "border-line hover:border-line-strong"}`}>
      <div className="flex flex-1 flex-col gap-2.5 p-3.5 sm:gap-3 sm:p-4">
        <div className="flex items-start gap-3">
          {member.publicPhotoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
            <img src={member.publicPhotoUrl} alt="" aria-hidden className="size-11 shrink-0 rounded-xl border border-line object-cover" />
          ) : (
            <span
              aria-hidden
              style={avatarToneStyle(member.name) as React.CSSProperties}
              className="u-staff-avatar u-mono flex size-11 shrink-0 items-center justify-center rounded-xl border text-sm font-semibold"
            >
              {initials(member.name)}
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[0.9375rem] font-semibold tracking-[-0.015em] text-foreground">{member.name}</span>
            <span className="truncate text-xs text-muted">{member.title ?? (member.takesBookings ? "Profesional" : "Recepción")}</span>
          </span>
          <span className="u-mono shrink-0 text-[0.6875rem] text-faint">{appts.length} hoy</span>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted">
          <IconBusiness />
          <span className="truncate">{member.siteName}</span>
          {next ? <span className="ml-auto shrink-0 text-faint">Sigue {fmtTime(next.startAt, tz)}</span> : null}
        </div>

        <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(7rem,0.75fr)] gap-3">
          <div className="min-w-0">
            <p className="u-th mb-1.5">Servicios</p>
            <div className="flex flex-wrap gap-1.5">
              {offered.slice(0, 3).map((service) => (
                <span key={service.id} className="inline-flex h-6 max-w-full items-center truncate rounded-md border border-line px-2 text-[0.6875rem] text-muted">
                  {service.name}
                </span>
              ))}
              {offered.length > 3 ? <span className="px-1 py-1 text-[0.6875rem] text-faint">+{offered.length - 3}</span> : null}
              {offered.length === 0 ? <span className="text-xs text-faint">Sin servicios asignados</span> : null}
            </div>
          </div>
          <div>
            <p className="u-th mb-1.5">Hoy</p>
            <div className="flex flex-wrap gap-1.5">
              <span className="inline-flex h-6 items-center rounded-md border border-line px-2 text-[0.6875rem] text-muted">
                Citas: <strong className="u-mono ml-1 font-medium text-foreground">{status === "no_chair" ? "—" : appts.length}</strong>
              </span>
              <span className="inline-flex h-6 items-center rounded-md border border-line px-2 text-[0.6875rem] text-muted">
                Horas: <strong className="u-mono ml-1 font-medium text-foreground">{status === "no_chair" ? "—" : bookedLabel}</strong>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex min-h-12 items-center gap-2 border-t border-line-row bg-card px-3.5 py-2 sm:px-4 sm:py-2.5">
        <span className={`inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-medium ${s.chip} ${s.text}`}>
          <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${s.dot}`} />
          <span className="truncate">{s.label}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-faint">{suffix.replace(/^ · /, "") || (member.startDate ? seniority(member.startDate) : "Perfil operativo")}</span>
        <Link href={href} scroll={false} className="inline-flex h-9 shrink-0 items-center rounded-lg bg-foreground px-3.5 text-xs font-medium text-surface transition hover:bg-foreground/90 sm:h-8 sm:px-3">
          Ver perfil
        </Link>
      </div>
    </article>
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
  photoUploadEnabled,
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
  // Time Off tab: an inline create/edit form + per-row delete.
  const [toForm, setToForm] = useState<null | { editing?: StaffTimeOff }>(null);
  const [toBusy, startTo] = useTransition();
  const [toError, setToError] = useState<string | null>(null);
  const [toConfirmDel, setToConfirmDel] = useState<string | null>(null);
  // Deactivation guard: the future appointments a deactivation would affect — shown for an
  // explicit confirmation. NEVER auto-cancelled; deactivating only stops NEW bookings.
  const [deactivateConfirm, setDeactivateConfirm] = useState<UpcomingApptView[] | null>(null);
  const router = useRouter();
  const panelRef = useTrappedPanel({ active: true, onClose: () => router.push(closeHref, { scroll: false }) });
  const dirtyDays = countDirtyDays(draft, member.workingHours);
  const dirtyFields = dirtyProfileFields(profile, member);
  const changes = dirtyDays + dirtyFields.length;
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
      else onSaved();
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
      aria-modal="true"
      role="dialog"
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
      className="pointer-events-auto flex h-full min-h-0 w-full max-w-full flex-col overflow-hidden bg-surface sm:rounded-xl sm:border sm:border-line sm:shadow-[var(--shadow-card)]"
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
            {member.publicPhotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
              <img src={member.publicPhotoUrl} alt="" aria-hidden className="size-[38px] rounded-full object-cover" />
            ) : (
              <span
                aria-hidden
                className={`u-mono flex size-[38px] items-center justify-center rounded-full text-[13px] font-semibold ${avatarColor(member.name)}`}
              >
                {initials(member.name)}
              </span>
            )}
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
                {presenceChip(status.key, status.appts, now)}
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
      <div className="flex shrink-0 items-center gap-3.5 overflow-x-auto border-b border-line px-3 sm:px-4" role="tablist">
        <div className="flex min-w-max items-center gap-3.5">
          {DETAIL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 pt-3 text-[12.5px] font-medium capitalize transition-colors ${
                tab === t ? "border-ink font-semibold text-foreground" : "border-transparent text-muted hover:text-foreground"
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
              <ReadRow label="Sede" value={member.siteName} />
            </DetailSection>

            {/* PUBLIC PROFILE — the only part of a professional the booking page shows
                besides the name (and only for someone who takes bookings). It is its own
                set of fields on purpose: the internal Role and the contact details below
                are never published. The photo saves immediately; title and presentation
                ride the unsaved bar with everything else. */}
            <DetailSection title="Public profile" icon={<IconIdentity />}>
              <p className="px-4 pb-2 text-[11px] text-faint">
                Shown on the public booking page. No phone numbers, e-mails or links.
              </p>
              <div className="px-4 pb-2">
                <StaffPhotoControl
                  clientId={clientId}
                  staffId={member.id}
                  name={member.name}
                  photoUrl={member.publicPhotoUrl}
                  enabled={photoUploadEnabled}
                  lang="en"
                  onChanged={onSaved}
                />
              </div>
              <FieldRow
                label="Public title"
                value={profile.publicTitle}
                onChange={(v) => setProfile((d) => ({ ...d, publicTitle: v }))}
                placeholder="e.g. Barbero profesional"
              />
              <label className="flex min-w-0 flex-col gap-1 px-4 pb-3 pt-1">
                <span className="flex items-baseline justify-between text-xs text-muted">
                  Presentation
                  <span className="u-tnum text-[11px] text-faint">
                    {profile.publicBio.trim().length}/{PUBLIC_BIO_MAX}
                  </span>
                </span>
                <textarea
                  value={profile.publicBio}
                  onChange={(e) => setProfile((d) => ({ ...d, publicBio: e.target.value }))}
                  rows={4}
                  maxLength={PUBLIC_BIO_MAX + 40}
                  placeholder="A short presentation the customer reads before choosing."
                  className="u-focus min-h-[96px] w-full resize-y rounded-md border border-line bg-surface px-2.5 py-2 text-sm leading-relaxed placeholder:text-faint"
                />
              </label>
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
              <p className="px-4 pb-1 text-[11px] text-faint">
                This is a contact detail only. It does not change how — or whether — this person
                logs in; a login is a separate account managed under Team.
              </p>
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

            {(() => {
              // When the barber has NO own shifts, an empty working_hours means they INHERIT
              // the site's opening hours (availability.ts). The footer must reflect that
              // effective schedule, not "0 H · 0 DAYS", which contradicted the inherit rule.
              const draftHasHours = WEEKDAYS.some((d) => (draft[d] ?? []).length > 0);
              const eff = (draftHasHours ? draft : member.siteOpeningHours) as Record<string, { start: string; end: string }[]>;
              const totalH = Math.round(
                WEEKDAYS.reduce((n, d) => n + (eff[d] ?? []).reduce((m, r) => m + minutesBetween(r.start, r.end), 0), 0) / 60,
              );
              const days = WEEKDAYS.filter((d) => (eff[d] ?? []).length > 0).length;
              return (
                <div className="flex items-center gap-2 text-xs text-muted">
                  {!draftHasHours ? (
                    <span className="rounded bg-chip px-1.5 py-0.5 text-[10px] font-medium text-muted">Site hours</span>
                  ) : null}
                  <span className="u-mono text-foreground">{totalH} H</span>
                  <span aria-hidden className="text-faintest">&middot;</span>
                  <span className="u-mono">{days} DAYS</span>
                </div>
              );
            })()}
          </div>
          </PanelSection>
        ) : (
          <PanelSection
            title="Time off"
            icon={<IconCalendar />}
            trailing={timeOff.length > 0 ? `${timeOff.length} booked` : undefined}
          >
          <div className="flex flex-col gap-2">
            {toError ? <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{toError}</p> : null}

            {toForm ? (
              <div className="rounded-lg border border-line bg-card/40 p-3">
                <TimeOffForm
                  clientId={clientId}
                  siteId={member.siteId}
                  staff={[{ id: member.id, name: member.name }]}
                  fixedStaffId={member.id}
                  canSiteClosure={false}
                  tz={tz}
                  edit={
                    toForm.editing
                      ? {
                          id: toForm.editing.id,
                          staffId: toForm.editing.staffId,
                          startsAt: toForm.editing.startsAt,
                          endsAt: toForm.editing.endsAt,
                          reason: toForm.editing.reason,
                        }
                      : undefined
                  }
                  onDone={() => setToForm(null)}
                  onClose={() => setToForm(null)}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setToError(null);
                  setToForm({});
                }}
                className="w-fit rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-subtle"
              >
                + Add time off
              </button>
            )}

            {timeOff.length === 0 && !toForm ? (
              <p className="text-sm text-muted">No time off booked.</p>
            ) : (
              [...timeOff]
                .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
                .map((t) => {
                  const days = Math.max(
                    1,
                    Math.round((new Date(t.endsAt).getTime() - new Date(t.startsAt).getTime()) / 86_400_000),
                  );
                  const past = new Date(t.endsAt).getTime() <= now.getTime();
                  return (
                    <div
                      key={t.id}
                      className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${
                        past ? "border-line bg-subtle/40 opacity-70" : "border-timeoff-edge bg-timeoff-bg/30"
                      }`}
                    >
                      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${past ? "bg-faintest" : "bg-timeoff-fg"}`} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-xs font-semibold text-foreground">
                          {t.reason?.trim() || "Time off"}
                          {past ? <span className="ml-1 font-normal text-faint">· past</span> : null}
                        </span>
                        <span className="u-mono truncate text-[11px] text-muted">
                          {fmtDay(t.startsAt, tz)} &rarr; {fmtDay(t.endsAt, tz)} · {days} {days === 1 ? "day" : "days"}
                        </span>
                      </span>
                      {/* Past blocks are history (read-only); future/current ones can be edited or removed. */}
                      {!past ? (
                        toConfirmDel === t.id ? (
                          <span className="flex shrink-0 gap-1.5">
                            <button type="button" disabled={toBusy} onClick={() => startTo(async () => { setToError(null); const r = await deleteTimeOffAction(clientId, t.id); if (r.ok) { setToConfirmDel(null); router.refresh(); } else setToError(r.error ?? "No se pudo eliminar."); })} className="rounded border border-danger/40 px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50">Delete</button>
                            <button type="button" onClick={() => setToConfirmDel(null)} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-subtle">Keep</button>
                          </span>
                        ) : (
                          <span className="flex shrink-0 gap-1.5">
                            <button type="button" onClick={() => { setToError(null); setToForm({ editing: t }); }} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-subtle">Edit</button>
                            <button type="button" onClick={() => setToConfirmDel(t.id)} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-subtle">Delete</button>
                          </span>
                        )
                      ) : null}
                    </div>
                  );
                })
            )}
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
            onClick={requestSave}
            className="inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md bg-ink px-3 text-xs font-medium text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      ) : null}

      {/* DEACTIVATION GUARD (3d): the future appointments this deactivation would affect.
          Nothing is cancelled — they are kept and simply stop being added to. */}
      {deactivateConfirm ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-line bg-surface px-4 py-3">
          <p className="text-xs font-semibold text-foreground">
            {member.name} has {deactivateConfirm.length} upcoming appointment{deactivateConfirm.length === 1 ? "" : "s"}
          </p>
          <p className="text-[11px] text-muted">
            Deactivating stops new bookings. These are kept — nothing is cancelled. Handle them with each
            customer if needed.
          </p>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {deactivateConfirm.map((a) => (
              <li key={a.id} className="u-mono truncate text-[11px] text-muted">
                {fmtDay(a.start_at, a.site_timezone)} · {a.service_name}
                {a.contact_name ? ` · ${a.contact_name}` : ""}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setDeactivateConfirm(null)} className="inline-flex h-8 items-center rounded-md border border-line-strong bg-surface px-3 text-xs hover:bg-hover">
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={commitSave} className="inline-flex h-8 items-center rounded-md border border-danger/40 px-3 text-xs text-danger hover:bg-danger/10 disabled:opacity-50">
              Deactivate anyway
            </button>
          </div>
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
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contractor", label: "Contractor" },
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
  if (d.name.trim() === "") return "A name is required.";
  if (d.weeklyHours !== "") {
    const n = Number(d.weeklyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) return "Weekly hours must be a whole number from 1 to 168.";
  }
  if (d.employmentType !== "" && !EMPLOYMENT_TYPES.some((t) => t.value === d.employmentType)) {
    return "Unknown employment type.";
  }
  return publicProfileError(d, "en");
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
          className="inline-flex h-7 items-center rounded-md bg-ink px-2.5 text-xs font-medium text-ink-fg transition-colors hover:bg-ink-hover disabled:opacity-50"
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
