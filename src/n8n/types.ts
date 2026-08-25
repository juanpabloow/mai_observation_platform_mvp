import { z } from 'zod';

/**
 * Types + zod schemas for the subset of the n8n public REST API (v1) we use.
 *
 * Design note: we validate the *envelope* (the fields we rely on) but keep the
 * execution `data` payload loosely typed. Its shape (resultData.runData, etc.)
 * varies per workflow and we store it raw — we never parse the runData tree here.
 */

/** n8n ids are normally strings, but tolerate numbers and normalise to string. */
const idLike = z.union([z.string(), z.number()]).transform((v) => String(v));

/**
 * A single row from GET /executions. PERMISSIVE BY DESIGN: ingestion reads ONLY the `id`
 * from a list row (to advance the cursor and to fetch the full detail), so we validate ONLY
 * that. Any other summary field n8n adds, removes, renames or nulls in a future API version
 * therefore CANNOT break the list — which is exactly the failure (a `startedAt`/`stoppedAt`
 * that went null) that silently killed ingestion for 12 days by rejecting the whole page.
 */
export const n8nExecutionSummarySchema = z.object({ id: idLike });

export type N8nExecutionSummary = z.infer<typeof n8nExecutionSummarySchema>; // { id: string }

/**
 * The ENVELOPE of GET /executions. `data` is kept as raw unknowns here on purpose — each row
 * is validated PER ROW by the client (a row without a usable id is skipped + logged, never
 * failing the whole page). `nextCursor` is null when there are no further pages.
 */
export const n8nExecutionListEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
  nextCursor: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

/** What the client returns after per-row validation: the usable rows, the cursor, and how
 *  many rows were skipped for failing validation (surfaced in the cycle log). */
export interface N8nExecutionListResponse {
  data: N8nExecutionSummary[];
  nextCursor: string | null;
  skipped: number;
}

/**
 * A single execution WITH data, as returned by GET /executions/{id}?includeData=true — the
 * payload we actually store. Validates ONLY the fields we derive columns from, and TOLERATES
 * n8n's evolving nullability: `startedAt` may be null (a not-yet-started execution), and
 * `status`/`mode` default rather than reject. Unknown fields are ignored; `data` (the full
 * runData tree) is kept loose and stored raw. This is the "strict deeper in" boundary —
 * strict about what we read, permissive about everything else.
 */
export const n8nExecutionDetailSchema = z.object({
  id: idLike,
  workflowId: idLike,
  status: z.string().nullish().transform((v) => v ?? 'unknown'),
  mode: z.string().nullish().transform((v) => v ?? 'unknown'),
  startedAt: z.string().nullish().transform((v) => v ?? null),
  stoppedAt: z.string().nullish().transform((v) => v ?? null),
  data: z.record(z.string(), z.unknown()).nullish(),
  workflowData: z.object({ name: z.string().nullish() }).nullish(),
});

export type N8nExecutionDetail = z.infer<typeof n8nExecutionDetailSchema>;

/**
 * A workflow as returned by GET /workflows. We only rely on id/name/active;
 * `active` is tolerated as missing (defaults false).
 */
export const n8nWorkflowSummarySchema = z.object({
  id: idLike,
  name: z.string(),
  active: z.boolean().nullish().transform((v) => v ?? false),
});

export type N8nWorkflowSummary = z.infer<typeof n8nWorkflowSummarySchema>;

/** Response shape of GET /workflows. */
export const n8nWorkflowListResponseSchema = z.object({
  data: z.array(n8nWorkflowSummarySchema),
  nextCursor: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export type N8nWorkflowListResponse = z.infer<typeof n8nWorkflowListResponseSchema>;
