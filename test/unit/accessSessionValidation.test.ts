import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateUnderPolicy, type ValidationDeps } from '../../web/lib/sessionValidation.js';
import { storedSessionDeadline, HOUR_MS, MINUTE_MS, DAY_MS } from '../../web/lib/sessionPolicy.js';

/**
 * ACCESO-1 — validating a session the previous code wrote, under CONCURRENCY, deterministically.
 * A fake store plays the database; "gates" pause one request at an exact point (after Better
 * Auth's read, after its reconcile) while another request — or a revocation — runs. No request
 * may ever accept a session that is expired or revoked at the moment it is judged.
 */
type Row = {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  absolute_expires_at: Date | null;
  persistent: boolean;
  last_activity_at: Date | null;
  auth_method: string | null;
};

const T = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00.000Z`);

function store(initial: Row) {
  let row: Row | null = { ...initial };
  const calls = { reconcile: 0, read: 0 };
  /** The SQL reconcile, in memory: clamp to the stored policy, never extend. */
  const reconcileNow = () => {
    if (!row) return [];
    const deadline = storedSessionDeadline({
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      persistent: row.persistent,
      lastActivityAt: row.last_activity_at,
    });
    if (row.absolute_expires_at && deadline.getTime() === row.expires_at.getTime()) return []; // nothing to do
    const legacy = !row.absolute_expires_at;
    row = {
      ...row,
      absolute_expires_at: legacy ? deadline : row.absolute_expires_at,
      persistent: legacy ? true : row.persistent,
      auth_method: row.auth_method ?? 'legacy',
      expires_at: deadline,
    };
    return [{ ...row }];
  };
  return {
    get row() {
      return row;
    },
    revoke() {
      row = null;
    },
    set(patch: Partial<Row>) {
      if (row) row = { ...row, ...patch };
    },
    calls,
    deps(now: Date, gates: { afterReconcile?: () => Promise<void> } = {}): ValidationDeps {
      return {
        now: () => now,
        reconcile: async () => {
          calls.reconcile++;
          const r = reconcileNow();
          await gates.afterReconcile?.();
          return r;
        },
        read: async () => {
          calls.read++;
          return row ? { ...row } : null;
        },
      };
    },
  };
}

/** What Better Auth handed us when it read the row (before our validation). */
const asRead = (r: Row) => ({
  session: {
    id: r.id,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    absoluteExpiresAt: r.absolute_expires_at,
    persistent: r.persistent,
    lastActivityAt: r.last_activity_at,
    authMethod: r.auth_method,
  },
  user: { id: r.user_id },
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let reached!: () => void;
  const arrived = new Promise<void>((r) => (reached = r));
  return { wait: async () => { reached(); await opened; }, open: () => open(), arrived };
}

// A non-persistent session: authenticated 09:00 (12 h end 21:00), last REAL activity 10:00
// (idle end 12:00). The previous code then slid expiresAt 7 days.
const slid: Row = {
  id: 's1',
  user_id: 'u1',
  created_at: T('09:00'),
  expires_at: new Date(T('09:00').getTime() + 7 * DAY_MS),
  absolute_expires_at: new Date(T('09:00').getTime() + 12 * HOUR_MS),
  persistent: false,
  last_activity_at: T('10:00'),
  auth_method: 'password',
};

test('a session this code wrote is accepted with ZERO extra work (no reconcile, no re-read)', async () => {
  const ok: Row = { ...slid, expires_at: T('12:00') }; // = last activity + 2 h, under its 12 h end
  const st = store(ok);
  const r = await validateUnderPolicy(asRead(ok), st.deps(T('11:00')));
  assert.ok(r);
  assert.deepEqual(st.calls, { reconcile: 0, read: 0 });
});

test('10:00 activity, idle end 12:00, slid by the old code, reconciled at 13:00 → expired (NOT valid until 15:00)', async () => {
  const st = store(slid);
  const r = await validateUnderPolicy(asRead(slid), st.deps(T('13:00')));
  assert.equal(r, null);
  assert.equal(st.row!.expires_at.toISOString(), T('12:00').toISOString(), 'clamped to last activity + 2 h, never to now + 2 h');
});

test('the same case judged at 11:30 → valid, but only until 12:00 (reading is not activity)', async () => {
  const st = store(slid);
  const r = await validateUnderPolicy(asRead(slid), st.deps(T('11:30')));
  assert.ok(r);
  assert.equal(new Date(r!.session.expiresAt).toISOString(), T('12:00').toISOString());
  assert.equal(st.row!.last_activity_at!.toISOString(), T('10:00').toISOString(), 'no activity invented');
});

test('another request reconciled first (our reconcile finds nothing): the CURRENT row is re-read and judged', async () => {
  const st = store(slid);
  // Request A reconciles completely at 11:00.
  await validateUnderPolicy(asRead(slid), st.deps(T('11:00')));
  // Request B had read the SLID row before A wrote; it now finds nothing to reconcile.
  const b = await validateUnderPolicy(asRead(slid), st.deps(T('11:00')));
  assert.ok(b, 'still valid at 11:00');
  assert.equal(new Date(b!.session.expiresAt).toISOString(), T('12:00').toISOString(), 'with the re-read limit, not the stale 7 days');
  // …and at 12:30 the same stale snapshot is refused.
  const late = await validateUnderPolicy(asRead(slid), st.deps(T('12:30')));
  assert.equal(late, null);
});

test('revoked between Better Auth\'s read and our re-read → refused', async () => {
  const st = store(slid);
  const g = gate();
  const pending = validateUnderPolicy(asRead(slid), st.deps(T('11:00'), { afterReconcile: g.wait }));
  await g.arrived; // A has reconciled and is about to re-read
  st.revoke(); // «Cerrar las demás» in another tab
  g.open();
  assert.equal(await pending, null);
});

test('expired by another request between reconcile and re-read → refused', async () => {
  const st = store({ ...slid, absolute_expires_at: null, persistent: false, auth_method: null, expires_at: T('14:00') });
  const g = gate();
  const pending = validateUnderPolicy(asRead(st.row!), st.deps(T('11:00'), { afterReconcile: g.wait }));
  await g.arrived;
  st.set({ expires_at: T('10:59'), absolute_expires_at: T('10:59') }); // ran out meanwhile
  g.open();
  assert.equal(await pending, null);
});

test('a row that now belongs to another user (id reuse / tampering) is refused', async () => {
  const st = store(slid);
  st.set({ user_id: 'u2' });
  assert.equal(await validateUnderPolicy(asRead(slid), st.deps(T('11:00'))), null);
});

test('many concurrent requests on one slid session: same verdict and the same limit for all', async () => {
  const st = store(slid);
  const snapshot = asRead(slid);
  const results = await Promise.all(Array.from({ length: 20 }, () => validateUnderPolicy(snapshot, st.deps(T('11:15')))));
  for (const r of results) {
    assert.ok(r);
    assert.equal(new Date(r!.session.expiresAt).toISOString(), T('12:00').toISOString());
  }
  assert.equal(st.row!.expires_at.toISOString(), T('12:00').toISOString());
});

test('concurrent requests with a revocation in the middle: every request judged after it refuses', async () => {
  const st = store(slid);
  const snapshot = asRead(slid);
  const gates = Array.from({ length: 6 }, () => gate());
  const runs = gates.map((g) => validateUnderPolicy(snapshot, st.deps(T('11:00'), { afterReconcile: g.wait })));
  await Promise.all(gates.map((g) => g.arrived));
  gates.slice(0, 3).forEach((g) => g.open());
  const firstHalf = await Promise.all(runs.slice(0, 3));
  st.revoke();
  gates.slice(3).forEach((g) => g.open());
  const secondHalf = await Promise.all(runs.slice(3));
  assert.ok(firstHalf.every((r) => r !== null), 'judged before the revocation: the row existed and was in policy');
  assert.ok(secondHalf.every((r) => r === null), 'judged after: none accepts a revoked session');
});

test('legacy row (no absolute end, written by the old code): adopted, never longer than its own deadline', async () => {
  const legacy: Row = { ...slid, absolute_expires_at: null, persistent: false, last_activity_at: null, auth_method: null, expires_at: new Date(T('09:00').getTime() + 6 * DAY_MS) };
  const st = store(legacy);
  const r = await validateUnderPolicy(asRead(legacy), st.deps(T('11:00')));
  assert.ok(r);
  assert.equal(r!.session.persistent, true);
  assert.equal(r!.session.authMethod, 'legacy');
  assert.equal(new Date(r!.session.expiresAt).getTime(), legacy.expires_at.getTime(), 'keeps its deadline, gains nothing');
  assert.equal(r!.session.lastActivityAt, null, 'activity unknown — not invented');
});

test('storedSessionDeadline never exceeds the stored expiresAt (startup, reads and polls cannot extend)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const created = T('09:00').getTime() + Math.floor(rnd() * DAY_MS);
    const row = {
      createdAt: new Date(created),
      expiresAt: new Date(created + Math.floor(rnd() * 40 * DAY_MS)),
      absoluteExpiresAt: rnd() < 0.2 ? null : new Date(created + Math.floor(rnd() * 31 * DAY_MS)),
      persistent: rnd() < 0.5,
      lastActivityAt: rnd() < 0.3 ? null : new Date(created + Math.floor(rnd() * 20 * HOUR_MS)),
    };
    const dl = storedSessionDeadline(row);
    assert.ok(dl.getTime() <= row.expiresAt.getTime());
    if (row.absoluteExpiresAt) assert.ok(dl.getTime() <= row.absoluteExpiresAt.getTime());
    if (row.absoluteExpiresAt && !row.persistent) assert.ok(dl.getTime() <= (row.lastActivityAt ?? row.createdAt).getTime() + 2 * HOUR_MS);
  }
  assert.ok(MINUTE_MS > 0);
});
