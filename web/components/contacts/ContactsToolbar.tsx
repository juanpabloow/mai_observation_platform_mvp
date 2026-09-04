"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { GHOST_ACTION_CLS, OUTLINE_CLS, SEARCH_SHELL_CLS } from "@/components/ui/primitives";
import { OPTIONAL_COLUMNS, type ContactColumnKey } from "@/lib/contactColumns";

/**
 * The Contacts screen's CONTROLS, split the way the redesign splits them
 * (docs/ui-redesign-crm-inbox.md §2.1–2.2).
 *
 * This file used to export one `ContactsToolbar` that drew a search box and three
 * `<select>` facets in a single row. The design breaks that into three places, and the
 * split is the point:
 *
 *   - the SEARCH moves up into the title row, wide, as the screen's primary verb;
 *   - the common facets become a segmented pill row WITH COUNTS, rendered by the page
 *     (server-side, from the summary it already queries) — see `FacetPills`;
 *   - what is left — the facets that are not one-of-five, plus sort and columns — sits
 *     right-aligned beside the pills behind `Filtrar` / `Orden` / `Columnas`.
 *
 * Every control here is still a pure URL-param writer. It never holds list state of its
 * own, so the server page stays the single source of truth, deep links keep working, and
 * `from` (the origin workflow) survives every interaction.
 *
 * Anything that changes WHICH ROWS match also drops `page` and `cursor`: a page number
 * from the previous filter set points at a different set of people, and a keyset cursor
 * from it is meaningless.
 */

/** Params that describe the current result SET, and so must reset paging when touched. */
const PAGING_PARAMS = ["page", "cursor"] as const;

/** Shared writer: apply a patch, drop paging, keep everything else. */
function useApply() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return {
    searchParams,
    apply: (patch: Record<string, string>, opts: { keepPaging?: boolean } = {}) => {
      const p = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v) p.set(k, v);
        else p.delete(k);
      }
      if (!opts.keepPaging) for (const k of PAGING_PARAMS) p.delete(k);
      const qs = p.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
  };
}

/**
 * THE search field, for the title row.
 *
 * A real `<form>` so Enter submits and it works before hydration. Typing is local; a
 * navigation that CHANGES `q` (Back/Forward, a cleared search, a deep link) re-seeds the
 * box. State is adjusted DURING render against the tracked previous value — React's
 * documented alternative to a setState-in-effect.
 *
 * The design gives this a transparent 1.5px border that only appears on hover, over the
 * `--chip` fill. That is what makes it read as a place to TYPE rather than as one more
 * button in the row, which is exactly what it looked like when it was a bordered control
 * sitting between two dropdowns.
 */
export function ContactsSearch({ compact = false }: { compact?: boolean } = {}) {
  const { searchParams, apply } = useApply();
  const q = searchParams.get("q") ?? "";

  const [draft, setDraft] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (lastQ !== q) {
    setLastQ(q);
    if (draft !== q) setDraft(q);
  }

  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        apply({ q: draft.trim() });
      }}
      // The SHARED shell (§2.1). Only the SIZING is local: the search takes the row's
      // slack, capped at the artboard's 420px — and tightens to 240px with a shorter
      // placeholder when the detail panel is open (design frame 20f), so the toolbar
      // stays on one line beside the narrowed table.
      className={`${SEARCH_SHELL_CLS} min-w-0 flex-1 ${compact ? "max-w-[240px]" : "max-w-[420px]"}`}
    >
      <SearchIcon />
      <input
        name="q"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={compact ? "Buscar contacto…" : "Buscar nombre, email o teléfono…"}
        aria-label="Buscar contactos"
        className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
      />
      {q ? (
        <button
          type="button"
          onClick={() => {
            setDraft("");
            apply({ q: "" });
          }}
          aria-label="Limpiar búsqueda"
          className="u-tap shrink-0 rounded text-faint transition-colors hover:text-foreground"
        >
          ✕
        </button>
      ) : (
        // A key badge, not a sentence: the reader sees the glyph they press, which stays
        // legible at any width.
        <span
          aria-hidden
          className="u-mono hidden shrink-0 rounded-sm border border-line-strong bg-surface px-1.5 text-[0.625rem] leading-4 text-faint sm:inline"
        >
          ↵
        </span>
      )}
    </form>
  );
}

