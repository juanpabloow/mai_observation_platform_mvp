/**
 * Node.js server start (see instrumentation.ts).
 *
 * ACCESO-1: bring every session the PREVIOUS code wrote (a deploy that overlapped the old
 * version, or a code-only rollback) under the session policy — clamped, never extended. The
 * per-request path (lib/session.ts) covers rows written after this point. Best-effort: a
 * failure is logged and never blocks the server from starting.
 */
import { reconcileLegacySessions } from "@worker/db/repositories/authSessions.js";
import { IDLE_TIMEOUT_MS } from "./lib/sessionPolicy";

try {
  const rows = await Promise.race([
    reconcileLegacySessions({ idleMs: IDLE_TIMEOUT_MS }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
  ]);
  if (rows.length) console.info(`[auth] session policy: reconciled ${rows.length} session(s) written by previous code`);
} catch (err) {
  console.error(`[auth] session policy reconcile at startup failed: ${(err as Error).message}`);
}
