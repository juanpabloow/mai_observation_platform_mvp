"use client";

import { useId, useRef, type ReactNode } from "react";
import { useModuleRail } from "./ModuleRailContext";

/**
 * THE MODULE SURFACE — one continuous surface per screen (Catálogo, Presencia y marketing,
 * Configuración) that fills the shell panel. The header, the toolbar, the side menu and the content are all INSIDE
 * it: there is no header card floating above a content card, and no tab row repeating
 * the sidebar's destinations (the sidebar already says where you are).
 *
 *   ┌───────────────────────────────────────────────────────────┐
 *   │ SurfaceHeader   title · summary                 actions   │
 *   │ SurfaceToolbar  [rail] [ search ……………… ] [filter] [more]  │
 *   ├──────────────┬────────────────────────────────────────────┤
 *   │ side menu    │ content (scrolls on its own)               │
 *   └──────────────┴────────────────────────────────────────────┘
 *
 * The side menu is the list's filters or the editor's section index — it is KEPT on
 * desktop (lg+) and can be folded with the toolbar's rail toggle; that preference is a
 * cookie read during SSR (lib/moduleRail.ts), so it never causes a hydration mismatch.
 * Below lg the side menu is not drawn: lists show a filter <select> in the toolbar and
 * editors fold their sections instead.
 *
 * Pure layout. No module rule, permission or data shape lives here.
 */

export function ModuleSurface({ children, label }: { children: ReactNode; label?: string }) {
  return (
    // FULL-BLEED: the shell's framed panel (xl+) — or the whole content area on smaller
    // screens — IS the surface. It cancels the content gutter (--content-pad) and draws no
    // border, radius or shadow of its own, so there is never a card inside the panel.
    // Phones keep the canvas grey under the grouped white cards; md+ is one white surface.
    // `relative`: absolutely positioned descendants (sr-only inputs, menus) are contained
    // by the surface, so they can never extend the page's own scroll area.
    <main aria-label={label} className="u-module relative -m-[var(--content-pad)] flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:bg-surface">
      {children}
    </main>
  );
}

/** Title band of a list / settings screen. On a phone the primary action stays on the
 *  title row (a 44px target) and the secondary actions wrap below it. */
