import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assignedCategoryCount,
  categoriesPhrase,
  checksProgress,
  featuredCount,
  servicesSummaryHelper,
  servicesSummaryTitle,
  uncategorisedCount,
  visualFamilyCount,
} from '../../web/lib/schedulingOverview.js';
import { CATEGORY_GROUPS } from '../../web/components/scheduling/services/categories.js';

/**
 * AUDIT V1/V2 — Configuración de agenda → Resumen said "1 categoría · 0 destacados" while
 * the agenda, Nueva cita and the booking page showed 4 categories, and "3 / 3" over four
 * completed checks. The Resumen summarises the SAME data the Servicios tab groups (the
 * STORED category); the agenda's colours are a VISUAL family, inferred from the name when
 * nothing is stored. Neither is ever written to make the other match.
 */

// The sandbox exactly as src/scripts/seedAgendaDev.ts creates it: no stored category, no
// featured flag — the agenda's colours come from the names.
const SANDBOX = [
  'Classic cut',
  'Cut + beard',
  'Highlights',
  'Colour + cut',
  'Beard sculpt',
  'Grooming set',
  'Keratin package',
].map((name) => ({ name: `[DEV] ${name}`, category: null as string | null, featured: false }));

/** How Configuración → Servicios groups (ServiceMenu's byGroup): stored value or "". */
function servicesTabGroups(list: { category: string | null }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of CATEGORY_GROUPS) m.set(g.value, 0);
  for (const s of list) {
    const key = m.has(s.category ?? '') ? (s.category ?? '') : '';
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

test('V1: the Resumen counts what the Servicios tab groups — the STORED category', () => {
  const tab = servicesTabGroups(SANDBOX);
  assert.equal(tab.get(''), 7, 'Servicios: all seven under "Sin categoría"');
  assert.equal(assignedCategoryCount(SANDBOX), 0);
  assert.equal(uncategorisedCount(SANDBOX), 7);
  assert.equal(categoriesPhrase(SANDBOX), 'Sin categorías asignadas', 'not "1 categoría" (NULL is not a category), not "4"');

  const mixed = [
    { name: 'Corte clásico', category: 'cut', featured: false },
    { name: 'Fade', category: 'cut', featured: false },
    { name: 'Tinte', category: 'color', featured: false },
    { name: 'Keratina', category: null, featured: false },
    { name: 'Raro', category: 'not-a-category', featured: false }, // Servicios files it under "Sin categoría"
  ];
  const named = [...servicesTabGroups(mixed).entries()].filter(([k, n]) => k !== '' && n > 0).length;
  assert.equal(assignedCategoryCount(mixed), named, 'same number of non-empty named groups as the tab');
  assert.equal(uncategorisedCount(mixed), servicesTabGroups(mixed).get(''));
  assert.equal(categoriesPhrase(mixed), '2 categorías · 2 sin categoría');
  assert.equal(categoriesPhrase([{ name: 'Corte', category: 'cut' }]), '1 categoría');
  assert.equal(categoriesPhrase([]), 'Sin categorías');
});

test('V1: the agenda\'s colours are a separate, named figure — inferred, never stored', () => {
  assert.equal(visualFamilyCount(SANDBOX), 4, 'cut, colour, grooming, feature — the agenda legend');
  const title = servicesSummaryTitle(SANDBOX);
  assert.match(title, /como en Servicios/);
  assert.match(title, /7 servicios sin categoría: en la agenda y en la reserva toman un color según su nombre\./);
  assert.match(title, /Colores en la agenda: 4\./);
  // The helpers are read-only: the input is not touched.
  assert.ok(SANDBOX.every((s) => s.category === null));
});

test('V1: "destacados" counts the Destacado flag, never the "Tratamiento destacado" category', () => {
  const keratinStored = SANDBOX.map((s) => (s.name.includes('Keratin') ? { ...s, category: 'feature' } : s));
  assert.equal(featuredCount(keratinStored), 0, 'in the "Tratamiento destacado" category but not flagged');
  const flagged = SANDBOX.map((s, i) => ({ ...s, featured: i === 0 }));
  assert.equal(featuredCount(flagged), 1);
  assert.equal(servicesSummaryHelper(SANDBOX), 'Sin categorías asignadas · ★ 0 destacados');
  assert.equal(servicesSummaryHelper(keratinStored), '1 categoría · 6 sin categoría · ★ 0 destacados');
  assert.equal(servicesSummaryHelper(flagged), 'Sin categorías asignadas · ★ 1 destacado');
  assert.match(servicesSummaryTitle(SANDBOX), /★ Destacado es la opción del servicio, no la categoría «Tratamiento destacado»\./);
});

test('V2: the badge counts the checks that are listed', () => {
  // The audit's screen: sites, catalogue, team and "Reservas en línea", all ✓.
  const allOk = ['ok', 'ok', 'ok', 'ok'] as const;
  assert.deepEqual(checksProgress(allOk.map((state) => ({ state }))), { done: 4, total: 4 });
  // A warning row joins the list and the denominator.
  assert.deepEqual(checksProgress([{ state: 'ok' }, { state: 'ok' }, { state: 'ok' }, { state: 'warn' }, { state: 'ok' }]), { done: 4, total: 5 });
  assert.deepEqual(checksProgress([{ state: 'todo' }, { state: 'ok' }, { state: 'ok' }, { state: 'todo' }]), { done: 2, total: 4 });
});

test('both Resumen screens use the shared helpers', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  const admin = read('components/scheduling/AdminPanel.tsx');
  assert.match(admin, /helper: servicesSummaryHelper\(activeServices\)/);
  assert.match(admin, /title: servicesSummaryTitle\(activeServices\)/);
  assert.match(admin, /\{progress\.done\} \/ \{progress\.total\}/);
  assert.doesNotMatch(admin, /category \?\? "none"/);
  const phone = read('components/scheduling/mobile/config/ConfigMobile.tsx');
  assert.match(phone, /categoriesPhrase\(activeServices\)/);
  assert.doesNotMatch(phone, /category \?\? "none"/);
});
