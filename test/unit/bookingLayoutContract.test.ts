import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Layout contracts of the public booking page that a refactor could silently undo:
 * the laptop service list (equal fixed-height rows, detail in a dialog, the Signature
 * alternative outside the card) and the artist profile (large photo or initials, the
 * CTA outside the scroll, viewing never choosing).
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const step = read('web/components/booking/ServiceStep.tsx');
const profile = read('web/components/booking/ArtistProfile.tsx');
const css = read('web/app/globals.css');

test('laptop services: one per row, one fixed height, every slot reserved', () => {
  assert.equal((step.match(/minmax\(min\(300px,100%\),1fr\)\)\] items-start gap-2\.5 lg:grid-cols-1/g) ?? []).length, 2, 'both card grids become a list from lg');
  assert.match(step, /lg:grid lg:h-\[108px\]/, 'one common compact height');
  assert.match(step, /lg:\[grid-template-areas:'info_side'_'desc_side'_'meta_side'\]/, 'info left, price · duration · selection right');
  assert.match(step, /lg:order-none lg:self-center/, '"Recomendado" sits beside the name on a laptop (no row of its own)');
  assert.match(step, /<span className="hidden flex-none lg:inline-flex">\s*<RatingButton/, 'laptop: the rating sits on the name line');
  assert.match(step, /aria-hidden className="hidden h-5 lg:block lg:\[grid-area:desc\]"/, 'the description line is reserved');
  assert.match(step, /lg:line-clamp-2 lg:min-w-0">\{s\.name\}/, 'name up to two lines');
  assert.match(step, /lg:sr-only/, 'price and duration stay in the select button for screen readers');
});

test('laptop "Ver más" opens a dialog (never grows the card, never selects); the alternative sits outside', () => {
  assert.match(step, /aria-haspopup="dialog"\s+onClick=\{\(e\) => onOpenDetail\(s\.id, e\.currentTarget\)\}/);
  assert.match(step, /function ServiceDetailDialog/);
  assert.match(step, /d\.showModal\(\);/);
  assert.match(step, /t\?\.focus\(\);/, 'focus returns to the trigger');
  assert.match(step, /<div className="lg:hidden">\{offerBox\}<\/div>/, 'phone: inside the card');
  assert.match(step, /<div className="hidden lg:block">\{offerBox\}<\/div>/, 'laptop: outside the fixed height');
  // Opening the detail never calls onSelect; only its explicit button does.
  const open = step.slice(step.indexOf('onOpenDetail: (id: string, trigger: HTMLElement) =>'), step.indexOf('const detailDialog'));
  assert.doesNotMatch(open, /onSelect/);
});

test('artist profile: large rounded photo or initials, laptop two columns, CTA outside the scroll', () => {
  assert.match(profile, /aspect-\[4\/3\] max-h-\[38dvh\] w-full overflow-hidden rounded-\[20px\] object-\[50%_25%\] lg:aspect-\[4\/5\]/);
  assert.match(profile, /lg:grid-cols-\[minmax\(0,320px\)_minmax\(0,1fr\)\]/);
  assert.match(profile, /className="pb-dialog pb-profile"/);
  assert.match(css, /\.pb3 dialog\.pb-dialog\.pb-profile \{\s*width: min\(920px, calc\(100vw - 64px\)\);/);
  assert.match(profile, /Elegir a \$\{artist\.name\}/);
  assert.doesNotMatch(profile, /rounded-full lg:size-28/, 'no small round avatar any more');
  // The only path that chooses is the CTA.
  assert.equal((profile.match(/onChoose\(/g) ?? []).length, 1);
});
