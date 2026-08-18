import type { ReactNode } from "react";
import { stageLabel } from "@/lib/contactLabels";

/**
 * SHARED visual primitives for the operative surfaces (Contacts list, Contact
 * record, Inbox). They exist so the redesign is a DESIGN SYSTEM rather than
 * per-page classes: every surface composes the same Panel / Chip / StatTile /
 * Th / Td / Meta, so light and dark keep exactly the same structure, spacing and
 * hierarchy (the tokens in globals.css flip, the markup does not).
 *
 * House rules encoded here: 1px hairlines, small radius, no gradients, no
 * glassmorphism, Geist Mono for timestamps / ids / metadata / table headings, and
 * metadata in gray.
 *
 * ELEVATION. The rule used to be "no shadows at all — elevation comes from surface
 * contrast". It is now "one shadow, from one token": floating CARDS (PageShell, the
 * contact panel) carry --shadow-card, a 1px / 4% lift that separates them from the
 * canvas. Everything else — chips, inputs, rows, inset blocks — still has none. What
 * the old rule was really protecting was against per-screen shadow values, and the
 * token is what protects that now.
 */

/** An inset surface: 1px hairline, small radius, NO shadow — the lift is reserved
 *  for the page-level cards (see the elevation note above). */
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
 *
 * It prints the HUMAN label, never the stored value: `new` is storage, "Nuevo" is what
 * a person reads. Because every surface renders stage through this one chip, they
 * cannot disagree — which is the point.
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
      {stageLabel(stage)}
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

/**
 * ONE counter in a page's TITLE BAND — a coloured dot, a tabular number, a lowercase
 * noun. Not to be confused with StatTile above: a tile is a block in a metrics strip,
 * this is an inline bit that sits on the title line beside the screen's name.
 *
 * It lives here because it is the title band's vocabulary, not one screen's: Contacts
 * says "12 nuevos · 4 clientes" and the roster says "3 con cliente · 2 disponibles" in
 * the SAME shape. The roster used to print its own smaller, dimmer version of this in
 * the filter row, which is exactly the kind of near-copy that makes two screens in one
 * product look like two products.
 *
 * The dot is DECORATION carrying a hint, never the meaning — every counter still says
 * its own name, so the strip survives greyscale. `urgent` promotes the bit to brand
 * ONLY when the number is non-zero: "0 tareas vencidas" must never shout.
 */
export function SummaryBit({
  label,
  value,
  tone = "muted",
  urgent = false,
  title,
}: {
  label: string;
  value: number;
  /** `busy` is the roster's "with a client" purple, the same hue the agenda books in. */
  tone?: "muted" | "info" | "success" | "brand" | "busy";
  urgent?: boolean;
  title?: string;
}) {
  const hot = urgent && value > 0;
  const dot =
    hot || tone === "brand"
      ? "bg-brand"
      : tone === "success"
        ? "bg-success"
        : tone === "info"
          ? "bg-accent"
          : tone === "busy"
            ? "bg-service-purple"
            : "bg-line-strong";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-sm ${hot ? "font-medium text-brand" : "text-muted"}`}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="u-mono">{value}</span> {label}
    </span>
  );
}

/**
 * THE section heading inside a panel — an icon, a mono uppercase label, a hairline
 * running to the edge, and an optional right-aligned count.
 *
 * NOT a bordered card's title. A card per section puts a second border inside a panel
 * that already has one and breaks the column into floating slabs; every panel in this
 * app separates its sections with a single hairline on the panel's own surface, which
 * reads as one continuous document.
 *
 * It lives in the neutral primitives, not beside the contact form it was written for,
 * because it is the vocabulary of ANY detail panel: the contact quick view, the record's
 * right rail, the contact drawer and the staff roster's panel all draw this heading.
 * Sharing the component rather than re-typing its classes is what stops those surfaces
 * from drifting into four slightly different greys.
 */
export function SectionHeading({
  title,
  icon,
  trailing,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {icon ? (
        <span aria-hidden className="shrink-0 text-faint">
          {icon}
        </span>
      ) : null}
      <h3 className="u-th shrink-0">{title}</h3>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-line" />
      {trailing ? <span className="shrink-0 text-[0.625rem] text-faint">{trailing}</span> : null}
    </div>
  );
}

/**
 * A panel section: the shared heading, then the content, closed by a full-width rule.
 * `last:border-b-0` keeps the final section from drawing a rule against the panel's own
 * edge. The padding is the panel body's, which is why the body itself adds none.
 */
export function PanelSection({
  title,
  icon,
  trailing,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-b border-line px-4 py-4 last:border-b-0 ${className}`}>
      <SectionHeading title={title} icon={icon} trailing={trailing} className="mb-3" />
      {children}
    </section>
  );
}

