"use client";

import { useState } from "react";
import { JsonTree } from "@/components/JsonTree";
import { statusBadgeClasses } from "@/lib/format";

export interface RunView {
  status: string;
  durationDisplay: string;
  output: unknown;
  input: unknown | null;
  error: unknown | null;
}

export interface NodeView {
  name: string;
  status: string;
  durationDisplay: string;
  hasError: boolean;
  defaultOpen: boolean;
  runs: RunView[];
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  );
}

function NodeSection({ node }: { node: NodeView }) {
  // Every node starts COLLAPSED in the panel — a uniform closed list the user
  // expands deliberately (node.defaultOpen is retained on the type but no longer
  // drives the initial state). The panel is keyed by execution id, so swapping
  // executions remounts this and resets all nodes to collapsed. The oversized
  // JsonTree guards still apply once a node is expanded.
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-black/10 dark:border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-subtle"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="select-none text-neutral-500">{open ? "▾" : "▸"}</span>
          <span className="truncate font-medium">{node.name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <span className="text-xs tabular-nums text-neutral-500">
            {node.durationDisplay}
          </span>
          <span className={statusBadgeClasses(node.status)}>{node.status}</span>
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-black/10 px-4 py-3 font-mono text-xs leading-relaxed dark:border-line">
          {node.runs.map((run, i) => (
            <div key={i} className="space-y-3">
              {node.runs.length > 1 ? (
                <div className="text-[11px] uppercase tracking-wider text-neutral-500">
                  Run {i + 1} · {run.status} · {run.durationDisplay}
                </div>
              ) : null}

              {run.error ? (
                <div>
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-danger">
                    Error
                  </div>
                  <JsonTree value={run.error} />
                </div>
              ) : null}

              {run.input !== null ? (
                <div>
                  <SectionLabel>Input</SectionLabel>
                  <JsonTree value={run.input} />
                </div>
              ) : null}

              <div>
                <SectionLabel>Output</SectionLabel>
                {run.output === null || run.output === undefined ? (
                  <div className="text-faint">No output</div>
                ) : (
                  <JsonTree value={run.output} />
                )}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function NodeSections({ nodes }: { nodes: NodeView[] }) {
  return (
    <div className="space-y-3">
      {nodes.map((node) => (
        <NodeSection key={node.name} node={node} />
      ))}
    </div>
  );
}
