"use client";

import { MobileMenuButton } from "@/components/MobileMenuButton";

import { useEffect, useState, useSyncExternalStore } from "react";
import { serviceCategory, type ApptCategory } from "@/lib/agendaCategory";
import { apptClientLabel } from "@/lib/apptClientLabel";
import { buildDay, groupWeek, hhmm, untilLabel, zoned, type MBlock } from "@/lib/mobileAgenda";
import { blockSpanLabel } from "@/lib/siteCalendar";
import type { Appt } from "../AgendaView";
import { Icon, ICON, M_CARD, MButton, MCheck, MIconButton, MPill, MSegmented, MStaffAvatar, MStateChip, Sheet, STATE_ICON, STATE_LABEL, staffColors } from "./kit";

/**
 * The PHONE agenda (< 768px), after the reference "M_AI Scheduling Móvil v2" §01: a
 * compact header (identity, search and filters as icons, Hoy), Día/Semana, a tappable
 * day strip (or the week's load), the team as avatars, and a chronological LIST — never
 * a desktop grid squeezed into a phone. Real data only: the appointments, blocks, hours
 * and staff the page loaded; nothing here decides availability.
 */

type HoursRange = { start: string; end: string };
type WeeklyHours = Partial<Record<string, HoursRange[]>>;
interface StaffOpt {
  id: string;
  name: string;
  active: boolean;
  workingHours: WeeklyHours;
  /** Public photo (Equipo → Perfil público); initials when absent. */
  photoUrl?: string | null;
}

const WD_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
/** "los domingos" / "los lunes" — only sábado and domingo change in the plural. */
const WD_PLURAL = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"];
const WD_LETTER = ["D", "L", "M", "X", "J", "V", "S"];
const WD_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTH_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const dow = (dayKey: string) => {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const dnum = (dayKey: string) => Number(dayKey.slice(8, 10));
const mon = (dayKey: string) => MONTH_SHORT[Number(dayKey.slice(5, 7)) - 1];
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}
const mondayOf = (dayKey: string) => addDays(dayKey, dow(dayKey) === 0 ? -6 : 1 - dow(dayKey));

const FAMILY_CLASS: Partial<Record<ApptCategory, string>> = { cut: "u-m-cut", grooming: "u-m-grooming", color: "u-m-color", feature: "u-m-feature" };
export const mFamilyClass = (a: Pick<Appt, "service_name" | "service_category">) =>
  FAMILY_CLASS[serviceCategory(a.service_name, a.service_category)] ?? "u-m-neutral";

const firstName = (name: string | null) => (name ?? "").replace(/^\s*[[(][^\])]*[\])]\s*/, "").trim().split(/\s+/)[0] || "—";

/** The current instant, refreshed every minute — the "Ahora" line and the "Siguiente"
 *  countdown move with the clock, not only when the page reloads. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Viewport width, for how many team avatars fit (3 at 360, 4 at 390, 5 at 430). */
function useViewportWidth(): number {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("resize", cb);
      return () => window.removeEventListener("resize", cb);
    },
    () => window.innerWidth,
    () => 390,
  );
}

