import { encrypt } from '../crypto.js';
import { createN8nClient } from '../n8n/client.js';
import { insertConnection } from '../db/repositories/n8nConnections.js';
import { logger } from '../logger.js';

/**
 * Create an n8n connection for a tenant from user-entered details. Shared core
 * (the web server action wraps this with requireTenant). SECURITY:
 *   - The API key is ENCRYPTED at rest (AES-256-GCM) — only the ciphertext is
 *     stored, never plaintext.
 *   - The key is NEVER logged and NEVER returned to the caller.
 *   - Credentials are tested SERVER-SIDE before saving; only a working
 *     connection is persisted, and the test never echoes the key.
 */
export interface CreateConnectionInput {
  tenantId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
}

export type CreateConnectionResult =
  | { ok: true; connectionId: string }
  | { ok: false; error: string };

export async function createConnectionForTenant(
  input: CreateConnectionInput,
): Promise<CreateConnectionResult> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, ''); // drop trailing slash
  const apiKey = input.apiKey;

  if (!name) return { ok: false, error: 'Please enter a name for this connection.' };
  if (!apiKey.trim()) return { ok: false, error: 'Please enter your n8n API key.' };

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: 'Enter a valid URL, e.g. https://your-n8n.example.com' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'The n8n URL must start with http:// or https://' };
  }

  // Verify the URL + key actually work before persisting (server-side only).
  try {
    const client = createN8nClient({ baseUrl, apiKey });
    await client.listExecutions({ limit: 1 });
  } catch (err) {
    // n8n client errors describe status/URL, not the key — safe to surface.
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: `Could not reach n8n with those details: ${message}` };
  }

  const row = await insertConnection({
    tenant_id: input.tenantId,
    name,
    n8n_base_url: baseUrl,
    n8n_api_key_encrypted: encrypt(apiKey), // ciphertext ONLY
  });

  // Log the creation WITHOUT the key.
  logger.info(
    { tenantId: input.tenantId, connectionId: row.id, name, baseUrl },
    'n8n connection created via onboarding',
  );

  return { ok: true, connectionId: row.id };
}
