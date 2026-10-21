import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { HistoryLike, PopEvents } from '../../web/lib/leaveGuard.ts';
import { createPageFormGuard } from '../../web/lib/pageFormGuard.ts';

/**
 * PAGE FORM GUARD — BEHAVIOUR, against a fake browser: a session history of (url, state)
 * entries, asynchronous Back/Forward with popstate, pushState for router navigations and
 * replaceState for the router refresh after a save (which rewrites the state and drops
 * the marker key). The SAME module usePageFormGuard runs in the browser
 * (Reglas de reserva, contacto público y categorías públicas de Página de reservas).
 *
 * Every case checks where the person ENDS UP and how many Backs it takes, so a ghost
 * entry (a same-URL copy of the form left behind) or a double jump fails the test.
 */

interface Entry { url: string; state: Record<string, unknown> }

class FakeBrowser implements HistoryLike, PopEvents {
  entries: Entry[];
  index: number;
  private listeners = new Set<() => void>();
  constructor(...urls: string[]) {
    this.entries = urls.map((url) => ({ url, state: { __NA: true, url } }));
    this.index = this.entries.length - 1;
  }
  get state() {
    return this.entries[this.index].state;
  }
  get url() {
    return this.entries[this.index].url;
  }
  get length() {
    return this.entries.length;
  }
  pushState(data: unknown, _unused: string, url?: string) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ url: url ?? this.url, state: data as Record<string, unknown> });
    this.index++;
  }
  replaceState(data: unknown) {
    this.entries[this.index] = { url: this.url, state: data as Record<string, unknown> };
  }
  private go(delta: number) {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length) return;
    this.index = next;
    queueMicrotask(() => this.listeners.forEach((l) => l()));
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
  /** A router navigation (link). */
  navigate(url: string) {
    this.pushState({ __NA: true, url }, '', url);
  }
  /** The router refresh after a server action: same entry, state rewritten, marker gone. */
  routerRefresh() {
    this.replaceState({ __NA: true, url: this.url, refreshed: true });
  }
  addEventListener(_t: 'popstate', l: () => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'popstate', l: () => void) {
    this.listeners.delete(l);
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const SERVICIOS = '/clients/c/scheduling/services';
const REGLAS = '/clients/c/scheduling/rules';
const SEDES = '/clients/c/scheduling/sites';

/** Servicios → (internal navigation) → Reglas, with the guard mounted on Reglas. */
function onRules() {
  const b = new FakeBrowser('/clients/c/inbox', SERVICIOS, REGLAS);
  const log: string[] = [];
  let pendingHref: string | null = null;
  const guard = createPageFormGuard({
    history: b,
    events: b,
    pathname: () => b.url,
    onAsk: () => log.push('ask'),
    followLink: () => {
      log.push(`follow ${pendingHref}`);
      if (pendingHref) b.navigate(pendingHref);
    },
  });
  /** What useNavigationGuard does on a sidebar click while dirty. */
  const clickLink = (href: string) => {
    pendingHref = href;
    guard.askLink();
  };
  return { b, log, guard, clickLink };
}

test('a clean form adds nothing to the history; changes add exactly one same-URL entry', () => {
  const { b, guard } = onRules();
  guard.setDirty(false);
  assert.equal(b.length, 3, 'clean: no marker');
  guard.setDirty(true);
  assert.equal(b.length, 4, 'dirty: one marker');
  assert.equal(b.url, REGLAS, 'on the same page');
  assert.equal(b.state.__NA, true, 'the router state is kept on the marker');
  guard.setDirty(true);
  assert.equal(b.length, 4, 'staying dirty adds nothing more');
});

test('Back with changes asks; «Seguir editando» stays, keeps asking, and never grows the history', async () => {
  const { b, log, guard } = onRules();
  guard.setDirty(true);
  b.back();
  await settle();
  assert.deepEqual(log, ['ask']);
  assert.equal(b.url, REGLAS, 'still on Reglas');
  assert.equal(b.length, 4);
  guard.keepEditing();
  b.back();
  await settle();
  assert.deepEqual(log, ['ask', 'ask'], 'a second Back asks again');
  assert.equal(b.url, REGLAS);
  assert.equal(b.length, 4, 'the history did not grow');
});

test('«Descartar» after Back lands on the previous page exactly once — no ghost, no double jump', async () => {
  const { b, log, guard } = onRules();
  guard.setDirty(true);
  b.back();
  await settle();
  guard.discard();
  await settle();
  assert.deepEqual(log, ['ask']);
  assert.equal(b.url, SERVICIOS, 'one step back, to Servicios');
  // The page unmounts after leaving: disposing must not touch the history again.
  guard.dispose();
  await settle();
  assert.equal(b.url, SERVICIOS, 'still Servicios after unmount');
  // The next Back is a normal one (no trap): the page before Servicios.
  b.back();
  await settle();
  assert.equal(b.url, '/clients/c/inbox');
});

test('Forward after «Descartar» returns to Reglas, clean; the browser keeps working normally', async () => {
  const { b, guard } = onRules();
  guard.setDirty(true);
  b.back();
  await settle();
  guard.discard();
  await settle();
  guard.dispose();
  assert.equal(b.url, SERVICIOS);
  b.forward();
  await settle();
  assert.equal(b.url, REGLAS, 'Forward re-opens Reglas');
  // A new mount of the (clean) form adds nothing; Back leaves to Servicios in one step.
  const again = createPageFormGuard({ history: b, events: b, pathname: () => b.url, onAsk: () => assert.fail('clean: must not ask'), followLink: () => {} });
  again.setDirty(false);
  b.back();
  await settle();
  assert.equal(b.url, SERVICIOS);
  again.dispose();
});

test('saving: the marker goes, so ONE Back leaves the page — also when the router refresh stripped the marker', async () => {
  for (const refresh of [false, true]) {
    const { b, log, guard } = onRules();
    guard.setDirty(true);
    if (refresh) b.routerRefresh(); // the save's router.refresh() rewrites history.state
    guard.setDirty(false); // saved: the form now equals what is stored
    await settle();
    assert.equal(b.url, REGLAS, `still on Reglas after saving (refresh=${refresh})`);
    assert.equal(b.length, 4, 'the marker is only in the FORWARD history now, which the next navigation drops');
    assert.equal(b.index, 2, 'back on the real Reglas entry');
    b.back();
    await settle();
    assert.equal(b.url, SERVICIOS, `one Back leaves Reglas (refresh=${refresh})`);
    assert.deepEqual(log, [], 'and nothing asked');
    guard.dispose();
  }
});

test('the form\'s own «Descartar cambios» (back to clean) behaves like a save: no entry left behind', async () => {
  const { b, log, guard } = onRules();
  guard.setDirty(true);
  guard.setDirty(false);
  await settle();
  b.back();
  await settle();
  assert.equal(b.url, SERVICIOS);
  assert.deepEqual(log, []);
});

test('editing again after a save re-arms ONE marker, and Back asks again', async () => {
  const { b, log, guard } = onRules();
  guard.setDirty(true);
  guard.setDirty(false);
  await settle();
  guard.setDirty(true);
  assert.equal(b.length, 4, 'one marker, not two');
  b.back();
  await settle();
  assert.deepEqual(log, ['ask']);
  assert.equal(b.url, REGLAS);
});

test('a sidebar link with changes asks; «Seguir editando» stays guarded; «Descartar» follows it once', async () => {
  const { b, log, guard, clickLink } = onRules();
  guard.setDirty(true);
  clickLink(SEDES);
  assert.deepEqual(log, ['ask']);
  guard.keepEditing();
  assert.equal(b.url, REGLAS, 'Seguir editando: no navigation');
  // Still guarded against Back after declining the link.
  b.back();
  await settle();
  assert.deepEqual(log, ['ask', 'ask']);
  assert.equal(b.url, REGLAS);
  guard.keepEditing();

  clickLink(SEDES);
  guard.discard();
  await settle();
  assert.deepEqual(log, ['ask', 'ask', 'ask', `follow ${SEDES}`], 'the link is followed exactly once');
  assert.equal(b.url, SEDES);
  guard.dispose(); // Reglas unmounts
  await settle();
  assert.equal(b.url, SEDES, 'unmount after the link leaves the history alone');
  // Back from Sedes: the real Reglas entry (the marker was removed BEFORE the link).
  b.back();
  await settle();
  assert.equal(b.url, REGLAS);
  b.back();
  await settle();
  assert.equal(b.url, SERVICIOS, 'and then Servicios: no same-URL copy of Reglas in between');
});

test('a clean form never asks: Back and links leave at once', async () => {
  const { b, log, guard } = onRules();
  guard.setDirty(false);
  b.back();
  await settle();
  assert.equal(b.url, SERVICIOS);
  assert.deepEqual(log, []);
});

test('unmounting while dirty on the same page (e.g. switching site) drops the marker', async () => {
  const { b, guard } = onRules();
  guard.setDirty(true);
  guard.dispose();
  await settle();
  assert.equal(b.index, 2, 'back on the real Reglas entry');
  b.back();
  await settle();
  assert.equal(b.url, SERVICIOS);
});
