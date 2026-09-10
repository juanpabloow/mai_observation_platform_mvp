"use client";

import Link from "next/link";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OUTLINE_CLS, SEARCH_SHELL_CLS } from "@/components/ui/primitives";
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
      // The SHARED shell (§2.1). Sizing is local: it NEVER drops below 240px
      // (min-w-[15rem]) so the field can't compress to just its icon, and it now
      // takes ALL the slack in the row.
      //
      // The 420px cap is gone. It existed when the header held six controls and the
      // search had to leave room for them; with the actions folded into `···` there
      // are three, and capping the field just left a band of empty card between the
      // input and `Filtrar`. Search is this screen's primary verb — it should be the
      // widest thing in the row.
      className={`${SEARCH_SHELL_CLS} min-w-[15rem] flex-1 ${compact ? "max-w-[240px]" : ""}`}
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
  iconOnly = false,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  /** Marks the trigger when the menu holds a filter that is currently ON. */
  active?: boolean;
  align?: "left" | "right";
  width?: string;
  /** `···` form: the icon alone, with `label` as the accessible name. Used by
   *  the overflow menu, where a visible label would defeat the point. */
  iconOnly?: boolean;
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
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
        className={
          iconOnly
            ? `inline-flex size-[var(--control-h)] shrink-0 items-center justify-center rounded-lg border text-muted transition-colors hover:text-foreground ${
                open || active ? "border-faint text-foreground" : "border-line-strong"
              }`
            : `${OUTLINE_CLS} ${active ? "border-ink text-foreground" : ""}`
        }
      >
        {icon}
        {iconOnly ? null : label}
        {iconOnly ? null : <Chevron />}
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE OVERFLOW MENU — `···`

   The control band used to lay out six controls in a row: Filtrar, Orden,
   Columnas, Exportar, Campos del negocio and the primary. Past four the row
   stops being a hierarchy and becomes a wall, and on a laptop with the detail
   panel open it wrapped to a second line — which moved the primary and made
   the header's height depend on the viewport.

   What stays visible is what an operator uses every session: the SEARCH, the
   FILTER, and the PRIMARY. Everything else is one click away in here.

   Two-level, in ONE popover: the root lists the actions, and Columnas / Orden
   swap the panel's contents rather than opening a nested menu — a submenu that
   opens sideways off a 224px popover has nowhere to go on a narrow window.

   "Importar contactos" IS in the menu, because the header's shape is part of the
   spec — but it is INERT and says so. Import is a feature (file upload, column
   mapping, dedup against the C-2 identity spine), not a restyle, and there is no
   route behind it yet. `aria-disabled` + the "Pronto" tag is the honest form:
   the slot is reserved and visible, and nobody clicks into a dead end. Enabling
   it later is one line — swap the <span> for a <Link href={importHref}>.
   ═══════════════════════════════════════════════════════════════════════════ */

function ItemIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.split("|").map((seg) => (
        <path key={seg} d={seg} />
      ))}
    </svg>
  );
}

const ITEM_CLS =
  "flex min-h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-foreground no-underline transition-colors hover:bg-subtle";

