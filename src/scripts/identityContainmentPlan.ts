/**
 * ID-H §4 — identity collapse containment, DRY-RUN BY DEFAULT.
 *
 * Finds conversations and contacts keyed on a sentinel identifier ("undefined", an unrendered
 * expression, empty, …) — the Q1–Q4 collapse the new §1 guards now prevent going forward — and,
 * with --apply, QUARANTINES them: the conversation is re-keyed to an unmatchable
 * `quarantined:<uuid>` ref and detached; the shared sentinel contact's sentinel identities are
 * dropped and its channel_user_id re-keyed, so no future message can rejoin it. The data is
 * kept for human review; a quarantined conversation is invisible to GET /context.
 *
 * RE-ATTRIBUTION: NOT attempted. handoff_messages stores no per-message field that reliably
 * identifies the real sender of a message inside a collapsed thread (sender is only user/bot),
 * so splitting a collapsed conversation back into real people would be guessing. We contain, not
 * guess — exactly the planner discipline of the Fresha reconcile tool.
 *
 * Usage (worker console; read-only unless --apply):
 *   npm run identity:contain            # dry run — prints what WOULD change, writes nothing
 *   npm run identity:contain -- --apply # performs the quarantine in one transaction
 *   npm run identity:contain -- --tenant=<uuid> [--apply]   # limit to one tenant
 */
import { detectCollapsedIdentity, applyContainment } from '../db/repositories/identityContainment.js';
import { pool } from '../db/client.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const apply = arg('apply') !== undefined;
  const tenantId = arg('tenant') || undefined;

  const report = await detectCollapsedIdentity({ tenantId });
  const mixed = report.conversations.filter((c) => c.distinct_contacts > 1);

  console.log('=== ID-H §4 identity containment ===');
  console.log(tenantId ? `scope: tenant ${tenantId}` : 'scope: ALL tenants');
  console.log(`sentinel-keyed conversations: ${report.conversations.length} (${mixed.length} mix >1 distinct contact — active collapse)`);
  console.log(`sentinel contacts:            ${report.contacts.length}`);
  console.log(`legacy BSUID-cuid contacts:   ${report.legacyBsuidContacts} (informational — one real person each, NOT contained)`);

  if (report.conversations.length) {
    console.log('\n-- conversations that WOULD be quarantined (re-keyed + detached) --');
    for (const c of report.conversations.slice(0, 50)) {
      console.log(`  conv ${c.id} wf=${c.n8n_workflow_id} ref=${JSON.stringify(c.conversation_ref)} contact=${c.contact_id ?? '∅'} distinct_contacts=${c.distinct_contacts}`);
    }
    if (report.conversations.length > 50) console.log(`  … and ${report.conversations.length - 50} more`);
  }
  if (report.contacts.length) {
    console.log('\n-- contacts that WOULD be detached (sentinel identities dropped, cuid re-keyed) --');
    for (const ct of report.contacts.slice(0, 50)) {
      console.log(`  contact ${ct.id} client=${ct.client_id} cuid=${JSON.stringify(ct.channel_user_id)} sentinel_identities=${JSON.stringify(ct.sentinel_identity_values)}`);
    }
    if (report.contacts.length > 50) console.log(`  … and ${report.contacts.length - 50} more`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to contain the above.');
    if (report.conversations.length === 0 && report.contacts.length === 0) {
      console.log('Nothing to clean: no sentinel-keyed conversations or contacts found.');
    }
    return;
  }

  const result = await applyContainment(report);
  console.log(`\nAPPLIED: quarantined ${result.quarantinedConversations} conversation(s), detached ${result.detachedContacts} contact(s).`);
}

main()
  .catch((err) => {
    console.error('identity:contain failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
