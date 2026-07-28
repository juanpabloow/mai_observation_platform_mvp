import type { PoolClient, QueryResultRow } from 'pg';
import { query, firstRowOrThrow, withTransaction } from '../client.js';
import { normalizeE164 } from '../../scheduling/phone.js';
import type { ContactRow } from './contacts.js';

/**
 * THE contact-identity spine (C-2). One chokepoint — resolveContactByIdentity —
 * owns how any inbound identity (a WhatsApp wa_id, a typed booking phone, an email)
 * resolves to a contact, the way resolveWorkflowScope owns workflow scope. Nothing
 * here branches on the channel/label: classification looks at the VALUE only.
 */

export type IdentityKind = 'phone' | 'email' | 'external';
export interface NormalizedIdentity {
  kind: IdentityKind;
  value: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * CHANNEL-AGNOSTIC classification (the design principle): inspect the VALUE, never the
 * channel label. A value that normalizes as a phone IS a phone — this is what collapses
 * a WhatsApp wa_id and a typed booking phone into ONE identity. An @-address is an
 * email (lowercased/trimmed). Anything else is an opaque `external` id, stored as-is.
 * Returns null for an empty/unusable value.
 */
export function classifyIdentity(raw: string | null | undefined): NormalizedIdentity | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const phone = normalizeE164(trimmed);
  if (phone) return { kind: 'phone', value: phone };
  const lower = trimmed.toLowerCase();
  if (EMAIL_RE.test(lower)) return { kind: 'email', value: lower };
  return { kind: 'external', value: trimmed };
}