/**
 * A row of metrics as ONE box divided by hairlines — never as separate floating tiles.
 *
 * Three or four numbers side by side are ONE reading ("how much, how recently, by which
 * channel"), and a grid of individually bordered cards reads as three unrelated facts
 * while spending three borders to do it. `cols` is 2 for a 2×2 (four metrics at 440px
 * cannot fit one row) and unset for a single divided row.
 */
export function MetricBox({ children, cols }: { children: ReactNode; cols?: 2 }) {
  return cols === 2 ? (
    <div className="grid grid-cols-2 divide-x divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
      {children}
    </div>
  ) : (
    <div className="flex items-stretch divide-x divide-line overflow-hidden rounded-lg border border-line bg-card">
      {children}
    </div>
  );
}

/** One cell of a MetricBox: mono caps label over the value, with an optional note. */
export function MetricCell({
  label,
  value,
  note,
  dot = false,
  tone,
}: {
  label: string;
  value: ReactNode;
  /** The quiet qualifier beside the value ("of 76 h", "84%"). */
  note?: string;
  /** For a value that is a live STATE (a channel, a presence) — a count is not a state. */
  dot?: boolean;
  tone?: "brand";
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-1.5">
      <span className="u-th truncate">{label}</span>
      <span className="flex min-w-0 items-baseline gap-1.5">
        {dot ? <span aria-hidden className="size-1.5 shrink-0 self-center rounded-full bg-success" /> : null}
        <span className={`truncate text-sm font-medium ${tone === "brand" ? "text-brand" : "text-foreground"}`}>
          {value}
        </span>
        {note ? <span className="u-mono shrink-0 text-[11px] text-faint">{note}</span> : null}
      </span>
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
  "inline-flex h-[var(--control-h)] items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50";

/**
 * THE toolbar's search field — the shell, not the input. A soft `--chip` fill with no
 * visible border until focus, which is what makes it read as a place to type rather than
 * as one more button in the row.
 *
 * `rounded-lg`, the same radius as the facets and the primary beside it. Not `rounded-full`:
 * a 38px control taken to a full pill reads as a tag, and next to the 12px cards it sits
 * inside it looks like it came from a different kit.
 *
 * Shared because the control band is the same object on every list screen: Contacts and
 * the staff roster used to draw two search boxes with two radii and two heights (one
 * `rounded-lg` at `--control-h`, one `rounded-md` at a hard-coded 36px), which is visible
 * the moment the two screens sit one click apart.
 */
export const SEARCH_SHELL_CLS =
  "u-focus flex h-[var(--control-h)] items-center gap-2 rounded-lg border border-transparent bg-chip px-3 transition-colors focus-within:bg-surface";

/** The screen's PRIMARY action in the control band — solid brand, control height, and the
 *  SAME radius as the search and the facets it shares the row with. */
export const TOOLBAR_PRIMARY_CLS =
  "inline-flex h-[var(--control-h)] shrink-0 items-center whitespace-nowrap rounded-lg bg-brand px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

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
