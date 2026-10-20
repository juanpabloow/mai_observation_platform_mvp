"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { useSidebar } from "@/components/SidebarContext";
import { useScope } from "@/components/ScopeProvider";
import { InboxTabLink } from "@/components/InboxTabLink";
import { AccountMenu } from "@/components/AccountMenu";
import { RAIL_ACTIVE, RAIL_H, RAIL_IDLE, RAIL_OPEN, RAIL_ROW, RAIL_SUB_H, RAIL_SUB_IDLE } from "@/components/railRow";
import { buildSections, locate, type NavSection as ModelSection, type PageId, type SectionId } from "@/lib/sectionNav";
import { memberLandingPath } from "@/lib/landing";
import { hasSidebarCollapsedCookie, LEGACY_SIDEBAR_COLLAPSED_KEY } from "@/lib/sidebarCollapsed";

const AUTH_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password"];

/** The client id when inside a client (/clients/<id>/…); null at the tenant level. */
function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? m[1] : null;
}

// ── Inline SVG icon set (no icon dependency is installed; the app uses inline SVG).
// 18px, 1.5 stroke, currentColor — consistent weight across the rail. ─────────────
/* 17px. The design specifies 15px against its own 13.5px label; at the 14px label this
   rail actually renders, 15px read as a smaller glyph beside a bigger word. */
const iconCls = "size-[1.0625rem] shrink-0";

const Icon = {
  /* Disponibilidad — a clock: WHEN the business attends. */
  availability: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  /* Servicios — a list with leading dots (the menu of what is booked). */
  services: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="4.75" cy="6.5" r="1.1" fill="currentColor" />
      <circle cx="4.75" cy="12" r="1.1" fill="currentColor" />
      <circle cx="4.75" cy="17.5" r="1.1" fill="currentColor" />
    </svg>
  ),
  /* Promociones — a percent sign. */
  promotions: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="7.5" cy="7.5" r="2.25" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="16.5" r="2.25" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  /* Página de reservas — a globe: the business's public face. */
  bookingPage: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  /* Sedes — a map pin. */
  sites: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0c0 5.4 6.5 11 6.5 11Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.25" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  /* Reglas de reserva — sliders. */
  rules: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="15" cy="7" r="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="17" r="2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  workflows: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="15" y="15" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 6h4a3 3 0 0 1 3 3v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  overview: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3" y="3" width="8" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="3" width="7" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 14h4a2 2 0 0 0 4 0h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  contacts: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  /* Reuniones. A microphone rather than a waveform: the rail names the PLACE
     ("recorded meetings"), and a waveform there would collide with the one the
     player uses to mean audio POSITION. */
  meetings: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="9.25" y="2.75" width="5.5" height="11" rx="2.75" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  agenda: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  modules: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  hub: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 11 12 4l8 7M6 9.5V19h12V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  clients: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="4" width="9" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13 9h6a1.5 1.5 0 0 1 1.5 1.5V20M7 8h3M7 12h3M7 16h3M16 13h1.5M16 16h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  reviews: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M12 4.2l2.3 4.7 5.2.7-3.8 3.6.9 5.1L12 15.9l-4.6 2.4.9-5.1-3.8-3.6 5.2-.7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
  schedulingAdmin: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="14.5" r="1.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  ),
  /* Catalog ("Productos") — a price tag: what the business SELLS, priced. */
  catalog: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 7a2 2 0 0 1 2-2h5.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8l-4.2 4.2a2 2 0 0 1-2.8 0l-7-7a2 2 0 0 1-.6-1.4V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="8.5" cy="8.5" r="1.2" fill="currentColor" />
    </svg>
  ),
  /* Campaigns ("Campañas") — a megaphone: ads that bring leads in. */
  campaigns: (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" aria-hidden>
      <path d="M4 10v4a1 1 0 0 0 1 1h2l2.5 3.5a1 1 0 0 0 1.8-.6V6.1a1 1 0 0 0-1.8-.6L7 9H5a1 1 0 0 0-1 1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M17 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
} as const;

interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: ReactNode;
  active: boolean;
  /** When set, render the polling InboxTabLink (live aggregated pending badge). */
  countEndpoint?: string;
  /** A static number badge (e.g. unconfigured-ads count); rendered when > 0 in the expanded rail. */
  badge?: number;
  /** A quiet tag after the label (Módulos → AGENCIA). */
  tag?: string;
}
/** A section with 2+ pages: its row unfolds them (one group open at a time). */
interface NavGroup {
  key: string;
  label: string;
  icon: ReactNode;
  /** The current page is inside this group. */
  active: boolean;
  /** The row ALSO navigates (Agenda → Calendario); its chevron is a separate button. */
  homeHref: string | null;
  /** That home is the current page. */
  homeActive: boolean;
  pages: Array<{ key: string; label: string; href: string; active: boolean; badge?: number }>;
}
type NavEntry = ({ kind: "link" } & NavItem) | ({ kind: "group" } & NavGroup);
interface NavSection {
  /** The block's accessible name (Operación, Negocio, Herramientas…). */
  label: string;
  entries: NavEntry[];
  /** Blocks are separated by a hairline, not titled; the tenant/member lists keep a title. */
  divider?: boolean;
}

