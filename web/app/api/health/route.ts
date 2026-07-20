import { query } from "@worker/db/client.js";

/**
 * GET /api/health — public, unauthenticated liveness/readiness probe (for uptime
 * monitors; the outage that motivated this was invisible until a human loaded a page).
 * Runs a `SELECT 1` with a ~2s ceiling: 200 when the DB answers, 503 otherwise. NO
 * internals are leaked in either body. Registered in the middleware public prefixes so
 * a cookieless request reaches it instead of redirecting to /login.
 */
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 2000;

async function dbHealthy(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), DB_TIMEOUT_MS);
  });
  // Any failure (connection refused, error, or exceeding the timeout) → not healthy.
  const check = query("SELECT 1")
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([check, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET(): Promise<Response> {
  if (await dbHealthy()) {
    return Response.json({ status: "ok", db: "ok" }, { status: 200 });
  }
  return Response.json({ status: "degraded" }, { status: 503 });
}
