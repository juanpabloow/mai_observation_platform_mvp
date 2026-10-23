"use client";

import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type RefObject } from "react";

/**
 * SHARED CONTROLS — buttons, fields, segmented controls, the modal layer and the
 * confirmation. Born as the Scheduling design system (components/scheduling/ui/system.tsx,
 * which re-exports everything here unchanged); promoted so CRM builds from the SAME
 * vocabulary instead of a parallel one. Moving a class string here changes every module
 * that uses it — that is the point, and the reason to change them deliberately.
 *
 * Shapes follow the KIND of component (tokens in globals.css):
 *
 *   control  12px  buttons, inputs, selects, segmented controls, menu items' frame
 *   card     16px  sections, service cards, popovers, menus
 *   modal    24px  dialogs on desktop (full-bleed sheets on a phone)
 *   pill           state chips, counters
 *   circle         avatars
 *
 * Sizes: one control height — 44px on touch widths, 40px from `lg` — so every target
 * on a phone is at least 44px, and a desktop row of controls lines up. `sm` is for
 * dense desktop rows only and is still 44px below `lg`. Heights are PX, not rem steps:
 * the root font-size is a user preference (90% compact), and a rem-based h-11 would
 * shrink a 44px touch target to 39.6px.
 *
 * Variants: primary = ink (black in light, inverted in dark — the --ink token), the ONE
 * main action of a surface; secondary = neutral surface + hairline; tertiary = quiet
 * text for minor actions; destructive = red, ONLY for actions that destroy or cancel.
 */

export const RADIUS = {
  control: "rounded-sch-control",
  card: "rounded-sch-card",
  modal: "rounded-sch-modal",
} as const;

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "destructive";
export type ButtonSize = "md" | "sm";

// `u-btn u-btn-<variant>` and `u-field` are inert hooks: they carry no style of their own,
// so a module can scope a reference's sizes to itself (Agenda's panels, `.u-ag` in
// globals.css) without changing this component anywhere else.
const BUTTON_BASE =
  "u-btn u-focus inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sch-control text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";

const BUTTON_SIZE: Record<ButtonSize, string> = {
  md: "h-[44px] px-4 lg:h-[40px]",
  sm: "h-[44px] px-3.5 lg:h-[36px] lg:text-[13px]",
};

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink font-semibold text-ink-fg hover:bg-ink-hover",
  secondary: "border border-line-strong bg-surface text-foreground hover:bg-subtle aria-pressed:border-foreground aria-pressed:bg-subtle",
  tertiary: "text-muted hover:bg-subtle hover:text-foreground aria-pressed:bg-subtle aria-pressed:text-foreground",
  destructive: "bg-sch-destructive font-semibold text-white hover:bg-sch-destructive-hover",
};