export function MobileAgenda(props: {
  title: string;
  subtitle: string;
  badge: string;
  timezone: string;
  date: string;
  todayKey: string;
  view: "day" | "week";
  appointments: Appt[];
  /** Appointments per day for the week around `date` (day view's strip dots). */
  weekCounts: Record<string, number>;
  blocks: MBlock[];
  staff: StaffOpt[];
  openingHours: WeeklyHours;
  /** Team row + professional filter (reception). A staff login sees its own agenda. */
  showTeam: boolean;
  /** Staff login: only its own appointments are listed. */
  ownStaffId: string | null;
  canBook: boolean;
  initialStaffFilter: string[];
  onNavigate: (patch: { date?: string; view?: "day" | "week" }) => void;
  onOpen: (id: string) => void;
  onNew: () => void;
  /** Only supplied to roles allowed to manage time off; server rechecks the write. */
  onBlock?: () => void;
  /** Open one occurrence of a usual break / recurring block (its id is the occurrence key). */
  onOpenSeries?: (id: string) => void;
  /** Open a DATED block or absence to edit it (only when this login may). */
  onOpenBlock?: (id: string) => void;
  /** PY-2: «Cobros pendientes» (payments.view only) — count in the loaded range + open the list. */
  pendingCharges?: { count: number; onOpen: () => void };
}) {
  const tz = props.timezone;
  const isDay = props.view === "day";
  const width = useViewportWidth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState("");
  const [proF, setProF] = useState<string[]>(props.initialStaffFilter);
  const [stF, setStF] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const now = useNow();

  const closed = (dayKey: string) => {
    const h = props.openingHours;
    return !!h && Object.keys(h).length > 0 && !(h[WEEKDAY_KEYS[dow(dayKey)]]?.length ?? 0);
  };
  const query = q.trim().toLocaleLowerCase("es");
  const matches = (a: Appt) =>
    (!props.ownStaffId || a.staff_id === props.ownStaffId) &&
    (proF.length === 0 || proF.includes(a.staff_id)) &&
    (stF.length === 0 || stF.includes(a.status)) &&
    (!query || [a.contact_name, a.service_name].some((v) => (v ?? "").toLocaleLowerCase("es").includes(query)));
  const visible = props.appointments.filter(matches);
  const staffInView = props.ownStaffId ? [props.ownStaffId] : proF;
  const activeStaff = props.staff.filter((s) => s.active || props.appointments.some((a) => a.staff_id === s.id));
  const staffById = new Map(props.staff.map((s) => [s.id, s]));
  const colors = staffColors(props.staff.map((s) => s.id));

  const day = isDay ? buildDay(visible, props.blocks, props.date, tz, now, { staffInView }) : null;
  const weekStart = mondayOf(props.date);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const week = !isDay ? groupWeek(visible, weekDays, tz, closed) : null;
  const weekBlockCount = !isDay ? weekDays.reduce((n, d) => n + buildDay([], props.blocks, d, tz, now, { staffInView }).blockCount, 0) : 0;

  const nShow = width < 380 ? 3 : width < 420 ? 4 : 5;
  const teamShown = activeStaff.slice(0, nShow);
  const hiddenTeam = activeStaff.length - teamShown.length;
  const nf = proF.length + stF.length;

  const countMain = isDay
    ? `${day!.items.filter((i) => i.kind === "appt").length} ${day!.items.filter((i) => i.kind === "appt").length === 1 ? "cita" : "citas"}`
    : `${visible.length} ${visible.length === 1 ? "cita" : "citas"} en la semana`;
  const blocksN = isDay ? day!.blockCount : weekBlockCount;
  const countSub = [
    blocksN ? `${blocksN} bloqueo${blocksN === 1 ? "" : "s"}` : null,
    proF.length && props.showTeam ? proF.map((id) => firstName(staffById.get(id)?.name ?? null)).join(", ") : null,
    stF.length ? stF.map((s) => STATE_LABEL[s]).join(", ") : null,
  ].filter(Boolean);

  const periodLabel = isDay
    ? `${WD_LONG[dow(props.date)]} ${dnum(props.date)} ${mon(props.date)}${props.date === props.todayKey ? " · Hoy" : ""}`
    : `${dnum(weekStart)} ${mon(weekStart)} – ${dnum(weekDays[6])} ${mon(weekDays[6])}`;

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const resultCount = isDay ? day!.items.filter((i) => i.kind === "appt").length : visible.length;

  return (
    <div className="u-sch-m flex min-h-[calc(100dvh-var(--topbar-height))] flex-col bg-m-bg">
      {/* ── HEADER ── */}
      {/* Sticky inside the shell's scroller, whose padding (--content-pad) this layout
          cancels — so the sticky edge is offset by the same amount. */}
      <header className="sticky top-[calc(var(--content-pad)*-1)] z-20 flex flex-none flex-col gap-2 border-b border-m-bd bg-m-sf px-4 pb-2 pt-[10px]">
        {searchOpen ? (
          <div className="flex min-h-[44px] items-center gap-2">
            <label className="u-focus flex h-[44px] min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-m-sf2 px-3 text-m-tx3">
              <Icon d={ICON.search} size={18} />
              <input
                type="search"
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Cliente o servicio"
                aria-label="Buscar en la agenda"
                className="h-[44px] min-w-0 flex-1 border-0 bg-transparent text-[16px] text-m-tx outline-none placeholder:text-m-tx3"
              />
            </label>
            <button
              type="button"
              onClick={() => {
                setSearchOpen(false);
                setQ("");
              }}
              className="h-[44px] flex-none border-0 bg-transparent px-1.5 text-[16px] text-m-tx"
            >
              Cancelar
            </button>
          </div>
        ) : (
          <div className="flex min-h-[44px] items-center gap-[10px]">
            <MobileMenuButton />
            <div className="flex min-w-0 flex-1 flex-col">
              <h1 className="m-0 truncate text-[21px] font-semibold leading-[1.2] tracking-[-0.01em]">{props.title}</h1>
              <span className="truncate text-[13px] leading-[1.3] text-m-tx3">{props.subtitle}</span>
            </div>
            <MIconButton label="Buscar" onClick={() => setSearchOpen(true)}>
              <Icon d={ICON.search} />
            </MIconButton>
            <MIconButton label={nf ? `Filtros, ${nf} activos` : "Filtros"} onClick={() => setFiltersOpen(true)}>
              <Icon d={ICON.filter} />
              {nf ? (
                <span aria-hidden className="absolute right-[5px] top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-[9px] bg-m-pri px-1 text-[11px] font-semibold text-m-onpri">
                  {nf}
                </span>
              ) : null}
            </MIconButton>
            <button type="button" onClick={() => props.onNavigate({ date: props.todayKey })} className="flex h-[44px] flex-none items-center rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[15px] text-m-tx">
              Hoy
            </button>
          </div>
        )}

        <div className="flex min-h-[44px] items-center gap-1">
          {!isDay ? (
            <button type="button" aria-label="Semana anterior" onClick={() => props.onNavigate({ date: addDays(props.date, -7) })} className="-ml-3 flex size-[44px] flex-none items-center justify-center border-0 bg-transparent text-m-tx">
              <Icon d={ICON.back} size={18} width={1.6} />
            </button>
          ) : null}
          <span className="whitespace-nowrap text-[15px] font-semibold">{periodLabel}</span>
          {!isDay ? (
            <button type="button" aria-label="Semana siguiente" onClick={() => props.onNavigate({ date: addDays(props.date, 7) })} className="flex size-[44px] flex-none items-center justify-center border-0 bg-transparent text-m-tx">
              <Icon d={ICON.next} size={18} width={1.6} />
            </button>
          ) : null}
          <div className="ml-auto">
            <MSegmented
              label="Vista"
              value={props.view}
              options={[
                { value: "day", label: "Día" },
                { value: "week", label: "Semana" },
              ]}
              onChange={(v) => props.onNavigate({ view: v })}
            />
          </div>
        </div>

        {isDay ? (
          <div className="-mx-1.5 flex gap-[2px]">
            {weekDays.map((d) => {
              const sel = d === props.date;
              const today = d === props.todayKey;
              const c = closed(d) ? 0 : props.weekCounts[d] ?? 0;
              return (
                <button
                  key={d}
                  type="button"
                  aria-label={`${WD_LONG[dow(d)]} ${dnum(d)}${c ? `, ${c} citas` : ""}${closed(d) ? ", cerrado" : ""}`}
                  aria-current={sel ? "date" : undefined}
                  onClick={() => props.onNavigate({ date: d })}
                  className="flex min-h-[64px] min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-[12px] border-0 bg-transparent p-0"
                >
                  <span className="text-[12px] text-m-tx3">{WD_LETTER[dow(d)]}</span>
                  <span
                    className={`flex size-[38px] items-center justify-center rounded-full text-[16px] ${sel || today ? "font-semibold" : ""} ${
                      sel ? "bg-m-pri text-m-onpri" : closed(d) ? "text-m-tx3" : "text-m-tx"
                    } ${today && !sel ? "shadow-[inset_0_0_0_1.5px_var(--m-tx)]" : ""}`}
                  >
                    {dnum(d)}
                  </span>
                  <span aria-hidden className={`size-[5px] rounded-full ${c ? "bg-m-tx3" : "bg-transparent"}`} />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex gap-1 pb-1">
            {week!.map((g) => {
              const today = g.dayKey === props.todayKey;
              const c = g.appts.length;
              return (
                <button
                  key={g.dayKey}
                  type="button"
                  aria-label={`Ir al ${WD_LONG[dow(g.dayKey)]} ${dnum(g.dayKey)}, ${g.closed && !c ? "cerrado" : `${c} citas`}`}
                  onClick={() => props.onNavigate({ date: g.dayKey, view: "day" })}
                  className={`flex min-h-[72px] min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-[12px] bg-m-sf px-0 py-1.5 ${today ? "border-[1.5px] border-m-tx" : "border border-m-bd"}`}
                >
                  <span className="whitespace-nowrap text-[11.5px] text-m-tx3">
                    {WD_LETTER[dow(g.dayKey)]} {dnum(g.dayKey)}
                  </span>
                  <span className={`u-tnum text-[17px] font-semibold ${g.closed && !c ? "text-m-tx3" : "text-m-tx"}`}>{g.closed && !c ? "—" : c}</span>
                  <span aria-hidden className="block h-1 w-[60%] overflow-hidden rounded-[2px] bg-m-sf2">
                    <span className="block h-1 rounded-[2px] bg-m-tx" style={{ width: `${Math.min(100, (c / 12) * 100)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {props.showTeam && !searchOpen ? (
        <div role="group" aria-label="Profesionales" className="flex flex-none items-center gap-1.5 px-4 pt-[10px]">
          <MPill selected={proF.length === 0} onClick={() => setProF([])}>
            Todos
          </MPill>
          {teamShown.map((s) => {
            const sel = proF.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                aria-label={`Filtrar por ${s.name}`}
                aria-pressed={sel}
                onClick={() => setProF(toggle(proF, s.id))}
                className={`flex size-[44px] flex-none items-center justify-center rounded-full border-0 bg-transparent p-0 ${sel ? "shadow-[inset_0_0_0_2px_var(--m-tx)]" : ""} ${proF.length && !sel ? "opacity-45" : ""}`}
              >
                <MStaffAvatar id={s.id} name={s.name} size={36} color={colors.get(s.id)} photoUrl={s.photoUrl} />
              </button>
            );
          })}
          {hiddenTeam > 0 ? (
            <button type="button" onClick={() => setFiltersOpen(true)} aria-label="Ver todos los profesionales" className="flex h-[44px] min-w-[44px] flex-none items-center whitespace-nowrap rounded-[12px] border border-m-bd bg-m-sf px-3 text-[14px] text-m-tx">
              +{hiddenTeam}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-none flex-wrap items-baseline gap-1.5 px-4 pb-1 pt-3 text-[14px] text-m-tx3">
        <span className="font-semibold text-m-tx">{countMain}</span>
        {countSub.map((s) => (
          <span key={s}>· {s}</span>
        ))}
        {props.onBlock ? (
          <button type="button" onClick={props.onBlock} className="ml-auto min-h-[44px] rounded-[12px] border border-m-bd bg-m-sf px-3 text-[14px] text-m-tx">
            Bloquear horario
          </button>
        ) : null}
      </div>

      {/* ── LIST ── room at the bottom so "Nueva cita" never covers the last card */}
      <div className="flex-1 px-4 pb-[calc(100px+env(safe-area-inset-bottom))] pt-1.5">
        {props.pendingCharges && props.pendingCharges.count > 0 ? (
          <button type="button" onClick={props.pendingCharges.onOpen} className="mb-2 flex min-h-[48px] w-full items-center gap-2 rounded-[14px] border border-m-bd bg-m-sf px-[14px] text-left text-[15px] text-m-tx">
            <span aria-hidden className="grid size-[24px] place-items-center rounded-full bg-m-sf2 text-[13px] font-semibold">$</span>
            <span className="min-w-0 flex-1">{props.pendingCharges.count === 1 ? "1 cobro pendiente" : `${props.pendingCharges.count} cobros pendientes`}</span>
            <span className="text-[14px] text-m-tx2">Ver</span>
          </button>
        ) : null}
        {isDay ? (
          <DayList
            onOpenSeries={props.onOpenSeries}
            onOpenBlock={props.onOpenBlock}
            items={day!.items}
            tz={tz}
            now={now}
            staffById={staffById}
            colors={colors}
            onOpen={props.onOpen}
            empty={
              day!.items.every((i) => i.kind !== "appt")
                ? query
                  ? { title: `Sin resultados para «${q.trim()}»`, body: "Busca por nombre del cliente o del servicio." }
                  : nf
                    ? { title: "Ninguna cita con estos filtros", body: "Restablece los filtros para ver todo el día.", reset: true }
                    : closed(props.date)
                      ? { title: "Cerrado", body: `La sede no abre los ${WD_PLURAL[dow(props.date)]}. Elige otro día en la tira superior.` }
                      : { title: "Sin citas este día", body: props.canBook ? "Toca «Nueva cita» para agendar." : "No hay citas en tu agenda este día." }
                : null
            }
            onReset={() => {
              setProF([]);
              setStF([]);
            }}
          />
        ) : (
          week!.map((g) => (
            <section key={g.dayKey} className="flex flex-col gap-2 pb-1.5 pt-[10px]">
              <div className="flex items-baseline gap-2">
                <h2 className="m-0 text-[16px] font-semibold">
                  {WD_LONG[dow(g.dayKey)]} {dnum(g.dayKey)}
                  {g.dayKey === props.todayKey ? " · Hoy" : ""}
                </h2>
                <span className="text-[13px] text-m-tx3">{g.appts.length ? `${g.appts.length} ${g.appts.length === 1 ? "cita" : "citas"}` : g.closed ? "Cerrado" : "Sin citas"}</span>
              </div>
              {g.appts.length === 0 ? (
                g.closed ? (
                  <div className="min-h-[48px] rounded-[16px] bg-m-sf2 px-[14px] py-3 text-[14px] text-m-tx2">Cerrado · la sede no abre este día</div>
                ) : (
                  <div className="min-h-[48px] rounded-[16px] border border-dashed border-m-bd px-[14px] py-3 text-[14px] text-m-tx3">Sin citas</div>
                )
              ) : (
                <div className={M_CARD}>
                  {g.shown.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => props.onOpen(a.id)}
                      aria-label={`${fmt(a.start_at, tz)} ${apptClientLabel(a)}, ${a.service_name}, ${STATE_LABEL[a.status] ?? a.status}${a.payment_state === "pending" && a.status !== "cancelled" ? ", cobro pendiente" : ""}${a.review.length > 0 && a.status !== "cancelled" ? ", requiere revisión" : ""}`}
                      className="flex min-h-[64px] w-full items-center gap-[10px] border-0 border-t border-m-dv bg-transparent py-[10px] pl-[14px] pr-3 text-left text-m-tx first:border-t-0"
                    >
                      <span className="u-tnum w-11 flex-none text-[14px] font-semibold">{fmt(a.start_at, tz)}</span>
                      <span aria-hidden className={`${mFamilyClass(a)} size-[10px] flex-none rounded-full bg-[var(--m-dot)]`} />
                      <span className="flex min-w-0 flex-1 flex-col gap-px">
                        <span className={`text-[15px] font-semibold leading-[1.3] ${a.status === "cancelled" ? "line-through" : ""}`}>{apptClientLabel(a)}</span>
                        <span className="text-[13px] leading-[1.3] text-m-tx3">
                          {a.service_name} · {firstName(a.staff_name)}
                        </span>
                      </span>
                      {/* The compact marks of the grid: ! Requiere revisión (amber) · $ Cobro pendiente (neutral). */}
                      {a.status !== "cancelled" && a.review.length > 0 ? (
                        <span aria-hidden title="Requiere revisión" className="flex size-[22px] flex-none items-center justify-center rounded-full bg-[var(--warn-soft)] text-[12px] font-bold text-[var(--warn)]">
                          !
                        </span>
                      ) : null}
                      {a.status !== "cancelled" && a.payment_state === "pending" ? (
                        <span aria-hidden title="Cobro pendiente" className="flex size-[22px] flex-none items-center justify-center rounded-full bg-m-sf2 text-[12px] font-bold text-m-tx2 shadow-[inset_0_0_0_1px_var(--m-bd)]">
                          $
                        </span>
                      ) : null}
                      <MStateChip status={a.status} className="self-center" />
                    </button>
                  ))}
                  {g.hidden > 0 ? (
                    <button
                      type="button"
                      onClick={() => props.onNavigate({ date: g.dayKey, view: "day" })}
                      className="flex min-h-[52px] w-full items-center justify-between border-0 border-t border-m-dv bg-transparent px-[14px] text-[15px] font-semibold text-m-tx"
                    >
                      Ver las {g.appts.length} citas del {WD_SHORT[dow(g.dayKey)]} {dnum(g.dayKey)}
                      <span aria-hidden className="text-m-tx3">
                        ›
                      </span>
                    </button>
                  ) : null}
                </div>
              )}
            </section>
          ))
        )}
      </div>

      {props.canBook ? (
        <button
          type="button"
          onClick={props.onNew}
          className="fixed bottom-[max(16px,env(safe-area-inset-bottom))] right-4 z-30 flex h-[52px] items-center gap-2 rounded-[12px] border-0 bg-m-pri pl-4 pr-5 text-[16px] font-semibold text-m-onpri shadow-[0_8px_22px_rgba(0,0,0,0.24)]"
        >
          <Icon d={ICON.plus} size={18} width={1.8} />
          Nueva cita
        </button>
      ) : null}

      {/* ── FILTERS ── */}
      <Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        label="Filtros"
        header={
          <div className="flex flex-none items-center px-4 pb-2">
            <span className="text-[18px] font-semibold">Filtros</span>
            <button
              type="button"
              onClick={() => {
                setProF([]);
                setStF([]);
              }}
              className="ml-auto h-[44px] border-0 bg-transparent px-2 text-[15px] text-m-tx underline underline-offset-[3px]"
            >
              Restablecer
            </button>
          </div>
        }
        footer={
          <MButton kind="primary" grow className="w-full" onClick={() => setFiltersOpen(false)}>
            Ver {resultCount} {resultCount === 1 ? "cita" : "citas"}
          </MButton>
        }
        bodyClassName="flex flex-col gap-4 px-4 pb-2"
      >
        {props.showTeam ? (
          <section className="flex flex-col gap-1">
            <h2 className="m-0 text-[14px] font-semibold text-m-tx2">Profesionales</h2>
            <div>
              {activeStaff.map((s) => {
                const on = proF.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setProF(toggle(proF, s.id))}
                    className="flex min-h-[56px] w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent px-1 py-1.5 text-left text-m-tx first:border-t-0"
                  >
                    <MCheck on={on} />
                    <MStaffAvatar id={s.id} name={s.name} size={32} color={colors.get(s.id)} photoUrl={s.photoUrl} />
                    <span className="flex-1 text-[16px] leading-[1.3]">{s.name}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[14px] font-semibold text-m-tx2">Color de las citas · por servicio</h2>
          <ul aria-label="Leyenda" className="flex flex-wrap gap-x-3 gap-y-1.5 text-[14px] text-m-tx2">
            {(["cut", "grooming", "color", "feature"] as const).map((f) => (
              <li key={f} className="flex items-center gap-1.5">
                <span aria-hidden className={`${FAMILY_CLASS[f]} size-3 rounded-[4px] bg-m-sf shadow-[inset_0_0_0_1.5px_var(--m-dot)]`} />
                {{ cut: "Corte", grooming: "Barba y cuidado", color: "Color", feature: "Tratamiento" }[f]}
              </li>
            ))}
          </ul>
          <p className="m-0 text-[13px] leading-[1.45] text-m-tx3">
            El color es el servicio. Contorno: confirmada · punteado: sin confirmar · relleno: completada. El icono y el texto de cada cita repiten el estado.
          </p>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[14px] font-semibold text-m-tx2">Estado</h2>
          <div className="flex flex-wrap gap-2">
            {(["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const).map((s) => (
              <MPill key={s} selected={stF.includes(s)} onClick={() => setStF(toggle(stF, s))}>
                <span aria-hidden>{STATE_ICON[s]}</span> {STATE_LABEL[s]}
              </MPill>
            ))}
          </div>
        </section>
        {props.pendingCharges ? (
          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-[14px] font-semibold text-m-tx2">Cobros</h2>
            <button
              type="button"
              onClick={() => {
                setFiltersOpen(false);
                props.pendingCharges?.onOpen();
              }}
              className="flex min-h-[48px] items-center justify-between rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[15px] text-m-tx">
              Cobros pendientes
              <span className="text-[14px] text-m-tx2">Ver lista</span>
            </button>
          </section>
        ) : null}
      </Sheet>
    </div>
  );
}

const fmt = (iso: string, tz: string) => hhmm(zoned(iso, tz).min);

function DayList({
  items,
  tz,
  now,
  staffById,
  colors,
  onOpen,
  onOpenSeries,
  onOpenBlock,
  empty,
  onReset,
}: {
  items: ReturnType<typeof buildDay<Appt>>["items"];
  onOpenSeries?: (id: string) => void;
  onOpenBlock?: (id: string) => void;
  tz: string;
  now: Date;
  staffById: Map<string, StaffOpt>;
  colors: Map<string, string>;
  onOpen: (id: string) => void;
  empty: { title: string; body: string; reset?: boolean } | null;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((it) => {
        if (it.kind === "now") {
          return (
            // The server and the browser read the clock seconds apart: across a minute change
            // the time legitimately differs at hydration (it is refreshed every minute anyway).
            <div key="now" role="separator" aria-label={`Hora actual ${hhmm(it.at)}`} suppressHydrationWarning className="flex items-center gap-2 py-0.5">
              <span suppressHydrationWarning className="u-tnum w-[52px] flex-none text-[12px] font-semibold leading-tight">
                Ahora
                <br />
                {hhmm(it.at)}
              </span>
              <span aria-hidden className="size-2 flex-none rounded-full bg-m-tx" />
              <span aria-hidden className="h-[1.5px] flex-1 bg-m-tx" />
            </div>
          );
        }
        if (it.kind === "block") {
          const who = it.block.staff_id ? staffById.get(it.block.staff_id)?.name ?? "Un profesional" : "Toda la sede";
          const isBreak = it.block.series === "break";
          // A whole day (or several) reads «Todo el día», with its dates — not 00:00–23:59.
          const span = blockSpanLabel(it.block.starts_at, it.block.ends_at, tz);
          const wholeDay = span.allDay || (it.from === 0 && it.to >= 24 * 60);
          const range = wholeDay ? (span.allDay ? span.text : "Todo el día") : `${hhmm(it.from)} – ${hhmm(Math.min(it.to, 24 * 60 - 1))}`;
          const body = (
            // A usual break has NO border (routine); a block or absence has one.
            <div className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-[16px] bg-m-sf2 px-[14px] py-3 text-left ${isBreak ? "" : "border border-dashed border-m-tx3"}`}>
              <span className="text-[14px] font-semibold text-m-tx2">{isBreak ? `Pausa habitual · ${range}` : `⊘ Bloqueado · ${range}`}</span>
              <span className="text-[14px] text-m-tx2">{[isBreak ? null : it.block.reason, who].filter(Boolean).join(" · ")}</span>
            </div>
          );
          const open = it.block.series ? onOpenSeries : onOpenBlock;
          const series = Boolean(open);
          return (
            <div key={`b-${it.block.id}`} className="flex gap-3">
              <div className="flex w-[52px] flex-none flex-col gap-0.5 pt-3">
                <span className="u-tnum text-[15px] font-semibold text-m-tx2">{wholeDay ? "Todo" : hhmm(it.from)}</span>
                <span className="text-[12px] text-m-tx3">{wholeDay ? "el día" : `${it.to - it.from} min`}</span>
              </div>
              {series ? (
                <button type="button" onClick={() => open?.(it.block.id)} className="flex min-h-[44px] min-w-0 flex-1 border-0 bg-transparent p-0" aria-label={`${isBreak ? "Pausa habitual" : "Bloqueo"} ${range}, ${who}. Abrir`}>
                  {body}
                </button>
              ) : (
                body
              )}
            </div>
          );
        }
        const a = it.appt;
        const end = fmt(a.service_end_at, tz);
        const cancelled = a.status === "cancelled";
        return (
          <button
            key={a.id}
            type="button"
            data-appt-id={a.id}
            onClick={() => onOpen(a.id)}
            aria-label={`${fmt(a.start_at, tz)} ${apptClientLabel(a)}, ${a.service_name}, ${STATE_LABEL[a.status] ?? a.status}${a.payment_state === "pending" && !cancelled ? ", cobro pendiente" : ""}${a.review.length > 0 && !cancelled ? ", requiere revisión" : ""}`}
            className="flex w-full gap-3 border-0 bg-transparent p-0 text-left text-m-tx"
          >
            <div className="flex w-[52px] flex-none flex-col gap-0.5 pt-3">
              <span className="u-tnum text-[15px] font-semibold">{fmt(a.start_at, tz)}</span>
              <span className="text-[12px] text-m-tx3">{a.duration_min} min</span>
            </div>
            {/* The colour is the service; the state is how the card wears it (as on the desktop):
                contour = confirmada, dashed = sin confirmar, filled = completada; a cancelled
                one is a grey dashed outline. «Siguiente» keeps its ink edge. Card language 5a:
                the service bar on the left, «Requiere revisión» amber, «Cobro pendiente»
                neutral, and the state as quiet text (a red ⊘ for a no-show) — not a button. */}
            <div
              data-status={a.status}
              className={`${mFamilyClass(a)} flex min-w-0 flex-1 overflow-hidden rounded-[14px] border ${
                cancelled
                  ? "border-dashed border-m-bd bg-transparent"
                  : a.status === "completed"
                    ? "border-transparent bg-[var(--m-fill)]"
                    : a.status === "confirmed" || a.status === "scheduled"
                      ? "border-[var(--m-dot)] bg-m-sf"
                      : "border-[color-mix(in_srgb,var(--m-dot)_55%,var(--m-sf))] bg-m-sf"
              } ${it.isNext ? "!border-m-tx" : ""} ${a.status === "scheduled" ? "border-dashed" : ""}`}
            >
              <span
                aria-hidden
                className={`w-1 flex-none ${cancelled ? "bg-m-bd" : "bg-[var(--m-dot)]"}`}
                style={a.status === "scheduled" ? { background: "repeating-linear-gradient(180deg, var(--m-dot) 0 5px, transparent 5px 9px)" } : undefined}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-[14px] py-3">
                {it.isNext ? (
                  <span className="text-[12px] font-semibold uppercase tracking-[0.02em]">→ Siguiente · {untilLabel(now.getTime(), new Date(a.start_at).getTime())}</span>
                ) : null}
                <span className={`break-words text-[16px] font-semibold leading-[1.3] ${cancelled ? "line-through" : ""}`}>{apptClientLabel(a)}</span>
                <span className="text-[14px] leading-[1.35] text-m-tx2">
                  {a.service_name} <span className="text-m-tx3">· hasta {end}</span>
                </span>
                {!cancelled && (a.review.length > 0 || a.payment_state === "pending") ? (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {a.review.length > 0 ? (
                      <span className="rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[12px] font-semibold text-[var(--warn)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warn)_30%,transparent)]">! Requiere revisión</span>
                    ) : null}
                    {a.payment_state === "pending" ? (
                      <span className="rounded-full bg-m-sf2 px-2 py-0.5 text-[12px] font-semibold text-m-tx2 shadow-[inset_0_0_0_1px_var(--m-bd)]">$ Cobro pendiente</span>
                    ) : null}
                  </span>
                ) : null}
                <div className="mt-1.5 flex items-center gap-1.5">
                  <MStaffAvatar id={a.staff_id} name={a.staff_name} size={24} color={colors.get(a.staff_id)} />
                  <span className="min-w-0 truncate text-[13px] text-m-tx2">{firstName(a.staff_name)}</span>
                  <span className="ml-auto shrink-0 self-center text-[13px] text-m-tx3">
                    <span aria-hidden className={a.status === "no_show" ? "text-m-dn" : ""}>
                      {STATE_ICON[a.status] ?? ""}
                    </span>{" "}
                    {STATE_LABEL[a.status] ?? a.status}
                  </span>
                </div>
              </div>
            </div>
          </button>
        );
      })}
      {empty ? (
        <div className="mt-2 flex flex-col items-center gap-1.5 rounded-[16px] border border-m-bd bg-m-sf px-5 py-7 text-center">
          <span className="text-[16px] font-semibold">{empty.title}</span>
          <span className="text-[14px] leading-[1.45] text-m-tx3 [text-wrap:pretty]">{empty.body}</span>
          {empty.reset ? (
            <button type="button" onClick={onReset} className="mt-2 h-[44px] rounded-[12px] border border-m-bd bg-m-sf px-4 text-[15px] text-m-tx">
              Restablecer filtros
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
