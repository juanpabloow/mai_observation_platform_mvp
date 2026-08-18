"use client";

import type { ReactNode } from "react";
import { avatarColor } from "@/lib/avatarColor";
import { initialsFor } from "@/lib/contactForm";
import { PanelSection } from "@/components/ui/primitives";

/**
 * The contact form's own control vocabulary — the pieces the reference uses that the
 * shared `primitives.tsx` does not have: a section card with a rule, a segmented
 * control, a switch, selectable chips, and the owner disc row.
 *
 * They live HERE rather than in ui/primitives.tsx because primitives.tsx is the
 * READING vocabulary (Panel, Chip, StageChip, Th/Td, Meta) shared by the list, the
 * record and the inbox — every one of those is display-only. These are EDITING
 * controls with pressed/checked state and keyboard semantics, and mixing the two sets
 * would mean the list pulls a "use client" module it never renders. Both draw from the
 * same tokens, so they still look like one system.
 */

/**
 * One section of the contact form. A thin alias over the shared PanelSection so the
 * form, the quick view, the record's rail and the staff panel all draw the same box —
 * the vertical rhythm BETWEEN fields is the only thing the form adds of its own.
 */
export function FormSection({
  title,
  icon,
  trailing,
  children,
}: {
  title: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PanelSection title={title} icon={icon} trailing={trailing}>
      <div className="flex flex-col gap-3.5">{children}</div>
    </PanelSection>
  );
}

/**
 * The section heading, re-exported from the neutral primitives where it now lives —
 * it is the vocabulary of every detail panel in the app, not of this form. Kept as a
 * named export here so the contact surfaces that already import it from this module
 * keep working, and so there is still exactly ONE definition.
 */
export { SectionHeading } from "@/components/ui/primitives";

/** A labelled field. `hint` is the right-aligned "opcional" marker from the reference. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
          {label}
        </label>
        {hint ? <span className="text-[11px] text-faintest">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

export const INPUT_CLS =
  "u-focus w-full rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm text-foreground transition-colors placeholder:text-faintest";

/** Text input with an optional leading glyph, matching the reference's boxed fields. */
export function TextInput({
  value,
  onChange,
  placeholder,
  leading,
  id,
  mono = false,
  inputMode,
  ariaLabel,
  ariaDescribedBy,
  invalid = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  leading?: ReactNode;
  id?: string;
  mono?: boolean;
  inputMode?: "text" | "tel" | "email";
  ariaLabel?: string;
  ariaDescribedBy?: string;
  invalid?: boolean;
}) {
  return (
    <div
      // ONE focus treatment, app-wide: `u-focus` tints the border and adds the soft halo
      // (see globals.css). This used to be a THIRD vocabulary — a near-black border plus a
      // `ring-1` — which meant the same act of clicking into a field looked one way in the
      // contact form, another in the roster and a third on a button. An INVALID field
      // keeps its own red edge, because that is a state and not a focus.
      className={`u-focus flex items-center gap-2 rounded-lg border bg-surface px-2.5 transition-colors ${
        invalid ? "border-danger" : "border-line-strong"
      }`}
    >
      {leading ? (
        <span aria-hidden className="shrink-0 text-faint">
          {leading}
        </span>
      ) : null}
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        className={`w-full bg-transparent py-2 text-sm text-foreground outline-none placeholder:text-faintest ${mono ? "u-mono" : ""}`}
      />
    </div>
  );
}

/**
 * Segmented control — one choice out of a few, all visible. Rendered as a real radio
 * group so arrow keys move between options and a screen reader announces "2 of 3";
 * a row of buttons would look identical and be none of those things.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  name: string;
  value: T | null;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="flex rounded-lg bg-chip p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <label
            key={o.value}
            // px-1.5 + 13px: at the panel's width four options share ~356px, and at px-2/14px
            // "WhatsApp" was the one label that truncated.
            className={`relative flex min-w-0 flex-1 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-1.5 py-1.5 text-[0.8125rem] transition-colors ${
              active
                ? "border border-line-strong bg-surface font-medium text-foreground"
                : "border border-transparent text-muted hover:text-foreground"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={active}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span className="truncate">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** A switch. Separate from a checkbox on purpose: the reference uses this ONLY for
 *  "No contactar", whose effect is immediate and system-wide, and the different control
 *  is what stops it reading as one more opt-in box. */
