/**
 * COSTOS DE IA — list prices of the models the bots run, in USD per million tokens.
 *
 * Same rules as the meetings table (src/meetings/analysis/openai.ts): a CLOSED list with exact
 * identifiers, no prefix matching, and an unknown model costs `null` («sin precio»), never 0.
 * A dated id that bills at its alias's rate goes in MODEL_ALIAS explicitly.
 *
 * Source: https://developers.openai.com/api/docs/pricing («Prices per 1M tokens», US$), Standard
 * tier, SHORT context (≤272K input tokens per request). Cross-checked against each model's page
 * (developers.openai.com/api/docs/models/<id>), which lists the bare id as its only snapshot.
 * Not applied: long context (>272K input: 2× input, 1.5× output for the whole request), Batch/Flex
 * (½), Fast (2×), and the 10% regional-processing uplift. A WhatsApp turn stays far below 272K.
 * `verified: true` = read off those pages on `checkedAt`; the page publishes no effective date.
 */
export interface ModelPrice {
  inPerM: number;
  cachedInPerM: number | null;
  outPerM: number;
  checkedAt: string;
  verified: boolean;
}

export const LLM_PRICES: Readonly<Record<string, ModelPrice>> = {
  'gpt-5.6-terra': { inPerM: 2.0, cachedInPerM: 0.2, outPerM: 12.0, checkedAt: '2026-11-04', verified: true },
  'gpt-5.6-luna': { inPerM: 0.2, cachedInPerM: 0.02, outPerM: 1.2, checkedAt: '2026-11-04', verified: true },
  'gpt-5.4-mini': { inPerM: 0.75, cachedInPerM: 0.075, outPerM: 4.5, checkedAt: '2026-11-04', verified: true },
};

export const MODEL_ALIAS: Readonly<Record<string, string>> = {};

export function priceKeyFor(
  model: string | null,
  prices: Readonly<Record<string, ModelPrice>> = LLM_PRICES,
  aliases: Readonly<Record<string, string>> = MODEL_ALIAS,
): string | null {
  if (!model) return null;
  // hasOwn on both: a model id like "toString" must not resolve to Object.prototype.
  if (Object.hasOwn(aliases, model)) {
    const target = aliases[model];
    return Object.hasOwn(prices, target) ? target : null;
  }
  return Object.hasOwn(prices, model) ? model : null;
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
