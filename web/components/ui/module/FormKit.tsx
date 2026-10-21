"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * FORM PIECES for the module editors, on top of components/ui/controls (Field, INPUT,
 * TEXTAREA, CheckRow keep their meaning). Labels are always visible; help and errors
 * sit right under the control they belong to; every target is 44px below lg.
 */

/** A group of controls under one visible legend (radio chips, checkbox lists). */
export function FieldGroup({
  legend,
  hint,
  error,
  optional,
  children,
}: {
  legend: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-[0.8125rem] font-medium text-foreground">
        {legend}
        {optional ? <span className="font-normal text-muted"> (opcional)</span> : null}
      </legend>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </fieldset>
  );
}

/** Single choice drawn as chips — native radios underneath, so arrow keys and screen
 *  readers behave as a radio group. */
export function ChoiceChips<T extends string>({
  name,
  value,
  options,
  onChange,
  idPrefix,
}: {
  name: string;
  value: T;
  options: readonly { value: T; label: string; dot?: string }[];
  onChange: (v: T) => void;
  /** id of the FIRST radio is `${idPrefix}` (error summary target). */
  idPrefix?: string;
}) {
  const auto = useId();
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o, i) => {
        const id = i === 0 && idPrefix ? idPrefix : `${auto}-${i}`;
        const on = o.value === value;
        return (
          <label key={o.value || "none"} htmlFor={id} className="u-focus relative inline-flex cursor-pointer rounded-sch-control">
            <input id={id} type="radio" name={name} checked={on} onChange={() => onChange(o.value)} className="peer sr-only" />
            <span
              className={`inline-flex h-[44px] items-center gap-2 rounded-sch-control border px-3 text-[0.8125rem] font-medium transition-colors lg:h-[2.125rem] ${
                on ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface text-foreground hover:bg-subtle"
              }`}
            >
              {o.dot ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${o.dot}`} /> : null}
              {o.label}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** The on/off track (a native checkbox with role="switch"), shared by every switch. */
export const SWITCH =
  "u-focus peer relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full bg-line-strong transition-colors before:absolute before:left-0.5 before:top-0.5 before:size-5 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-ink checked:before:translate-x-4 checked:before:bg-ink-fg disabled:cursor-not-allowed motion-reduce:before:transition-none";

/** A setting that is on or off, with its consequence in words. */
export function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label htmlFor={inputId} className={`flex min-h-[56px] items-center gap-3 rounded-sch-card border border-line px-3.5 py-2.5 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-subtle/60"}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-[0.875rem] font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted">{hint}</span> : null}
      </span>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className={SWITCH}
      />
    </label>
  );
}

/** An input with a fixed prefix / suffix ("$ … COP", "… min"). */
export function AffixInput({
  prefix,
  suffix,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { prefix?: string; suffix?: string }) {
  return (
    <span
      className={`u-focus flex h-[44px] min-w-0 items-center gap-2 rounded-sch-control border border-line-strong bg-surface px-3 has-[[aria-invalid=true]]:border-danger lg:h-[2.5rem] ${className}`}
    >
      {prefix ? <span className="shrink-0 text-sm text-muted">{prefix}</span> : null}
      <input {...rest} className="tabular-nums min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-faint lg:text-sm" />
      {suffix ? <span className="shrink-0 text-[0.7812rem] text-muted">{suffix}</span> : null}
    </span>
  );
}

/** A bordered list of checkboxes (professionals, sites, services included…). */
export function CheckList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col divide-y divide-line-soft rounded-sch-card border border-line">{children}</div>;
}

export function CheckItem({
  checked,
  onChange,
  children,
  hint,
  leading,
  id,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  hint?: ReactNode;
  leading?: ReactNode;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex min-h-[48px] items-center gap-3 px-3.5 py-2 text-sm ${disabled ? "opacity-60" : "cursor-pointer hover:bg-subtle/60"}`}>
      <input id={id} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="u-focus size-4 shrink-0 accent-[var(--ink)]" />
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block text-foreground">{children}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** An inline note inside a form: info (neutral) or warn (a consequence to read). */
export function Notice({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <p
      role={tone === "warn" ? "status" : undefined}
      className={`rounded-sch-control px-3.5 py-2.5 text-[0.8125rem] leading-relaxed ${tone === "warn" ? "bg-warn-soft text-warn" : "bg-subtle text-muted"}`}
    >
      {children}
    </p>
  );
}