export function Switch({
  checked,
  onChange,
  label,
  note,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  note?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">{label}</span>
        {note ? <span className="text-[11px] leading-4 text-faint">{note}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-brand" : "bg-line-strong"}`}
      >
        <span
          aria-hidden
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${checked ? "left-[18px]" : "left-0.5"}`}
        />
      </button>
    </div>
  );
}

/** Checkbox in a bordered row — the reference's consent / welcome / "create another"
 *  controls. `disabled` carries a tooltip via `title` (the welcome toggle needs one). */
export function CheckRow({
  checked,
  onChange,
  label,
  note,
  disabled = false,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  note?: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label
      title={title}
      className={`flex items-start gap-2.5 rounded-lg border border-line bg-card px-3 py-2.5 ${
        disabled ? "cursor-not-allowed opacity-55" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--brand)] disabled:cursor-not-allowed"
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-foreground">{label}</span>
        {note ? <span className="text-[11px] leading-4 text-faint">{note}</span> : null}
      </span>
    </label>
  );
}

/**
 * Selectable value chips — the shape the reference gives every client-configured field.
 * `multi` decides checkbox vs radio semantics; the visual is identical, which is fine
 * because the LABEL above the group says which it is and the pressed state is per-chip.
 */
export function ChipSelect({
  values,
  selected,
  onToggle,
  multi,
  ariaLabel,
}: {
  values: string[];
  selected: string[];
  onToggle: (value: string) => void;
  multi: boolean;
  ariaLabel: string;
}) {
  return (
    <div role={multi ? "group" : "radiogroup"} aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {values.map((v) => {
        const on = selected.includes(v);
        return (
          <button
            key={v}
            type="button"
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            onClick={() => onToggle(v)}
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[0.8125rem] transition-colors ${
              on
                ? "bg-foreground font-medium text-background"
                : "border border-line bg-chip text-muted hover:text-foreground"
            }`}
          >
            {on ? (
              <span aria-hidden className="text-[0.6875rem]">
                ✓
              </span>
            ) : null}
            {v}
          </button>
        );
      })}
    </div>
  );
}

/** The contact disc, on the SAME deterministic palette the list, inbox and thread use,
 *  so a person keeps one colour everywhere. */
export function Avatar({
  name,
  fallback,
  size = 28,
}: {
  name: string | null;
  fallback: string;
  size?: number;
}) {
  const seed = name?.trim() ? name : fallback;
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`u-mono flex shrink-0 items-center justify-center rounded-full font-semibold ${avatarColor(seed)}`}
    >
      {initialsFor(name, fallback)}
    </span>
  );
}

export interface OwnerOption {
  userId: string;
  label: string;
}

/**
 * Owner picker — discs with the name beneath, plus a dashed "Cualquiera" for no owner.
 * A radio group again, for the same keyboard reason as Segmented.
 *
 * The reference shows four people. A real tenant can have many more, so past `maxDiscs`
 * the overflow goes into a plain <select>: a row of thirty discs is a worse control than
 * a list, and silently truncating would hide assignable teammates.
 */
export function OwnerPicker({
  options,
  value,
  onChange,
  maxDiscs = 5,
}: {
  options: OwnerOption[];
  value: string | null;
  onChange: (v: string | null) => void;
  maxDiscs?: number;
}) {
  const discs = options.slice(0, maxDiscs);
  const overflow = options.slice(maxDiscs);
  const selectedInOverflow = overflow.find((o) => o.userId === value) ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Dueño del contacto" className="flex flex-wrap items-start gap-3">
        {discs.map((o) => {
          const active = o.userId === value;
          return (
            <label key={o.userId} className="flex w-14 cursor-pointer flex-col items-center gap-1">
              <input
                type="radio"
                name="contact-owner"
                checked={active}
                onChange={() => onChange(o.userId)}
                className="sr-only"
              />
              <span
                className={`rounded-full transition-shadow ${
                  active ? "ring-2 ring-foreground ring-offset-2 ring-offset-[var(--surface)]" : ""
                }`}
              >
                <Avatar name={o.label} fallback={o.userId} size={36} />
              </span>
              <span
                className={`w-full truncate text-center text-[11px] ${active ? "font-medium text-foreground" : "text-faint"}`}
                title={o.label}
              >
                {o.label}
              </span>
            </label>
          );
        })}

        <label className="flex w-14 cursor-pointer flex-col items-center gap-1">
          <input
            type="radio"
            name="contact-owner"
            checked={value === null}
            onChange={() => onChange(null)}
            className="sr-only"
          />
          <span
            className={`flex size-9 items-center justify-center rounded-full border border-dashed text-faint transition-colors ${
              value === null ? "border-foreground text-foreground" : "border-line-strong"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
            </svg>
          </span>
          <span className={`w-full truncate text-center text-[11px] ${value === null ? "font-medium text-foreground" : "text-faint"}`}>
            Cualquiera
          </span>
        </label>
      </div>

      {overflow.length > 0 ? (
        <select
          value={selectedInOverflow?.userId ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          aria-label={`Otros miembros del equipo (${overflow.length})`}
          className={INPUT_CLS}
        >
          <option value="">Otro miembro del equipo… ({overflow.length})</option>
          {overflow.map((o) => (
            <option key={o.userId} value={o.userId}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

/** Free tag chips with a remove ✕ and a "type to add" input — created on the fly, so
 *  the value here is a NAME, never a catalogue id. */
export function TagChips({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-chip px-2 py-0.5 text-xs text-foreground"
        >
          {t}
          <button
            type="button"
            onClick={() => onRemove(t)}
            aria-label={`Quitar etiqueta ${t}`}
            className="text-faint transition-colors hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
      <input
        placeholder="+ Etiqueta"
        aria-label="Agregar etiqueta"
        onKeyDown={(e) => {
          const el = e.currentTarget;
          // Enter commits; Backspace on an empty box removes the last chip — the
          // interaction people already expect from every tag field.
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            const v = el.value.trim();
            if (v) {
              onAdd(v);
              el.value = "";
            }
          } else if (e.key === "Backspace" && el.value === "" && tags.length > 0) {
            onRemove(tags[tags.length - 1]);
          }
        }}
        onBlur={(e) => {
          const v = e.currentTarget.value.trim();
          if (v) {
            onAdd(v);
            e.currentTarget.value = "";
          }
        }}
        className="u-focus min-w-20 flex-1 rounded-md border border-dashed border-line-strong bg-transparent px-2 py-1 text-sm text-foreground placeholder:text-faint focus:border-solid"
      />
    </div>
  );
}

/** The reference's centred "Todo lo de abajo es opcional" rule. */
export function OptionalDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-1">
      <span aria-hidden className="h-px flex-1 bg-line" />
      <span className="whitespace-nowrap text-[11px] text-faintest">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-line" />
    </div>
  );
}

// ── Section icons (inline, 14px, currentColor) ────────────────────────────────
/** The icon set moved to the neutral ui/icons — see the note there. Re-exported so the
 *  contact surfaces that import their glyphs from this module keep working. */
export {
  IconIdentity,
  IconAssign,
  IconComms,
  IconInternal,
  IconBusiness,
  IconPhone,
  IconCalendar,
  IconTask,
  IconPencil,
  IconMail,
} from "@/components/ui/icons";
