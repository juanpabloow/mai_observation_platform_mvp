import { pool, query } from '../db/client.js';
import { classifyIdentity } from '../db/repositories/contactIdentities.js';
import type { ContactRow } from '../db/repositories/contacts.js';

/**
 * C-2 backfill: one contact_identities row per existing contact (from channel_user_id
 * + phone_e164 + email), and a duplicate_contact_candidates row whenever two contacts
 * normalize to the SAME identity value. IDEMPOTENT + re-runnable: every insert is
 * guarded (identity by its UNIQUE, candidate by ON CONFLICT DO NOTHING), so a second
 * run creates nothing new and leaves the same end state.
 *
 * COLLISION POLICY (no auto-merge): contacts are processed OLDEST-FIRST, so the oldest
 * contact claims a shared identity value (the winner). A later contact that would claim
 * the same value does NOT get the identity; instead a candidate (keep=winner,
 * duplicate=this contact) is recorded. Nothing is deleted — the loser keeps its own row
 * and history until a human merges it. CONSEQUENCE: until merged, new messages/bookings
 * for that identity attach to the WINNER while the loser's history stays behind.
 *
 * Run: npm run backfill:contact-spine
 */

interface Ident {
  kind: 'phone' | 'email' | 'external';
  value: string;
}

function deriveIdentities(c: ContactRow): Ident[] {
  const out: Ident[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null) => {
    const n = classifyIdentity(raw);
    if (!n) return;
    const k = `${n.kind}:${n.value}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  add(c.channel_user_id);
  add(c.phone_e164);
  add(c.email);
  return out;
}

async function main(): Promise<void> {
  const groups = (
    await query<{ tenant_id: string; client_id: string }>(
      `SELECT DISTINCT tenant_id, client_id FROM contacts ORDER BY tenant_id, client_id`,
    )
  ).rows;

  let totalContacts = 0;
  let totalCreated = 0;
  let totalCollisions = 0;
  const perGroup: string[] = [];

  for (const g of groups) {
    // Oldest first so the oldest contact wins a shared identity value.
    const contacts = (
      await query<ContactRow>(
        `SELECT * FROM contacts WHERE tenant_id=$1 AND client_id=$2 ORDER BY created_at ASC, id ASC`,
        [g.tenant_id, g.client_id],
      )
    ).rows;

    let created = 0;
    let collisions = 0;
    for (const c of contacts) {
      for (const id of deriveIdentities(c)) {
        const existing = (
          await query<{ contact_id: string }>(
            `SELECT contact_id FROM contact_identities WHERE tenant_id=$1 AND client_id=$2 AND kind=$3 AND value=$4`,
            [g.tenant_id, g.client_id, id.kind, id.value],
          )
        ).rows[0];
        if (existing) {
          if (existing.contact_id !== c.id) {
            // Shared value → the earlier (older) contact is the winner.
            const rec = await query(
              `INSERT INTO duplicate_contact_candidates (tenant_id, client_id, contact_id_keep, contact_id_duplicate, reason)
                 VALUES ($1,$2,$3,$4,'backfill_collision')
               ON CONFLICT (tenant_id, client_id, contact_id_keep, contact_id_duplicate) DO NOTHING`,
              [g.tenant_id, g.client_id, existing.contact_id, c.id],
            );
            collisions += rec.rowCount ?? 0;
          }
          // else already ours (re-run) — skip.
        } else {
          await query(
            `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label)
               VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (tenant_id, client_id, kind, value) DO NOTHING`,
            [g.tenant_id, g.client_id, c.id, id.kind, id.value, c.channel],
          );
          created += 1;
        }
      }
    }

    const openCandidates = (
      await query<{ n: number }>(
        `SELECT count(*)::int n FROM duplicate_contact_candidates WHERE tenant_id=$1 AND client_id=$2 AND resolved_at IS NULL`,
        [g.tenant_id, g.client_id],
      )
    ).rows[0].n;
    const totalIdents = (
      await query<{ n: number }>(
        `SELECT count(*)::int n FROM contact_identities WHERE tenant_id=$1 AND client_id=$2`,
        [g.tenant_id, g.client_id],
      )
    ).rows[0].n;

    totalContacts += contacts.length;
    totalCreated += created;
    totalCollisions += collisions;
    perGroup.push(
      `  tenant ${g.tenant_id.slice(0, 8)}… client ${g.client_id.slice(0, 8)}…  contacts=${contacts.length}  identities(total)=${totalIdents} (+${created} this run)  openCandidates=${openCandidates} (+${collisions} this run)`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      '=== C-2 contact-identity backfill ===',
      ...perGroup,
      `--- totals: contacts processed=${totalContacts}  identities created this run=${totalCreated}  collisions found this run=${totalCollisions} ---`,
    ].join('\n'),
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    return pool.end().finally(() => process.exit(1));
  });
