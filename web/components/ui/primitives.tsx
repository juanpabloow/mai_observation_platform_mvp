import type { ReactNode } from "react";

/**
 * SHARED visual primitives for the operative surfaces (Contacts list, Contact
 * record, Inbox). They exist so the redesign is a DESIGN SYSTEM rather than
 * per-page classes: every surface composes the same Panel / Chip / StatTile /
 * Th / Td / Meta, so light and dark keep exactly the same structure, spacing and
 * hierarchy (the tokens in globals.css flip, the markup does not).
 *
 * House rules encoded here: 1px hairlines, small radius, no gradients, no
 * glassmorphism, no shadows (elevation comes from surface contrast), Geist Mono
 * for timestamps / ids / metadata / table headings, and metadata in gray.
 */

/** A raised surface: 1px hairline, small radius, no shadow. */
export function Panel({
  children,
  className = "",
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "aside";
}) {
  return <As className={`rounded-lg border border-line bg-surface ${className}`}>{children}</As>;
}

/** Panel header strip — compact title on the left, actions on the right. */
export function PanelHeader({
  title,
  actions,
  className = "",
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-h-10 items-center justify-between gap-2 border-b border-line px-3 py-2 ${className}`}>
      <h2 className="u-th">{title}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export type Tone = "neutral" | "brand" | "warn" | "danger" | "success" | "muted";

const CHIP_TONE: Record<Tone, string> = {
  neutral: "border-line-strong bg-chip text-foreground",
  brand: "border-brand/35 bg-brand-soft text-brand",
  warn: "border-warn/35 bg-warn-soft text-warn",
  /** Solid brand fill + white text — for the one marker that must not be missed. */
  danger: "border-transparent bg-brand text-white",
  success: "border-success/35 bg-success/10 text-success",
  /** Outline only — e.g. the derived "customer" marker beside a name. */
  muted: "border-line-strong bg-transparent text-muted",
};

/** A small labelled chip. Never color-only: it always carries its own text. */
export function Chip({
  children,
  tone = "neutral",
  mono = false,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full border px-2 py-[0.1rem] text-[0.6875rem] font-medium leading-4 ${
        mono ? "u-mono" : ""
      } ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Stage pill for a contact (`new` | `active` | `customer` | `archived`), mono +
 * uppercase like the reference. `active` is the INVERSE chip (near-black on light,
 * off-white on dark) so the engaged rows pop out of a dense table without spending
 * the brand red — which the system reserves for selection and urgency.
 */
export function StageChip({ stage }: { stage: string }) {
  //   active   → SOLID near-black pill (the engaged rows pop out of a dense table
  //              without spending the brand red, which means urgency here);
  //   others   → OUTLINE pill on the neutral chip fill.
  const cls =
    stage === "active"
      ? "border-transparent bg-foreground text-background"
      : stage === "archived"
        ? "border-line bg-transparent text-faint"
        : "border-line-strong bg-chip text-muted";
  return (
    <span
      className={`u-mono inline-flex items-center rounded-full border px-2 py-[0.1rem] text-[0.625rem] font-medium uppercase leading-4 tracking-wider ${cls}`}
    >
      {stage}
    </span>
  );
}

/**
 * One compact metric in the summary strip: a mono uppercase label over a large
 * tabular value. `tone` tints only the VALUE (never the whole tile) so the strip
 * stays calm and the exceptional numbers read first.
 */
export function StatTile({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  const valueTone =
    tone === "warn" ? "text-warn" : tone === "brand" ? "text-brand" : tone === "success" ? "text-success" : "text-foreground";
  return (
    <div title={title} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      <span className="u-th truncate">{label}</span>
      <span className={`u-mono text-lg font-medium leading-tight ${valueTone}`}>{value}</span>
    </div>
  );
}

/** Metadata text — gray, mono, tabular. For ids, counts and timestamps. */
export function Meta({ children, className = "", title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={`u-mono text-[0.6875rem] text-faint ${className}`}>
      {children}
    </span>
  );
}

/** Table heading cell — mono, uppercase, tracked out. */
export function Th({
  children,
  className = "",
  align = "left",
}: {
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <th scope="col" className={`u-th px-3 py-2 ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      {children}
    </th>
  );
}

/** Table body cell. */
export function Td({
  children,
  className = "",
  align = "left",
}: {
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  return (
    <td className={`px-3 py-1.5 align-middle ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      {children}
    </td>
  );
}

/** Neutral, 40px-tall control surface shared by buttons/selects in the toolbars. */
export const CONTROL_CLS =
  "inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50";

/** Empty state — a single calm sentence inside a dashed hairline. */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line-strong px-5 py-10 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-faint">{hint}</p> : null}
    </div>
  );
}

/** Inline error surface (kept red, distinct from the amber "needs attention"). */
export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-danger/35 bg-danger/8 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
