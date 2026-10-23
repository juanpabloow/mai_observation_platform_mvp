"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { addDays, calendarDays, shiftMonth } from "@/lib/siteCalendar";

/**
 * AGENDA CHROME — the approved «M_AI Agenda» reference's own pieces, shared by Calendario,
 * Equipo and Horarios y ausencias (all inside `.u-ag`, see globals.css):
 *   AgAvatar       pastel initials (Grafito: neutral), stable per person
 *   StateChip      state as glyph + words (stChip)
 *   usePopover     one popover behaviour: Escape closes and returns focus to its trigger,
 *                  a click outside closes, the first control takes focus on open
 *   GearMenu       «Más opciones de agenda» — the reference's toolbar menu
 *   FiltersPopover «Color de las citas» (Servicio | Estado) + legend, professionals, states
 *   DateTitle      the date as the page title, opening a month picker
 * Nothing here decides a permission or a rule: callers pass only what the login may do.
 */

// ── Page header (one identity for every Agenda screen) ──────────────────────────
/**
 * The reference's page head (ST.head + ST.h1): 24px / 600 / −0.02em, 24px from the side,
 * the title box 40px tall (the toolbar's height) so a title with a subtitle, a title next
 * to the calendar's tools and a bare title all start at the SAME place on every screen.
 */
export const AG_HEAD = "flex shrink-0 flex-wrap items-start gap-2 px-5 pb-2.5 pt-3";
export const AG_H1 = "py-[3px] text-[20px] font-semibold leading-[26px] tracking-[-0.015em] text-foreground";
export const AG_SUB = "-mt-1 text-[13px] text-muted";

export function AgPageHeader(props: { title: ReactNode; subtitle?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <div className={AG_HEAD}>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 id={props.id} className={`${AG_H1} truncate`}>{props.title}</h1>
        {props.subtitle ? <p className={AG_SUB}>{props.subtitle}</p> : null}
      </div>
      {props.children ? <div className="flex shrink-0 flex-wrap items-center gap-2.5">{props.children}</div> : null}
    </div>
  );
}

// ── Avatar ────────────────────────────────────────────────────────────────────

/** Stable 1–4 tint from an id (or a name), so a person keeps one colour on every screen. */
export function agTint(key: string): "1" | "2" | "3" | "4" {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return String((h % 4) + 1) as "1" | "2" | "3" | "4";
}

/** First letter of the first and the last word — "María Fernanda Castellanos" → "MC". */
export function agInitials(name: string | null | undefined): string {
  const words = (name ?? "").replace(/^\s*[[(][^\])]*[\])]\s*/, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0].match(/[\p{L}\p{N}]/u)?.[0] ?? "";
  const last = words.length > 1 ? words[words.length - 1].match(/[\p{L}\p{N}]/u)?.[0] ?? "" : "";
  return (first + last).toLocaleUpperCase("es") || "?";
}

/** The reference assigns the four pastels by ROSTER ORDER (cols[i % 4]): pass the person's
 *  index in the site's roster (the same alphabetical order on every Agenda screen). */
export function agTintAt(index: number): "1" | "2" | "3" | "4" {
  return String((((index % 4) + 4) % 4) + 1) as "1" | "2" | "3" | "4";
}

export function AgAvatar(props: { name: string | null; id?: string | null; size: number; radius?: number; photoUrl?: string | null; className?: string; tint?: "1" | "2" | "3" | "4" }) {
  const style = { width: props.size, height: props.size, borderRadius: props.radius ?? 9999, fontSize: Math.round(props.size * 0.36) };
  if (props.photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
    return <img src={props.photoUrl} alt="" aria-hidden className={`shrink-0 object-cover ${props.className ?? ""}`} style={style} />;
  }
  return (
    <span aria-hidden data-tint={props.tint ?? agTint(props.id ?? props.name ?? "")} className={`u-ag-av ${props.className ?? ""}`} style={style}>
      {agInitials(props.name)}
    </span>
  );
}

// ── State ─────────────────────────────────────────────────────────────────────

export const STATE_GLYPH: Record<string, string> = { scheduled: "○", confirmed: "✓", completed: "✓✓", cancelled: "✕", no_show: "!" };
export const STATE_WORD: Record<string, string> = {
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "Inasistencia",
};

