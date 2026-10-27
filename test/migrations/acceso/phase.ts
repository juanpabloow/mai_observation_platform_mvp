/**
 * One phase of the ACCESO-1 compatibility check (driven by ./run.sh). It loads the REAL Better
 * Auth instance of a given checkout — the previous code (origin/main) or this branch — and
 * exercises it against the shared, disposable database:
 *
 *   PHASE=old-baseline        previous code, previous schema: sign in, slide a session
 *   PHASE=old-on-new-schema   previous code AFTER migration 1822: sign in, slide, list,
 *                             revoke, sign out — every call must still succeed
 *   PHASE=new-reconcile       new code: rows the old code wrote are clamped, never extended;
 *                             a new sign-in without rememberMe is not persistent
 *   PHASE=old-rollback        previous code again (code-only rollback): reads and slides a
 *                             session the NEW code created
 *   PHASE=new-after-rollback  new code again: that slid session is back under the policy
 *
 * State between phases lives in $STATE (JSON). Env: CHECKOUT (repo root whose web/lib/auth.ts
 * is loaded), DATABASE_URL (refused unless it is the disposable container), BETTER_AUTH_*.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const PHASE = process.env.PHASE!;
const CHECKOUT = process.env.CHECKOUT!;
const STATE = process.env.STATE!;
const url = new URL(process.env.DATABASE_URL!);
// Only the disposable database run.sh created for THIS run (127.0.0.1, unique name).
if (url.hostname !== "127.0.0.1" || !/^acceso_compat_[0-9_]+$/.test(process.env.COMPAT_DB ?? "") || url.pathname !== `/${process.env.COMPAT_DB}`) {
  throw new Error("refusing: not the disposable compat database of this run");
}

const require = createRequire(`${CHECKOUT}/package.json`);
const { Client } = require("pg") as typeof import("pg");
const db = new Client({ connectionString: url.toString() });
await db.connect();
const q = async <T = Record<string, unknown>>(sql: string, v: unknown[] = []) => (await db.query(sql, v)).rows as T[];

const state: Record<string, unknown> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const { auth } = (await import(`${CHECKOUT}/web/lib/auth.ts`)) as { auth: { handler: (r: Request) => Promise<Response>; api: Record<string, (a: unknown) => Promise<unknown>> } };
const BASE = process.env.BETTER_AUTH_URL!;
const PASS = "compat-pass-2026";
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function call(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", origin: BASE, ...(init.cookie ? { cookie: init.cookie } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return res;
}
const cookieFrom = (res: Response) => {
  const set = res.headers.getSetCookie().filter((c) => c.startsWith("better-auth.session_token=")).pop();
  return set ? set.split(";")[0]! : null;
};
async function signUp(email: string) {
  const r = await call("/sign-up/email", { body: { email, password: PASS, name: "Compat" } });
  assert.equal(r.status, 200, `sign-up ${email}: ${await r.clone().text()}`);
  await q(`UPDATE "user" SET "emailVerified" = true WHERE email = $1`, [email]);
}
async function signIn(email: string, extra: Record<string, unknown> = {}) {
  const r = await call("/sign-in/email", { body: { email, password: PASS, ...extra } });
  assert.equal(r.status, 200, `sign-in ${email}: ${await r.clone().text()}`);
  return cookieFrom(r)!;
}
const tokenOf = (cookie: string) => decodeURIComponent(cookie.split("=")[1]!).split(".")[0]!;
const row = async (cookie: string) =>
  (await q<Record<string, unknown> & { expiresAt: Date }>(`SELECT * FROM session WHERE token = $1`, [tokenOf(cookie)]))[0];
async function getSession(cookie: string) {
  const r = await call("/get-session", { cookie });
  assert.equal(r.status, 200, `get-session: ${await r.clone().text()}`);
  return r.json();
}
/** Make the PREVIOUS code's sliding refresh fire on the next read (updateAge 1 day of 7). */
const dueForRefresh = (cookie: string) => q(`UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE token = $1`, [tokenOf(cookie)]);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

