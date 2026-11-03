/**
 * COSTOS DE IA — the COP per USD rate shown next to every US$ amount.
 *
 * Source: the official TRM (Tasa Representativa del Mercado) the Superintendencia Financiera
 * publishes on datos.gov.co (dataset 32sa-8pi3). Public, free, no key. This module is PURE:
 * it only parses and validates; the fetch, cache and fallback live server-side in
 * web/lib/usdCop.ts.
 */

/** Fixed endpoint: the latest TRM only. Never built from request input (no SSRF surface). */
export const TRM_URL =
  'https://www.datos.gov.co/resource/32sa-8pi3.json?$select=valor,vigenciadesde,vigenciahasta&$order=vigenciadesde%20DESC&$limit=1';

/** A plausible COP/USD band. Outside it, the response is treated as broken, never shown. */
export const TRM_MIN = 1000;
export const TRM_MAX = 20000;

export interface UsdCop {
  rate: number;
  source: 'trm' | 'env';
  /** Local days the TRM is valid for (TRM only). */
  validFrom: string | null;
  validTo: string | null;
}

const DAY = /^(\d{4}-\d{2}-\d{2})T/;

/** Parse the dataset's JSON; null for anything unexpected (wrong shape, out-of-band value). */
export function parseTrmResponse(json: unknown): UsdCop | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const row = json[0] as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return null;
  const raw = row.valor;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < TRM_MIN || rate > TRM_MAX) return null;
  const from = typeof row.vigenciadesde === 'string' ? DAY.exec(row.vigenciadesde)?.[1] ?? null : null;
  const to = typeof row.vigenciahasta === 'string' ? DAY.exec(row.vigenciahasta)?.[1] ?? null : null;
  return { rate: Math.round(rate * 100) / 100, source: 'trm', validFrom: from, validTo: to };
}

/** The manual fallback (USD_COP_RATE), with the same band check. */
export function parseEnvRate(raw: string | undefined): UsdCop | null {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < TRM_MIN || n > TRM_MAX) return null;
  return { rate: n, source: 'env', validFrom: null, validTo: null };
}