export function StateChip({ status, size = "md" }: { status: string; size?: "sm" | "md" }) {
  return (
    <span className={`u-status-${status} inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-[6px] px-2 ${size === "sm" ? "h-[22px] text-[12px]" : "h-[26px] text-[13px]"}`}>
      <span aria-hidden>{STATE_GLYPH[status] ?? "·"}</span>
      {STATE_WORD[status] ?? status}
    </span>
  );
}

// ── Popover behaviour ─────────────────────────────────────────────────────────

export function usePopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Only the top layer: a dialog opened over the popover handles its own Escape.
      if (document.querySelector("[role=dialog][aria-modal=true]")) return;
      e.stopPropagation();
      close(true);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    const first = panelRef.current?.querySelector<HTMLElement>("button:not([disabled]), input, [href], select, [tabindex]:not([tabindex='-1'])");
    first?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [open, close]);
  return { open, setOpen, close, triggerRef, panelRef, toggle: () => setOpen((o) => !o) };
}

const POP = "absolute right-0 top-[calc(100%+8px)] z-40 flex flex-col rounded-[12px] bg-[var(--surface)] shadow-[0_0_0_1px_var(--line),0_14px_36px_rgba(0,0,0,0.14)]";
export const TB_ICON =
  "u-focus relative inline-flex size-[32px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] text-foreground transition-colors hover:bg-[var(--subtle)]";
export const TB_BTN =
  "u-focus inline-flex h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--subtle)]";
export const TB_PRIMARY =
  "u-focus inline-flex h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] bg-[var(--ink)] px-3 text-[13px] font-medium text-[var(--ink-fg)] transition-colors hover:bg-[var(--ink-hover)] disabled:bg-[var(--ag-prim-dis)] disabled:text-[var(--ag-prim-dis-ink)]";

// ── «Más opciones de agenda» ──────────────────────────────────────────────────

export interface GearItem {
  label: string;
  sub: string;
  onSelect: () => void;
}

export function GearMenu(props: {
  items: GearItem[];
  badge: boolean;
  /** «Filtrar»: opens the filters ON the same button (the reference's flow). */
  filters?: { label: string; sub: string; content: ReactNode };
}) {
  const { open, setOpen, close, toggle, triggerRef, panelRef } = usePopover();
  const [mode, setMode] = useState<"menu" | "filters">("menu");
  const id = useId();
  const showFilters = () => {
    setMode("filters");
    setOpen(true);
    // The menu item that had focus is gone: focus moves into the filters.
    window.requestAnimationFrame(() => document.getElementById(id)?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true }));
  };
  const items = [...(props.filters ? [{ label: props.filters.label, sub: props.filters.sub, onSelect: showFilters, keep: true }] : []), ...props.items.map((x) => ({ ...x, keep: false }))];
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Más opciones de agenda"
        title="Filtros, bloqueos y ajustes"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setMode("menu");
          toggle();
        }}
        className={TB_ICON}
      >
        <svg aria-hidden viewBox="0 0 16 16" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
        </svg>
        {props.badge ? <span aria-hidden className="absolute right-[7px] top-[7px] size-[7px] rounded-full bg-[var(--ink)] ring-2 ring-[var(--surface)]" /> : null}
      </button>
      {open && mode === "filters" && props.filters ? (
        <div ref={panelRef} id={id} role="dialog" aria-label="Filtros de la agenda" className={`${POP} max-h-[min(640px,calc(100vh-120px))] w-[296px] overflow-y-auto px-4 py-3.5`}>
          {props.filters.content}
        </div>
      ) : open ? (
        <div ref={panelRef} id={id} role="menu" aria-label="Más opciones de agenda" className={`${POP} w-[268px] p-1.5`}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                if (it.keep) return it.onSelect();
                close(false);
                it.onSelect();
              }}
              className="u-focus flex min-h-[48px] flex-col items-start justify-center rounded-[8px] px-3 py-1.5 text-left hover:bg-[var(--subtle)]"
            >
              <span className="text-[14px] text-foreground">{it.label}</span>
              <span className="text-[12.5px] text-muted">{it.sub}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Filtros ───────────────────────────────────────────────────────────────────

