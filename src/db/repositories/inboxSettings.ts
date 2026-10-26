import { query } from '../client.js';

/**
 * JP-2 per-client inbox settings. `auto_return_minutes`: how long a conversation may sit out of the
 * bot's hands before the platform returns it to the bot (0 = never). Mirrors pipeline.ts: the repo
 * COALESCEs the default so a missing row behaves exactly like a default one.
 */
export const DEFAULT_AUTO_RETURN_MINUTES = 60;

export interface InboxSettings {
  auto_return_minutes: number;
}

/** The client's settings, with the default filled in for a missing row (never throws). */
export async function getInboxSettings(tenantId: string, clientId: string): Promise<InboxSettings> {
  const r = await query<InboxSettings>(
    `SELECT auto_return_minutes FROM inbox_settings WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  return { auto_return_minutes: r.rows[0]?.auto_return_minutes ?? DEFAULT_AUTO_RETURN_MINUTES };
}

/**
 * Upsert the client's auto-return threshold (minutes; 0 = never). The caller validates the range and
 * authorization; the CHECK constraint (0–10080) is the DB belt. Returns the stored value.
 */
export async function setInboxAutoReturnMinutes(
  tenantId: string,
  clientId: string,
  minutes: number,
): Promise<number> {
  const r = await query<{ auto_return_minutes: number }>(
    `INSERT INTO inbox_settings (tenant_id, client_id, auto_return_minutes)
       VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, client_id)
       DO UPDATE SET auto_return_minutes = EXCLUDED.auto_return_minutes, updated_at = now()
     RETURNING auto_return_minutes`,
    [tenantId, clientId, minutes],
  );
  return r.rows[0]!.auto_return_minutes;
}