/** The rail icon of each section, and of the lone page a section shrinks to. */
const SECTION_ICON: Record<SectionId, ReactNode> = {
  inbox: Icon.inbox,
  contacts: Icon.contacts,
  agenda: Icon.agenda,
  catalog: Icon.catalog,
  presence: Icon.bookingPage,
  results: Icon.overview,
  settings: Icon.rules,
  automations: Icon.workflows,
  agency: Icon.modules,
};
const PAGE_ICON: Partial<Record<PageId, ReactNode>> = {
  pipeline: Icon.overview,
  products: Icon.catalog,
  services: Icon.services,
  promotions: Icon.promotions,
  campaigns: Icon.campaigns,
  reviews: Icon.reviews,
  users: Icon.team,
  fields: Icon.modules,
  sites: Icon.sites,
  rules: Icon.rules,
  hours: Icon.availability,
  meetings: Icon.meetings,
  team: Icon.team,
  workflows: Icon.workflows,
  "tech-analytics": Icon.overview,
};

const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden data-open={open} className="u-rail-chevron size-3.5 shrink-0 opacity-55" fill="none">
    <path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The small red count pill (white on the red current row, so it never vanishes into it). */
function CountPill({ value, onActive, label }: { value: number; onActive: boolean; label: string }) {
  return (
    <span
      aria-label={label}
      className={`ml-1.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${
        onActive ? "bg-white text-nav-active" : "bg-nav-active text-white"
      }`}
    >
      {value}
    </span>
  );
}

