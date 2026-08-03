import { randomBytes, createHash } from 'node:crypto';
import { query, firstRowOrThrow } from '../client.js';

/**
 * H-1a repository for handoff tokens — per-connection MACHINE credentials that
 * n8n uses to call the handoff API (H-1b). The raw token is credential-like and
 * is NEVER stored: only its SHA-256 hash (for lookup) and an 8-char display
 * prefix are persisted. issueToken returns the raw token exactly once. Every
 * function is tenant-scoped.
 */

/**
 * The machine-token capability vocabulary (C-5). Exactly these five, dot-separated,
 * stored as text[]. Deny-by-default: a token grants ONLY the capabilities it lists; an
 * unknown/removed string is simply absent (never a wildcard). LEGACY_CAPABILITIES is the
 * authority every pre-C-5 token effectively had — the migration + backfill grant exactly
 * these to existing tokens so no running workflow changes behavior. CRM is deliberately
 * NOT in the legacy set.
 */
export const ALL_CAPABILITIES = [
  'handoff',
  'scheduling.read',
  'scheduling.write',
  'crm.read',
  'crm.write',
] as const;
export type Capability = (typeof ALL_CAPABILITIES)[number];

export const LEGACY_CAPABILITIES: Capability[] = ['handoff', 'scheduling.read', 'scheduling.write'];

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

/** Deny-by-default membership check. An unknown string in `have` is ignored. */
export function tokenHasCapability(have: readonly string[] | null | undefined, required: Capability): boolean {
  return Array.isArray(have) && have.includes(required);
}

export interface HandoffTokenRow {
  id: string;
  tenant_id: string;
  n8n_connection_id: string;
  token_hash: string;
  token_prefix: string;
  /** Deny-by-default capability grants (C-5). */
  capabilities: string[];
  created_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
}

export interface IssuedToken {
  /** The stored row (hash + prefix; no raw token). */
  row: HandoffTokenRow;
  /** The RAW token — returned once for the caller to show; never persisted. */
  rawToken: string;
}

/** SHA-256 hex of a raw token, for storage + lookup. High-entropy input, so a
 * fast one-way hash (not a slow KDF) is the right lookup key. */
export function hashHandoffToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Mint a token for a connection: "hk_" + 32 crypto-random bytes (base64url). The
 * connection must belong to the tenant (the EXISTS guard scopes it), else this
 * throws. Stores only the hash + prefix; returns the raw token to show once.
 */
export async function issueToken(
  tenantId: string,
  n8nConnectionId: string,
  capabilities: Capability[],
): Promise<IssuedToken> {
  const rawToken = `hk_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashHandoffToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  // Store a de-duped, vocabulary-validated set (never trust the caller's shape).
  const caps = [...new Set(capabilities.filter(isCapability))];

  const r = await query<HandoffTokenRow>(
    `INSERT INTO handoff_tokens (tenant_id, n8n_connection_id, token_hash, token_prefix, capabilities)
     SELECT $1, $2, $3, $4, $5::text[]
      WHERE EXISTS (SELECT 1 FROM n8n_connections WHERE id = $2 AND tenant_id = $1)
     RETURNING *`,
    [tenantId, n8nConnectionId, tokenHash, tokenPrefix, caps],
  );
  if (!r.rows[0]) {
    throw new Error(`issueToken: connection ${n8nConnectionId} not found for tenant`);
  }
  return { row: r.rows[0], rawToken };
}

/**
 * Replace a token's capabilities (C-5). Narrowing takes effect on the NEXT request —
 * there is no cached authority. Tenant-scoped; only an ACTIVE (non-revoked) token is
 * editable. Returns the updated row or null (not found / revoked / not this tenant).
 */
export async function updateTokenCapabilities(
  tenantId: string,
  tokenId: string,
  capabilities: Capability[],
): Promise<HandoffTokenRow | null> {
  const caps = [...new Set(capabilities.filter(isCapability))];
  const r = await query<HandoffTokenRow>(
    `UPDATE handoff_tokens SET capabilities = $3::text[]
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
     RETURNING *`,
    [tokenId, tenantId, caps],
  );
  return r.rows[0] ?? null;
}

/**
 * Resolve a presented token by its hash — returns the row (with tenant_id +
 * n8n_connection_id) only if it exists AND is not revoked; otherwise null.
 * The caller hashes the raw token via hashHandoffToken().
 */
export async function findActiveByHash(tokenHash: string): Promise<HandoffTokenRow | null> {
  const r = await query<HandoffTokenRow>(
    `SELECT * FROM handoff_tokens WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  return r.rows[0] ?? null;
}

/** Revoke a token (tenant-scoped). Returns true iff an active token was revoked. */
export async function revokeToken(tenantId: string, tokenId: string): Promise<boolean> {
  const r = await query(
    `UPDATE handoff_tokens SET revoked_at = now()
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [tokenId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Stamp last_used_at (best-effort telemetry on each authenticated call). Fire-and-
 * forget: never throws, so a failed stamp can't break the request it belongs to.
 */
export async function touchLastUsed(id: string): Promise<void> {
  try {
    await query(`UPDATE handoff_tokens SET last_used_at = now() WHERE id = $1`, [id]);
  } catch {
    /* best-effort — ignore */
  }
}

/** List a tenant's tokens (RBAC-3-style management surfaces later). No raw token
 * exists to leak; the hash is included only for internal use. */
export async function listTokensForTenant(tenantId: string): Promise<HandoffTokenRow[]> {
  const r = await query<HandoffTokenRow>(
    `SELECT * FROM handoff_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return r.rows;
}

/** A connection's tokens (tenant-scoped), newest first — for the token UI. */
export async function listTokensForConnection(
  tenantId: string,
  n8nConnectionId: string,
): Promise<HandoffTokenRow[]> {
  const r = await query<HandoffTokenRow>(
    `SELECT * FROM handoff_tokens
      WHERE tenant_id = $1 AND n8n_connection_id = $2
      ORDER BY created_at DESC`,
    [tenantId, n8nConnectionId],
  );
  return r.rows;
}
