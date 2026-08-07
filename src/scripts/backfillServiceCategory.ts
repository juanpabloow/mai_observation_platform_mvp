/**
 * OPTIONAL backfill for services.category.
 *
 * The migration deliberately leaves the column NULL: nothing breaks, because the
 * agenda still infers a colour family from the service NAME when it is unset. But
 * "unset" also means the operator sees no category anywhere and the agenda keeps
 * guessing, so this script writes down the guess ONCE — after which it is a value
 * someone can correct, instead of a rule buried in the front-end.
 *
 * It is deliberately NOT part of the migration: a migration should not make product
 * decisions about a shop's catalogue, and this one is a judgement call ("Corte de
 * barba" is grooming, probably). Run it if you want a starting point.
 *
 *   npx tsx src/scripts/backfillServiceCategory.ts             # DRY RUN, prints the plan
 *   npx tsx src/scripts/backfillServiceCategory.ts --apply     # writes
 *
 * Safe to re-run: it only ever touches rows where category IS NULL, so a category an
 * operator has since corrected is never overwritten.
 */
import { query } from '../db/client.js';
import { SERVICE_CATEGORIES, type ServiceCategory } from '../db/repositories/scheduling/services.js';

/** The SAME rule the front-end falls back to — kept in step with
 *  web/lib/agendaCategory.ts. Most specific first. */
const KEYWORDS: Array<{ category: ServiceCategory; words: string[] }> = [
  { category: 'feature', words: ['keratin', 'queratina', 'botox', 'alisado', 'premium', 'transformation'] },
  {
    category: 'color',
    words: ['colour', 'color', 'highlight', 'mecha', 'balayage', 'tinte', 'gloss', 'toner', 'bleach', 'decolor'],
  },
  {
    category: 'grooming',
    words: ['beard', 'barba', 'shave', 'afeitad', 'grooming', 'moustache', 'mustache', 'bigote', 'sculpt', 'brow', 'ceja'],
  },
  { category: 'cut', words: ['cut', 'corte', 'fade', 'trim', 'haircut', 'buzz', 'kids', 'nino', 'peinado', 'styling'] },
];

function normalise(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** null = no keyword matched. Those rows are LEFT NULL rather than defaulted to
 *  'cut': an unclassified service should look unclassified to whoever reviews it. */
function classify(name: string): ServiceCategory | null {
  const n = normalise(name);
  for (const { category, words } of KEYWORDS) {
    if (words.some((w) => n.includes(w))) return category;
  }
  return null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const r = await query<{ id: string; name: string; tenant_id: string }>(
    `SELECT id, name, tenant_id FROM services WHERE category IS NULL ORDER BY name`,
  );

  const plan = r.rows
    .map((row) => ({ ...row, category: classify(row.name) }))
    .filter((row): row is typeof row & { category: ServiceCategory } => row.category !== null);
  const skipped = r.rows.length - plan.length;

  const byCategory = new Map<string, number>();
  for (const p of plan) byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);

  console.log(`${r.rows.length} service(s) with no category.`);
  for (const c of SERVICE_CATEGORIES) console.log(`  ${c.padEnd(9)} ${byCategory.get(c) ?? 0}`);
  console.log(`  (left alone: ${skipped} — no keyword matched)`);

  if (!apply) {
    console.log('\nDRY RUN. Re-run with --apply to write.');
    for (const p of plan.slice(0, 40)) console.log(`  ${p.category.padEnd(9)} ${p.name}`);
    if (plan.length > 40) console.log(`  … and ${plan.length - 40} more`);
    return;
  }

  for (const p of plan) {
    // The `category IS NULL` guard is repeated in the UPDATE so a concurrent edit
    // between the SELECT and here wins over this script.
    await query(`UPDATE services SET category = $2, updated_at = now() WHERE id = $1 AND category IS NULL`, [
      p.id,
      p.category,
    ]);
  }
  console.log(`\nWrote ${plan.length} categor${plan.length === 1 ? 'y' : 'ies'}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
