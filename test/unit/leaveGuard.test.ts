import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLeaveGuard, type HistoryLike, type PopEvents } from '../../web/lib/leaveGuard.js';

/**
 * "¿Descartar los cambios?" for the contact forms (create + edit), behind every way out:
 * Cancelar / Cerrar / scrim / Escape (requestLeave) and the browser / system Back
 * (popstate). A fake history models the real one: entries, an index, async back().
 */
class FakeHistory implements HistoryLike, PopEvents {
  entries: unknown[] = [{ page: 'list' }];
  index = 0;
  private listeners = new Set<() => void>();
  get state() {
    return this.entries[this.index];
  }
  get length() {
    return this.entries.length;
  }
  pushState(data: unknown) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(data);
    this.index++;
  }
  back() {
    if (this.index === 0) return;
    this.index--;
    queueMicrotask(() => this.listeners.forEach((l) => l()));
  }
  /** The user pressing the browser's Back. */
  userBack() {
    this.back();
  }
  addEventListener(_t: 'popstate', l: () => void) {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'popstate', l: () => void) {
    this.listeners.delete(l);
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(dirty = false) {
  const h = new FakeHistory();
  const log: string[] = [];
  let isDirty = dirty;
  const g = createLeaveGuard({
    history: h,
    events: h,
    isDirty: () => isDirty,
    onAsk: () => log.push('ask'),
    onLeave: () => log.push('leave'),
  });
  g.arm();
  return { h, g, log, setDirty: (v: boolean) => (isDirty = v) };
}

test('arming adds ONE same-page entry that carries the marker, keeping existing state', () => {
  const { h } = setup();
  assert.equal(h.length, 2);
  assert.equal((h.state as Record<string, unknown>).page, 'list', 'the router state is kept');
  assert.ok(Object.keys(h.state as object).some((k) => k === '__leaveGuard'));
});

test('no changes: Cancelar / Cerrar / Escape close at once — no question, no ghost entry', async () => {
  const { h, g, log } = setup(false);
  g.requestLeave();
  await flush();
  assert.deepEqual(log, ['leave']);
  assert.equal(h.index, 0, 'the marker entry was removed, so the next Back is a real one');
});

test('real changes: closing asks; "Seguir editando" keeps the form open', async () => {
  const { h, g, log } = setup(true);
  g.requestLeave();
  await flush();
  assert.deepEqual(log, ['ask']);
  assert.equal(h.index, 1, 'still armed — nothing left');
});

test('"Descartar" leaves without saving and removes the marker', async () => {
  const { h, g, log } = setup(true);
  g.requestLeave();
  g.leave(); // the dialog's Descartar
  await flush();
  assert.deepEqual(log, ['ask', 'leave']);
  assert.equal(h.index, 0);
});

test('Back with changes asks, and re-arms without growing the history', async () => {
  const { h, log } = setup(true);
  const before = h.length;
  h.userBack();
  await flush();
  assert.deepEqual(log, ['ask']);
  assert.equal(h.index, 1, 'back on the form');
  assert.equal(h.length, before, 'no extra entries piling up');
  // A second Back while still dirty asks again, still no growth.
  h.userBack();
  await flush();
  assert.deepEqual(log, ['ask', 'ask']);
  assert.equal(h.length, before);
});

test('Back without changes just closes the form', async () => {
  const { h, log } = setup(false);
  h.userBack();
  await flush();
  assert.deepEqual(log, ['leave']);
  assert.equal(h.index, 0);
});

test('saving leaves without asking even if the guard thinks it is dirty', async () => {
  const { h, g, log } = setup(true);
  g.leave();
  await flush();
  assert.deepEqual(log, ['leave']);
  assert.equal(h.index, 0);
});

test('unmounting (dispose) drops the marker; a second leave is a no-op', async () => {
  const { h, g, log } = setup(false);
  g.dispose();
  await flush();
  assert.equal(h.index, 0, 'no ghost entry after the form goes away');
  assert.deepEqual(log, [], 'disposing does not call onLeave');
  g.leave();
  g.requestLeave();
  await flush();
  assert.equal(h.index, 0);
});

test('the guard only removes ITS entry: after a navigation it leaves history alone', async () => {
  const { h, g, log } = setup(false);
  h.pushState({ page: 'other' }); // the app navigated somewhere else meanwhile
  g.dispose();
  await flush();
  assert.equal(h.index, 2, 'the navigation is not undone');
  assert.deepEqual(log, []);
});

test('unmounting during an asynchronous leave removes its pending callback', async () => {
  const { g, log } = setup(false);
  g.leave();
  g.dispose();
  await flush();
  assert.deepEqual(log, [], 'an unmounted form must not run a stale onLeave');
  g.leave();
  g.requestLeave();
  await flush();
  assert.deepEqual(log, [], 'a disposed guard remains inert');
});

test('the contact forms route every exit through the guard', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  for (const rel of ['components/contacts/form/ContactCreateForm.tsx', 'components/contacts/form/ContactEditForm.tsx']) {
    const src = read(rel);
    assert.match(src, /useLeaveGuard\(\{ dirty, onLeave: onClose \}\)/, `${rel}: one guard`);
    assert.match(src, /onClose=\{guard\.requestLeave\}/, `${rel}: Cerrar / scrim ask`);
    assert.match(src, /guard=\{guard\}/, `${rel}: the drawer renders the question`);
    assert.match(src, /onClick=\{guard\.requestLeave\}[^>]*>\s*Cancelar/, `${rel}: Cancelar asks`);
    assert.match(src, /guard\.leave\(\)/, `${rel}: a save leaves without asking`);
    assert.doesNotMatch(src, /onClick=\{onClose\}/, `${rel}: nothing closes around the guard`);
  }
  const drawer = read('components/contacts/form/ContactFormDrawer.tsx');
  assert.match(drawer, /const onEscape = guard \? guard\.onEscape : onClose;/, 'Escape goes through the guard');
  assert.match(drawer, /title="¿Descartar los cambios\?"/);
  assert.match(drawer, /cancelLabel="Seguir editando"/);
  assert.match(drawer, /confirmLabel="Descartar"/);
  assert.match(drawer, /inert=\{guard\?\.asking \|\| undefined\}/, 'the form is inert behind the question');
});