if (PHASE === "old-baseline") {
  await signUp("antes@compat.test");
  const a = await signIn("antes@compat.test");
  await dueForRefresh(a);
  await getSession(a);
  const r = await row(a);
  assert.ok(r!.expiresAt.getTime() > Date.now() + 6.9 * DAY, "previous code slides to 7 days");
  ok("código anterior + esquema anterior: inicia sesión y desliza la sesión a 7 días");
  state.legacy = a;
  save();
}

if (PHASE === "old-on-new-schema") {
  // selftest.sh: prove a failed check stops the run (non-zero, no final OK).
  if (process.env.ACCESO_COMPAT_INJECT === "check-failure") assert.fail("comprobación fallida inyectada por selftest.sh");
  const legacy = state.legacy as string;
  const before = await row(legacy);
  assert.equal(before!.authMethod, "legacy", "the migration backfill marked it legacy");
  assert.ok(before!.absoluteExpiresAt, "…with its current deadline as absolute end");
  // Simulate a backfilled session whose absolute end is close, then let the OLD code slide it.
  await q(`UPDATE session SET "absoluteExpiresAt" = now() + interval '1 day' WHERE token = $1`, [tokenOf(legacy)]);
  await dueForRefresh(legacy);
  await getSession(legacy);
  const slid = await row(legacy);
  assert.ok(slid!.expiresAt.getTime() > (slid!.absoluteExpiresAt as Date).getTime(), "old code slid it PAST the absolute end (no CHECK to fail it)");
  ok("código anterior + esquema nuevo: el refresco de una sesión existente funciona (sin error de restricción)");

  await signUp("durante@compat.test");
  const b = await signIn("durante@compat.test");
  const bRow = await row(b);
  assert.equal(bRow!.absoluteExpiresAt, null, "a row created by the old code has no policy yet");
  assert.equal(bRow!.persistent, false, "column default");
  ok("código anterior + esquema nuevo: inicia sesión (fila sin política, con valores por defecto)");

  const b2 = await signIn("durante@compat.test");
  const list = await call("/list-sessions", { cookie: b });
  assert.equal(list.status, 200, "old list-sessions");
  const revoke = await call("/revoke-session", { cookie: b, body: { token: tokenOf(b2) } });
  assert.equal(revoke.status, 200, "old revoke-session");
  const out = await call("/sign-out", { cookie: b2, body: {} });
  assert.ok(out.status === 200, "old sign-out");
  ok("código anterior + esquema nuevo: listar, revocar y cerrar sesión funcionan");

  state.slid = { cookie: legacy, expiresAt: slid!.expiresAt.toISOString(), absolute: (slid!.absoluteExpiresAt as Date).toISOString() };
  state.oldCreated = { cookie: b, expiresAt: bRow!.expiresAt.toISOString() };
  save();
}