/** One static nav row (icon + label expanded, icon-only + tooltip collapsed). */
function NavLink({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  // The CURRENT page is the production red pill. The row is INSET (mx-2) rather than
  // full-bleed; idle rows carry the same inset as transparent margin, so nothing shifts
  // by a pixel when selection moves. Collapsed, the label is a tooltip on hover AND
  // keyboard focus (`.u-rail-tip`, from `data-tip`).
  const base = `${RAIL_ROW} ${RAIL_H} ${
    collapsed ? "u-rail-tip justify-center px-0" : "gap-2.5 pl-2.5 pr-1.5"
  } ${item.active ? RAIL_ACTIVE : RAIL_IDLE}`;
  const tip = item.tag ? `${item.label} · ${item.tag.toLocaleLowerCase("es")}` : item.label;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={item.active ? "page" : undefined}
      aria-label={collapsed ? tip : undefined}
      data-tip={collapsed ? tip : undefined}
      className={base}
    >
      <span className="shrink-0" aria-hidden>
        {item.icon}
      </span>
      {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {!collapsed && item.tag ? (
        <span className={`shrink-0 pr-1 text-[10px] font-semibold tracking-[0.08em] ${item.active ? "text-white/80" : "text-sidebar-section"}`}>{item.tag}</span>
      ) : null}
      {!collapsed && item.badge != null && item.badge > 0 ? (
        <CountPill value={item.badge} onActive={item.active} label={`${item.badge} anuncios sin configurar`} />
      ) : null}
    </Link>
  );
}

/**
 * A group of pages (expanded rail and phone menu). Its pages unfold beneath it, aligned
 * with the parent's label on a thin vertical guide. Two different marks, never confused:
 *   - the CURRENT PAGE is the red pill;
 *   - an OPEN group only lifts to the rail foreground (its chevron turns).
 * If the group holding the current page is closed, the pill moves to the group row, so
 * the person never loses where they are. Agenda's row navigates (to the calendar); the
 * chevron beside it is its own button, reachable by keyboard.
 */
function NavGroupRow({
  group,
  open,
  onToggle,
  onNavigate,
}: {
  group: NavGroup;
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  const regionId = `rail-group-${group.key}`;
  const holdsPill = group.active && !open;
  const state = holdsPill ? RAIL_ACTIVE : open ? RAIL_OPEN : RAIL_IDLE;
  const hiddenBadge = !open ? group.pages.reduce((n, p) => n + (p.badge ?? 0), 0) : 0;
  const toggleLabel = `${open ? "Ocultar" : "Mostrar"} páginas de ${group.label}`;
  return (
    <div className="flex flex-col">
      {group.homeHref ? (
        <div className={`${RAIL_ROW} ${RAIL_H} ${state}`}>
          <Link
            href={group.homeHref}
            onClick={onNavigate}
            aria-current={group.homeActive && !open ? "page" : group.active ? "true" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-[10px] pl-2.5"
          >
            <span className="shrink-0" aria-hidden>
              {group.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{group.label}</span>
          </Link>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={regionId}
            aria-label={toggleLabel}
            title={toggleLabel}
            className={`mr-1 flex size-[30px] shrink-0 items-center justify-center rounded-lg max-xl:mr-0 max-xl:size-11 ${
              holdsPill ? "hover:bg-white/15" : "hover:bg-sidebar-hover"
            }`}
          >
            <Chevron open={open} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={regionId}
          aria-current={group.active ? "true" : undefined}
          className={`${RAIL_ROW} ${RAIL_H} gap-2.5 pl-2.5 pr-0.5 text-left ${state}`}
        >
          <span className="shrink-0" aria-hidden>
            {group.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{group.label}</span>
          {hiddenBadge > 0 ? <CountPill value={hiddenBadge} onActive={holdsPill} label={`${hiddenBadge} anuncios sin configurar`} /> : null}
          <span className="-ml-1.5 mr-0.5 flex w-3.5 shrink-0 items-center justify-center">
            <Chevron open={open} />
          </span>
        </button>
      )}
      <div className="u-rail-group" data-open={open}>
        <div id={regionId} role="group" aria-label={group.label} inert={!open}>
          <div className="u-rail-group-inner relative flex flex-col gap-px pb-1 pt-px">
            <span aria-hidden className="absolute bottom-2 left-[26px] top-1 w-px bg-sidebar-border" />
            {group.pages.map((pg) => (
              <Link
                key={pg.key}
                href={pg.href}
                onClick={onNavigate}
                aria-current={pg.active ? "page" : undefined}
                className={`${RAIL_ROW} ${RAIL_SUB_H} pl-[37px] pr-1.5 ${pg.active ? RAIL_ACTIVE : RAIL_SUB_IDLE}`}
              >
                <span className="min-w-0 flex-1 truncate">{pg.label}</span>
                {pg.badge ? <CountPill value={pg.badge} onActive={pg.active} label={`${pg.badge} anuncios sin configurar`} /> : null}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Collapsed rail: a group is ONE icon; pressing it opens a small floating menu with the
 * group's name and pages (Escape, an outside click or choosing a page closes it, and focus
 * returns to the icon). The icon carries the red pill while the current page is inside.
 */
function CollapsedGroup({
  group,
  open,
  setOpen,
}: {
  group: NavGroup;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = `rail-fly-${group.key}`;
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      setOpen(false);
      if (refocus) btnRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, setOpen]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={group.label}
        aria-current={group.active ? "true" : undefined}
        data-tip={open ? undefined : group.label}
        className={`${RAIL_ROW} ${RAIL_H} u-rail-tip w-[calc(100%-1rem)] justify-center px-0 ${group.active ? RAIL_ACTIVE : open ? RAIL_OPEN : RAIL_IDLE}`}
      >
        <span className="shrink-0" aria-hidden>
          {group.icon}
        </span>
      </button>
      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label={group.label}
          className="absolute left-full top-0 z-50 ml-2 min-w-52 rounded-xl border border-line bg-popover p-1.5 shadow-[var(--shadow-float)]"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{group.label}</p>
          {group.pages.map((pg) => (
            <Link
              key={pg.key}
              href={pg.href}
              onClick={() => setOpen(false)}
              aria-current={pg.active ? "page" : undefined}
              className={`flex min-h-[34px] items-center rounded-lg px-2.5 text-[13.5px] ${
                pg.active ? "bg-nav-active font-semibold text-white" : "text-foreground hover:bg-subtle"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{pg.label}</span>
              {pg.badge ? <CountPill value={pg.badge} onActive={pg.active} label={`${pg.badge} anuncios sin configurar`} /> : null}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BlockDivider({ collapsed }: { collapsed: boolean }) {
  return <span aria-hidden className={`block h-px bg-sidebar-border ${collapsed ? "mx-3 my-1.5" : "mx-5 my-1.5"}`} />;
}

function SectionHeader({ label, collapsed, first, divider = false }: { label: string; collapsed: boolean; first: boolean; divider?: boolean }) {
  if (collapsed || divider) return first ? null : <BlockDivider collapsed={collapsed} />;
  // 18px of side padding to line the label up with the row TEXT.
  return <p className={`u-th-sidebar px-[18px] pb-1.5 ${first ? "pt-0.5" : "pt-4"}`}>{label}</p>;
}

/**
 * The BRAND block at the top of the rail (final design): the red mark plus the
 * wordmark, linking home. It lives here — not in the header — because the sidebar
 * is now the full-height first column, so the brand sits above the nav and the
 * header starts after the rail.
 */
/**
 * The rail's own collapse control. The TOP BAR normally carries it; when the person hides
 * the bar (xl+, lib/topbarPref.ts) this one shows instead — `.u-rail-toggle` is display:none
 * unless `html[data-topbar='hidden']`, so it never doubles the header's button.
 */
function RailToggle({ onClick, push = false }: { onClick: () => void; push?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Toggle sidebar"
      title="Toggle sidebar"
      className={`u-rail-toggle shrink-0 items-center justify-center rounded-lg p-1.5 text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-fg ${push ? "ml-auto" : ""}`}
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4">
        <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 3v10" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    </button>
  );
}

function Brand({ homeHref, collapsed, onNavigate }: { homeHref: string; collapsed: boolean; onNavigate?: () => void }) {
  const { toggle } = useSidebar();
  return (
    <>
    <div
      // NO bottom rule. The brand is part of the rail, not a titlebar over it: a hairline
      // here cut the rail into two panels and made the first section heading look like it
      // belonged to a different list. The padding below is the separation.
      className={`flex h-[var(--topbar-height)] shrink-0 items-center ${
        collapsed ? "justify-center px-2" : "px-[18px]"
      }`}
    >
      <Link
        href={homeHref}
        onClick={onNavigate}
        aria-label="MONTSERRAT_AI — home"
        title={collapsed ? "MONTSERRAT_AI — home" : undefined}
        className="flex min-w-0 items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
      >
        {/* The wordmark only — "MONTSERRAT_AI" — when expanded; the collapsed rail keeps a
            compact red mark so the brand still has a glyph in the narrow strip. */}
        {collapsed ? (
          <span aria-hidden className="size-6 shrink-0 rounded bg-nav-active" />
        ) : (
          <span className="truncate text-[0.8125rem] font-semibold tracking-tight text-sidebar-fg">MONTSERRAT_AI</span>
        )}
      </Link>
      {collapsed ? null : <RailToggle onClick={toggle} push />}
    </div>
    {collapsed ? (
      // The whole row only exists while the bar is hidden (u-rail-toggle), so it adds no gap otherwise.
      <div className="u-rail-toggle w-full shrink-0 justify-center pb-1">
        <RailToggle onClick={toggle} />
      </div>
    ) : null}
    </>
  );
}

/**
 * The account disc in the rail's footer — a two-tone gradient SPHERE, the same object the
 * contacts table and the inbox queue draw (see `.u-avatar-*` in globals.css).
 *
 * It used to be a flat `--sidebar-border` fill, which made the one person who is always
 * on screen the only person in the app without an identity colour. Seeding it from the
 * account's own identifier means it is stable across sessions and consistent with how
 * every other person is coloured.
 *
 * CRM footer avatar: a NEUTRAL squared tile with the account's mono initials (per the
 * design), not an identity-coloured disc — the one person the rail already names in words
 * beside it needs no colour to be found.
 */
function Avatar({ initial }: { initial: string }) {
  return (
    <span
      aria-hidden
      className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-sidebar-tile text-[11px] font-semibold text-sidebar-fg"
    >
      {initial}
    </span>
  );
}

/** Who is signed in, in the business's words (the footer's second line). */
const ACCESS_LABEL: Record<string, string> = { agency: "Agencia", owner: "Dueño", setter: "Recepción", staff: "Profesional" };

interface Account {
  /** Display name — the footer's primary label (an email is a fallback, not a label). */
  name: string | null;
  email: string;
  role: "owner" | "admin" | "member";
  accessLabel: "owner" | "setter" | "staff" | null;
  clientLabel: string | null;
  canSwitchClients: boolean;
}

/** Accent- and case-insensitive match («pagina» finds «Página de reservas»). */
const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");

/**
 * The section search (top of the rail): narrows the rail to the sections and pages whose
 * name contains the text, unfolding every group with a match. Navigation only — it lists
 * what the rail already shows this person (the same permission-filtered model), nothing
 * more. Enter opens the first result; Escape clears.
 */
function filterSections(sections: NavSection[], agency: NavItem | null, q: string) {
  const nq = fold(q.trim());
  if (!nq) return { sections, agency, first: null as string | null, count: -1 };
  let first: string | null = null;
  let count = 0;
  const out = sections
    .map((sec) => ({
      ...sec,
      entries: sec.entries.flatMap((e): NavEntry[] => {
        if (e.kind === "link") {
          if (!fold(e.label).includes(nq)) return [];
          first ??= e.href;
          count += 1;
          return [e];
        }
        const pages = fold(e.label).includes(nq) ? e.pages : e.pages.filter((pg) => fold(pg.label).includes(nq));
        if (pages.length === 0) return [];
        first ??= pages[0].href;
        count += pages.length;
        return [{ ...e, pages }];
      }),
    }))
    .filter((sec) => sec.entries.length > 0);
  const ag = agency && fold(agency.label).includes(nq) ? agency : null;
  if (ag) {
    first ??= ag.href;
    count += 1;
  }
  return { sections: out, agency: ag, first, count };
}

/** The rail contents (nav + fixed account footer), shared by the desktop rail and
 * the mobile drawer. `collapsed` only ever true on desktop. */
function RailBody({
  sections,
  agency,
  pathname,
  collapsed,
  account,
  homeHref,
  onNavigate,
  searchable = false,
}: {
  sections: NavSection[];
  /** Módulos — the agency's own tool, kept apart at the bottom of the rail. */
  agency: NavItem | null;
  pathname: string;
  collapsed: boolean;
  account: Account;
  homeHref: string;
  onNavigate?: () => void;
  /** Show the section search (inside a client, where the rail has groups). */
  searchable?: boolean;
}) {
  const [acctOpen, setAcctOpen] = useState(false);
  const router = useRouter();
  const { toggle } = useSidebar();
  // The search text belongs to the page it was typed on: navigating clears it.
  const [searchState, setSearchState] = useState<{ path: string; q: string }>({ path: pathname, q: "" });
  const q = searchState.path === pathname ? searchState.q : "";
  const setQ = (v: string) => setSearchState({ path: pathname, q: v });
  const searchRef = useRef<HTMLInputElement | null>(null);
  // Collapsed → the search icon expands the rail; the field takes focus once it mounts.
  const focusOnMount = useRef(false);
  const shown = filterSections(sections, agency, searchable ? q : "");
  const searching = shown.count >= 0;
  // ONE group open at a time. The open group FOLLOWS THE URL: arriving anywhere (also by a
  // direct link) opens the section that holds the page; a toggle only lasts until the next
  // navigation. Derived during render — no effect re-syncing state.
  const activeGroup =
    sections.flatMap((sec) => sec.entries).find((e): e is { kind: "group" } & NavGroup => e.kind === "group" && e.active)?.key ?? null;
  const [openState, setOpenState] = useState<{ path: string; open: string | null }>({ path: pathname, open: activeGroup });
  const openGroup = openState.path === pathname ? openState.open : activeGroup;
  const toggleGroup = (key: string) => setOpenState({ path: pathname, open: openGroup === key ? null : key });
  // Collapsed: which group's floating menu is showing (closes on navigation too).
  const [flyState, setFlyState] = useState<{ path: string; key: string | null }>({ path: pathname, key: null });
  const flyKey = flyState.path === pathname ? flyState.key : null;
  const footerRef = useRef<HTMLDivElement>(null);

  // Close the account popover on outside click / Escape.
  useEffect(() => {
    if (!acctOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) setAcctOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAcctOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [acctOpen]);

  const label = account.name?.trim() || account.email;
  const initial = (label.trim().slice(0, 2) || "?").toUpperCase();

  const renderEntry = (entry: NavEntry) => {
    if (entry.kind === "group") {
      if (searching && !collapsed) {
        return <NavGroupRow key={entry.key} group={entry} open onToggle={() => {}} onNavigate={onNavigate} />;
      }
      return collapsed ? (
        <CollapsedGroup
          key={entry.key}
          group={entry}
          open={flyKey === entry.key}
          setOpen={(o) => setFlyState({ path: pathname, key: o ? entry.key : null })}
        />
      ) : (
        <NavGroupRow key={entry.key} group={entry} open={openGroup === entry.key} onToggle={() => toggleGroup(entry.key)} onNavigate={onNavigate} />
      );
    }
    return entry.countEndpoint ? (
      <InboxTabLink
        key={entry.key}
        href={entry.href}
        active={entry.active}
        countEndpoint={entry.countEndpoint}
        label={entry.label}
        icon={entry.icon}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
    ) : (
      <NavLink key={entry.key} item={entry} collapsed={collapsed} onNavigate={onNavigate} />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Brand homeHref={homeHref} collapsed={collapsed} onNavigate={onNavigate} />
      {searchable && !collapsed ? (
        <div className="shrink-0 px-2 pb-1.5">
          <label className="u-focus flex h-8 items-center gap-2 rounded-[9px] bg-sidebar-field px-2.5 text-sidebar-section max-xl:h-11">
            <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <input
              ref={(el) => {
                searchRef.current = el;
                if (el && focusOnMount.current) {
                  focusOnMount.current = false;
                  el.focus();
                }
              }}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown.first) {
                  e.preventDefault();
                  setQ("");
                  onNavigate?.();
                  router.push(shown.first);
                } else if (e.key === "Escape" && q) {
                  e.stopPropagation();
                  setQ("");
                }
              }}
              placeholder="Buscar sección"
              aria-label="Buscar sección del menú"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-fg outline-none placeholder:text-sidebar-section [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          <span role="status" className="sr-only">
            {searching ? (shown.count === 0 ? "Sin resultados" : `${shown.count} resultados`) : ""}
          </span>
        </div>
      ) : null}
      <nav
        aria-label="Primary"
        className={`flex min-h-0 flex-1 flex-col pb-2.5 pt-1 [scrollbar-width:none] ${collapsed ? "overflow-visible" : "overflow-y-auto"}`}
      >
        {searchable && collapsed ? (
          <button
            type="button"
            onClick={() => {
              focusOnMount.current = true;
              toggle();
            }}
            aria-label="Buscar sección del menú"
            data-tip="Buscar sección"
            className={`${RAIL_ROW} ${RAIL_H} u-rail-tip mb-1 w-[calc(100%-1rem)] justify-center px-0 ${RAIL_IDLE}`}
          >
            <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0" fill="none">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
        {searching && shown.count === 0 ? <p className="px-[18px] py-2 text-[13px] text-sidebar-section">Sin resultados</p> : null}
        {shown.sections.map((section, i) => (
          <div key={section.label} role="group" aria-label={section.label} className="flex flex-col gap-px">
            <SectionHeader label={section.label} collapsed={collapsed} first={i === 0} divider={section.divider} />
            {section.entries.map(renderEntry)}
          </div>
        ))}
        {shown.agency ? (
          // Apart, at the foot of the nav: the agency's tool, never the business's.
          <div role="group" aria-label="Agencia" className="mt-auto flex flex-col pt-3">
            <NavLink item={shown.agency} collapsed={collapsed} onNavigate={onNavigate} />
          </div>
        ) : null}
      </nav>

      {/* Fixed account footer — opens the SHARED account menu (same one the header uses).
          Flyout above when expanded, to the right when collapsed. No rule above it: the
          rail is one continuous ground (proposal), the spacing is the separation. */}
      <div ref={footerRef} className={`relative shrink-0 ${collapsed ? "p-2 pb-3" : "pb-3 pt-1"}`}>
        <button
          type="button"
          onClick={() => setAcctOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={acctOpen}
          aria-label={collapsed ? `Account: ${label}` : undefined}
          title={account.email}
          // The SAME row as the nav items above (RAIL_ROW): same inset, same 10px radius,
          // same hover. It used to be a full-width `rounded-lg` block with its own
          // padding, so the one row that is always on screen was the one row shaped
          // differently from every other.
          className={`${RAIL_ROW} w-[calc(100%-1.25rem)] text-sidebar-muted hover:bg-sidebar-hover hover:text-sidebar-fg ${
            collapsed
              ? "flex items-center justify-center p-1"
              : "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-2.5 py-2 text-left"
          }`}
        >
          <Avatar initial={initial} />
          {collapsed ? null : (
            <>
              {/* Track 2: starts AFTER the avatar's track + the gap, so the label can never
                  render on top of the avatar. minmax(0,1fr) lets it shrink below its content
                  width, which is what makes truncate work. */}
              <span className="flex min-w-0 flex-col overflow-hidden">
                <span className="truncate text-[13px] font-medium leading-tight text-sidebar-fg">{label}</span>
                <span className="truncate text-[11.5px] leading-tight text-sidebar-section">
                  {[ACCESS_LABEL[account.accessLabel ?? "agency"], account.clientLabel].filter(Boolean).join(" · ")}
                </span>
              </span>
              {/* The disclosure caret (design) — the footer opens the account menu. */}
              <span aria-hidden className="shrink-0 text-[0.5625rem] text-sidebar-section">▾</span>
            </>
          )}
        </button>

        {acctOpen ? (
          <div
            role="menu"
            className={`absolute z-50 overflow-hidden rounded-lg border border-line bg-popover ${
              collapsed ? "bottom-2 left-full ml-2 w-60" : "inset-x-2 bottom-full mb-2"
            }`}
          >
            <AccountMenu
              email={account.email}
              role={account.role}
              clientLabel={account.clientLabel}
              canSwitchClients={account.canSwitchClients}
              onNavigate={() => {
                setAcctOpen(false);
                onNavigate?.();
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Left navigation, below the full-width header.
 *
 * INSIDE A CLIENT (proposal "Mismo sidebar, tres bloques", lib/sectionNav.ts) — three
 * blocks split by a hairline, no headings:
 *   Operación     Inbox (live pending count), Contactos, Agenda ▸ Calendario · Equipo ·
 *                 Horarios y ausencias (pressing «Agenda» opens the calendar; its chevron
 *                 unfolds the pages)
 *   Negocio       Catálogo ▸, Presencia y marketing ▸, Dashboard de valor
 *   Herramientas  Configuración ▸, Automatizaciones ▸
 *   Módulos       apart at the foot, AGENCIA — agency-only plumbing.
 * One group open at a time; the open group follows the URL (a direct link opens its
 * section). The current page is the red pill; if its group is closed the pill moves to
 * the group, so "where am I" never disappears. Every row keeps its own module key and
 * server gate, and a section with no visible page is not rendered. NO individual
 * workflow names appear in the rail — switching workflows is the header's job.
 *
 * OUTSIDE A CLIENT: owner/admin get Clientes y workflows; a member gets a short list back
 * into their client. Members never see Usuarios y accesos of another client.
 *
 * Three responsive states: full rail (≥md), collapsed icon-only rail (≥md, toggled),
 * and an off-canvas drawer (<md). A fixed footer opens the shared account menu.
 * Reactive via usePathname; hidden on auth screens.
 */
export function AppSidebar({
  name,
  memberClientId,
  defaultClientId,
  enabledModules,
  adCounts,
  email,
  role,
  clientLabel,
  clientRole,
}: {
  /** Display name for the account footer; falls back to the email when absent. */
  name: string | null;
  memberClientId: string | null;
  /** The tenant's default/"Unassigned" client id (owner/admin; null for members or
   * logged-out) — the rail hides Modules for it (it can't have modules). */
  defaultClientId: string | null;
  /** clientId → ENABLED module keys (server-resolved). Drives Contacts/Agenda. */
  enabledModules: Record<string, string[]>;
  /** clientId → count of real (non-test) ads with no campaign yet — the Campañas nav badge. */
  adCounts: Record<string, number>;
  /** Signed-in user identity for the footer account menu. */
  email: string;
  role: "owner" | "admin" | "member";
  clientLabel: string | null;
  /** The client-level role (owner/setter/staff) for a member; null for the agency. */
  clientRole: "owner" | "setter" | "staff" | null;
}) {
  const pathname = usePathname();
  const { collapsed, mobileOpen, setMobileOpen, setCollapsed } = useSidebar();
  const { scopeFor } = useScope();

  // ONE-TIME carry-over of a collapsed preference saved before the cookie existed
  // (lib/sidebarCollapsed.ts). It runs HERE — in an effect of the rail itself, i.e. after
  // the rail has hydrated against the server HTML — never during hydration, which is
  // what used to break it. An explicit cookie always wins over the legacy value.
  useEffect(() => {
    if (hasSidebarCollapsedCookie(document.cookie)) return;
    let legacy: string | null = null;
    try {
      legacy = window.localStorage.getItem(LEGACY_SIDEBAR_COLLAPSED_KEY);
    } catch {
      return;
    }
    if (legacy === "1") setCollapsed(true);
  }, [setCollapsed]);

  // The phone/tablet menu is a modal drawer: focus moves in, Tab stays inside, Escape
  // closes it and focus returns to the control that opened it (useTrappedPanel).
  const drawerRef = useTrappedPanel({ active: mobileOpen, onClose: () => setMobileOpen(false) });

  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const clientId = parseClientId(pathname);
  const isMember = memberClientId !== null;
  // Brand target: the Hub for owner/admin; a member has no Hub access, so their brand
  // links to their own landing — the same rule as the server bounce (lib/landing.ts).
  const homeHref = memberClientId ? memberLandingPath(memberClientId, clientRole) : "/";
  const account: Account = {
    name,
    email,
    role,
    accessLabel: clientRole,
    clientLabel,
    canSwitchClients: memberClientId === null,
  };

  // Build the section model for the current context.
  let sections: NavSection[];
  let agency: NavItem | null = null;
  const links = (items: NavItem[]): NavEntry[] => items.map((it) => ({ kind: "link" as const, ...it }));
  if (clientId) {
    // The proposal's three blocks — Operación · Negocio · Herramientas — split by a
    // hairline, plus Módulos apart for the agency. A section with one visible page is a
    // direct link; with none it is not rendered. The flags inside buildSections are the
    // ones this rail always used (general / manage / insights, the scheduling module, the
    // default client); every page still gates itself on the server.
    const here = locate(clientId, pathname);
    const model = buildSections({
      clientId,
      modules: enabledModules[clientId] ?? [],
      isAgency: !isMember,
      clientRole,
      memberClientId,
      defaultClientId,
      workflowScope: scopeFor(clientId),
    });
    const ads = adCounts[clientId] ?? 0;
    const toEntry = (sec: ModelSection): NavEntry => {
      if (sec.kind === "group") {
        return {
          kind: "group",
          key: sec.id,
          label: sec.label,
          icon: SECTION_ICON[sec.id],
          active: here?.section === sec.id,
          homeHref: sec.homeHref,
          homeActive: here?.section === sec.id && sec.pages.some((pg) => pg.href === sec.homeHref && pg.id === here.page),
          pages: sec.pages.map((pg) => ({
            key: pg.id,
            label: pg.label,
            href: pg.href,
            active: here?.section === sec.id && here.page === pg.id,
            badge: pg.id === "campaigns" ? ads : undefined,
          })),
        };
      }
      const lone = sec.pages[0];
      return {
        kind: "link",
        key: sec.id,
        label: sec.label,
        href: sec.href,
        icon: PAGE_ICON[lone.id] ?? SECTION_ICON[sec.id],
        active: here?.section === sec.id,
        countEndpoint: sec.id === "inbox" ? `/api/inbox/${clientId}/pending-count` : undefined,
        badge: lone.id === "campaigns" ? ads : undefined,
      };
    };
    const BLOCK_LABEL = { 1: "Operación", 2: "Negocio", 3: "Herramientas" } as const;
    sections = ([1, 2, 3] as const)
      .map((block) => ({ label: BLOCK_LABEL[block], entries: model.filter((x) => x.block === block).map(toEntry), divider: true }))
      .filter((g) => g.entries.length > 0);
    const modules = model.find((x) => x.id === "agency");
    if (modules) {
      agency = { key: "modules", label: "Módulos", href: modules.href, icon: Icon.modules, active: here?.section === "agency", tag: "AGENCIA" };
    }
  } else if (isMember) {
    // A member landed OFF their client path (e.g. root) — a small stand-in until they
    // navigate in. Staff → agenda; SETTER → inbox (never insights); owner → Dashboard de valor.
    const m = (p: string) => `/clients/${memberClientId}${p}`;
    const memberModules = enabledModules[memberClientId] ?? [];
    const items: NavItem[] =
      clientRole === "staff"
        ? [{ key: "agenda", label: "Mi agenda", href: m("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(m("/scheduling")) }]
        : clientRole === "setter"
          ? memberModules.includes("inbox")
            ? [{ key: "inbox", label: "Inbox", href: m("/inbox"), icon: Icon.inbox, active: pathname.startsWith(m("/inbox")), countEndpoint: `/api/inbox/${memberClientId}/pending-count` }]
            : []
          : [{ key: "analytics", label: "Dashboard de valor", href: m("/analytics"), icon: Icon.overview, active: false }];
    if (clientRole !== "staff" && memberModules.includes("crm")) {
      items.push({ key: "contacts", label: "Contactos", href: m("/contacts"), icon: Icon.contacts, active: pathname.startsWith(m("/contacts")) });
    }
    if (clientRole !== "staff" && memberModules.includes("scheduling")) {
      items.push({ key: "agenda", label: "Agenda", href: m("/scheduling/agenda"), icon: Icon.agenda, active: pathname.startsWith(m("/scheduling")) });
    }
    if (clientRole !== "staff" && memberModules.includes("catalog")) {
      items.push({ key: "catalog", label: "Productos", href: m("/catalog"), icon: Icon.catalog, active: pathname.startsWith(m("/catalog")) });
    }
    if (clientRole !== "staff" && memberModules.includes("campaigns")) {
      items.push({
        key: "campaigns",
        label: "Campañas",
        href: m("/campaigns"),
        icon: Icon.campaigns,
        active: pathname.startsWith(m("/campaigns")),
        badge: adCounts[memberClientId] ?? 0,
      });
    }
    sections = [{ label: "Tu negocio", entries: links(items) }];
  } else {
    // Owner/admin tenant level (the Hub) — ONLY global surfaces. Scheduling is NOT
    // here: sites/services/staff/hours belong to a specific client and are
    // administered inside that client's workspace.
    sections = [
      {
        label: "Agencia",
        entries: links([
          {
            key: "clients",
            label: "Clientes y workflows",
            href: "/clients",
            icon: Icon.clients,
            active: pathname === "/clients" || pathname.startsWith("/clients/"),
          },
        ]),
      },
    ];
  }

  return (
    <>
      {/* DESKTOP rail — full or collapsed icon-only. Tablet and phone use the
          drawer so the operational surfaces keep their full working width. */}
      <aside
        data-collapsed={collapsed}
        style={collapsed ? undefined : { width: "var(--sidebar-width)" }}
        className={`hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar-bg transition-[width] duration-200 xl:flex ${
          collapsed ? "w-16" : ""
        }`}
      >
        <RailBody sections={sections} agency={agency} pathname={pathname} collapsed={collapsed} account={account} homeHref={homeHref} searchable={Boolean(clientId)} />
      </aside>

      {/* MOBILE drawer — off-canvas, over a backdrop. Always expanded content. */}
      {mobileOpen ? (
        <div className="xl:hidden">
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setMobileOpen(false)}
            className="fixed inset-0 z-40 bg-black/40"
          />
          <aside
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menú"
            tabIndex={-1}
            className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,86vw)] flex-col bg-sidebar-bg shadow-[var(--shadow-float)]"
          >
            <RailBody
              sections={sections}
              agency={agency}
              pathname={pathname}
              searchable={Boolean(clientId)}
              collapsed={false}
              account={account}
              homeHref={homeHref}
              onNavigate={() => setMobileOpen(false)}
            />
          </aside>
        </div>
      ) : null}
    </>
  );
}
