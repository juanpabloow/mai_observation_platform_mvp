"use client";

import { useState } from "react";

/**
 * Lightweight, collapsible JSON tree. Custom-built (no dependency) so we fully
 * control truncation: nested containers are collapsed by default beyond a small
 * depth and never render their children until expanded; long arrays are capped
 * when expanded; long strings are previewed. This keeps the page responsive even
 * for multi-MB payloads with 1500-element embedding vectors — we never attempt
 * to render a huge array/string into the DOM.
 */

const AUTO_EXPAND_DEPTH = 2;
const AUTO_EXPAND_MAX_CHILDREN = 12;
const ARRAY_RENDER_CAP = 200; // hard cap on items rendered even when expanded
const STRING_PREVIEW = 140;
const STRING_MAX = 5000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shouldAutoExpand(value: unknown, depth: number): boolean {
  if (depth > AUTO_EXPAND_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= AUTO_EXPAND_MAX_CHILDREN;
  if (isPlainObject(value)) return Object.keys(value).length <= AUTO_EXPAND_MAX_CHILDREN;
  return false;
}

function KeyLabel({ name }: { name?: string }) {
  if (name === undefined) return null;
  return <span className="text-sky-300">{name}: </span>;
}

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  if (value.length <= STRING_PREVIEW) {
    return <span className="break-words text-green-300">&quot;{value}&quot;</span>;
  }

  if (!expanded) {
    return (
      <span className="break-words text-green-300">
        &quot;{value.slice(0, STRING_PREVIEW)}…&quot;{" "}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-xs text-sky-400 hover:underline"
        >
          (show {value.length.toLocaleString()} chars)
        </button>
      </span>
    );
  }

  const truncated = value.length > STRING_MAX;
  return (
    <span className="whitespace-pre-wrap break-words text-green-300">
      &quot;{value.slice(0, STRING_MAX)}{truncated ? "…" : ""}&quot;{" "}
      {truncated ? (
        <span className="text-xs text-amber-400/80">
          ({(value.length - STRING_MAX).toLocaleString()} chars truncated)
        </span>
      ) : null}{" "}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="text-xs text-sky-400 hover:underline"
      >
        (collapse)
      </button>
    </span>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null) return <span className="text-neutral-500">null</span>;
  if (typeof value === "boolean")
    return <span className="text-purple-400">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-amber-300">{value}</span>;
  if (typeof value === "string") return <StringValue value={value} />;
  return <span className="text-neutral-400">{String(value)}</span>;
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
}

function ContainerNode({ name, value, depth }: NodeProps) {
  // Auto-expand small, shallow containers so the meaningful shape is visible
  // without clicking; collapse deep/large ones (handled by initial open state).
  const autoExpand = shouldAutoExpand(value, depth);

  if (Array.isArray(value)) {
    const numeric = value.length > 0 && value.every((x) => typeof x === "number");
    const summary = `[ ${value.length.toLocaleString()} ${
      numeric ? "numbers" : value.length === 1 ? "item" : "items"
    } ]`;
    const shown = value.slice(0, ARRAY_RENDER_CAP);
    const hidden = value.length - shown.length;
    return (
      <AutoContainer name={name} summary={summary} autoExpand={autoExpand}>
        {() => (
          <>
            {shown.map((item, i) => (
              <JsonTree key={i} name={String(i)} value={item} depth={depth + 1} />
            ))}
            {hidden > 0 ? (
              <div className="py-1 text-xs text-amber-400/80">
                … {hidden.toLocaleString()} more items not shown (showing first{" "}
                {ARRAY_RENDER_CAP})
              </div>
            ) : null}
          </>
        )}
      </AutoContainer>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const summary = `{ ${entries.length} ${entries.length === 1 ? "key" : "keys"} }`;
  return (
    <AutoContainer name={name} summary={summary} autoExpand={autoExpand}>
      {() => (
        <>
          {entries.map(([k, v]) => (
            <JsonTree key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </>
      )}
    </AutoContainer>
  );
}

/** Container whose initial open state respects `autoExpand`. */
function AutoContainer({
  name,
  summary,
  autoExpand,
  children,
}: {
  name?: string;
  summary: string;
  autoExpand: boolean;
  children: () => React.ReactNode;
}) {
  const [open, setOpen] = useState(autoExpand);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-start gap-1 text-left hover:text-neutral-200"
      >
        <span className="select-none text-neutral-500">{open ? "▾" : "▸"}</span>
        <span>
          <KeyLabel name={name} />
          <span className="text-neutral-500">{summary}</span>
        </span>
      </button>
      {open ? <div className="ml-3 border-l border-white/10 pl-3">{children()}</div> : null}
    </div>
  );
}

export function JsonTree({ name, value, depth = 0 }: { name?: string; value: unknown; depth?: number }) {
  if (Array.isArray(value) || isPlainObject(value)) {
    return <ContainerNode name={name} value={value} depth={depth} />;
  }
  return (
    <div className="py-0.5">
      <KeyLabel name={name} />
      <PrimitiveValue value={value} />
    </div>
  );
}
