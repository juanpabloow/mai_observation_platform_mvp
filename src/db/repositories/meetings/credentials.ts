import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { query } from '../../client.js';

/**
 * Autenticación de un worker por su credencial. **Toda la identidad sale de la
 * credencial**: pool, ambiente, alcance y capacidades. Nada de eso se lee del
 * cuerpo ni de la query de la petición.
 *
 * ── Por qué el lookup va por prefijo y la comparación es timing-safe ────────
 *
 * Lo natural sería `WHERE token_hash = $1`: un índice y listo. Pero entonces la
 * única comparación del secreto la hace PostgreSQL, y «hash y comparación
 * timing-safe» quedaría delegado a un motor cuyo comportamiento temporal en esa
 * comparación no controlamos.
 *
 * Así que se busca por `token_prefix` —que ya se guarda en claro porque la UI lo
 * muestra, así que no es secreto— y el digesto completo se compara en proceso
 * con `timingSafeEqual`. El prefijo es de 8 caracteres, así que puede devolver
 * más de una fila; se comparan todas y se para en la que verifica.
 *
 * ── Deny-by-default ─────────────────────────────────────────────────────────
 *
 * Una credencial revocada o caducada NO autentica. Se filtra en el propio SQL,
 * no después: si alguien añade una rama en el código que se olvide de mirar
 * `revoked_at`, la fila ya no está ahí para olvidarla.
 */

export type WorkerCapability =
  | 'meetings.transcribe'
  | 'meetings.analyze'
  /**
   * Mantenimiento global: reencolar los leases caducados de TODA la
   * instalación. No es una capacidad reclamable —no tiene etapa ni
   * concurrencia— y por eso está separada en el vocabulario de M-1.
   *
   * Ninguna credencial de proceso la tiene por defecto, y una credencial de un
   * pool atado a un tenant NO PUEDE TENERLA: `pools_scope_allows_capabilities`
   * lo impide en la base. Sobre eso, `requeueExpiredLeases` exige además
   * `scope === 'internal'`, porque una `WorkerIdentity` se puede construir en
   * memoria sin pasar por `worker_pools`.
   */
  | 'meetings.maintenance';

export interface WorkerIdentity {
  readonly credentialId: string;
  readonly credentialLabel: string;
  readonly poolId: string;
  readonly poolSlug: string;
  readonly environment: 'production' | 'staging' | 'development';
  readonly scope: 'internal' | 'single_tenant';
  /** Sólo para `single_tenant`. Para `internal` es null: ve cualquier tenant. */
  readonly tenantId: string | null;
  readonly capabilities: readonly WorkerCapability[];
  readonly concurrency: Readonly<Record<string, number>>;
  readonly maxBytes: number | null;
  /** Etiqueta que mai escribe en `leased_credential_label` y en la auditoría. */
  readonly attributionLabel: string;
}

export function hashWorkerToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** `mtk_` + 32 bytes aleatorios. El prefijo guardado son los 8 primeros chars. */
export function mintWorkerToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = `mtk_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashWorkerToken(token), tokenPrefix: token.slice(0, 8) };
}

interface CredentialRow {
  id: string;
  label: string;
  token_hash: string;
  pool_id: string;
  pool_slug: string;
  environment: 'production' | 'staging' | 'development';
  scope: 'internal' | 'single_tenant';
  tenant_id: string | null;
  capabilities: string[];
  concurrency: { limits?: Record<string, number> } | null;
  max_bytes: string | null;
  token_prefix: string;
}

/**
 * Autentica y devuelve la identidad, o null. Un solo null para todos los
 * motivos: token ausente, formato raro, prefijo desconocido, hash que no cuadra,
 * credencial revocada, caducada o de un pool desactivado.
 */
export async function authenticateWorkerToken(rawToken: string): Promise<WorkerIdentity | null> {
  // Un token con una forma imposible no llega a tocar la base.
  if (typeof rawToken !== 'string' || rawToken.length < 8 || rawToken.length > 512) return null;
  const prefix = rawToken.slice(0, 8);

  const result = await query<CredentialRow>(
    `SELECT c.id, c.label, c.token_hash, c.token_prefix,
            p.id AS pool_id, p.slug AS pool_slug, p.environment, p.scope,
            p.tenant_id, p.capabilities, p.concurrency, p.max_bytes
       FROM worker_credentials c
       JOIN worker_pools p ON p.id = c.pool_id
      WHERE c.token_prefix = $1
        AND c.revoked_at IS NULL
        AND (c.expires_at IS NULL OR c.expires_at > now())
        AND p.enabled`,
    [prefix],
  );
  if (result.rows.length === 0) return null;

  const expected = hashWorkerToken(rawToken);
  const expectedBuf = Buffer.from(expected, 'hex');
  let matched: CredentialRow | null = null;
  for (const row of result.rows) {
    if (!/^[0-9a-f]{64}$/.test(row.token_hash)) continue;
    if (timingSafeEqual(expectedBuf, Buffer.from(row.token_hash, 'hex'))) {
      matched = row;
      break;
    }
  }
  if (!matched) return null;

  void touchLastUsed(matched.id);

  return {
    credentialId: matched.id,
    credentialLabel: matched.label,
    poolId: matched.pool_id,
    poolSlug: matched.pool_slug,
    environment: matched.environment,
    scope: matched.scope,
    tenantId: matched.tenant_id,
    capabilities: matched.capabilities.filter(isWorkerCapability),
    concurrency: matched.concurrency?.limits ?? {},
    maxBytes: matched.max_bytes === null ? null : Number(matched.max_bytes),
    // Lo que queda en `leased_credential_label` y en los eventos: identifica la
    // credencial sin contener nada secreto (el prefijo ya es público).
    attributionLabel: `${matched.pool_slug}/${matched.token_prefix}`,
  };
}

function isWorkerCapability(value: string): value is WorkerCapability {
  return (
    value === 'meetings.transcribe' ||
    value === 'meetings.analyze' ||
    value === 'meetings.maintenance'
  );
}

/** Las que corresponden a una etapa. Espeja `meetings_claimable_capability`. */
export function isClaimableCapability(value: string): boolean {
  return value === 'meetings.transcribe' || value === 'meetings.analyze';
}

/** Telemetría best-effort. Un fallo aquí no debe tumbar una autenticación. */
async function touchLastUsed(credentialId: string): Promise<void> {
  try {
    await query(`UPDATE worker_credentials SET last_used_at = now() WHERE id = $1`, [credentialId]);
  } catch {
    // Deliberadamente silencioso: es un contador, no una garantía.
  }
}

/** Revoca dejando constancia. `actor` decide qué columna identifica al autor. */
export async function revokeCredential(
  credentialId: string,
  actor: { kind: 'user'; userId: string; label: string } | { kind: 'system'; process: string },
  reason: string,
): Promise<boolean> {
  const label = actor.kind === 'user' ? actor.label : actor.process;
  const userId = actor.kind === 'user' ? actor.userId : null;
  const result = await query(
    `UPDATE worker_credentials
        SET revoked_at = now(), revoked_actor = $2, revoked_actor_label = $3,
            revoked_reason = $4, revoked_by_user_id = $5
      WHERE id = $1 AND revoked_at IS NULL`,
    [credentialId, actor.kind, label, reason, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
