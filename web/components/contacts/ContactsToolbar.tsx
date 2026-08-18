"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CONTROL_CLS, SEARCH_SHELL_CLS } from "@/components/ui/primitives";
import { OPTIONAL_COLUMNS, type ContactColumnKey } from "@/lib/contactColumns";

/**
 * The Contacts toolbar: the REAL search (Enter submits), the Stage / Owner / Tasks
 * facets, and the Columns menu. Every control is a pure URL-param writer — it
 * never holds list state of its own, so the server page stays the single source
 * of truth, deep links keep working, and `from` (the origin workflow) survives
 * every interaction. Changing any facet also drops `cursor`, because a keyset
 * cursor from the previous filter set is meaningless against a new one.
 */
export function ContactsToolbar({ owners }: { owners: { userId: string; label: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const q = searchParams.get("q") ?? "";
  const stage = searchParams.get("stage") ?? "";
  const owner = searchParams.get("owner") ?? "";
  const tasks = searchParams.get("tasks") ?? "";

  // Typing is local; a navigation that CHANGES `q` (Back/Forward, a cleared search,
  // a deep link) re-seeds the box. State is adjusted DURING render against the
  // tracked previous value — React's documented alternative to a setState-in-effect,
  // and the same pattern HeaderBar uses to react to a route change.
  const [draft, setDraft] = useState(q);
  const [lastQ, setLastQ] = useState(q);
  if (lastQ !== q) {
    setLastQ(q);
    if (draft !== q) setDraft(q);
  }

  /** Write one facet, always resetting the keyset cursor. */
  const apply = (patch: Record<string, string>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    p.delete("cursor");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
      {/* Search — a real form so Enter submits (and so it works before hydration). */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: draft.trim() });
        }}
        className={`${SEARCH_SHELL_CLS} min-w-[220px] max-w-[420px] flex-1`}
      >
        <SearchIcon />
        <input
          name="q"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Buscar nombre, email o teléfono…"
          aria-label="Buscar contactos"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint"
        />
        {/* A key badge, not a sentence: the reference shows the glyph the reader
            presses, which stays legible at any width. */}
        <span
          aria-hidden
          className="u-mono hidden shrink-0 rounded border border-line-strong bg-surface px-1.5 text-[0.625rem] leading-4 text-faint sm:inline"
        >
          ↵
        </span>
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
        ) : null}
      </form>

      <Facet
        label="Stage"
        value={stage}
        onChange={(v) => apply({ stage: v })}
        options={[
          { value: "", label: "Cualquier stage" },
          { value: "new", label: "Nuevo" },
          { value: "active", label: "Activo" },
          { value: "customer", label: "Cliente" },
          { value: "archived", label: "Archivado" },
        ]}
      />
      <Facet
        label="Dueño"
        value={owner}
        onChange={(v) => apply({ owner: v })}
        options={[
          { value: "", label: "Cualquier dueño" },
          { value: "unassigned", label: "Sin dueño" },
          ...owners.map((o) => ({ value: o.userId, label: o.label })),
        ]}
      />
      <Facet
        label="Tareas"
        value={tasks}
        onChange={(v) => apply({ tasks: v })}
        options={[
          { value: "", label: "Cualquier tarea" },
          { value: "open", label: "Con tareas abiertas" },
          { value: "overdue", label: "Con tareas vencidas" },
        ]}
      />
    </div>
  );
}

/**
 * One facet control. A native <select> under a styled shell: it keeps full
 * keyboard + screen-reader behavior and the platform's own popup (no portal, no
 * focus trap to get wrong), while reading as the reference's "Stage ⌄" pill. The
 * visible label shows the ACTIVE option so the filter state is never hidden.
 */
function Facet({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const active = value !== "";
  const current = options.find((o) => o.value === value);
  return (
    <div
      className={`relative ${CONTROL_CLS} ${active ? "border-brand/45 bg-brand-soft text-brand" : ""}`}
    >
      <span className="pointer-events-none whitespace-nowrap">
        {label}
        {active && current ? <span className="font-medium">: {current.label}</span> : null}
      </span>
      <Chevron />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value || "any"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Columns — toggles which OPTIONAL columns render. Purely presentational: it
 * writes `?cols=` and nothing else, so it can never change which rows or values
 * the table shows (the required columns are not togglable).
 */
export function ContactsColumnsMenu({ visibleColumns }: { visibleColumns: ContactColumnKey[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const visible = visibleColumns;
  /** Writes ONLY `?cols=`, preserving every other param. Presentational by
   *  construction: it can never reach a query. */
  const onApply = (cols: ContactColumnKey[]) => {
    const p = new URLSearchParams(searchParams.toString());
    if (cols.length) p.set("cols", cols.join(","));
    else p.delete("cols");
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
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

  const toggle = (key: ContactColumnKey) => {
    const next = visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key];
    onApply(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="u-th inline-flex h-[var(--control-h)] shrink-0 items-center gap-1 rounded-md px-2 transition-colors hover:text-foreground"
      >
        Columnas
        <Chevron />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-line bg-popover py-1"
        >
          <p className="u-th px-3 py-1.5">Optional columns</p>
          {OPTIONAL_COLUMNS.map((c) => (
            <label
              key={c.key}
              className="flex min-h-10 cursor-pointer items-center gap-2.5 px-3 text-sm text-foreground transition-colors hover:bg-subtle"
            >
              <input
                type="checkbox"
                checked={visible.includes(c.key)}
                onChange={() => toggle(c.key)}
                className="size-3.5 accent-[var(--brand)]"
              />
              {c.label}
            </label>
          ))}
        </div>
      ) : null}
    </div>
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

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3 shrink-0 opacity-60" fill="none">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
