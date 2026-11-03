import { decrypt } from '../crypto.js';
import { logger } from '../logger.js';
import { fetchCompletionsUsage, fetchCosts, fetchProjects, OpenAiAdminError } from '../openai/adminClient.js';
import {
  getOpenAiKeyForSync,
  listOpenAiConnectionsDue,
  recordOpenAiSync,
  replaceOpenAiWindow,
} from '../db/repositories/openaiBilling.js';

/**
 * COSTOS DE IA — pull what OpenAI billed (costs) and its token counts (usage) for the last
 * WINDOW_DAYS UTC days and replace that window. Recent days keep changing on OpenAI's side, so
 * the whole window is re-read each time; older days stay as stored.
 * Run by the worker every few hours and on demand from the screen. Never logs the key.
 */

export const WINDOW_DAYS = 95;
const DAY_MS = 86_400_000;

export type OpenAiSyncResult = { ok: true; costs: number; usage: number; skipped: number } | { ok: false; error: string };

export async function syncOpenAiForTenant(tenantId: string, now = new Date(), fetcher: typeof fetch = fetch): Promise<OpenAiSyncResult> {
  const encrypted = await getOpenAiKeyForSync(tenantId);
  if (!encrypted) return { ok: false, error: 'No hay una conexión con OpenAI.' };
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = todayUtc - (WINDOW_DAYS - 1) * DAY_MS;
  const end = todayUtc + DAY_MS; // tomorrow 00:00 UTC, exclusive: includes today's partial day
  try {
    const key = decrypt(encrypted);
    const [costs, usage, projects] = await Promise.all([
      fetchCosts(key, start / 1000, end / 1000, fetcher),
      fetchCompletionsUsage(key, start / 1000, end / 1000, fetcher),
      // Names for the project → business picker. A failure here must not lose the figures.
      fetchProjects(key, fetcher).catch(() => undefined),
    ]);
    await replaceOpenAiWindow({
      tenantId,
      fromDay: new Date(start).toISOString().slice(0, 10),
      toDay: new Date(todayUtc).toISOString().slice(0, 10),
      costs: costs.rows,
      usage: usage.rows,
      projects,
    });
    await recordOpenAiSync(tenantId, null);
    return { ok: true, costs: costs.rows.length, usage: usage.rows.length, skipped: costs.skipped + usage.skipped };
  } catch (err) {
    const message = err instanceof OpenAiAdminError ? err.message : 'No se pudo sincronizar con OpenAI.';
    logger.warn({ tenantId, kind: err instanceof OpenAiAdminError ? err.kind : 'unknown' }, 'openai billing sync failed');
    await recordOpenAiSync(tenantId, message);
    return { ok: false, error: message };
  }
}

/** Worker step: every tenant whose last sync is older than `staleMs`. Best-effort, never throws. */
export async function syncDueOpenAiConnections(staleMs = 6 * 60 * 60 * 1000): Promise<void> {
  let due: string[] = [];
  try {
    due = await listOpenAiConnectionsDue(staleMs);
  } catch (err) {
    logger.error({ err }, 'listing openai connections failed; skipping billing sync');
    return;
  }
  for (const tenantId of due) await syncOpenAiForTenant(tenantId);
}
