import { parseExecution } from "./executionDetail";

/**
 * Builds the "available fields" catalog for a workflow's column picker from a
 * sample of recent executions' raw_data (newest first). Pure — the caller
 * fetches the sample (tenant-scoped) and passes it in. Parses runData (reusing
 * parseExecution, which already unwraps the n8n main/ai_* envelope and drops
 * pairedItem) and flattens each node's unwrapped output into pickable leaf
 * fields.
 *
 * - Field PATHS are unioned across the sample (complete menu); each field gets
 *   ONE example value from the most recent execution that has it.
 * - The stored jsonPath is the REAL extraction path RELATIVE TO THE NODE'S
 *   unwrapped output (dotted, numeric segments = array indices). The human label
 *   is the same segments joined by spaces. Pair this with the node name to
 *   extract at runtime: parseExecution → node.runs[0].output → extractByPath().
 * - Oversized arrays (> MAX_ARRAY, e.g. 1536-element embeddings) are NOT
 *   exploded into pickable indices — they're skipped. Long strings are pickable
 *   with a truncated example.
 */

const MAX_ARRAY = 50; // arrays larger than this are not exploded into fields
const ARRAY_INDEX_CAP = 20; // index at most this many elements of a small array
const MAX_DEPTH = 8;
const MAX_FIELDS_PER_NODE = 300;
const EXAMPLE_MAX = 80; // example value preview length

export interface CatalogField {
  /** Readable label, e.g. "messages 0 text body". */
  label: string;
  /** Real extraction path relative to the node's unwrapped output, e.g. "messages.0.text.body". */
  jsonPath: string;
  /** One representative value (truncated preview). */
  exampleValue: string;
  /** 'string' | 'number' | 'boolean' | 'null'. */
  dataType: string;
}

export interface CatalogNode {
  nodeName: string;
  fields: CatalogField[];
}

export type FieldCatalog = CatalogNode[];

function previewValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > EXAMPLE_MAX ? `${value.slice(0, EXAMPLE_MAX)}…` : value;
  }
  return String(value);
}

function dataTypeOf(value: unknown): string {
  return value === null ? "null" : typeof value;
}

type FieldAccumulator = Map<string, { label: string; example: string; dataType: string }>;

/** Walk a value, emitting leaf fields (primitives). Sets only if path is new. */
function flattenLeaves(
  value: unknown,
  pathSegs: string[],
  labelSegs: string[],
  depth: number,
  out: FieldAccumulator,
): void {
  if (out.size >= MAX_FIELDS_PER_NODE || depth > MAX_DEPTH) return;

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    const jsonPath = pathSegs.join(".");
    if (jsonPath && !out.has(jsonPath)) {
      out.set(jsonPath, {
        label: labelSegs.join(" "),
        example: previewValue(value),
        dataType: dataTypeOf(value),
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) return; // skip oversized arrays (e.g. embeddings)
    const n = Math.min(value.length, ARRAY_INDEX_CAP);
    for (let i = 0; i < n; i += 1) {
      flattenLeaves(value[i], [...pathSegs, String(i)], [...labelSegs, String(i)], depth + 1, out);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(child, [...pathSegs, key], [...labelSegs, key], depth + 1, out);
    }
  }
}

export function buildFieldCatalog(rawDataList: unknown[]): FieldCatalog {
  // nodeName -> (jsonPath -> field). Iterated newest-first, so the first time a
  // path is seen (set-if-absent) captures the most recent example.
  const nodes = new Map<string, FieldAccumulator>();

  for (const rawData of rawDataList) {
    const parsed = parseExecution(rawData);
    for (const node of parsed.nodes) {
      const output = node.runs[0]?.output;
      if (output === undefined || output === null) continue;
      let fields = nodes.get(node.name);
      if (!fields) {
        fields = new Map();
        nodes.set(node.name, fields);
      }
      flattenLeaves(output, [], [], 0, fields);
    }
  }

  return [...nodes.entries()].map(([nodeName, fields]) => ({
    nodeName,
    fields: [...fields.entries()].map(([jsonPath, f]) => ({
      label: f.label,
      jsonPath,
      exampleValue: f.example,
      dataType: f.dataType,
    })),
  }));
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