export function ContactsOverflowMenu({
  clientId,
  visibleColumns,
  fieldsHref,
}: {
  clientId: string;
  visibleColumns: ContactColumnKey[];
  /** Omitted for a member — they cannot manage the business's fields. */
  fieldsHref?: string;
}) {
  const { searchParams, apply } = useApply();
  const [view, setView] = useState<"root" | "columns" | "sort">("root");

  const toggleColumn = (key: ContactColumnKey) => {
    const next = visibleColumns.includes(key) ? visibleColumns.filter((k) => k !== key) : [...visibleColumns, key];
    apply({ cols: next.join(",") }, { keepPaging: true });
  };

  // The export URL describes the FILTERED SET, not the current page.
  const exportParams = new URLSearchParams(searchParams.toString());
  for (const k of [...PAGING_PARAMS, "c", "edit", "cols"]) exportParams.delete(k);
  const exportQs = exportParams.toString();

  const Back = ({ title }: { title: string }) => (
    <button
      type="button"
      onClick={() => setView("root")}
      className="flex min-h-9 w-full items-center gap-2 border-b border-line-row px-3 text-left text-[0.71875rem] font-semibold text-muted transition-colors hover:text-foreground"
    >
      <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9.5 3.5 5 8l4.5 4.5" />
      </svg>
      {title}
    </button>
  );

  return (
    <Menu
      label="Más acciones"
      iconOnly
      width="w-64"
      active={visibleColumns.length > 0}
      icon={
        <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
          <circle cx="3" cy="8" r="1.35" />
          <circle cx="8" cy="8" r="1.35" />
          <circle cx="13" cy="8" r="1.35" />
        </svg>
      }
    >
      {(close) => {
        if (view === "columns") {
          return (
            <>
              <Back title="Columnas" />
              {OPTIONAL_COLUMNS.map((c) => (
                <label key={c.key} className="flex min-h-9 cursor-pointer items-center gap-2.5 px-3 text-sm transition-colors hover:bg-subtle">
                  <input
                    type="checkbox"
                    checked={visibleColumns.includes(c.key)}
                    onChange={() => toggleColumn(c.key)}
                    className="size-3.5 rounded border-line-strong"
                  />
                  <span className="flex-1">{c.label}</span>
                </label>
              ))}
            </>
          );
        }
        if (view === "sort") {
          return (
            <>
              <Back title="Ordenar por" />
              <MenuOption label="Última interacción (más reciente)" selected onSelect={() => {}} />
              <p className="px-3 pb-2 pt-1 text-[0.6875rem] leading-4 text-faint">
                Otros órdenes necesitan un cambio en el listado del servidor — el cursor de paginación se construye sobre esta columna.
              </p>
            </>
          );
        }
        return (
          <>
            <button type="button" onClick={() => setView("columns")} className={ITEM_CLS}>
              <ItemIcon d="M2.8 3.2h10.4v9.6H2.8V3.2Z|M6.6 3.2v9.6|M10.4 3.2v9.6" />
              <span className="flex-1">Columnas</span>
              {visibleColumns.length > 0 ? <span className="u-mono text-[0.65625rem] text-faint">{visibleColumns.length}</span> : null}
            </button>
            <button type="button" onClick={() => setView("sort")} className={ITEM_CLS}>
              <ItemIcon d="M4.4 3.4v9.2|M2.6 10.8l1.8 1.8 1.8-1.8|M11.6 12.6V3.4|M9.8 5.2l1.8-1.8 1.8 1.8" />
              <span className="flex-1">Orden: última interacción</span>
            </button>

            <div className="my-1 border-t border-line-row" />

            <span
              role="menuitem"
              aria-disabled="true"
              title="La importación necesita subida de archivo y mapeo de columnas; todavía no está disponible."
              className={`${ITEM_CLS} cursor-not-allowed text-muted hover:bg-transparent`}
            >
              <ItemIcon d="M8 9.6V2.8|M5.4 5.4 8 2.8l2.6 2.6|M3.2 12.4h9.6" />
              <span className="flex-1">Importar contactos</span>
              <span className="shrink-0 rounded border border-line-strong px-1 text-[0.625rem] uppercase tracking-wide text-faint">
                Pronto
              </span>
            </span>

            <a
              href={`/api/crm/v1/contacts/export/${clientId}${exportQs ? `?${exportQs}` : ""}`}
              download
              onClick={close}
              className={ITEM_CLS}
            >
              <ItemIcon d="M8 2.8v6.8|M5.4 7l2.6 2.6L10.6 7|M3.2 12.4h9.6" />
              <span className="flex-1">Exportar CSV</span>
            </a>

            {fieldsHref ? (
              <>
                <div className="my-1 border-t border-line-row" />
                <Link href={fieldsHref} onClick={close} className={ITEM_CLS}>
                  <ItemIcon d="M2.8 2.8h4.6v4.6H2.8V2.8Z|M8.6 2.8h4.6v4.6H8.6V2.8Z|M2.8 8.6h4.6v4.6H2.8V8.6Z|M8.6 8.6h4.6v4.6H8.6V8.6Z" />
                  <span className="flex-1">Campos del negocio</span>
                </Link>
              </>
            ) : null}
          </>
        );
      }}
    </Menu>
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
