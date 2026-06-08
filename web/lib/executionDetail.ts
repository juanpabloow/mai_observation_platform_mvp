/**
 * Parses an n8n execution's raw_data payload into an ordered list of executed
 * nodes with their per-run input/output/error. Framework-agnostic and pure — no
 * React, no formatting — so the conversation view (a later phase) can reuse the
 * same "walk runData" logic.
 *
 * Shape of raw_data: { resultData: { runData: { "<Node Name>": [ runEntry, ... ] },
 * lastNodeExecuted }, ... }. Each runEntry has: executionStatus, executionTime
 * (ms), startTime (epoch ms), data (the node OUTPUT), and optionally
 * inputOverride (the node INPUT) and error. The set of nodes varies per run.
 */

export interface NodeRunData {
  /** executionStatus, e.g. 'success' | 'error'. */
  status: string;
  /** executionTime in ms, or null if absent. */
  executionTimeMs: number | null;
  /** startTime as epoch ms, or null. */
  startTime: number | null;
  /** The node's output (runEntry.data). */
  output: unknown;
  /** The node's input, if present (runEntry.inputOverride). */
  input: unknown | null;
  /** The node's error object, if it failed. */
  error: unknown | null;
}

export interface ExecutionNodeData {
  name: string;
  runs: NodeRunData[];
  /** 'error' if any run errored, else the last run's status. */
  status: string;
  /** Earliest run startTime (epoch ms), used for ordering. */
  startTime: number | null;
  /** Sum of run execution times (ms), or null. */
  totalTimeMs: number | null;
  hasError: boolean;
}

export interface ParsedExecution {
  nodes: ExecutionNodeData[];
  lastNodeExecuted: string | null;
  /** False when raw_data is null/missing or has no runData. */
  hasRunData: boolean;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseExecution(rawData: unknown): ParsedExecution {
  const root = asObject(rawData);
  const resultData = asObject(root?.resultData);
  const runData = asObject(resultData?.runData);
  const lastNodeExecuted =
    typeof resultData?.lastNodeExecuted === "string"
      ? resultData.lastNodeExecuted
      : null;

  if (!runData) {
    return { nodes: [], lastNodeExecuted, hasRunData: false };
  }

  const nodes: ExecutionNodeData[] = Object.entries(runData).map(([name, value]) => {
    const entries = Array.isArray(value) ? value : [];
    const runs: NodeRunData[] = entries.map((raw) => {
      const entry = asObject(raw) ?? {};
      return {
        status:
          typeof entry.executionStatus === "string" ? entry.executionStatus : "unknown",
        executionTimeMs: numberOrNull(entry.executionTime),
        startTime: numberOrNull(entry.startTime),
        output: entry.data ?? null,
        input: entry.inputOverride ?? null,
        error: entry.error ?? null,
      };
    });

    const hasError = runs.some((r) => r.status === "error" || r.error !== null);
    const startTimes = runs.map((r) => r.startTime).filter((t): t is number => t !== null);
    const times = runs
      .map((r) => r.executionTimeMs)
      .filter((t): t is number => t !== null);

    return {
      name,
      runs,
      status: hasError ? "error" : (runs[runs.length - 1]?.status ?? "unknown"),
      startTime: startTimes.length ? Math.min(...startTimes) : null,
      totalTimeMs: times.length ? times.reduce((a, b) => a + b, 0) : null,
      hasError,
    };
  });

  // Order by startTime ascending; nodes without a startTime keep their original
  // (object-key) order and sort to the end. Array.sort is stable in Node/V8.
  nodes.sort((a, b) => {
    if (a.startTime === null && b.startTime === null) return 0;
    if (a.startTime === null) return 1;
    if (b.startTime === null) return -1;
    return a.startTime - b.startTime;
  });

  return { nodes, lastNodeExecuted, hasRunData: nodes.length > 0 };
}
