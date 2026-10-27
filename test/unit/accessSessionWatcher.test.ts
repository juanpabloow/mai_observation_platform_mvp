import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SessionWatcher, STATUS_POLL_MS, type FetchResult, type ServerStatus, type WatcherMessage, type WatcherView } from '../../web/lib/sessionWatcher.js';
import { HOUR_MS, MINUTE_MS, WARNING_LEAD_MS } from '../../web/lib/sessionPolicy.js';

/**
 * ACCESO-1 — the browser half of the session policy with a CONTROLLED CLOCK and fake tabs.
 * A tiny fake server holds the one authoritative deadline (like Better Auth's expiresAt) and
 * applies the same rules as the activity route: POST restarts 2 h clamped to the absolute
 * end; GET only reads. Tabs share a fake BroadcastChannel.
 */
class World {
  t = Date.parse('2026-10-26T14:00:00Z');
  timers: { at: number; fn: () => void; id: number }[] = [];
  nextId = 1;
  server: { expiresAt: number; absoluteExpiresAt: number; persistent: boolean; alive: boolean };
  online = true;
  posts = 0;
  gets = 0;
  tabs: Tab[] = [];
  constructor(persistent = false) {
    this.server = persistent
      ? { expiresAt: this.t + 30 * 24 * HOUR_MS, absoluteExpiresAt: this.t + 30 * 24 * HOUR_MS, persistent, alive: true }
      : { expiresAt: this.t + 2 * HOUR_MS, absoluteExpiresAt: this.t + 12 * HOUR_MS, persistent, alive: true };
  }
  status(): ServerStatus {
    return { expiresAt: this.server.expiresAt, absoluteExpiresAt: this.server.absoluteExpiresAt, persistent: this.server.persistent, serverNow: this.t };
  }
  read(): FetchResult {
    if (!this.online) return 'offline';
    this.gets++;
    if (!this.server.alive || this.t >= this.server.expiresAt) {
      this.server.alive = false;
      return 'ended';
    }
    return this.status();
  }
  activity(): FetchResult {
    if (!this.online) return 'offline';
    this.posts++;
    const r = this.read();
    if (r === 'ended' || r === 'offline') return r;
    if (!this.server.persistent) this.server.expiresAt = Math.min(this.t + 2 * HOUR_MS, this.server.absoluteExpiresAt);
    return this.status();
  }
  /** Advance the wall clock, firing due timers in order (like a running browser). */
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
  /** The laptop sleeps: time passes, NO timer fires. */
  sleep(ms: number) {
    this.t += ms;
  }
  tab(visible = true) {
    const t = new Tab(this, visible);
    this.tabs.push(t);
    return t;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

class Tab {
  view: WatcherView | null = null;
  ended: { reason: string; fromPeer: boolean } | null = null;
  kept = 0;
  w: SessionWatcher;
  constructor(private world: World, public visible: boolean) {
    this.w = new SessionWatcher(world.status(), {
      now: () => world.t,
      fetchStatus: async () => world.read(),
      reportActivity: async () => world.activity(),
      post: (m: WatcherMessage) => {
        for (const other of world.tabs) if (other !== this) other.w.receive(structuredClone(m));
      },
      setTimer: (fn, ms) => {
        const id = world.nextId++;
        world.timers.push({ at: world.t + ms, fn, id });
        return id;
      },
      clearTimer: (h) => {
        world.timers = world.timers.filter((x) => x.id !== h);
      },
      isVisible: () => this.visible,
      onView: (v) => (this.view = v),
      onKept: () => this.kept++,
      onEnded: (reason, fromPeer) => (this.ended = { reason, fromPeer }),
    });
    this.w.start();
  }
}

test('the warning opens exactly 5 minutes before the idle end, counts down, and ends the session on the SERVER\'s word', async () => {
  const w = new World();
  const tab = w.tab();
  await w.advance(2 * HOUR_MS - WARNING_LEAD_MS - 1000);
  assert.equal(tab.view!.phase, 'ok');
  await w.advance(2000);
  assert.equal(tab.view!.phase, 'warn');
  assert.equal(tab.view!.reason, 'idle');
  await w.advance(2 * MINUTE_MS);
  assert.ok(tab.view!.remainingMs <= 3 * MINUTE_MS && tab.view!.remainingMs > 2 * MINUTE_MS, 'counting down');
  await w.advance(3 * MINUTE_MS + 1000);
  assert.deepEqual(tab.ended, { reason: 'idle', fromPeer: false });
});

test('polling alone (status reads every minute for 2 hours) never keeps a session alive', async () => {
  const w = new World();
  const tab = w.tab();
  await w.advance(2 * HOUR_MS + 2 * MINUTE_MS);
  assert.ok(w.gets >= 100, 'it did read the status repeatedly');
  assert.equal(w.posts, 0, 'but never reported activity');
  assert.equal(tab.ended?.reason, 'idle');
});

test('real interaction is reported at most once a minute and restarts the 2 hours', async () => {
  const w = new World();
  const tab = w.tab();
  for (let i = 0; i < 50; i++) {
    tab.w.interaction(); // a burst of keystrokes
    await w.advance(1000);
  }
  assert.equal(w.posts, 1, 'throttled to one report per minute');
  await w.advance(90 * MINUTE_MS);
  tab.w.interaction();
  await flush();
  assert.equal(w.posts, 2);
  assert.ok(w.server.expiresAt > w.t + 119 * MINUTE_MS);
  await w.advance(100 * MINUTE_MS);
  assert.equal(tab.view!.phase, 'ok', 'still within the restarted 2 hours');
});

test('while the warning is open only «Seguir trabajando» counts; it restarts the idle clock but NEVER the 12-hour end', async () => {
  const w = new World();
  const tab = w.tab();
  await w.advance(2 * HOUR_MS - 4 * MINUTE_MS);
  assert.equal(tab.view!.phase, 'warn');
  tab.w.interaction();
  await flush();
  assert.equal(w.posts, 0, 'a stray key while warned does not extend');
  await tab.w.keepWorking();
  assert.equal(tab.kept, 1);
  assert.equal(tab.view!.phase, 'ok');

  // Keep clicking «Seguir trabajando» at every warning for 13 hours.
  for (let i = 0; i < 12 && !tab.ended; i++) {
    await w.advance(2 * HOUR_MS - 4 * MINUTE_MS);
    if (tab.view!.phase === 'warn' && tab.view!.reason === 'idle') await tab.w.keepWorking();
  }
  await w.advance(2 * HOUR_MS);
  assert.ok(tab.ended, 'the session ended');
  assert.equal(tab.ended!.reason, 'max', 'at the 12-hour absolute end');
  assert.ok(w.t >= Date.parse('2026-10-26T14:00:00Z') + 12 * HOUR_MS);
});

test('the absolute-limit warning says so (reason max), and a persistent session ends at 30 days with reason persist', async () => {
  const w = new World();
  w.server.absoluteExpiresAt = w.t + 90 * MINUTE_MS;
  w.server.expiresAt = w.server.absoluteExpiresAt;
  const tab = w.tab();
  await w.advance(86 * MINUTE_MS);
  assert.equal(tab.view!.phase, 'warn');
  assert.equal(tab.view!.reason, 'max');

  const p = new World(true);
  const pt = p.tab();
  pt.w.interaction();
  await flush();
  assert.equal(p.posts, 0, 'a persistent session has no idle clock to report to');
  await p.advance(30 * 24 * HOUR_MS + MINUTE_MS);
  assert.equal(pt.ended?.reason, 'persist');
});

test('several tabs: activity in one moves every tab\'s deadline; «Seguir trabajando» in one closes the warning in all', async () => {
  const w = new World();
  const a = w.tab();
  const b = w.tab(false); // a background tab
  await w.advance(60 * MINUTE_MS);
  a.w.interaction();
  await flush();
  assert.equal(b.w.deadline, a.w.deadline, 'the background tab learned the new deadline');
  await w.advance(2 * HOUR_MS - 4 * MINUTE_MS);
  assert.equal(a.view!.phase, 'warn');
  assert.equal(b.view!.phase, 'warn');
  await a.w.keepWorking();
  assert.equal(b.view!.phase, 'ok', 'the other tab\'s warning closed too');
});

test('a sign-out or expiry in one tab ends every tab of the browser', async () => {
  const w = new World();
  const a = w.tab();
  const b = w.tab();
  await w.advance(2 * HOUR_MS + MINUTE_MS);
  assert.equal(a.ended?.reason, 'idle');
  assert.deepEqual(b.ended, { reason: 'idle', fromPeer: true }, 'told by the first tab, no extra round-trip needed');
});

test('a session closed elsewhere (Seguridad → Sesiones, an admin) is noticed within a minute as «revocada»', async () => {
  const w = new World();
  const tab = w.tab();
  await w.advance(10 * MINUTE_MS);
  w.server.alive = false; // revoked on the server
  await w.advance(STATUS_POLL_MS + 1000);
  assert.equal(tab.ended?.reason, 'revoked');
});

test('a sleeping laptop: no timer fired, but waking re-reads the server and ends an expired session — never keeps it', async () => {
  const w = new World();
  const tab = w.tab();
  w.sleep(3 * HOUR_MS);
  assert.equal(tab.ended, null, 'nothing ran while asleep');
  await tab.w.wake();
  assert.equal(tab.ended?.reason, 'idle');
});

test('offline at the deadline: it waits for the server instead of guessing; back online it ends', async () => {
  const w = new World();
  const tab = w.tab();
  w.online = false;
  await w.advance(2 * HOUR_MS + MINUTE_MS);
  assert.equal(tab.ended, null, 'offline: no verdict from the local clock alone');
  w.online = true;
  await tab.w.wake();
  assert.equal(tab.ended?.reason, 'idle');
});

test('clock skew: a browser clock 10 minutes fast still warns relative to the SERVER deadline', async () => {
  const w = new World();
  const real = w.t;
  w.t = real + 10 * MINUTE_MS; // the browser's clock is fast
  const tab = new Tab(w, true);
  w.tabs.push(tab);
  // The watcher was seeded with serverNow = real time (from the server).
  tab.w.stop();
  const seeded = new SessionWatcher({ ...w.status(), serverNow: real }, {
    now: () => w.t,
    fetchStatus: async () => ({ ...w.status(), serverNow: w.t - 10 * MINUTE_MS }),
    reportActivity: async () => 'offline',
    post: () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    isVisible: () => true,
    onView: () => {},
    onEnded: () => {},
  });
  assert.ok(Math.abs(seeded.view().remainingMs - 2 * HOUR_MS) < 1000, 'remaining measured on the server clock');
});