export function SurfaceHeader({
  title,
  summary,
  status,
  actions,
  primary,
}: {
  title: string;
  /** The whole-set line under the title ("11 activos · 3 archivados"). Real numbers only. */
  summary?: ReactNode;
  /** A short state chip beside the title (e.g. «Publicada»). */
  status?: ReactNode;
  /** Secondary actions, right-aligned before the primary one. */
  actions?: ReactNode;
  /** The one primary action of the screen. */
  primary?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-3 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
      {/* The title keeps at least ~18rem: when the actions would squeeze it (phones), they
          wrap to their own row instead of leaving the summary in a narrow column. */}
      <div className="min-w-[min(100%,18rem)] flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="min-w-0 text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.625rem]">{title}</h1>
          {status}
        </div>
        {summary ? <p className="mt-1 text-[0.8125rem] text-muted">{summary}</p> : null}
      </div>
      {actions || primary ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {primary}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Title + toolbar in ONE band, the layout of the design: the title and its summary on
 * their own line; below them a single row — rail toggle, search, the phone filter picker,
 * the secondary actions and the primary action last. On a phone the primary action moves
 * up beside the title (a real 44px target) and the search takes the full width below.
 */
export function SurfaceTop({
  title,
  summary,
  status,
  actions,
  primary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  status?: ReactNode;
  /** Secondary actions, after the search and filters. */
  actions?: ReactNode;
  /** The one primary action, last in the row. */
  primary?: ReactNode;
  /** The toolbar's left part: <RailToggle/>, <SearchField/>, <FilterSelect/>… */
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-3 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
      <div className="order-1 min-w-0 flex-1 md:basis-full">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 className="min-w-0 text-[1.375rem] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[1.625rem]">{title}</h1>
          {status}
        </div>
        {summary ? <p className="mt-1 text-[0.8125rem] text-muted">{summary}</p> : null}
      </div>
      {primary ? <div className="order-2 flex shrink-0 items-center md:order-4">{primary}</div> : null}
      <div className="order-3 flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:flex-1 md:flex-nowrap">
        {children}
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

/** The row under the title: rail toggle, search, the phone filter picker, more actions.
 *  It stays put while the content scrolls (it sits outside the scrolling region). */
export function SurfaceToolbar({ children }: { children: ReactNode }) {
  // No rule under it: the list's own column header draws the only line (as in the design).
  return <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">{children}</div>;
}

const RAIL_ID = "module-side-menu";

/** Folds / unfolds the side menu (desktop only — below lg there is no side menu). */
export function RailToggle() {
  const { open, toggle } = useModuleRail();
  const label = open ? "Ocultar menú lateral" : "Mostrar menú lateral";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-controls={RAIL_ID}
      aria-expanded={open}
      aria-label={label}
      title={label}
      className="u-focus hidden size-[2.5rem] shrink-0 items-center justify-center rounded-sch-control border border-line-strong bg-surface text-muted transition-colors hover:bg-subtle hover:text-foreground aria-expanded:bg-subtle aria-expanded:text-foreground lg:inline-flex"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-[0.9375rem]" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="2.2" y="3" width="11.6" height="10" rx="2" />
        <path d="M6.4 3v10" />
      </svg>
    </button>
  );
}

/**
 * A labelled search box. 16px text on phones (no iOS zoom), a clear button when filled.
 *
 * TOUCH TARGETS. The input itself covers the whole box, border included (-inset-px), so
 * the interactive element is the full 44px — tapping the icon or the edge focuses it; it
 * is not a 42px field inside a 44px frame. «Borrar búsqueda» gets its own 44 × 44 strip at
 * the right, and while it shows the input stops short of it, so the two never overlap.
 */
export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`u-focus relative h-[44px] min-w-0 flex-1 rounded-sch-control border border-line-strong bg-surface lg:h-[2.5rem] ${className}`}>
      <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="7" cy="7" r="4.4" />
        <path d="M10.4 10.4 13.6 13.6" />
      </svg>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? label}
        autoComplete="off"
        className={`absolute -inset-y-px -left-px min-w-0 rounded-sch-control bg-transparent pl-[2.3rem] text-base text-foreground outline-none placeholder:text-faint lg:text-sm [&::-webkit-search-cancel-button]:hidden ${
          value ? "right-11 pr-1 lg:right-10" : "-right-px pr-3"
        }`}
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            // The button goes away with the text: keep focus in the search, not on <body>.
            inputRef.current?.focus();
          }}
          aria-label="Borrar búsqueda"
          className="absolute -inset-y-px -right-px inline-flex w-11 items-center justify-center rounded-sch-control text-faint hover:bg-subtle hover:text-foreground lg:w-10"
        >
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/**
 * Side menu + content. The side menu is a column of its own on desktop (lg+) that the
 * rail toggle can fold; the content scrolls inside the surface, so the header and the
 * toolbar stay in view. `railLabel` names the menu for assistive tech.
 */
export function SurfaceBody({
  rail,
  railLabel,
  children,
  railAlwaysOpen = false,
  contentRef,
}: {
  rail?: ReactNode;
  railLabel?: string;
  children: ReactNode;
  /** The editor's section index ignores the fold preference (it is how you navigate a
   *  long form, not a filter). */
  railAlwaysOpen?: boolean;
  contentRef?: React.Ref<HTMLDivElement>;
}) {
  const { open } = useModuleRail();
  const showRail = Boolean(rail) && (railAlwaysOpen || open);
  return (
    <div className="flex min-h-0 flex-1">
      {rail ? (
        <nav
          id={railAlwaysOpen ? undefined : RAIL_ID}
          aria-label={railLabel}
          className={`${showRail ? "lg:flex" : ""} hidden w-[13.5rem] shrink-0 flex-col overflow-y-auto px-3 py-3`}
        >
          {rail}
        </nav>
      ) : null}
      <div ref={contentRef} className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}
