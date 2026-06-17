"use client";

import { useState, type ReactNode } from "react";

/**
 * Lightweight, collapsible JSON tree. Custom-built (no dependency) so we fully
 * control truncation.
 *
 * Default view is EXPANDED: objects and arrays auto-open so the payload shows
 * without click-through — EXCEPT containers larger than AUTO_EXPAND_CONTAINER_MAX
 * (e.g. a 1536-element embedding) stay collapsed and are never rendered to the
 * DOM until the user expands them (then capped at ARRAY_RENDER_CAP items). Long
 * strings are previewed. This keeps the page responsive on multi-MB payloads —
 * we never render a huge array/string just because the default is "expanded".
 */

// Containers with more children than this stay COLLAPSED by default. This is the
// freeze guard: an embedding vector (1536 numbers) is far above the threshold,
// so it renders as a collapsed summary, not 1536 DOM nodes.
const AUTO_EXPAND_CONTAINER_MAX = 50;
const ARRAY_RENDER_CAP = 200; // hard cap on items rendered even when expanded
const STRING_PREVIEW = 140;
const STRING_MAX = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Auto-expand small containers; force-collapse oversized ones (freeze guard). */
function shouldAutoExpand(value: unknown): boolean {
  if (Array.isArray(value)) return value.length <= AUTO_EXPAND_CONTAINER_MAX;
  if (isPlainObject(value)) return Object.keys(value).length <= AUTO_EXPAND_CONTAINER_MAX;
  return false;
}

function KeyLabel({ name }: { name?: string }) {
  if (name === undefined) return null;
  return <span className="text-sky-700 dark:text-sky-300">{name}: </span>;
}

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  if (value.length <= STRING_PREVIEW) {
    return <span className="break-words text-success">&quot;{value}&quot;</span>;
  }

  if (!expanded) {
    return (
      <span className="break-words text-success">
        &quot;{value.slice(0, STRING_PREVIEW)}…&quot;{" "}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-sky-700 dark:text-sky-400 hover:underline"
        >
          (show {value.length.toLocaleString()} chars)
        </button>
      </span>
    );
  }

  const truncated = value.length > STRING_MAX;
  return (
    <span className="whitespace-pre-wrap break-words text-success">
      &quot;{value.slice(0, STRING_MAX)}{truncated ? "…" : ""}&quot;{" "}
      {truncated ? (
        <span className="text-xs text-amber-700/80 dark:text-amber-400/80">
          ({(value.length - STRING_MAX).toLocaleString()} chars truncated)
        </span>
      ) : null}{" "}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="text-xs text-sky-700 dark:text-sky-400 hover:underline"
      >
        (collapse)
      </button>
    </span>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-neutral-500">null</span>;
  if (typeof value === "boolean")
    return <span className="text-purple-700 dark:text-purple-400">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-amber-700 dark:text-amber-300">{value}</span>;
  if (typeof value === "string") return <StringValue value={value} />;
  return <span className="text-muted">{String(value)}</span>;
}

function Container({
  name,
  bracket,
  count,
  unit,
  oversized,
  autoExpand,
  children,
}: {
  name?: string;
  bracket: "array" | "object";
  count: number;
  unit: string;
  oversized: boolean;
  autoExpand: boolean;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(autoExpand);
  const [lb, rb] = bracket === "array" ? ["[", "]"] : ["{", "}"];
  // Make it explicit when a container is collapsed for size reasons.
  const note = !open && oversized ? " — collapsed" : "";
  const summary = `${lb} ${count.toLocaleString()} ${unit}${note} ${rb}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-start gap-1 text-left hover:text-foreground"
      >
        <span className="select-none text-neutral-500">{open ? "▾" : "▸"}</span>
        <span>
          <KeyLabel name={name} />
          <span className="text-neutral-500">{summary}</span>
        </span>
      </button>
      {open ? <div className="ml-3 border-l border-line pl-3">{children()}</div> : null}
    </div>
  );
}

function ContainerNode({ name, value }: { name?: string; value: unknown }) {
  const autoExpand = shouldAutoExpand(value);

  if (Array.isArray(value)) {
    const numeric = value.length > 0 && value.every((x) => typeof x === "number");
    const unit = numeric ? "numbers" : value.length === 1 ? "item" : "items";
    const shown = value.slice(0, ARRAY_RENDER_CAP);
    const hidden = value.length - shown.length;
    return (
      <Container
        name={name}
        bracket="array"
        count={value.length}
        unit={unit}
        oversized={!autoExpand}
        autoExpand={autoExpand}
      >
        {() => (
          <>
            {shown.map((item, i) => (
              <JsonTree key={i} name={String(i)} value={item} />
            ))}
            {hidden > 0 ? (
              <div className="py-1 text-xs text-amber-700/80 dark:text-amber-400/80">
                … {hidden.toLocaleString()} more items not shown (showing first{" "}
                {ARRAY_RENDER_CAP})
              </div>
            ) : null}
          </>
        )}
      </Container>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return (
    <Container
      name={name}
      bracket="object"
      count={entries.length}
      unit={entries.length === 1 ? "key" : "keys"}
      oversized={!autoExpand}
      autoExpand={autoExpand}
    >
      {() => entries.map(([k, v]) => <JsonTree key={k} name={k} value={v} />)}
    </Container>
  );
}

export function JsonTree({ name, value }: { name?: string; value: unknown }) {
  if (Array.isArray(value) || isPlainObject(value)) {
    return <ContainerNode name={name} value={value} />;
  }
  return (
    <div className="py-0.5">
      <KeyLabel name={name} />
      <PrimitiveValue value={value} />
    </div>
  );
}
