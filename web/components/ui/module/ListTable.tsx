"use client";

import type { MouseEvent, ReactNode } from "react";
import { scrollWithin } from "./scrollWithin";

/**
 * A module LIST with aligned columns. Desktop/tablet (md+) is a real <table>: one table
 * for every group, so «Duración», «Profesionales» and «Precio» line up from the first
 * group to the last, and assistive tech reads headers and row groups. Phones get the
 * same rows as a grouped card list (MobileList), never a squeezed table.
 *
 * A row opens its item from anywhere on the row (mouse) and from the name button
 * (keyboard / screen reader); the trailing ⋯ menu keeps its own clicks.
 */

export interface ListColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Width / visibility classes for the column (header and cells), e.g. "w-28 hidden lg:table-cell". */
  className?: string;
}

const CELL_PAD = "px-3 first:pl-4 sm:first:pl-6 last:pr-4 sm:last:pr-6";

export function ListTable({ label, columns, withMenu = true, children }: { label: string; columns: ListColumn[]; withMenu?: boolean; children: ReactNode }) {
  return (
    <table className="hidden w-full table-fixed border-separate border-spacing-0 text-[0.8438rem] md:table">
      <caption className="sr-only">{label}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={`sticky top-0 z-[2] h-[2.75rem] border-b border-line bg-surface text-[0.8125rem] font-normal tracking-[0.01em] text-muted ${CELL_PAD} ${c.align === "right" ? "text-right" : "text-left"} ${c.className ?? ""}`}
            >
              {c.label}
            </th>
          ))}
          {withMenu ? (
            <th scope="col" className={`sticky top-0 z-[2] h-[2.75rem] w-[3.25rem] border-b border-line bg-surface ${CELL_PAD}`}>
              <span className="sr-only">Acciones</span>
            </th>
          ) : null}
        </tr>
      </thead>
      {children}
    </table>
  );
}

/** One group of rows (a category, a state…) with its heading row and real count. */
export function ListGroup({
  title,
  dot,
  count,
  span,
  children,
}: {
  title?: string;
  dot?: string;
  /** Right-aligned count text, e.g. "2 servicios". */
  count?: string;
  /** Number of columns (+1 when the table has the menu column). */
  span: number;
  children: ReactNode;
}) {
  return (
    <tbody>
      {title ? (
        <tr>
          <th scope="rowgroup" colSpan={span} className="h-[2.75rem] px-4 pb-1 pt-4 text-left align-bottom sm:px-6">
            <span className="flex items-center gap-2">
              {dot ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} /> : null}
              <span className="text-[0.875rem] font-semibold text-foreground">{title}</span>
              {count ? <span className="ml-auto text-[0.75rem] font-normal text-muted">{count}</span> : null}
            </span>
          </th>
        </tr>
      ) : null}
      {children}
    </tbody>
  );
}

/** Ignore row clicks that land on an interactive child (the ⋯ menu, a toggle, a link). */
function fromControl(e: MouseEvent) {
  return Boolean((e.target as HTMLElement).closest("button, a, input, select, textarea, label, [role=menu]"));
}

export function ListRow({
  columns,
  cells,
  name,
  onOpen,
  openLabel,
  menu,
  dimmed = false,
  raised = false,
  openKey,
}: {
  columns: ListColumn[];
  /** One node per column, in column order; the FIRST is wrapped in the open button. */
  cells: ReactNode[];
  /** Accessible name of the item (used in the open button label). */
  name: string;
  onOpen?: () => void;
  openLabel?: string;
  /** The ⋯ menu, or null to keep the column empty. Undefined = table without menu. */
  menu?: ReactNode;
  /** Archived / hidden items read quieter — text only, never the whole row's opacity. */
  dimmed?: boolean;
  /** Lift this row above its siblings (its menu is open). */
  raised?: boolean;
  /** Stable key so focus can return to this row after an editor closes (returnFocus). */
  openKey?: string;
}) {
  return (
    <tr
      onClick={onOpen ? (e) => !fromControl(e) && onOpen() : undefined}
      className={`group ${onOpen ? "cursor-pointer" : ""} ${raised ? "relative z-[3]" : ""} [&>td]:transition-colors hover:[&>td]:bg-subtle/70 focus-within:[&>td]:bg-subtle/70`}
    >
      {cells.map((cell, i) => {
        const c = columns[i];
        return (
          <td
            key={c?.key ?? i}
            className={`h-[3rem] border-b border-line-soft align-middle ${CELL_PAD} ${c?.align === "right" ? "text-right" : "text-left"} ${c?.className ?? ""} ${
              dimmed ? "text-muted" : "text-foreground"
            }`}
          >
            {i === 0 && onOpen ? (
              <button
                type="button"
                onClick={onOpen}
                data-open-key={openKey}
                aria-label={openLabel ? `${openLabel}: ${name}` : undefined}
                className="u-focus -mx-1 block max-w-full truncate rounded px-1 text-left font-medium"
              >
                {cell}
              </button>
            ) : (
              <div className="min-w-0 truncate">{cell}</div>
            )}
          </td>
        );
      })}
      {menu !== undefined ? <td className={`h-[3rem] w-[3.25rem] border-b border-line-soft text-right align-middle ${CELL_PAD}`}>{menu}</td> : null}
    </tr>
  );
}