export interface ResolveIdentityInput {
  tenantId: string;
  clientId: string;
  /** How the contact arrived — descriptive SOURCE + the identity label. Never branched. */
  channel: string;
  /** The primary channel id (wa_id / typed phone / external id). */
  channelUserId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

type Run = <T extends QueryResultRow>(text: string, params: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
const runner = (client?: PoolClient): Run =>
  client ? (t, p) => client.query(t, p) : (t, p) => query(t, p);

interface LabeledIdentity extends NormalizedIdentity {
  label: string | null;
}

/** Build the deduped identity set for a write (primary = channelUserId, first). */
function buildIdentities(input: ResolveIdentityInput): LabeledIdentity[] {
  const label = input.channel || null;
  const out: LabeledIdentity[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined) => {
    const n = classifyIdentity(raw);
    if (!n) return;
    const k = `${n.kind}:${n.value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...n, label });
  };
  add(input.channelUserId); // primary
  add(input.phone);
  add(input.email);
  return out;
}

async function insertContact(run: Run, input: ResolveIdentityInput): Promise<ContactRow> {
  const r = await run<ContactRow>(
    `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name, phone_e164, email, last_contact_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
    [input.tenantId, input.clientId, input.channel, input.channelUserId, input.name ?? null, normalizeE164(input.phone), input.email ?? null],
  );
  return firstRowOrThrow(r as never, 'insertContact');
}

/** Attach identities to a contact, skipping any value already claimed (by this or any
 * contact) — a claimed-by-another value is a collision handled by the caller. */
async function attachIdentities(run: Run, input: ResolveIdentityInput, contactId: string, idents: LabeledIdentity[]): Promise<void> {
  for (const i of idents) {
    await run(
      `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, client_id, kind, value) DO NOTHING`,
      [input.tenantId, input.clientId, contactId, i.kind, i.value, i.label],
    );
  }
}

async function getContact(run: Run, tenantId: string, clientId: string, id: string): Promise<ContactRow> {
  const r = await run<ContactRow>(`SELECT * FROM contacts WHERE id=$1 AND tenant_id=$2 AND client_id=$3`, [id, tenantId, clientId]);
  return firstRowOrThrow(r as never, 'getContact');
}

/** Fill only the empty survivor fields from this write; advance last_contact_at. */
async function fillEmptyAndTouch(run: Run, input: ResolveIdentityInput, id: string): Promise<ContactRow> {
  const r = await run<ContactRow>(
    `UPDATE contacts
        SET name = COALESCE(name, $4),
            phone_e164 = COALESCE(phone_e164, $5),
            email = COALESCE(email, $6),
            last_contact_at = now(), updated_at = now()
      WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING *`,
    [id, input.tenantId, input.clientId, input.name ?? null, normalizeE164(input.phone), input.email ?? null],
  );
  return firstRowOrThrow(r as never, 'fillEmptyAndTouch');
}

async function recordCandidate(run: Run, tenantId: string, clientId: string, keep: string, dup: string, reason: string): Promise<number> {
  if (keep === dup) return 0;
  const r = await run(
    `INSERT INTO duplicate_contact_candidates (tenant_id, client_id, contact_id_keep, contact_id_duplicate, reason)
       VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, client_id, contact_id_keep, contact_id_duplicate) DO NOTHING`,
    [tenantId, clientId, keep, dup, reason],
  );
  return r.rowCount ?? 0;
}

/**
 * THE resolution chokepoint. Normalizes the inbound identities, resolves them through
 * contact_identities (creating the contact + identities on first sight), and returns
 * the contact. A value already claimed by an EXISTING contact resolves to that contact
 * — so a wa_id and a later typed phone for the same number can never become two
 * contacts. If the write's identities split across MULTIPLE existing contacts, the
 * OLDEST wins and a duplicate candidate is recorded for each other (never auto-merged).
 */
export async function resolveContactByIdentity(
  input: ResolveIdentityInput,
  client?: PoolClient,
): Promise<{ contact: ContactRow; candidatesRecorded: number }> {
  const run = runner(client);
  const idents = buildIdentities(input);
  if (idents.length === 0) {
    // Defensive: no usable identity → a bare contact with no identity row.
    return { contact: await insertContact(run, input), candidatesRecorded: 0 };
  }

  const pred = idents.map((_, k) => `($${3 + 2 * k}, $${4 + 2 * k})`).join(', ');
  const found = await run<{ contact_id: string }>(
    `SELECT DISTINCT contact_id FROM contact_identities
       WHERE tenant_id=$1 AND client_id=$2 AND (kind, value) IN (${pred})`,
    [input.tenantId, input.clientId, ...idents.flatMap((i) => [i.kind, i.value])],
  );
  const matchedIds = found.rows.map((r) => r.contact_id);

  if (matchedIds.length === 0) {
    // CREATE — race-safe: create, then claim the primary identity; if lost, adopt the winner.
    const created = await insertContact(run, input);
    const primary = idents[0];
    const claim = await run<{ contact_id: string }>(
      `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label)
         VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, client_id, kind, value) DO NOTHING RETURNING contact_id`,
      [input.tenantId, input.clientId, created.id, primary.kind, primary.value, primary.label],
    );
    if ((claim.rowCount ?? 0) === 0) {
      const owner = await run<{ contact_id: string }>(
        `SELECT contact_id FROM contact_identities WHERE tenant_id=$1 AND client_id=$2 AND kind=$3 AND value=$4`,
        [input.tenantId, input.clientId, primary.kind, primary.value],
      );
      // Drop our just-created orphan (no children yet) and adopt the existing contact.
      await run(`DELETE FROM contacts WHERE id=$1 AND tenant_id=$2 AND client_id=$3`, [created.id, input.tenantId, input.clientId]);
      const existingId = owner.rows[0].contact_id;
      await attachIdentities(run, input, existingId, idents);
      return { contact: await fillEmptyAndTouch(run, input, existingId), candidatesRecorded: 0 };
    }
    await attachIdentities(run, input, created.id, idents.slice(1));
    return { contact: created, candidatesRecorded: 0 };
  }

  // One or more existing contacts matched. Oldest wins.
  const winnerRow = await run<ContactRow>(
    `SELECT * FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND id = ANY($3::uuid[]) ORDER BY created_at ASC, id ASC LIMIT 1`,
    [input.tenantId, input.clientId, matchedIds],
  );
  const winner = firstRowOrThrow(winnerRow as never, 'resolveContactByIdentity.winner') as ContactRow;

  let candidatesRecorded = 0;
  for (const other of matchedIds.filter((id) => id !== winner.id)) {
    candidatesRecorded += await recordCandidate(run, input.tenantId, input.clientId, winner.id, other, 'identity_collision');
  }
  // Attach any of this write's still-free identities to the winner (claimed ones skip).
  await attachIdentities(run, input, winner.id, idents);
  return { contact: await fillEmptyAndTouch(run, input, winner.id), candidatesRecorded };
}

// ── Identity display / candidate management ────────────────────────────────────────

export interface IdentityRow {
  id: string;
  kind: IdentityKind;
  value: string;
  label: string | null;
  created_at: Date;
}
export async function listIdentitiesForContact(tenantId: string, clientId: string, contactId: string): Promise<IdentityRow[]> {
  const r = await query<IdentityRow>(
    `SELECT id, kind, value, label, created_at FROM contact_identities
      WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3 ORDER BY created_at ASC`,
    [tenantId, clientId, contactId],
  );
  return r.rows;
}

export interface CandidateRow {
  id: string;
  contact_id_keep: string;
  keep_name: string | null;
  keep_ref: string;
  contact_id_duplicate: string;
  dup_name: string | null;
  dup_ref: string;
  reason: string | null;
  detected_at: Date;
}
/** Open (unresolved) duplicate candidates for a client, with both contacts' display fields. */
export async function listOpenCandidates(tenantId: string, clientId: string): Promise<CandidateRow[]> {
  const r = await query<CandidateRow>(
    `SELECT d.id, d.contact_id_keep, k.name AS keep_name, k.channel_user_id AS keep_ref,
            d.contact_id_duplicate, u.name AS dup_name, u.channel_user_id AS dup_ref,
            d.reason, d.detected_at
       FROM duplicate_contact_candidates d
       JOIN contacts k ON k.id = d.contact_id_keep
       JOIN contacts u ON u.id = d.contact_id_duplicate
      WHERE d.tenant_id=$1 AND d.client_id=$2 AND d.resolved_at IS NULL
      ORDER BY d.detected_at ASC`,
    [tenantId, clientId],
  );
  return r.rows;
}

export async function dismissCandidate(tenantId: string, clientId: string, candidateId: string): Promise<boolean> {
  const r = await query(
    `UPDATE duplicate_contact_candidates SET resolved_at = now(), reason = 'dismissed'
      WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND resolved_at IS NULL`,
    [candidateId, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── Merge (transactional, auditable, no silent data loss) ───────────────────────────

export interface MergeResult {
  ok: boolean;
  reason?: string;
  keptId?: string;
}

/**
 * Merge `dropId` INTO `keepId` in one transaction: move identities, appointments and
 * conversations to keep; keep the earliest created_at; fill empty survivor fields from
 * the duplicate (never overwrite); delete the duplicate (a JSON snapshot is written to
 * contact_merges so a human could reverse it); resolve/cascade the candidate row. Derived
 * values (visits, "customer") recompute at read time from the moved appointments.
 * (C-3 note: when notes/tasks/tags land, add their move here.)
 */
export async function mergeContacts(
  tenantId: string,
  clientId: string,
  keepId: string,
  dropId: string,
  mergedByUserId: string | null,
): Promise<MergeResult> {
  if (keepId === dropId) return { ok: false, reason: 'same_contact' };
  return withTransaction(async (client) => {
    const run = runner(client);
    const both = await run<ContactRow>(
      `SELECT * FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND id = ANY($3::uuid[]) FOR UPDATE`,
      [tenantId, clientId, [keepId, dropId]],
    );
    const keep = both.rows.find((c) => c.id === keepId);
    const drop = both.rows.find((c) => c.id === dropId);
    if (!keep || !drop) return { ok: false, reason: 'not_found' };

    // Snapshot the duplicate (fields + identities) BEFORE moving anything.
    const dropIdentities = (await run(`SELECT kind, value, label FROM contact_identities WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3`, [tenantId, clientId, dropId])).rows;
    const snapshot = { contact: drop, identities: dropIdentities };

    // Move identities that keep doesn't already have; drop the rest (true value-dups).
    await run(
      `UPDATE contact_identities ci SET contact_id=$4
        WHERE ci.tenant_id=$1 AND ci.client_id=$2 AND ci.contact_id=$3
          AND NOT EXISTS (SELECT 1 FROM contact_identities k
                           WHERE k.tenant_id=$1 AND k.client_id=$2 AND k.contact_id=$4 AND k.kind=ci.kind AND k.value=ci.value)`,
      [tenantId, clientId, dropId, keepId],
    );
    await run(`DELETE FROM contact_identities WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3`, [tenantId, clientId, dropId]);

    // Move child rows.
    await run(`UPDATE appointments SET contact_id=$4, updated_at=now() WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3`, [tenantId, clientId, dropId, keepId]);
    await run(`UPDATE conversations SET contact_id=$3, updated_at=now() WHERE tenant_id=$1 AND contact_id=$2`, [tenantId, dropId, keepId]);

    // Survivor: keep earliest created_at; fill only empty fields; union custom_fields (keep wins).
    await run(
      `UPDATE contacts
          SET created_at = LEAST(created_at, $4::timestamptz),
              name = COALESCE(name, $5), phone_e164 = COALESCE(phone_e164, $6), email = COALESCE(email, $7),
              assigned_to = COALESCE(assigned_to, $8),
              custom_fields = $9::jsonb || custom_fields,
              updated_at = now()
        WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
      [keepId, tenantId, clientId, drop.created_at, drop.name, drop.phone_e164, drop.email, drop.assigned_to, JSON.stringify(drop.custom_fields ?? {})],
    );

    // Resolve the candidate (best-effort; it also cascades when the drop row is deleted).
    await run(
      `UPDATE duplicate_contact_candidates SET resolved_at=now(), reason='merged'
        WHERE tenant_id=$1 AND client_id=$2 AND resolved_at IS NULL
          AND ((contact_id_keep=$3 AND contact_id_duplicate=$4) OR (contact_id_keep=$4 AND contact_id_duplicate=$3))`,
      [tenantId, clientId, keepId, dropId],
    );

    // Audit BEFORE deleting the drop (delete cascades its remaining candidate rows).
    await run(
      `INSERT INTO contact_merges (tenant_id, client_id, kept_contact_id, dropped_contact_id, merged_by, dropped_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [tenantId, clientId, keepId, dropId, mergedByUserId, JSON.stringify(snapshot)],
    );

    await run(`DELETE FROM contacts WHERE id=$1 AND tenant_id=$2 AND client_id=$3`, [dropId, tenantId, clientId]);
    return { ok: true, keptId: keepId };
  });
}
