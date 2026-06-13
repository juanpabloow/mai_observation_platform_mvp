/**
 * Pure parsing + extraction core for n8n execution payloads. Lives in the shared
 * worker layer (src/) so BOTH the ingestion worker (turn derivation) and the web
 * app (field catalog / columns / conversation display) use the exact same logic.
 * No React, no DB, no formatting — just parsing raw_data and extracting values.
 *
 * Shape of raw_data: { resultData: { runData: { "<Node Name>": [ runEntry, ... ] },
 * lastNodeExecuted, metadata }, ... }. Each runEntry has: executionStatus,
 * executionTime (ms), startTime (epoch ms), data (the node OUTPUT), and
 * optionally inputOverride (the node INPUT) and error. The set of nodes varies
 * per run.
 */

export interface NodeRunData {
  /** executionStatus, e.g. 'success' | 'error'. */
  status: string;
  /** executionTime in ms, or null if absent. */
  executionTimeMs: number | null;
  /** startTime as epoch ms, or null. */
  startTime: number | null;
  /** The node's output (runEntry.data), unwrapped. */
  output: unknown;
  /** The node's input, if present (runEntry.inputOverride), unwrapped. */
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

/**
 * Sentinel node identifier for fields that live under data.resultData.metadata
 * (execution-level, not a node's output — e.g. an AI reply written to metadata).
 */
export const METADATA_NODE_NAME = "__metadata__";

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Unwrap n8n's output/input envelope to the meaningful payload (DISPLAY/EXTRACT
 * transformation — raw_data in the DB is untouched).
 *
 * n8n wraps node data as `{ <connection>: [ [ { json, pairedItem }, ... ] ] }`,
 * where <connection> is 'main' for normal nodes or an AI key (ai_tool,
 * ai_memory, ai_languageModel, ai_embedding, ...) for sub-nodes — all the same
 * shape. Returns the inner `json` object directly when there's a single item, or
 * an array of `json` objects for multiple items, dropping `pairedItem`. Anything
 * that doesn't match the envelope is returned unchanged (fall back to raw — never
 * hide data, never crash).
 */
export function unwrapNodeData(value: unknown): unknown {
  const envelope = asObject(value);
  if (!envelope) return value;

  const keys = Object.keys(envelope);
  if (keys.length !== 1) return value;

  const connections = envelope[keys[0]];
  if (!Array.isArray(connections) || connections.length === 0) return value;

  const items = connections[0];
  if (!Array.isArray(items)) return value;
  if (items.length === 0) return [];

  const firstItem = asObject(items[0]);
  if (!firstItem || !("json" in firstItem)) return value;

  const jsons = items.map((item) => {
    const itemObj = asObject(item);
    return itemObj && "json" in itemObj ? itemObj.json : item; // drops pairedItem
  });

  return jsons.length === 1 ? jsons[0] : jsons;
}

export function parseExecution(rawData: unknown): ParsedExecution {
  const root = asObject(rawData);
  const resultData = asObject(root?.resultData);
  const runData = asObject(resultData?.runData);
  const lastNodeExecuted =
    typeof resultData?.lastNodeExecuted === "string" ? resultData.lastNodeExecuted : null;

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
        output: unwrapNodeData(entry.data ?? null),
        input: unwrapNodeData(entry.inputOverride ?? null),
        error: entry.error ?? null,
      };
    });

    const hasError = runs.some((r) => r.status === "error" || r.error !== null);
    const startTimes = runs.map((r) => r.startTime).filter((t): t is number => t !== null);
    const times = runs.map((r) => r.executionTimeMs).filter((t): t is number => t !== null);

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

/** data.resultData.metadata, or undefined if absent. */
export function getResultDataMetadata(rawData: unknown): unknown {
  const root = asObject(rawData);
  const resultData = asObject(root?.resultData);
  return resultData ? resultData.metadata : undefined;
}

/** Walk a dotted path (numeric segment = array index) into a value. */
export function extractByPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export interface ExecutionResolver {
  /** nodeName -> that node's unwrapped output. */
  nodeOutputs: Map<string, unknown>;
  /** data.resultData.metadata. */
  metadata: unknown;
}

/** Parse one execution into node outputs + metadata, for repeated extraction. */
export function buildExecutionResolver(rawData: unknown): ExecutionResolver {
  const nodeOutputs = new Map<string, unknown>();
  for (const node of parseExecution(rawData).nodes) {
    if (!nodeOutputs.has(node.name)) {
      nodeOutputs.set(node.name, node.runs[0]?.output);
    }
  }
  return { nodeOutputs, metadata: getResultDataMetadata(rawData) ?? null };
}

/**
 * Extract a mapping's value from a resolver. Handles BOTH node-output mappings
 * and execution-metadata mappings (node_name === METADATA_NODE_NAME, json_path
 * relative to resultData.metadata). Null-safe: returns undefined if the node
 * didn't run / metadata is absent / the path doesn't resolve.
 */
export function extractMapping(
  resolver: ExecutionResolver,
  nodeName: string | null,
  jsonPath: string,
): unknown {
  const source =
    nodeName === METADATA_NODE_NAME
      ? resolver.metadata
      : nodeName
        ? resolver.nodeOutputs.get(nodeName)
        : undefined;
  if (source === undefined || source === null) return undefined;
  return extractByPath(source, jsonPath);
}