if (PHASE === "new-reconcile" || PHASE === "new-after-rollback") {
  const { reconcileLegacySessions } = await import(`${CHECKOUT}/src/db/repositories/authSessions.ts`);
  const { getSessionFromHeaders } = await import(`${CHECKOUT}/web/lib/session.ts`);
  const { IDLE_TIMEOUT_MS } = await import(`${CHECKOUT}/web/lib/sessionPolicy.ts`);
  const before = await q<{ id: string; expiresAt: Date }>(`SELECT id, "expiresAt" FROM session`);
  const reconciled = await reconcileLegacySessions({ idleMs: IDLE_TIMEOUT_MS });
  const after = await q<{ id: string; expiresAt: Date; absoluteExpiresAt: Date | null }>(`SELECT id, "expiresAt", "absoluteExpiresAt" FROM session`);
  for (const r of after) {
    const b = before.find((x) => x.id === r.id)!;
    assert.ok(r.expiresAt.getTime() <= b.expiresAt.getTime(), "reconciling never extends a session");
    assert.ok(r.absoluteExpiresAt, "every row now has an absolute end");
    assert.ok(r.expiresAt.getTime() <= r.absoluteExpiresAt!.getTime(), "and is within it");
  }
  ok(`código nuevo al arrancar: ${reconciled.length} sesión(es) conciliada(s), ninguna alargada`);

  if (PHASE === "new-reconcile") {
    const slid = state.slid as { cookie: string; absolute: string };
    const s = (await getSessionFromHeaders(new Headers({ cookie: slid.cookie }))) as { session: { expiresAt: Date } } | null;
    assert.ok(s, "the legacy session still works under the new code");
    assert.ok(new Date(s!.session.expiresAt).getTime() <= new Date(slid.absolute).getTime(), "…clamped to its absolute end");
    const old = state.oldCreated as { cookie: string; expiresAt: string };
    const o = (await getSessionFromHeaders(new Headers({ cookie: old.cookie }))) as { session: { persistent: boolean; authMethod: string; expiresAt: Date } } | null;
    assert.ok(o && o.session.persistent === true && o.session.authMethod === "legacy", "old-code session adopted as legacy");
    assert.ok(new Date(o!.session.expiresAt).getTime() <= new Date(old.expiresAt).getTime(), "…without gaining time");
    ok("código nuevo: las sesiones existentes siguen abiertas, bajo la política y sin ganar tiempo");

    await signUp("despues@compat.test");
    const c = await signIn("despues@compat.test"); // rememberMe omitted on purpose
    const cRow = await row(c);
    assert.equal(cRow!.persistent, false, "omitted rememberMe = not persistent");
    assert.ok((cRow!.absoluteExpiresAt as Date).getTime() <= Date.now() + 12 * HOUR + 60_000, "12 h");
    ok("código nuevo: inicio de sesión sin rememberMe → no persistente (12 h)");
    state.newCreated = c;
    state.newIdle = await signIn("despues@compat.test");
    save();
  } else {
    const c = state.newCreated as string;
    const r = await row(c);
    assert.ok(r!.expiresAt.getTime() <= (r!.absoluteExpiresAt as Date).getTime(), "back within its 12-hour end");
    assert.ok(r!.expiresAt.getTime() <= Date.now() + 2 * HOUR + 60_000, "and within the idle window");
    ok("código nuevo tras rollback: la sesión que el código anterior deslizó vuelve a su límite");
    const idle = state.newIdle as string;
    const ir = (await q<{ expiresAt: Date; lastActivityAt: Date }>(`SELECT "expiresAt", "lastActivityAt" FROM session WHERE token = $1`, [tokenOf(idle)]))[0];
    assert.ok(ir, "row still there (Better Auth deletes it on its next read)");
    assert.equal(ir!.expiresAt.getTime(), ir!.lastActivityAt.getTime() + 2 * HOUR, "clamped to last REAL activity + 2 h");
    assert.ok(ir!.expiresAt.getTime() < Date.now(), "which is already in the past");
    const { getSessionFromHeaders } = await import(`${CHECKOUT}/web/lib/session.ts`);
    assert.equal(await getSessionFromHeaders(new Headers({ cookie: idle })), null, "refused by the new code");
    const ba = await call("/get-session", { cookie: idle });
    assert.equal(await ba.json(), null, "and by Better Auth itself");
    ok("código nuevo tras rollback: actividad real hace 3 h + deslizada por el anterior → vencida (no se regalan 2 h)");
  }
}

if (PHASE === "old-rollback") {
  // A new-code session whose last REAL activity was 3 h ago (idle end 1 h ago); the old code,
  // serving again, slides it 7 days.
  const idle = state.newIdle as string;
  await q(
    `UPDATE session SET "createdAt" = now() - interval '4 hours', "absoluteExpiresAt" = now() + interval '8 hours',
            "lastActivityAt" = now() - interval '3 hours', "expiresAt" = now() + interval '5 days' WHERE token = $1`,
    [tokenOf(idle)],
  );
  await getSession(idle);
  assert.ok((await row(idle))!.expiresAt.getTime() > Date.now() + 6.9 * DAY, "the old code slid it");
  const c = state.newCreated as string;
  await getSession(c);
  await dueForRefresh(c);
  await getSession(c);
  const r = await row(c);
  assert.ok(r!.expiresAt.getTime() > Date.now() + 6.9 * DAY, "the old code slides it again (expected during a rollback)");
  ok("rollback de código: el código anterior lee y refresca una sesión creada por el código nuevo sin errores");
}

await db.end();
process.exit(0);
