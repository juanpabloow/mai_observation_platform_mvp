import { pool } from '../db/client.js';
import { backfillConversationContacts } from '../db/repositories/contactIdentities.js';

/**
 * E-5 backfill (idempotent, no migration — conversations.contact_id already exists).
 * For every conversation with contact_id NULL, resolve its conversation_ref through the C-2
 * phone normalizer against contact_identities in the same tenant+client and link it when
 * EXACTLY ONE contact matches; ambiguous / no-match are left untouched. Safe to re-run.
 */
async function main(): Promise<void> {
  const { scanned, linked, ambiguous, noMatch } = await backfillConversationContacts();
  // eslint-disable-next-line no-console
  console.log(
    [
      '=== E-5 conversation→contact backfill ===',
      `conversations scanned (contact_id NULL): ${scanned}`,
      `linked (exactly one phone match):         ${linked}`,
      `skipped — ambiguous (>1 match):           ${ambiguous}`,
      `skipped — no match (no phone/contact):    ${noMatch}`,
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
