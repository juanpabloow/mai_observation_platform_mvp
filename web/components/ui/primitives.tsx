import type { ReactNode } from "react";
import Link from "next/link";
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

/**
 * A CARD surface: 1px hairline, THE card radius, NO shadow of its own.
 *
 * `rounded-xl` — the same 14px every other card on a screen uses (see the radius scale in
 * globals.css). It was `rounded-lg` (11px), one step tighter, on the theory that this is an
 * INSET surface nested inside a page card; on the record page these sit directly on the
 * canvas as page-level cards themselves, and two radii a few pixels apart in one column
 * reads as a mistake rather than as a hierarchy.
 *
 * The lift still comes from the caller: a card ON the canvas wants --shadow-card, a panel
 * nested inside one wants nothing.
 */
export function Panel({
  children,
  className = "",
  as: As = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "aside";
}) {
  return <As className={`rounded-xl border border-line bg-surface ${className}`}>{children}</As>;
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
 * THE section heading inside a panel — an optional icon, the label, a hairline running to
 * the edge, and an optional right-aligned count or affordance.
 *
 * SENTENCE-CASE SANS at 590, not the mono uppercase it used to be. The redesign
 * (docs/ui-redesign-crm-inbox.md §2.5 / §3.5) moves every panel heading and every table
 * head to this one voice, and the reason is legibility at density: `PRÓXIMA CITA` tracked
 * out to 0.08em is 40% wider than "Próxima cita" and competes with the content under it
 * for the same 340px. Mono uppercase is now reserved for what it is actually good at —
 * ids, timestamps, counts, and the structured labels inside a message payload.
 *
 * Changed HERE rather than per panel on purpose: this component is the vocabulary of
 * every detail surface in the app (the contact quick view, the record's rail, the staff
 * roster's panel, the inbox's client panel), so one edit moves them together. A
 * per-screen version of the new voice is how three of those four end up converted and
 * the fourth stays mono for a year.
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
      <h3 className="shrink-0 text-[0.6875rem] font-semibold text-muted">{title}</h3>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-line-soft" />
      {trailing ? <span className="shrink-0 text-[0.71875rem] text-muted">{trailing}</span> : null}
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
 * THE search field — the shell, not the input. A soft `--chip` fill whose border only
 * appears on hover or focus, which is what makes it read as a place to TYPE rather than as
 * one more button in the row.
 *
 * The border is 1.5px and TRANSPARENT at rest (the design's treatment — §2.1/§3.1), not
 * absent: a border that appears from nothing on hover shifts the control by 1.5px and the
 * whole row twitches. Declaring it transparent reserves the space.
 *
 * `rounded-lg`, the same radius as the facets and the primary beside it. Not
 * `rounded-full`: a 38px control taken to a full pill reads as a tag.
 *
 * Shared because the control band is the same object on every list screen: Contacts and
 * the staff roster used to draw two search boxes with two radii and two heights (one
 * `rounded-lg` at `--control-h`, one `rounded-md` at a hard-coded 36px), which is visible
 * the moment the two screens sit one click apart.
 */
export const SEARCH_SHELL_CLS =
  "u-focus flex h-[var(--control-h)] items-center gap-2 rounded-lg border-[1.5px] border-transparent bg-chip px-3 transition-colors hover:border-line-strong focus-within:border-line-strong";

/**
 * The screen's PRIMARY action in the control band — control height, and the SAME radius
 * as the search and the facets it shares the row with.
 *
 * INK, not brand red. See the note on --ink in globals.css: the redesign spends red on
 * the active nav item, `Agendar cita`, and the "a human is handling this" marker, and
 * nothing else. This button was the loudest red on every list screen in the app, which
 * is precisely what stopped red from reading as a signal.
 */
export const TOOLBAR_PRIMARY_CLS =
  "inline-flex h-[var(--control-h)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-ink px-3.5 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50";

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

/* ═══════════════════════════════════════════════════════════════════════════════
   REDESIGN PRIMITIVES (CRM + Inbox)

   Added for the visual rework specified in docs/ui-redesign-crm-inbox.md. They live
   here, beside the primitives they replace, because the point of that document is
   that these are the SHARED vocabulary of the two screens — a facet pill drawn twice
   is how the two screens start disagreeing about what a facet looks like.
   ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * The SHORT primary — for a panel's tab row and a card's footer, where the
 * control-height `TOOLBAR_PRIMARY_CLS` is too tall. Same ink, same role.
 */
export const PRIMARY_SM_CLS =
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-ink px-3 text-xs font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50";

/**
 * The RED primary — reserved for `Agendar cita`, and deliberately awkward to reach for
 * anywhere else. It carries a faint red-tinted lift (the artboard's
 * `0 1px 2px rgba(230,10,47,0.30)`) which no other button in the system has, so the one
 * action that books a customer in is visibly a different kind of thing.
 */
export const BOOK_CLS =
  "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-brand px-3 text-xs font-semibold text-white shadow-[var(--shadow-book)] transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50";

/** A GHOST toolbar action (Importar / Exportar): no border until hover. */
export const GHOST_ACTION_CLS =
  "inline-flex h-[var(--control-h)] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/** An OUTLINED secondary control (Filtrar / Orden / Reagendar / Cancelar). */
export const OUTLINE_CLS =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-line-strong px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-faint hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A segmented FACET row — the redesign's replacement for the three `<select>` facets.
 *
 * Why this is better here than the dropdowns it replaces: the counts. `Nuevos 28 ·
 * Activos 96 · Clientes 188` answers "how is my book distributed" at a glance and makes
 * the filter one click instead of open-read-pick. The old controls could not do that
 * because a `<select>` cannot show five numbers at once. What is LOST is arbitrary
 * combinations — the pills are one-of-N — which is why the `Filtrar` control beside them
 * still exists for the multi-facet case.
 *
 * TWO MECHANISMS, one look. Contacts filters SERVER-SIDE, so its pills are real `<Link>`s
 * — a facet is a URL there, which deep-links, middle-clicks into a new tab and works
 * before hydration. The staff roster is fully loaded and filters in client state, where a
 * URL would be a lie about what changed; its pills are `<button>`s. Passing `onPick`
 * selects the button form.
 *
 * They share this component because the look and the a11y contract are the shared part:
 * `aria-current` / `aria-pressed` (not colour) is what tells a screen reader which one is
 * on, and neither screen should be re-deriving the pill's geometry.
 */
export function FacetPills({
  items,
  className = "",
  label,
  onPick,
}: {
  items: { key: string; label: string; count?: number; href?: string; active: boolean }[];
  className?: string;
  /** Names the group for assistive tech — the pills alone don't say what they filter. */
  label: string;
  /** Client-side mode: render buttons and hand the picked key back. Omit for links. */
  onPick?: (key: string) => void;
}) {
  const cls = (active: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm no-underline transition-colors ${
      active ? "bg-ink font-semibold text-ink-fg" : "text-muted hover:bg-subtle hover:text-foreground"
    }`;
  const count = (it: { count?: number; active: boolean }) =>
    it.count !== undefined ? (
      <span className={`u-mono text-[0.65625rem] ${it.active ? "opacity-70" : "text-faint"}`}>
        {it.count}
      </span>
    ) : null;

  return (
    <nav aria-label={label} className={`flex min-w-0 flex-wrap items-center gap-1 ${className}`}>
      {items.map((it) =>
        onPick ? (
          <button
            key={it.key}
            type="button"
            onClick={() => onPick(it.key)}
            aria-pressed={it.active}
            className={cls(it.active)}
          >
            {it.label}
            {count(it)}
          </button>
        ) : (
          <Link
            key={it.key}
            href={it.href ?? "#"}
            scroll={false}
            aria-current={it.active ? "page" : undefined}
            className={cls(it.active)}
          >
            {it.label}
            {count(it)}
          </Link>
        ),
      )}
    </nav>
  );
}

/**
 * The VISITS cell: a magnitude bar plus the number.
 *
 * Deliberately UNTINTED (a neutral track and a grey fill). A visit count means neither
 * good nor bad — a 2-visit new lead and a 30-visit regular are both fine — so a red or
 * green bar would assert something the number does not support. The bar is scaled
 * against `max`, the largest count on the page, so it reads as "busy relative to this
 * shop" rather than against an invented ceiling.
 *
 * The number is the accessible value; the bar is `aria-hidden` decoration on top of it.
 */
export function VisitsMeter({ value, max }: { value: number; max: number }) {
  // A single visit on a page where the busiest contact has 30 must still be a visible
  // sliver, or the column reads as empty for most of the list.
  const pct = max > 0 && value > 0 ? Math.max(4, Math.round((value / max) * 100)) : 0;
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden className="h-1 min-w-6 flex-1 overflow-hidden rounded-sm bg-meter-track">
        <span className="block h-full rounded-sm bg-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="u-mono shrink-0 text-[0.71875rem] text-muted">{value}</span>
    </span>
  );
}

/**
 * The OWNER cell: a small initials disc, NOT a gradient sphere.
 *
 * The spheres identify CUSTOMERS; a colleague who owns the row is a different kind of
 * person and gets the design's flat outlined disc, so a glance down the table never
 * confuses "who this is" with "whose it is". An unowned row prints an em dash rather
 * than an empty cell, because blank reads as "not loaded".
 */
export function OwnerDisc({ name }: { name: string | null }) {
  if (!name) return <span className="text-faint">—</span>;
  const words = name.trim().split(/\s+/).filter(Boolean);
  // ALWAYS two characters. One initial per word for a real name ("Paola Ruiz" → PR), but
  // the first TWO letters when there is only one word — a lone "J" in a 26px disc reads
  // as a rendering bug, and plenty of these are usernames rather than full names.
  const initials =
    (words.length >= 2
      ? `${words[0][0]}${words[1][0]}`
      : (words[0] ?? "").slice(0, 2)
    ).toUpperCase() || "?";
  return (
    <span
      title={name}
      className="u-mono inline-flex size-[26px] items-center justify-center rounded-full border border-line bg-chip text-[0.53125rem] font-semibold text-muted"
    >
      {initials}
    </span>
  );
}

/**
 * A TWO-LINE table cell — a value over a quieter qualifier.
 *
 * The design uses this shape three times (name over email, channel over "hace 2 h",
 * service over staff), so it is one component rather than three near-identical pairs of
 * spans. `mono` is for the cells whose primary line is a number or an id.
 */
export function StackedCell({
  primary,
  secondary,
  mono = false,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  mono?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-px">
      <span
        className={`truncate text-[0.8125rem] tracking-[-0.01em] text-foreground ${mono ? "u-mono" : ""}`}
      >
        {primary}
      </span>
      {secondary ? <span className="truncate text-[0.6875rem] text-faint">{secondary}</span> : null}
    </span>
  );
}

/**
 * Page-number pagination.
 *
 * This replaces a keyset ("Load more") cursor, and the trade is real: page numbers need
 * a total COUNT, which the summary strip already pays for on this screen, plus an OFFSET
 * read instead of a keyset one. Offset paging drifts if rows are inserted while someone
 * is on page 3 — acceptable for a contacts book that changes a few times an hour, and
 * not acceptable for the executions log, which is why that table keeps its cursor.
 *
 * Windowed to `span` pages either side of the current one so a 40-page shop does not
 * render 40 links; the first and last page are always reachable, with an ellipsis
 * standing in for what was dropped.
 */
export function Pagination({
  page,
  pageCount,
  hrefForPage,
  span = 1,
}: {
  page: number;
  pageCount: number;
  hrefForPage: (page: number) => string;
  span?: number;
}) {
  if (pageCount <= 1) return null;
  const pages: (number | "gap")[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= span) pages.push(p);
    else if (pages[pages.length - 1] !== "gap") pages.push("gap");
  }
  const cell =
    "inline-flex size-[26px] items-center justify-center rounded-sm text-[0.6875rem] no-underline transition-colors";
  return (
    <nav aria-label="Paginación" className="flex items-center gap-1.5">
      {pages.map((p, i) =>
        p === "gap" ? (
          <span key={`gap-${i}`} aria-hidden className="px-0.5 text-[0.6875rem] text-faint">
            …
          </span>
        ) : p === page ? (
          <span key={p} aria-current="page" className={`u-mono ${cell} bg-ink font-medium text-ink-fg`}>
            {p}
          </span>
        ) : (
          <Link
            key={p}
            href={hrefForPage(p)}
            scroll={false}
            aria-label={`Página ${p}`}
            className={`u-mono ${cell} text-muted hover:bg-subtle hover:text-foreground`}
          >
            {p}
          </Link>
        ),
      )}
      {page < pageCount ? (
        <Link
          href={hrefForPage(page + 1)}
          scroll={false}
          aria-label="Página siguiente"
          className={`${cell} text-faint hover:bg-subtle hover:text-foreground`}
        >
          ›
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * ONE fact in a panel: a fixed-width label and its value.
 *
 * `align` exists because the two panels in the design genuinely differ — the contacts
 * panel right-aligns its values into a clean column, the inbox's client panel
 * left-aligns them next to their labels. That is a deliberate difference (one is a
 * record you read down, the other a summary you glance at), so it is a prop rather than
 * two components or one flattened compromise.
 */
export function FactRow({
  label,
  children,
  align = "right",
  mono = false,
  labelWidth = "6.5rem",
}: {
  label: string;
  children: ReactNode;
  align?: "right" | "left";
  mono?: boolean;
  labelWidth?: string;
}) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span style={{ width: labelWidth }} className="shrink-0 text-[0.71875rem] text-faint">
        {label}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[0.78125rem] text-foreground ${
          align === "right" ? "text-right" : ""
        } ${mono ? "u-mono" : ""}`}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * A panel's bottom ALERT strip — a dot, a sentence, and the action that resolves it.
 *
 * The redesign puts one at the foot of the contact quick view (artboard 22a): "Falta
 * confirmar el consentimiento de mensajería · Completar". It is deliberately NOT a
 * `PanelBanner` at the top of the body: an unresolved fact about a contact is not news
 * about the page you just opened, and a banner above the content pushes the content down
 * every time. Pinned to the bottom it stays visible while the body scrolls and costs the
 * content nothing.
 *
 * It renders NOTHING when there is nothing outstanding — the caller passes null. A strip
 * that says "todo en orden" is chrome asserting its own usefulness.
 */
export function PanelAlertStrip({
  children,
  action,
  tone = "warn",
}: {
  children: ReactNode;
  /** The affordance that resolves it. Omitted when the fact is informational only. */
  action?: ReactNode;
  tone?: "warn" | "danger";
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-3">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${tone === "danger" ? "bg-danger" : "bg-warn"}`}
      />
      <p className="min-w-0 flex-1 text-[0.75rem] leading-snug text-muted">{children}</p>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}
