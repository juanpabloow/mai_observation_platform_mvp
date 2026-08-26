import type { PoolClient, QueryResultRow } from 'pg';
import { query, firstRowOrThrow, withTransaction } from '../client.js';
import { normalizeE164 } from '../../scheduling/phone.js';
import { logger } from '../../logger.js';
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

/**
 * I-1: classify a workflow-DECLARED identity, HONORING its kind (unlike classifyIdentity,
 * which infers from the value). `external` is stored VERBATIM as opaque — so an opaque id
 * that happens to be all digits is never misfiled as a phone, which is the whole point of
 * letting a workflow declare a phone AND an opaque user id for the same person. phone/email
 * are still normalized (E.164 / lowercased); a value that isn't valid for its declared kind
 * returns null (the caller skips it — one bad identity never fails the write).
 */
export function classifyDeclaredIdentity(kind: IdentityKind, raw: string | null | undefined): NormalizedIdentity | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (kind === 'phone') {
    const p = normalizeE164(trimmed);
    return p ? { kind: 'phone', value: p } : null;
  }
  if (kind === 'email') {
    const l = trimmed.toLowerCase();
    return EMAIL_RE.test(l) ? { kind: 'email', value: l } : null;
  }
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
  /**
   * ADDITIONAL phones/emails beyond the primary pair — an operator who typed a person's
   * two numbers, or a contact that already carries two emails. Purely ADDITIVE to the
   * identity set: the scalar contacts.phone_e164 / contacts.email columns still come from
   * `phone` / `email` alone, so every existing caller (booking, handoff, /contacts/upsert)
   * behaves byte-for-byte as before.
   *
   * They go through buildIdentities rather than a separate INSERT after the resolve, and
   * that is the whole point: the lookup below queries the FULL identity set, so a second
   * email already claimed by another contact is found here — oldest still wins and a
   * duplicate candidate is still recorded. Attaching extras afterwards would slip them
   * past exactly the collision rules this chokepoint exists to enforce.
   */
  phones?: string[];
  emails?: string[];
  /**
   * I-1 MULTI-IDENTITY PUSH: every identity a workflow declares for one person in a single
   * call — [{kind, value, label}] using the C-2 vocabulary (phone|email|external), each with
   * its own free-text origin `label`. ADDITIVE to the identity set (like `phones`/`emails`):
   * ALL attach to the resolved contact, and — crucially — they go through the SAME lookup
   * below, so a declared identity already owned by ANOTHER contact triggers the collision
   * rules (oldest wins, duplicate candidate recorded, never auto-merged) instead of forking or
   * stealing. Unlike the value-inferred paths above, the DECLARED kind is honored: an
   * `external` value is stored VERBATIM as opaque (never re-read as a phone), which is exactly
   * what lets a WhatsApp phone (wa_id) and an opaque user id land on one contact. The scalar
   * contacts.phone_e164 / contacts.email columns STILL come from `phone`/`email` alone, so a
   * caller that omits `identities` behaves byte-for-byte as before.
   */
  identities?: Array<{ kind: IdentityKind; value: string; label?: string | null }>;
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
  // Secondary identities last, so `idents[0]` stays the primary the create path claims.
  for (const p of input.phones ?? []) add(p);
  for (const e of input.emails ?? []) add(e);
  // I-1: workflow-DECLARED identities — kind honored (external kept opaque), per-identity label.
  for (const it of input.identities ?? []) {
    const n = classifyDeclaredIdentity(it.kind, it.value);
    if (!n) continue;
    const k = `${n.kind}:${n.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...n, label: it.label ?? label });
  }
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
 * E-5: link this client's UNLINKED conversations to `contactId` when their conversation_ref
 * (raw channel id, e.g. "573058830676") normalizes to one of the contact's PHONE identities
 * (stored E.164, "+573058830676"). ONE indexed UPDATE that:
 *  - fills only NULL contact_id — NEVER overwrites an existing link;
 *  - is strictly tenant+client scoped (the conversation's CANONICAL workflow must belong to
 *    the client — the same rule the inbox + contact record use), so a phone in another
 *    client can never link across;
 *  - links ALL matches (a contact may have conversations across several client workflows).
 * The ref is normalized in SQL exactly as normalizeE164 treats a digit string — strip
 * non-digits, prepend '+' — and compared to the C-2-normalized phone identities (never raw
 * string equality). Because a phone identity is UNIQUE per (tenant,client), a NULL match
 * can only be this contact's; a conversation already linked to a different contact is left
 * untouched (the identity spine already records duplicate candidates for real collisions).
 * Returns the number of conversations newly linked.
 */
export async function linkNullConversationsByPhone(
  tenantId: string,
  clientId: string,
  contactId: string,
  client?: PoolClient,
): Promise<number> {
  const run = runner(client);
  const r = await run(
    `UPDATE conversations c
        SET contact_id = $3, updated_at = now()
      WHERE c.tenant_id = $1
        AND c.contact_id IS NULL
        AND ('+' || regexp_replace(c.conversation_ref, '[^0-9]', '', 'g')) IN (
          SELECT ci.value FROM contact_identities ci
           WHERE ci.tenant_id = $1 AND ci.client_id = $2 AND ci.contact_id = $3 AND ci.kind = 'phone'
        )
        AND EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
              FROM workflows w
             WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
             ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
          ) cw WHERE cw.client_id = $2
        )`,
    [tenantId, clientId, contactId],
  );
  return r.rowCount ?? 0;
}

/**
 * Best-effort auto-link at the chokepoint. When inside a caller transaction (booking), the
 * UPDATE runs in a SAVEPOINT so a failure ROLLS BACK ONLY the link and NEVER aborts the
 * caller — the appointment matters more than the association (log + continue).
 */
async function tryLinkConversationsByPhone(
  client: PoolClient | undefined,
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<void> {
  const run = runner(client);
  const inTxn = !!client;
  try {
    if (inTxn) await run('SAVEPOINT e5_link_conv', []);
    await linkNullConversationsByPhone(tenantId, clientId, contactId, client);
    if (inTxn) await run('RELEASE SAVEPOINT e5_link_conv', []);
  } catch (err) {
    if (inTxn) {
      try {
        await run('ROLLBACK TO SAVEPOINT e5_link_conv', []);
      } catch {
        /* the txn is already aborted; nothing more we can do here */
      }
    }
    logger.warn({ err: String(err), tenantId, clientId, contactId }, 'E-5: conversation auto-link failed; continuing');
  }
}

/**
 * D-2: on a first inbound user message, make sure the person exists in the CRM. Reuses the
 * C-2 spine — CHANNEL-BLIND: `conversationRef` is classified by VALUE (phone/email/external),
 * never assumed to be a phone. resolveContactByIdentity resolves-or-creates the contact
 * (name NULL, stage 'new', channel/source = `label`) and is concurrency-safe (the UNIQUE
 * identity index makes two simultaneous first messages converge on one contact). Then THIS
 * conversation is linked with a NULL-guarded UPDATE, so an existing link is NEVER overwritten
 * even under a race. The caller (the hot message endpoint) gates on sender='user' + a NULL
 * conversation contact + CRM enabled, and wraps this best-effort so a failure never fails the
 * push. One indexed identity lookup + an occasional insert; runs only on the FIRST inbound
 * message of a conversation (afterwards contact_id is set and the caller skips it).
 */
export async function ensureContactForInboundMessage(
  tenantId: string,
  clientId: string,
  conversationId: string,
  conversationRef: string,
  label: string,
  identities?: ResolveIdentityInput['identities'],
): Promise<void> {
  // I-1: pass the DECLARED identities through the same chokepoint. On the first message they
  // seed a new contact carrying every id; on a later message (conversation already linked) the
  // resolve still ATTACHES any newly-learned identity to the existing contact — the NULL-guarded
  // UPDATE below simply no-ops, so an existing link is never re-pointed.
  const { contact } = await resolveContactByIdentity({ tenantId, clientId, channel: label, channelUserId: conversationRef, identities });
  await query(
    `UPDATE conversations SET contact_id = $3, updated_at = now()
      WHERE id = $2 AND tenant_id = $1 AND contact_id IS NULL`,
    [tenantId, conversationId, contact.id],
  );
}

// The NULL-contact conversations + their canonical client + phone-normalized ref, and the
// contacts each matches — shared by the E-5 backfill's count + link passes.
const BACKFILL_CTE = `
  nullconv AS (
    SELECT c.id AS conv_id, c.tenant_id,
           ('+' || regexp_replace(c.conversation_ref, '[^0-9]', '', 'g')) AS e164,
           (SELECT cw.client_id FROM (
               SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
                 FROM workflows w
                WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
                ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
             ) cw LIMIT 1) AS client_id
      FROM conversations c
     WHERE c.contact_id IS NULL
  ),
  matched AS (
    SELECT nc.conv_id, nc.tenant_id, array_agg(DISTINCT ci.contact_id) AS contact_ids
      FROM nullconv nc
      JOIN contact_identities ci
        ON ci.tenant_id = nc.tenant_id AND ci.client_id = nc.client_id
       AND ci.kind = 'phone' AND ci.value = nc.e164
     WHERE nc.client_id IS NOT NULL
     GROUP BY nc.conv_id, nc.tenant_id
  )`;

/**
 * E-5 backfill (idempotent, no migration). Links every NULL-contact conversation whose
 * conversation_ref normalizes (phone) to EXACTLY ONE contact in the same tenant+client;
 * leaves ambiguous (>1) and no-match untouched. Running twice is a no-op (linked rows leave
 * the NULL set). Never overwrites an existing link.
 */
export async function backfillConversationContacts(): Promise<{ scanned: number; linked: number; ambiguous: number; noMatch: number }> {
  const scanned = (await query<{ n: number }>(`SELECT count(*)::int n FROM conversations WHERE contact_id IS NULL`)).rows[0].n;
  const ambiguous = (await query<{ n: number }>(`WITH ${BACKFILL_CTE} SELECT count(*)::int n FROM matched WHERE array_length(contact_ids, 1) > 1`)).rows[0].n;
  const linkRes = await query(
    `WITH ${BACKFILL_CTE}
     UPDATE conversations c
        SET contact_id = m.contact_ids[1], updated_at = now()
       FROM matched m
      WHERE c.id = m.conv_id AND c.tenant_id = m.tenant_id
        AND c.contact_id IS NULL
        AND array_length(m.contact_ids, 1) = 1`,
  );
  const linked = linkRes.rowCount ?? 0;
  return { scanned, linked, ambiguous, noMatch: scanned - linked - ambiguous };
}

/**
 * THE resolution chokepoint. Normalizes the inbound identities, resolves them through
 * contact_identities (creating the contact + identities on first sight), and returns
 * the contact. A value already claimed by an EXISTING contact resolves to that contact
 * — so a wa_id and a later typed phone for the same number can never become two
 * contacts. If the write's identities split across MULTIPLE existing contacts, the
 * OLDEST wins and a duplicate candidate is recorded for each other (never auto-merged).
 *
 * E-5: after resolving, it AUTO-LINKS the client's unlinked conversations of the same phone
 * (best-effort — never fails the caller). This is why a contact created by the booking/CRM
 * API now shows its WhatsApp chat, not just its appointments.
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
      const adopted = await fillEmptyAndTouch(run, input, existingId);
      await tryLinkConversationsByPhone(client, input.tenantId, input.clientId, adopted.id);
      return { contact: adopted, candidatesRecorded: 0 };
    }
    await attachIdentities(run, input, created.id, idents.slice(1));
    await tryLinkConversationsByPhone(client, input.tenantId, input.clientId, created.id);
    return { contact: created, candidatesRecorded: 0 };
  }

  // One or more existing contacts matched. Oldest wins (deterministic).
  const winnerRow = await run<ContactRow>(
    `SELECT * FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND id = ANY($3::uuid[]) ORDER BY created_at ASC, id ASC LIMIT 1`,
    [input.tenantId, input.clientId, matchedIds],
  );
  const winner = firstRowOrThrow(winnerRow as never, 'resolveContactByIdentity.winner') as ContactRow;

  if (matchedIds.length === 1) {
    // SAME person: every declared identity resolved to this one contact. Attach the ones it
    // doesn't have yet (a claimed value skips), fill only empty survivor fields, touch.
    await attachIdentities(run, input, winner.id, idents);
    const finalWinner = await fillEmptyAndTouch(run, input, winner.id);
    await tryLinkConversationsByPhone(client, input.tenantId, input.clientId, finalWinner.id);
    return { contact: finalWinner, candidatesRecorded: 0 };
  }

  // I-1: the declared identities span DIFFERENT existing contacts. NEVER auto-merge on a
  // workflow's assertion — that would silently fuse two real customers. Record the collision
  // for a human (one directed row per other contact — the candidate query is symmetric, so it
  // surfaces on BOTH contacts; a reverse row would falsely suggest keeping the newer), resolve
  // DETERMINISTICALLY to the oldest, and MUTATE NOTHING: attach no identity, steal none, fill
  // nothing — so both originals keep their data exactly as it was.
  let candidatesRecorded = 0;
  for (const other of matchedIds.filter((id) => id !== winner.id)) {
    candidatesRecorded += await recordCandidate(run, input.tenantId, input.clientId, winner.id, other, 'identity_collision');
  }
  return { contact: winner, candidatesRecorded };
}

// ── READ-ONLY lookups for the book-by-contact path (C-4.1) ──────────────────────────
// These never create or mutate a contact. The booking domain uses them when an explicit
// contact_id is supplied: validate it belongs to the client, and refuse if typed identity
// strings point at a DIFFERENT existing contact.

/** Does this contact belong to (tenant, client)? Pure existence check, no mutation. */
export async function contactBelongsToClient(
  tenantId: string,
  clientId: string,
  contactId: string,
  client?: PoolClient,
): Promise<boolean> {
  const run = runner(client);
  const r = await run(
    `SELECT 1 FROM contacts WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
    [contactId, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface ContactCard {
  id: string;
  name: string | null;
  primary_identity: string | null;
}

/** A contact's display card — id, name, and main phone-or-email — for a machine response
 *  (C-7). ONE query, client-scoped (null for a missing/cross-client id). */
export async function getContactCardById(
  tenantId: string,
  clientId: string,
  contactId: string,
  client?: PoolClient,
): Promise<ContactCard | null> {
  const run = runner(client);
  const r = await run<ContactCard>(
    `SELECT c.id, c.name,
            (SELECT ci.value FROM contact_identities ci
              WHERE ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id AND ci.contact_id = c.id
                AND ci.kind IN ('phone','email')
              ORDER BY (ci.kind = 'phone') DESC, ci.created_at ASC LIMIT 1) AS primary_identity
       FROM contacts c
      WHERE c.id = $1 AND c.tenant_id = $2 AND c.client_id = $3`,
    [contactId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** The DISTINCT contact ids the given identity strings currently map to within this
 *  client (via contact_identities). Empty when none are claimed yet. Read-only — used to
 *  detect a contact_id-vs-typed-identity conflict WITHOUT resolving (which would create). */
export async function findContactIdsByIdentity(
  input: { tenantId: string; clientId: string; channelUserId?: string | null; phone?: string | null; email?: string | null },
  client?: PoolClient,
): Promise<string[]> {
  const run = runner(client);
  const pairs: Array<{ kind: string; value: string }> = [];
  const seen = new Set<string>();
  for (const raw of [input.channelUserId, input.phone, input.email]) {
    const n = classifyIdentity(raw);
    if (!n) continue;
    const k = `${n.kind}:${n.value}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push(n);
  }
  if (pairs.length === 0) return [];
  const kinds = pairs.map((p) => p.kind);
  const values = pairs.map((p) => p.value);
  const r = await run<{ contact_id: string }>(
    `SELECT DISTINCT contact_id FROM contact_identities
      WHERE tenant_id=$1 AND client_id=$2
        AND (kind, value) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
    [input.tenantId, input.clientId, kinds, values],
  );
  return r.rows.map((row) => row.contact_id);
}

export interface IdentityMatch {
  contact_id: string;
  name: string | null;
  /** The stored identity that matched — E.164 for a phone, lowercased for an email. */
  matched_value: string;
  stage: string;
  last_contact_at: Date;
  created_at: Date;
}

/**
 * The contacts that already carry one typed identity — the form's inline duplicate
 * check. STRICTLY READ-ONLY: it resolves nothing and creates nothing, which is what
 * lets the form run it on every keystroke-settle without a half-typed number minting
 * a contact. (resolveContactByIdentity would create; findContactIdsByIdentity doesn't
 * but returns bare ids, and the operator needs to SEE who they'd be duplicating.)
 *
 * IT SEARCHES TWO SURFACES, AND MUST. `contact_identities` is UNIQUE per
 * (tenant, client, kind, value), so an identities-only query could never return more
 * than ONE row — it would be structurally incapable of reporting "ya existen 3
 * contactos con este número". The duplicates that actually exist live in the SCALAR
 * columns: contacts predating the C-2 spine (and any row insertContact created without
 * identity rows) have a phone_e164 / channel_user_id and no identity at all, and
 * contacts_tenant_client_phone_idx is a plain index, not a unique one. On the dev
 * database today that is 4 of 5 contacts, with one phone already shared by two of them
 * — so the identities-only version reported "no existe un contacto con este dato" for a
 * number that visibly duplicates, which is precisely the failure this feature exists to
 * prevent.
 *
 * Both surfaces are compared NORMALIZED, never as raw strings: the phone side strips
 * non-digits and re-prefixes '+' in SQL exactly as normalizeE164 treats a digit string
 * (the same expression linkNullConversationsByPhone uses), so a stored "573043906303"
 * and a stored "+57 304 390 6303" both match one typed value. The email side lowercases.
 *
 * Returns at most `limit` rows plus the TRUE total, because the UI says "Ya existen 3
 * contactos" while showing two — a count taken from the truncated array would say 2.
 * Oldest first: that is the contact the spine would pick as the survivor, so the first
 * card is the one the operator most likely wants to open.
 */
export async function findContactMatchesByIdentity(
  tenantId: string,
  clientId: string,
  rawValue: string,
  opts: { limit?: number; excludeContactId?: string | null } = {},
): Promise<{ matches: IdentityMatch[]; total: number }> {
  const n = classifyIdentity(rawValue);
  // `external` is not an identity a human types into the phone/email fields.
  if (!n || n.kind === 'external') return { matches: [], total: 0 };
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 10);

  // The scalar-column predicate, per kind. `channel_user_id` is included because a
  // contact born from a WhatsApp message keeps the raw wa_id there and may have nothing
  // else; it is NOT included for email-kind matching of a phone value (classifyIdentity
  // already decided which kind we are looking for).
  const digits = `('+' || regexp_replace($4, '[^0-9]', '', 'g'))`;
  const scalarMatch =
    n.kind === 'phone'
      ? `('+' || regexp_replace(coalesce(c.phone_e164, ''), '[^0-9]', '', 'g')) = ${digits}
         OR ('+' || regexp_replace(coalesce(c.channel_user_id, ''), '[^0-9]', '', 'g')) = ${digits}`
      : `lower(coalesce(c.email, '')) = $4 OR lower(coalesce(c.channel_user_id, '')) = $4`;

  const params: unknown[] = [tenantId, clientId, n.kind, n.value];
  let exclude = '';
  if (opts.excludeContactId) {
    params.push(opts.excludeContactId);
    exclude = ` AND c.id <> $${params.length}::uuid`;
  }
  params.push(limit);

  // ONE query. The window count is the untruncated total, so the heading and the cards
  // can never disagree (a second COUNT round-trip could also race against a write).
  // `matched_value` prefers the stored identity when there is one, else the scalar the
  // row actually matched on — the card shows what is ON RECORD, not what was typed.
  const r = await query<IdentityMatch & { total: string }>(
    `SELECT c.id AS contact_id, c.name,
            COALESCE(
              (SELECT ci.value FROM contact_identities ci
                WHERE ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id
                  AND ci.contact_id = c.id AND ci.kind = $3 AND ci.value = $4),
              CASE WHEN $3 = 'phone' THEN COALESCE(c.phone_e164, c.channel_user_id)
                   ELSE COALESCE(c.email, c.channel_user_id) END
            ) AS matched_value,
            c.stage, c.last_contact_at, c.created_at,
            COUNT(*) OVER () AS total
       FROM contacts c
      WHERE c.tenant_id = $1 AND c.client_id = $2${exclude}
        AND (
          EXISTS (
            SELECT 1 FROM contact_identities ci
             WHERE ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id
               AND ci.contact_id = c.id AND ci.kind = $3 AND ci.value = $4
          )
          OR (${scalarMatch})
        )
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT $${params.length}`,
    params,
  );
  return {
    matches: r.rows.map(({ total: _total, ...m }) => m),
    total: Number(r.rows[0]?.total ?? 0),
  };
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

/** Open (unresolved) duplicate candidates involving THIS contact (either side) — for the
 *  record's duplicate banner. Same display join as listOpenCandidates, filtered to rows
 *  where the contact is the keep OR the duplicate. Client-scoped. */
export async function listCandidatesForContact(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<CandidateRow[]> {
  const r = await query<CandidateRow>(
    `SELECT d.id, d.contact_id_keep, k.name AS keep_name, k.channel_user_id AS keep_ref,
            d.contact_id_duplicate, u.name AS dup_name, u.channel_user_id AS dup_ref,
            d.reason, d.detected_at
       FROM duplicate_contact_candidates d
       JOIN contacts k ON k.id = d.contact_id_keep
       JOIN contacts u ON u.id = d.contact_id_duplicate
      WHERE d.tenant_id=$1 AND d.client_id=$2 AND d.resolved_at IS NULL
        AND (d.contact_id_keep=$3 OR d.contact_id_duplicate=$3)
      ORDER BY d.detected_at ASC`,
    [tenantId, clientId, contactId],
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