/**
 * A small dismissable popover. Shared by `Filtrar`, `Orden` and `Columnas` so the three
 * behave identically — click-outside and Escape both close, and the trigger reports its
 * own expanded state.
 */
function Menu({
  label,
  icon,
  active = false,
  align = "right",
  width = "w-56",
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  /** Marks the trigger when the menu holds a filter that is currently ON. */
  active?: boolean;
  align?: "left" | "right";
  width?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${OUTLINE_CLS} ${active ? "border-ink text-foreground" : ""}`}
      >
        {icon}
        {label}
        <Chevron />
      </button>
      {open ? (
        <div
          role="menu"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full z-50 mt-1 ${width} overflow-hidden rounded-lg border border-line bg-popover py-1 shadow-[var(--shadow-float)]`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/** A radio-like row inside a Menu. */
function MenuOption({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-h-9 w-full items-center gap-2 px-3 text-left text-sm transition-colors hover:bg-subtle ${
        selected ? "font-medium text-foreground" : "text-muted"
      }`}
    >
      <span aria-hidden className={`w-3 shrink-0 text-center ${selected ? "" : "opacity-0"}`}>
        ✓
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1 pt-2 text-[0.6875rem] font-semibold text-faint">{children}</p>;
}

/**
 * `Filtrar` — the facets the pill row cannot hold.
 *
 * The pills cover the five buckets an operator lives in (all / new / active / customer /
 * unowned) because those are the ones worth a permanent, counted control. This holds the
 * rest: a SPECIFIC owner, the task filters, and the archived stage. They are here rather
 * than as more pills because a row of twelve pills stops being scannable, and because
 * these compose WITH a pill (owner "Paola" ∧ stage "Clientes") where the pills
 * themselves are one-of-N.
 */
export function ContactsFilterMenu({ owners }: { owners: { userId: string; label: string }[] }) {
  const { searchParams, apply } = useApply();
  const owner = searchParams.get("owner") ?? "";
  const tasks = searchParams.get("tasks") ?? "";
  const stage = searchParams.get("stage") ?? "";
  // "Sin dueño" and the three live stages are the PILLS' job; a filter is only "on" here
  // when it is something the pills cannot express.
  const activeHere = tasks !== "" || stage === "archived" || (owner !== "" && owner !== "unassigned");

  return (
    <Menu label="Filtrar" icon={<FilterIcon />} active={activeHere} width="w-60">
      {(close) => (
        <>
          <MenuLabel>Tareas</MenuLabel>
          {[
            { value: "", label: "Cualquier tarea" },
            { value: "open", label: "Con tareas abiertas" },
            { value: "overdue", label: "Con tareas vencidas" },
          ].map((o) => (
            <MenuOption
              key={o.value || "any"}
              label={o.label}
              selected={tasks === o.value}
              onSelect={() => {
                apply({ tasks: o.value });
                close();
              }}
            />
          ))}

          <MenuLabel>Dueño</MenuLabel>
          <MenuOption
            label="Cualquier dueño"
            selected={owner === ""}
            onSelect={() => {
              apply({ owner: "" });
              close();
            }}
          />
          {owners.map((o) => (
            <MenuOption
              key={o.userId}
              label={o.label}
              selected={owner === o.userId}
              onSelect={() => {
                apply({ owner: o.userId });
                close();
              }}
            />
          ))}

          <MenuLabel>Archivados</MenuLabel>
          <MenuOption
            label="Mostrar archivados"
            selected={stage === "archived"}
            onSelect={() => {
              apply({ stage: stage === "archived" ? "" : "archived" });
              close();
            }}
          />
        </>
      )}
    </Menu>
  );
}

/**
 * `Orden` — the design's "Orden: última visita".
 *
 * The list is ordered by `last_contact_at DESC` in SQL and that is the only order the
 * repository supports today, so this control offers exactly that one option and says so.
 * It exists in the redesign, so it exists here; wiring a second sort is a repository
 * change (the keyset cursor is built on that column pair), not a UI one, and shipping a
 * dropdown whose other entries silently did nothing would be worse than shipping one
 * honest entry.
 */
export function ContactsSortMenu() {
  return (
    <Menu label="Orden" width="w-64">
      {() => (
        <>
          <MenuOption label="Última interacción (más reciente)" selected onSelect={() => {}} />
          <p className="px-3 pb-2 pt-1 text-[0.6875rem] leading-4 text-faint">
            Otros órdenes necesitan un cambio en el listado del servidor — el cursor de
            paginación se construye sobre esta columna.
          </p>
        </>
      )}
    </Menu>
  );
}

/**
 * `Columnas` — toggles the OPTIONAL columns.
 *
 * The design's table is seven fixed columns and has no such control. It survives because
 * those six optional columns were real function (a shop that works by stage, or watches
 * consent), and a visual rework should not quietly delete capability. The DEFAULT view is
 * the artboard exactly; these append after `Dueño` only when asked for.
 *
 * Purely presentational by construction: it writes `?cols=` and nothing else, so it can
 * never change which rows or values the table shows — which is also why it does NOT drop
 * paging (`keepPaging`), unlike every other control in this file.
 */
export function ContactsColumnsMenu({ visibleColumns }: { visibleColumns: ContactColumnKey[] }) {
  const { apply } = useApply();
  const visible = visibleColumns;
  const toggle = (key: ContactColumnKey) => {
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    apply({ cols: next.join(",") }, { keepPaging: true });
  };

  return (
    <Menu label="Columnas" active={visible.length > 0} width="w-56">
      {() => (
        <>
          <MenuLabel>Columnas opcionales</MenuLabel>
          {OPTIONAL_COLUMNS.map((c) => (
            <label
              key={c.key}
              className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 text-sm text-foreground transition-colors hover:bg-subtle"
            >
              <input
                type="checkbox"
                checked={visible.includes(c.key)}
                onChange={() => toggle(c.key)}
                className="size-3.5 accent-[var(--ink)]"
              />
              {c.label}
            </label>
          ))}
        </>
      )}
    </Menu>
  );
}

/**
 * `Exportar` — the current filtered view as CSV.
 *
 * A link, not a fetch: it points at the export route with the SAME query string the list
 * is showing, so what downloads is what is on screen (filters, search and all) and the
 * browser owns the download. Nothing is held in memory here.
 */
export function ContactsExportLink({ clientId }: { clientId: string }) {
  const { searchParams } = useApply();
  const p = new URLSearchParams(searchParams.toString());
  // Paging and panel state are about the VIEW, not the result set — an export is the
  // whole filtered set, not page 3 of it.
  for (const k of [...PAGING_PARAMS, "c", "edit", "cols"]) p.delete(k);
  const qs = p.toString();
  return (
    <a
      href={`/api/crm/v1/contacts/export/${clientId}${qs ? `?${qs}` : ""}`}
      className={GHOST_ACTION_CLS}
      // A same-origin download; `download` lets the route's filename win.
      download
    >
      <ExportIcon />
      Exportar
    </a>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 shrink-0 text-faint" fill="none">
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none">
      <path
        d="M2 4h12M4.5 8h7M6.5 12h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 shrink-0" fill="none">
      <path
        d="M8 2.5V10.5M8 10.5 5.4 7.8M8 10.5l2.6-2.7M2.5 10v2.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3 shrink-0 opacity-60" fill="none">
      <path
        d="m4.5 6.5 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
