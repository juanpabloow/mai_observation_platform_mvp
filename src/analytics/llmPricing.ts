/**
 * COSTOS DE IA — list prices of the models the bots run, in USD per million tokens.
 *
 * Same rules as the meetings table (src/meetings/analysis/openai.ts): a CLOSED list with exact
 * identifiers, no prefix matching, and an unknown model costs `null` («sin precio»), never 0.
 * A dated id that bills at its alias's rate goes in MODEL_ALIAS explicitly.
 *
 * `verified: false` = taken from secondary sources on `checkedAt`, not yet read off
 * https://developers.openai.com/api/docs/pricing. The screen shows this table as is.
 */
export interface ModelPrice {
  inPerM: number;
  cachedInPerM: number | null;
  outPerM: number;
  checkedAt: string;
  verified: boolean;
}

export const LLM_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-terra': { inPerM: 2.0, cachedInPerM: 0.2, outPerM: 12.0, checkedAt: '2026-11-03', verified: false },
  'gpt-5.4-mini': { inPerM: 0.75, cachedInPerM: 0.075, outPerM: 4.5, checkedAt: '2026-11-03', verified: false },
};

export const MODEL_ALIAS: Readonly<Record<string, string>> = {};

export function priceKeyFor(model: string | null): string | null {
  if (!model) return null;
  // hasOwn on both: a model id like "toString" must not resolve to Object.prototype.
  if (Object.hasOwn(MODEL_ALIAS, model)) return MODEL_ALIAS[model];
  return Object.hasOwn(LLM_PRICES, model) ? model : null;
}

/**
 * Cost of `inputTokens` + `outputTokens` at list price, or null when the model has no price.
 * All input is billed at the uncached rate: n8n's counts do not split cached input.
 */
export function llmCostUsd(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const key = priceKeyFor(model);
  if (key === null) return null;
  const p = LLM_PRICES[key];
  return (inputTokens / 1e6) * p.inPerM + (outputTokens / 1e6) * p.outPerM;
}
