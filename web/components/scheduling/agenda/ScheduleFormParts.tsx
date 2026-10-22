"use client";

import { useId, type ReactNode } from "react";
import { fmtTime, longDate } from "@/lib/siteCalendar";
import { Button } from "../ui/system";

/** One appointment a schedule change would leave in conflict. */
export interface AffectedItem {
  id: string;
  customerName: string | null;
  serviceName: string;
  staffName: string | null;
  startAt: string;
  endAt: string;
  /** For rescheduling it from the form (the same appointment). */
  staffId?: string;
  serviceId?: string;
  durationMin?: number;
  status?: string;
}

/**
 * «Citas afectadas» — what a break/block/hours change leaves inside it. Nothing is moved,
 * cancelled or notified: each one has «Reagendar» (the same appointment, in its own panel;
 * the form keeps everything typed and recalculates when you come back). Only rescheduling it
 * out of the conflict resolves it — opening, cancelling or a failed save leave it listed.
 */
export function AffectedList(props: {
  items: AffectedItem[] | null;
  loading: boolean;
  error?: string | null;
  timezone: string;
  /** "la nueva pausa" / "el bloqueo" — completes "N citas quedan dentro de …". */
  what: string;
  onReschedule?: (item: AffectedItem) => void;
  onRetry?: () => void;
}) {
  const { items, timezone: tz } = props;
  if (props.error) {
    return (
      <div className="flex items-center gap-3 rounded-[12px] bg-subtle px-3.5 py-3 text-[13px] text-muted">
        <span className="min-w-0 flex-1">No pudimos revisar las citas afectadas.</span>
        {props.onRetry ? <Button size="sm" onClick={props.onRetry}>Reintentar</Button> : null}
      </div>
    );
  }
  if (props.loading && !items) {
    return <div aria-busy="true" aria-label="Revisando citas afectadas" className="h-12 rounded-[12px] bg-subtle" />;
  }
  if (!items) return null;
  if (items.length === 0) {
    return (
      <p role="status" className="flex items-center gap-2 rounded-[12px] bg-[var(--success-soft,rgba(34,87,58,0.08))] px-3.5 py-3 text-[13px] text-[var(--success,#22573a)]">
        <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3.5 8.5l3 3 6-7" /></svg>
        Ninguna cita queda dentro de {props.what}.
      </p>
    );
  }
  return (
    <div className={`flex flex-col gap-2 ${props.loading ? "opacity-70" : ""}`} aria-busy={props.loading || undefined}>
      <p role="status" className="rounded-[12px] border border-[var(--warn-rule)] bg-[var(--warn-soft)] px-3.5 py-3 text-[13px] text-[var(--warn)]">
        <span className="font-semibold">
          {items.length === 1 ? "1 cita queda" : `${items.length} citas quedan`} dentro de {props.what}.
        </span>{" "}
        No se mueven, no se cancelan ni se avisa al cliente automáticamente.
      </p>
      <ul className="flex flex-col divide-y divide-line-soft rounded-[12px] border border-line">
        {items.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{a.customerName ?? "Sin contacto"}</p>
              <p className="u-tnum truncate text-[12px] text-muted">
                {longDate(a.startAt, tz)} · {fmtTime(a.startAt, tz)}–{fmtTime(a.endAt, tz)} · {a.serviceName}
                {a.staffName ? ` · ${a.staffName}` : ""}
              </p>
            </div>
            {props.onReschedule ? (
              <Button size="sm" onClick={() => props.onReschedule?.(a)}>
                Reagendar
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type Scope = "date" | "following" | "future";

/** «Aplicar a» — the three scopes, each saying what it touches. */
export function ScopeChooser(props: {
  value: Scope;
  onChange: (s: Scope) => void;
  /** "Jue 22 oct" */
  dateLabel: string;
  /** Per-scope description override. */
  hints?: Partial<Record<Scope, string>>;
  disabled?: Partial<Record<Scope, boolean>>;
  legend?: string;
}) {
  const name = useId();
  const opts: Array<{ v: Scope; label: string; hint: string }> = [
    { v: "date", label: "Solo esta fecha", hint: props.hints?.date ?? `${props.dateLabel}. Las demás fechas no cambian.` },
    { v: "following", label: "Esta y las siguientes", hint: props.hints?.following ?? `Desde el ${props.dateLabel}. Lo anterior no cambia.` },
    { v: "future", label: "Toda la serie futura", hint: props.hints?.future ?? "Desde la primera fecha que aún no empieza. Lo pasado no cambia." },
  ];
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] font-semibold">{props.legend ?? "Aplicar a"}</legend>
      {opts.map((o) => {
        const on = props.value === o.v;
        const off = props.disabled?.[o.v];
        return (
          <label
            key={o.v}
            className={`flex min-h-[52px] cursor-pointer items-start gap-3 rounded-[12px] border px-3.5 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-edge)] ${
              on ? "border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"
            } ${off ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <input type="radio" name={name} checked={on} disabled={off} onChange={() => props.onChange(o.v)} className="mt-1 size-4 accent-[var(--foreground)]" />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{o.label}</span>
              <span className="block text-[12.5px] leading-5 text-muted">{o.hint}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A labelled two-option switch (Un profesional | Toda la sede, Una vez | Se repite…). */
export function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (v: T) => void;
  /** The surrounding section already names it. */
  hideLabel?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {props.hideLabel ? null : <span className="text-[13px] font-semibold">{props.label}</span>}
      <div role="radiogroup" aria-label={props.label} className="grid auto-cols-fr grid-flow-col gap-0.5 rounded-[12px] bg-chip p-1">
        {props.options.map((o) => {
          const on = o.value === props.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={o.disabled}
              onClick={() => props.onChange(o.value)}
              className={`u-focus h-11 rounded-[9px] text-[13px] transition-colors disabled:opacity-40 md:h-9 ${on ? "bg-surface font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-foreground"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const DAY_LETTERS = [
  { d: 1, l: "L", n: "lunes" },
  { d: 2, l: "M", n: "martes" },
  { d: 3, l: "X", n: "miércoles" },
  { d: 4, l: "J", n: "jueves" },
  { d: 5, l: "V", n: "viernes" },
  { d: 6, l: "S", n: "sábado" },
  { d: 0, l: "D", n: "domingo" },
];

/** «Se repite cada» — weekday toggles, Monday first. */
export function WeekdayPicker(props: { value: number[]; onChange: (v: number[]) => void; error?: string | null; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-semibold">{props.label ?? "Se repite cada"}</span>
      <div role="group" aria-label={props.label ?? "Se repite cada"} className="flex flex-wrap gap-1.5">
        {DAY_LETTERS.map(({ d, l, n }) => {
          const on = props.value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={n}
              onClick={() => props.onChange(on ? props.value.filter((x) => x !== d) : [...props.value, d])}
              className={`u-focus grid size-11 place-items-center rounded-full border text-[13px] font-semibold transition-colors md:size-9 ${on ? "border-foreground bg-foreground text-background" : "border-line hover:bg-subtle"}`}
            >
              {l}
            </button>
          );
        })}
      </div>
      {props.error ? <span className="text-[12.5px] text-danger">{props.error}</span> : null}
    </div>
  );
}

/** A small "label: input" row. */
export function FieldRow({ label, children, error, hint, htmlFor }: { label: ReactNode; children: ReactNode; error?: string | null; hint?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold">{label}</label>
      {children}
      {hint ? <span className="text-[12.5px] text-muted">{hint}</span> : null}
      {error ? <span role="alert" className="text-[12.5px] text-danger">{error}</span> : null}
    </div>
  );
}

/** HH:MM options every `step` minutes, for selects (24 h). */
export function timeOptions(step = 15, from = 0, to = 24 * 60): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

export function TimeSelect(props: { id?: string; value: string; onChange: (v: string) => void; label: string; min?: string; max?: string; step?: number }) {
  const opts = timeOptions(props.step ?? 15).filter((t) => (!props.min || t >= props.min) && (!props.max || t <= props.max));
  const all = opts.includes(props.value) ? opts : [...opts, props.value].sort();
  return (
    <select
      id={props.id}
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      className="u-focus u-tnum h-11 rounded-sch-control border border-line-strong bg-surface px-2.5 text-[13px] md:h-9"
    >
      {all.map((t) => (
        <option key={t} value={t}>
          {t === "24:00" ? "24:00" : t}
        </option>
      ))}
    </select>
  );
}
