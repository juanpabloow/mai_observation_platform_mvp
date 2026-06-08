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
 * A single execution as returned by GET /executions (WITHOUT data).
 */
export const n8nExecutionSummarySchema = z.object({
  id: idLike,
  finished: z.boolean(),
  mode: z.string(),
  status: z.string(),
  startedAt: z.string(),
  stoppedAt: z.string().nullable(),
  workflowId: idLike,
});

export type N8nExecutionSummary = z.infer<typeof n8nExecutionSummarySchema>;

/**
 * Response shape of GET /executions. `nextCursor` is null when there are no
 * further pages.
 */
export const n8nExecutionListResponseSchema = z.object({
  data: z.array(n8nExecutionSummarySchema),
  nextCursor: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
});

export type N8nExecutionListResponse = z.infer<typeof n8nExecutionListResponseSchema>;

/**
 * A single execution WITH data, as returned by
 * GET /executions/{id}?includeData=true.
 *
 * `data` is the full execution payload (includes resultData.runData). We keep
 * it as a loose record and store it as-is. `workflowData` carries the workflow
 * definition snapshot; we only care about its `name`.
 */
export const n8nExecutionDetailSchema = n8nExecutionSummarySchema.extend({
  data: z.record(z.string(), z.unknown()).nullish(),
  workflowData: z
    .object({ name: z.string().nullish() })
    .nullish(),
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