const FAMILY_EDGE: Record<string, string> = {
  cut: "var(--appt-cut-rule)",
  grooming: "var(--appt-grooming-rule)",
  color: "var(--appt-color-rule)",
  feature: "var(--appt-feature-rule)",
};

export interface FiltersValue {
  colorBy: "service" | "status";
  /** Professionals shown (empty = everyone). */
  staff: string[];
  /** States shown in full; the rest are dimmed (never hidden — the time is still taken). */
  states: string[];
}

export const ALL_STATES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;

export function FiltersPopover(props: {
  value: FiltersValue;
  families: Array<{ family: string; label: string }>;
  people: Array<{ id: string; name: string; photoUrl?: string | null }>;
  onChange: (v: FiltersValue) => void;
  tintOf?: (id: string) => "1" | "2" | "3" | "4";
}) {
  const v = props.value;
  const everyone = v.staff.length === 0;
  const togglePerson = (id: string) => {
    const shown = everyone ? props.people.map((p) => p.id) : v.staff;
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    // Never an empty board: unticking the last one shows everyone again.
    props.onChange({ ...v, staff: next.length === 0 || next.length === props.people.length ? [] : next });
  };
  const toggleState = (s: string) => {
    const next = v.states.includes(s) ? v.states.filter((x) => x !== s) : [...v.states, s];
    props.onChange({ ...v, states: next });
  };
  return (
    <>
      <p className="text-[13px] text-muted">Color de las citas</p>
      <div role="radiogroup" aria-label="Color de las citas" className="mt-2 grid grid-cols-2 gap-0.5 rounded-[10px] bg-[var(--ag-seg)] p-[3px]">
        {(["service", "status"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={v.colorBy === m}
            onClick={() => props.onChange({ ...v, colorBy: m })}
            className={`u-focus h-[30px] rounded-[8px] text-[13px] ${v.colorBy === m ? "bg-[var(--surface)] text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08),inset_0_0_0_1px_var(--line)]" : "text-[var(--ag-ink2)]"}`}
          >
            {m === "service" ? "Servicio" : "Estado"}
          </button>
        ))}
      </div>
      <ul aria-label="Leyenda" className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1.5 text-[13px] text-[var(--ag-ink2)]">
        {v.colorBy === "service"
          ? props.families.map((f) => (
              <li key={f.family} className="flex items-center gap-1.5">
                <span aria-hidden className="size-[14px] rounded-[4px] border-[1.5px] bg-[var(--surface)]" style={{ borderColor: FAMILY_EDGE[f.family] ?? "var(--line-strong)" }} />
                {f.label}
              </li>
            ))
          : ALL_STATES.map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <StateChip status={s} size="sm" />
              </li>
            ))}
      </ul>
      <p className="mt-2 text-[12.5px] leading-[1.45] text-muted">
        {v.colorBy === "service"
          ? "El color es la categoría del servicio. El estado se lee en el icono y el texto de cada cita (✓ confirmada · ✓✓ completada)."
          : "El color es el estado. El servicio se lee en el texto de cada cita."}
      </p>
      {props.people.length > 1 ? (
        <fieldset className="mt-3 border-t border-[var(--line)] pt-3">
          <legend className="sr-only">Profesionales</legend>
          <p aria-hidden className="mb-1.5 text-[13px] text-muted">Profesionales</p>
          {props.people.map((p) => (
            <label key={p.id} className="flex min-h-[40px] cursor-pointer items-center gap-3">
              <input type="checkbox" checked={everyone || v.staff.includes(p.id)} onChange={() => togglePerson(p.id)} className="size-[18px] accent-[var(--ink)]" />
              <AgAvatar name={p.name} id={p.id} size={24} photoUrl={p.photoUrl} tint={props.tintOf?.(p.id)} />
              <span className="min-w-0 truncate text-[14px]">{p.name}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <fieldset className="mt-3 border-t border-[var(--line)] pt-3">
        <legend className="sr-only">Estados</legend>
        <p aria-hidden className="mb-1.5 text-[13px] text-muted">Estados</p>
        {ALL_STATES.map((s) => (
          <label key={s} className="flex min-h-[38px] cursor-pointer items-center gap-3">
            <input type="checkbox" checked={v.states.includes(s)} onChange={() => toggleState(s)} className="size-[18px] accent-[var(--ink)]" />
            <StateChip status={s} size="sm" />
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        onClick={() => props.onChange({ colorBy: v.colorBy, staff: [], states: [...ALL_STATES] })}
        className="u-focus mt-2 h-[32px] self-start rounded-[8px] px-0 text-[13px] text-[var(--ag-ink2)] underline-offset-2 hover:underline"
      >
        Restablecer filtros
      </button>
    </>
  );
}

// ── Date as title ─────────────────────────────────────────────────────────────

const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAYS_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

/** "Miércoles, 21 de octubre" · week: "19 – 25 de octubre" (both months/years when needed). */
export function agendaTitle(view: "day" | "week", date: string, weekStart?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (view === "day") return `${WEEKDAYS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${d} de ${MONTHS_LONG[m - 1]}`;
  const start = weekStart ?? date;
  const end = addDays(start, 6);
  const [ya, ma, da] = start.split("-").map(Number);
  const [yb, mb, db] = end.split("-").map(Number);
  if (ya !== yb) return `${da} de ${MONTHS_LONG[ma - 1]} ${ya} – ${db} de ${MONTHS_LONG[mb - 1]} ${yb}`;
  if (ma !== mb) return `${da} de ${MONTHS_LONG[ma - 1]} – ${db} de ${MONTHS_LONG[mb - 1]}`;
  return `${da} – ${db} de ${MONTHS_LONG[mb - 1]}`;
}

export function DateTitle(props: { label: string; date: string; today: string; onPick: (day: string) => void }) {
  const { open, toggle, close, triggerRef, panelRef } = usePopover();
  const [monthState, setMonth] = useState<{ forDate: string; month: string }>({ forDate: props.date, month: props.date.slice(0, 7) });
  const month = monthState.forDate === props.date ? monthState.month : props.date.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const id = useId();
  return (
    <div className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={toggle}
        className="u-focus -ml-1 flex min-w-0 items-center gap-1.5 rounded-[10px] px-1"
      >
        <h1 className={`${AG_H1} truncate`}>{props.label}</h1>
        <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0 text-[var(--ag-ink2)]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span className="sr-only">Elegir fecha</span>
      </button>
      {open ? (
        <div ref={panelRef} id={id} role="dialog" aria-label="Elegir fecha" className={`${POP} left-0 right-auto w-[292px] p-3`}>
          <div className="mb-2 flex items-center gap-1">
            <button type="button" aria-label="Mes anterior" onClick={() => setMonth({ forDate: props.date, month: shiftMonth(month, -1) })} className="u-focus inline-flex size-[32px] items-center justify-center rounded-[9px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">
              ‹
            </button>
            <span className="flex-1 text-center text-[14px] font-medium capitalize">
              {MONTHS_LONG[m - 1]} {y}
            </span>
            <button type="button" aria-label="Mes siguiente" onClick={() => setMonth({ forDate: props.date, month: shiftMonth(month, 1) })} className="u-focus inline-flex size-[32px] items-center justify-center rounded-[9px] text-[var(--ag-ink2)] hover:bg-[var(--subtle)]">
              ›
            </button>
          </div>
          <div aria-hidden className="grid grid-cols-7 text-center text-[11.5px] text-muted">
            {["L", "M", "X", "J", "V", "S", "D"].map((d) => (
              <span key={d} className="py-1">{d}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {calendarDays(month).map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={`${c.day} de ${MONTHS_LONG[Number(c.key.slice(5, 7)) - 1]}`}
                aria-current={c.key === props.date ? "date" : undefined}
                onClick={() => {
                  close(true);
                  props.onPick(c.key);
                }}
                className={`u-focus h-[36px] rounded-[9px] text-[13.5px] tabular-nums ${
                  c.key === props.date ? "bg-[var(--ink)] font-medium text-[var(--ink-fg)]" : c.inMonth ? "text-foreground hover:bg-[var(--subtle)]" : "text-muted hover:bg-[var(--subtle)]"
                } ${c.key === props.today && c.key !== props.date ? "font-semibold underline underline-offset-4" : ""}`}
              >
                {c.day}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
