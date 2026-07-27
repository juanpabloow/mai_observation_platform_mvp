"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export interface SwitcherWorkflow {
  id: string;
  name: string | null;
  active: boolean | null;
}

interface FlatOption {
  key: string;
  /** The scope this option selects: "all" (the aggregate) or a workflow id. */
  scope: "all" | string;
  label: string;
}

/**
 * The CONTENTS of the header's workflow-SCOPE switcher popover (Phase W-1). Rendered
 * inside HeaderBar's portal panel (reuses the shell positioning + global outside-
 * click/Escape close). It:
 *   - autofocuses a "Search workflows…" field (filters name + id);
 *   - offers "All workflows" as the FIRST, visually-set-apart option (the aggregate);
 *   - groups the rest into Active / Inactive with a status dot;
 *   - marks the CURRENT scope with a ✓.
 * It is purely a PICKER: selecting an option calls `onSelect(scope)` with "all" or a
 * workflow id — the host (HeaderBar) remembers the scope (cookie + context) and
 * navigates, preserving the current section (Executions / Analytics / Inbox). Keyboard:
 * ↑/↓ move a roving aria-activedescendant, Enter selects, Escape closes (host).
 */
export function WorkflowSwitcherPanel({
  clientName,
  workflows,
  currentScope,
  onSelect,
}: {
  clientName: string | null;
  workflows: SwitcherWorkflow[];
  /** The remembered scope: "all" or a workflow id — drives the ✓. */
  currentScope: "all" | string;
  onSelect: (scope: "all" | string) => void;
}) {
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = "workflow-switcher-listbox";

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const needle = q.trim().toLowerCase();
  const matchWf = (w: SwitcherWorkflow): boolean =>
    !needle ||
    (w.name ?? "").toLowerCase().includes(needle) ||
    w.id.toLowerCase().includes(needle);

  const activeWfs = workflows.filter((w) => (w.active ?? false) && matchWf(w));
  const inactiveWfs = workflows.filter((w) => !(w.active ?? false) && matchWf(w));
  const showAll = !needle || "all workflows".includes(needle);

  // Flat navigable option list in visual order — the source of truth for keyboard
  // navigation + aria-activedescendant.
  const options = useMemo<FlatOption[]>(() => {
    const opts: FlatOption[] = [];
    if (showAll) opts.push({ key: "all", scope: "all", label: "All workflows" });
    for (const w of activeWfs) opts.push({ key: w.id, scope: w.id, label: w.name ?? w.id });
    for (const w of inactiveWfs) opts.push({ key: w.id, scope: w.id, label: w.name ?? w.id });
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from props+query above
  }, [q, workflows]);

  const clamped = options.length === 0 ? -1 : Math.min(activeIndex, options.length - 1);
  const activeOptionId = clamped >= 0 ? `wf-opt-${clamped}` : undefined;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[clamped];
      if (o) onSelect(o.scope);
    }
  };

  // Row renderer — `index` is the flat option index (for id + highlight).
  const row = (o: FlatOption, index: number, dot?: boolean, dotActive?: boolean) => {
    const highlighted = index === clamped;
    const selected = o.scope === currentScope;
    return (
      <button
        key={o.key}
        id={`wf-opt-${index}`}
        role="option"
        aria-selected={highlighted}
        type="button"
        onClick={() => onSelect(o.scope)}
        onMouseEnter={() => setActiveIndex(index)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
          highlighted ? "bg-black/[0.05] dark:bg-subtle" : ""
        }`}
      >
        {dot ? (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotActive ? "bg-green-400" : "bg-neutral-500"}`}
          />
        ) : null}
        <span className={`truncate ${o.scope === "all" ? "font-medium" : ""}`}>{o.label}</span>
        {selected ? <span aria-hidden className="ml-auto text-xs text-accent">✓</span> : null}
      </button>
    );
  };

  // Precompute group offsets so each rendered row gets its flat index.
  const allCount = showAll ? 1 : 0;
  const activeStart = allCount;
  const inactiveStart = allCount + activeWfs.length;

  return (
    <div onKeyDown={onKeyDown}>
      <div className="border-b border-line p-2">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActiveIndex(0);
          }}
          placeholder="Search workflows…"
          className="h-8 w-full rounded-lg border border-black/10 bg-transparent px-2.5 text-sm outline-none focus:border-line-strong dark:border-line-strong"
        />
      </div>

      <div id={listboxId} role="listbox" aria-label="Workflows" className="max-h-72 overflow-y-auto py-1">
        {options.length === 0 ? (
          <p className="px-3 py-2 text-xs text-neutral-500">No workflows match.</p>
        ) : (
          <>
            {/* "All workflows" — the first, visually set-apart option (the everything view). */}
            {showAll ? <div className="border-b border-line pb-1">{row(options[0], 0)}</div> : null}

            {activeWfs.length > 0 ? (
              <div role="group" aria-label="Active">
                <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  Active
                </p>
                {activeWfs.map((w, j) => row(options[activeStart + j], activeStart + j, true, true))}
              </div>
            ) : null}

            {inactiveWfs.length > 0 ? (
              <div role="group" aria-label="Inactive">
                <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  Inactive
                </p>
                {inactiveWfs.map((w, k) => row(options[inactiveStart + k], inactiveStart + k, true, false))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {clientName ? (
        <p className="border-t border-line px-3 py-1.5 text-[10px] text-faint">Workflows in {clientName}</p>
      ) : null}
    </div>
  );
}
