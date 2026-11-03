import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * COSTOS DE IA — LLM usage derived from the n8n executions the worker already ingests.
 *
 * `execution_llm_usage`: one row per (execution, model, usage_source) with the number of model
 * calls and their input/output tokens. Read from the LangChain model sub-node runs inside
 * `executions.raw_data` (`data.ai_languageModel[*][*].json.tokenUsage | tokenUsageEstimate`).
 *   - usage_source 'provider'  n8n stored the provider's own usage (`tokenUsage`).
 *                  'estimate'  n8n could not read it and COUNTED the text itself
 *                              (`tokenUsageEstimate`, e.g. OpenAI's Responses API). An estimate
 *                              has no reasoning tokens (billed as output) and no cached-input
 *                              split, so it can sit well below the invoice.
 *   - model NULL = n8n did not record which model ran. Never guessed.
 *
 * `execution_llm_scans`: which executions were read and what was found, so the screen can tell
 * «0 tokens, measured» from «not read yet» or «n8n kept no data» (unknown is never 0).
 *
 * Both are DERIVED caches: rebuildable from `executions.raw_data` by `npm run llm-usage:backfill`.
 * Neither stores message content. Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE execution_llm_scans (
      execution_id uuid PRIMARY KEY REFERENCES executions (id) ON DELETE CASCADE,
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      has_run_data boolean NOT NULL,
      llm_calls integer NOT NULL CHECK (llm_calls >= 0),
      scanned_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX execution_llm_scans_tenant_idx ON execution_llm_scans (tenant_id);

    CREATE TABLE execution_llm_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      execution_id uuid NOT NULL REFERENCES execution_llm_scans (execution_id) ON DELETE CASCADE,
      n8n_connection_id uuid NOT NULL,
      n8n_workflow_id text NOT NULL,
      started_at timestamptz NOT NULL,
      model text CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 200),
      usage_source text NOT NULL CHECK (usage_source IN ('provider', 'estimate')),
      calls integer NOT NULL CHECK (calls > 0),
      input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
      output_tokens bigint NOT NULL CHECK (output_tokens >= 0)
    );
    CREATE UNIQUE INDEX execution_llm_usage_key
      ON execution_llm_usage (execution_id, coalesce(model, ''), usage_source);
    -- The screen reads a tenant's period, grouped by workflow.
    CREATE INDEX execution_llm_usage_tenant_time_idx
      ON execution_llm_usage (tenant_id, started_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE execution_llm_usage;
    DROP TABLE execution_llm_scans;
  `);
}
