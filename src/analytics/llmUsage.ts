/**
 * COSTOS DE IA — pure extraction of LLM token usage from a stored n8n execution payload.
 *
 * n8n's LangChain model sub-nodes (OpenAI Chat Model, Anthropic, Gemini…) record each call as a
 * run whose OUTPUT is `data.ai_languageModel[i][j].json` with either:
 *   - `tokenUsage`          the provider's own counts          → source 'provider'
 *   - `tokenUsageEstimate`  n8n counted the text itself        → source 'estimate'
 * and whose INPUT (`inputOverride.ai_languageModel[0][0].json.options.model`) names the model.
 * Observed on real ingested executions: with OpenAI's Responses API n8n only writes the estimate.
 *
 * Nothing here reads message content, and nothing is guessed: a missing model stays null and a
 * malformed count is skipped (never read as 0).
 */

export type LlmUsageSource = 'provider' | 'estimate';

export interface LlmUsageGroup {
  model: string | null;
  source: LlmUsageSource;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmUsageExtraction {
  /** False when the payload has no runData at all (n8n kept no execution data). */
  hasRunData: boolean;
  /** Model calls found (sum of `calls`). */
  calls: number;
  groups: LlmUsageGroup[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function modelOf(run: Record<string, unknown>): string | null {
  const input = asObject(run.inputOverride)?.ai_languageModel;
  if (!Array.isArray(input) || !Array.isArray(input[0])) return null;
  const json = asObject(asObject(input[0][0])?.json);
  const options = asObject(json?.options);
  for (const v of [options?.model, options?.modelName, options?.model_name, json?.model]) {
    if (typeof v === 'string' && v.trim() && v.length <= 200) return v.trim();
  }
  return null;
}

export function extractLlmUsage(rawData: unknown): LlmUsageExtraction {
  const runData = asObject(asObject(asObject(rawData)?.resultData)?.runData);
  if (!runData) return { hasRunData: false, calls: 0, groups: [] };

  const byKey = new Map<string, LlmUsageGroup>();
  let calls = 0;
  for (const runs of Object.values(runData)) {
    if (!Array.isArray(runs)) continue;
    for (const entry of runs) {
      const run = asObject(entry);
      const outputs = asObject(run?.data)?.ai_languageModel;
      if (!run || !Array.isArray(outputs)) continue;
      const model = modelOf(run);
      for (const branch of outputs) {
        if (!Array.isArray(branch)) continue;
        for (const item of branch) {
          const json = asObject(asObject(item)?.json);
          if (!json) continue;
          const provider = asObject(json.tokenUsage);
          const usage = provider ?? asObject(json.tokenUsageEstimate);
          if (!usage) continue;
          const inputTokens = count(usage.promptTokens);
          const outputTokens = count(usage.completionTokens);
          if (inputTokens === null || outputTokens === null) continue;
          const source: LlmUsageSource = provider ? 'provider' : 'estimate';
          const key = `${model ?? ''}\u0000${source}`;
          const group = byKey.get(key) ?? { model, source, calls: 0, inputTokens: 0, outputTokens: 0 };
          group.calls += 1;
          group.inputTokens += inputTokens;
          group.outputTokens += outputTokens;
          byKey.set(key, group);
          calls += 1;
        }
      }
    }
  }
  return { hasRunData: true, calls, groups: [...byKey.values()] };
}