/** «Mostrando 6 productos» under a list — the count of what is on screen right now. */
export function ListFoot({ children }: { children: ReactNode }) {
  return <p className="px-4 py-4 text-[0.7812rem] text-muted sm:px-6">{children}</p>;
}

/* ─────────────────────────────── phones (below md) ─────────────────────────────── */

export function MobileList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5 px-4 pb-6 pt-4 md:hidden">{children}</div>;
}

export function MobileGroup({ title, dot, count, children }: { title?: string; dot?: string; count?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      {title ? (
        <h2 className="flex items-center gap-2 px-1 text-[0.9375rem] font-semibold text-foreground">
          {dot ? <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} /> : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {count ? <span className="text-[0.7812rem] font-normal text-muted">{count}</span> : null}
        </h2>
      ) : null}
      <ul className="overflow-visible rounded-sch-card border border-line bg-surface">{children}</ul>
    </section>
  );
}

export function MobileRow({
  title,
  subtitle,
  value,
  badges,
  onOpen,
  openLabel,
  menu,
  dimmed = false,
  openKey,
}: {
  title: string;
  subtitle?: ReactNode;
  value?: ReactNode;
  badges?: ReactNode;
  onOpen?: () => void;
  openLabel?: string;
  menu?: ReactNode;
  dimmed?: boolean;
  openKey?: string;
}) {
  return (
    <li className="relative flex items-center border-b border-line-soft last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        disabled={!onOpen}
        data-open-key={openKey}
        aria-label={openLabel ? `${openLabel}: ${title}` : undefined}
        className="u-focus flex min-h-[60px] min-w-0 flex-1 items-center gap-3 rounded-sch-card py-2.5 pl-4 pr-2 text-left disabled:cursor-default"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className={`min-w-0 break-words text-[0.9375rem] font-semibold ${dimmed ? "text-muted" : "text-foreground"}`}>{title}</span>
            {badges}
          </span>
          {subtitle ? <span className="mt-0.5 block truncate text-[0.8125rem] text-muted">{subtitle}</span> : null}
        </span>
        {value ? <span className="shrink-0 text-[0.9062rem] font-semibold text-foreground">{value}</span> : null}
        {onOpen ? (
          <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
        ) : null}
      </button>
      {menu ? <div className="shrink-0 pr-1.5">{menu}</div> : null}
    </li>
  );
}

/**
 * After an in-page editor closes, put focus back on what opened it — found by its
 * `data-open-key`, because a save refreshes the list and may replace the node. Tries the
 * visible one (table on desktop, card on a phone) for a few frames while the list
 * re-renders; never steals focus the user already moved elsewhere.
 */
export function returnFocus(key: string) {
  let tries = 0;
  // Whatever has focus NOW belongs to the closing editor (its heading, its Guardar): only
  // a DIFFERENT, still-connected element means the user moved on.
  const closing = document.activeElement;
  const attempt = () => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== closing && active.isConnected) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>(`[data-open-key="${CSS.escape(key)}"]`)).find((x) => x.offsetParent !== null);
    if (el) {
      el.focus({ preventScroll: true });
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) scrollWithin(el, { block: "center", smooth: false });
    }
    else if (tries++ < 10) window.setTimeout(attempt, 60);
  };
  window.setTimeout(attempt, 0);
}