/** The class string, for the few places that must style a non-button (a Link). */
export function buttonClass({
  variant = "secondary",
  size = "md",
  block = false,
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}): string {
  return `${BUTTON_BASE} u-btn-${variant} ${BUTTON_SIZE[size]} ${BUTTON_VARIANT[variant]} ${block ? "w-full" : ""} ${className}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  block = false,
  loading = false,
  loadingLabel,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  /** Disables the button, marks it aria-busy and shows a spinner + `loadingLabel`. */
  loading?: boolean;
  loadingLabel?: string;
}) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, block, className })}
    >
      {loading ? <Spinner /> : null}
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

export function Spinner() {
  return <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />;
}

/** A square icon-only control. The label is its accessible name AND its tooltip. */
export function IconButton({
  label,
  onClick,
  variant = "tertiary",
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  variant?: "tertiary" | "secondary";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`u-focus inline-flex size-[44px] shrink-0 items-center justify-center rounded-sch-control transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:size-[36px] ${BUTTON_VARIANT[variant]}`}
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        {children}
      </svg>
    </button>
  );
}

/** Text inputs, selects and textareas share one frame. */
export const FIELD =
  "u-field u-focus w-full rounded-sch-control border border-line-strong bg-surface px-3 text-sm text-foreground outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger";
export const INPUT = `${FIELD} h-[44px] lg:h-[40px]`;
export const TEXTAREA = `${FIELD} py-2.5 leading-relaxed`;

/** A labelled field: label, control, then either the error or the hint. The wrapper IS
 *  the <label>, so the control is associated without ids. */
export function Field({
  label,
  hint,
  error,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-medium text-foreground">
        {label}
        {optional ? <span className="font-normal text-muted"> (opcional)</span> : null}
      </span>
      {children}
      {error ? (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

/** A checkbox row: 44px tall, the whole row is the target. */
export function CheckRow({ checked, onChange, children, hint }: { checked: boolean; onChange: () => void; children: ReactNode; hint?: string }) {
  return (
    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-sch-control px-2 text-sm transition-colors hover:bg-subtle">
      <input type="checkbox" checked={checked} onChange={onChange} className="u-focus size-4 shrink-0 accent-[var(--ink)]" />
      <span className="min-w-0 py-2">
        {children}
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** An inline error / notice strip at the top of a form or panel. */
export function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-sch-control bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      {children}
    </p>
  );
}

/** A section card. */
export const CARD = "rounded-sch-card border border-line bg-surface";

/** Floating surfaces (menus, popovers): a card that sits above the page. */
export const POPOVER = "rounded-sch-card border border-line bg-popover text-popover-foreground shadow-[var(--shadow-float)]";

/**
 * A SEGMENTED control — Día/Semana, Equipo/Horas. A recessed chip track (control radius)
 * holding segments whose radius is concentric with it (track radius − its 4px padding).
 * The selected segment is ink, so it reads the same as the primary action.
 */
export function segmentShell(size: ButtonSize = "md"): string {
  return `inline-flex shrink-0 items-center gap-0.5 rounded-sch-control border border-line bg-chip p-1 ${size === "sm" ? "h-[44px] lg:h-[36px]" : "h-[44px] lg:h-[40px]"}`;
}
export function segmentClass(active: boolean): string {
  return `u-focus flex h-full items-center rounded-[calc(var(--sch-radius-control)-4px)] px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    active ? "bg-ink text-ink-fg" : "text-muted hover:text-foreground"
  }`;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: ButtonSize;
}) {
  return (
    <div role="group" aria-label={label} className={segmentShell(size)}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={segmentClass(value === o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A MODAL LAYER inside an already-trapped surface (a confirmation over the appointment
 * panel, "¿Descartar los cambios?" over the service editor). While `open`:
 *   - spread `inert` onto everything behind it — the shared focus trap skips inert
 *     controls, so Tab / Shift+Tab cycle only the layer, and nothing behind it (Guardar,
 *     "Cambiar hora") can be clicked or reached;
 *   - focus moves to the layer's `[data-autofocus]` control (a confirmation marks its
 *     SAFE choice, so Enter never destroys by default and a phone does not pop the
 *     keyboard for an optional reason), else to its first control;
 *   - on close focus returns to whatever had it when the layer opened (the button that
 *     opened it), or to `fallback` if that element is gone.
 * Escape is the surrounding trap's job: it already peels the layer before closing.
 */
export function useModalLayer(open: boolean, fallback?: RefObject<HTMLElement | null>) {
  const layerRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const layer = layerRef.current;
      (layer?.querySelector<HTMLElement>("[data-autofocus]") ?? layer?.querySelector<HTMLElement>("textarea, input, select, button"))?.focus({ preventScroll: true });
      return;
    }
    const back = returnTo.current;
    returnTo.current = null;
    if (back) (back.isConnected ? back : fallback?.current)?.focus({ preventScroll: true });
  }, [open, fallback]);
  return { layerRef, inert: open };
}

/**
 * The confirmation every destructive or lossy step asks for — one look across
 * Scheduling. It renders in place (over its surface, `absolute inset-0`) and takes the
 * `layerRef` from useModalLayer.
 */
export function ConfirmDialog({
  layerRef,
  id,
  title,
  body,
  cancelLabel = "Volver",
  confirmLabel,
  tone = "destructive",
  pending = false,
  onCancel,
  onConfirm,
  children,
}: {
  layerRef: RefObject<HTMLDivElement | null>;
  id: string;
  title: string;
  body: ReactNode;
  cancelLabel?: string;
  confirmLabel: string;
  tone?: "destructive" | "primary";
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/30 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4">
      <div
        ref={layerRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        className={`w-full max-w-sm ${RADIUS.card} border border-line bg-popover p-5 text-popover-foreground shadow-[0_16px_40px_rgba(18,21,27,0.2)] sm:rounded-sch-modal sm:p-6`}
      >
        <h3 id={`${id}-title`} className="text-base font-semibold tracking-tight">
          {title}
        </h3>
        <div id={`${id}-body`} className="mt-1.5 text-sm leading-relaxed text-muted">
          {body}
        </div>
        {children ? <div className="mt-4">{children}</div> : null}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onCancel} disabled={pending} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={pending} loadingLabel="Guardando…">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
