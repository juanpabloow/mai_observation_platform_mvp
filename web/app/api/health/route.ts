import { query } from "@worker/db/client.js";

/**
 * GET /api/health — public, unauthenticated liveness/readiness probe (for uptime monitors;
 * the outage that motivated this was invisible until a human loaded a page).
 *
 * Checks two things and returns 503 if EITHER is unhealthy, so a plain "is it 200?" monitor
 * catches both:
 *   - the DB answers a `SELECT 1` within ~2s;
 *   - INGESTION is fresh — no active connection has stopped ingesting. This is the signal
 *     the old probe lacked: the worker cycled for 12 days while every poll failed, and
 *     nothing noticed because /health only checked the web app + DB. We flag a connection as
 *     stale when its last SUCCESSFUL poll is older than the threshold, or it has piled up a
 *     run of consecutive failures — either way "the worker is alive but not ingesting".
 *
 * The body names the failing subsystem (`db` vs `ingestion`) so an operator can tell them
 * apart; no internals are leaked. Fresh installs (no connections yet) are healthy.
 */
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 2000;
// A connection is stale if its last SUCCESSFUL poll is older than this — generous enough not
// to flap on one slow/failed cycle (default poll is 30s, so this is ~20 cycles), tight enough
// to catch a real stall within minutes instead of days. Tunable.
const INGESTION_STALE_SECONDS = 600;
// …or if it has failed this many cycles in a row (catches a connection that never once
// succeeded, where last_successful_poll_at is null).
const INGESTION_FAILURE_LIMIT = 20;

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), DB_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function dbHealthy(): Promise<boolean> {
  return withTimeout(
    query("SELECT 1")
      .then(() => true)
      .catch(() => false),
    false,
  );
}

type Ingestion =
  | { status: "ok"; freshestPollAgeSeconds: number | null }
  | { status: "stale"; staleConnections: number; freshestPollAgeSeconds: number | null }
  | { status: "unknown" }; // couldn't determine (query error/timeout) — fail OPEN, don't 503

async function ingestionHealth(): Promise<Ingestion> {
  const check = query<{ freshest_age_seconds: number | null; stale_connections: number }>(
    `SELECT
       EXTRACT(EPOCH FROM (now() - max(last_successful_poll_at)))::int AS freshest_age_seconds,
       count(*) FILTER (
         WHERE (last_successful_poll_at IS NOT NULL AND last_successful_poll_at < now() - make_interval(secs => $1))
            OR consecutive_failures >= $2
       )::int AS stale_connections
     FROM ingestion_state`,
    [INGESTION_STALE_SECONDS, INGESTION_FAILURE_LIMIT],
  )
    .then((r): Ingestion => {
      const row = r.rows[0];
      const freshestPollAgeSeconds = row?.freshest_age_seconds ?? null;
      const stale = row?.stale_connections ?? 0;
      return stale > 0
        ? { status: "stale", staleConnections: stale, freshestPollAgeSeconds }
        : { status: "ok", freshestPollAgeSeconds };
    })
    .catch((): Ingestion => ({ status: "unknown" }));
  return withTimeout(check, { status: "unknown" });
}

export async function GET(): Promise<Response> {
  if (!(await dbHealthy())) {
    return Response.json({ status: "degraded", db: "down" }, { status: 503 });
  }

  const ingestion = await ingestionHealth();
  if (ingestion.status === "stale") {
    return Response.json(
      {
        status: "degraded",
        db: "ok",
        ingestion: "stale",
        stale_connections: ingestion.staleConnections,
        freshest_poll_age_seconds: ingestion.freshestPollAgeSeconds,
        threshold_seconds: INGESTION_STALE_SECONDS,
      },
      { status: 503 },
    );
  }
  return Response.json(
    {
      status: "ok",
      db: "ok",
      ingestion: ingestion.status, // "ok" | "unknown"
      freshest_poll_age_seconds: ingestion.status === "ok" ? ingestion.freshestPollAgeSeconds : null,
      threshold_seconds: INGESTION_STALE_SECONDS,
    },
    { status: 200 },
  );
}
