/**
 * PURE parsing/validation for scheduling query-param filters (agenda, team, analytics)
 * — no server or DB imports, so it is unit-testable and reusable. The rule everywhere:
 * a filter value is only honored when it is well-formed AND belongs to the set the
 * server already loaded for the VALIDATED (tenant, client). A foreign or malformed
 * staff/site/service id resolves to `undefined` (ignored) — it never widens a query
 * or reveals another client's data. Enums are exact; dates are strict "YYYY-MM-DD".
 */

export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'] as const;
export type ApptStatus = (typeof APPOINTMENT_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Strict "YYYY-MM-DD" (also rejects impossible calendar dates like 2026-13-40). */
export function parseYmd(raw: string | undefined | null): string | null {
  if (!raw || !YMD_RE.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const ok = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  return ok ? raw : null;
}

/** A single appointment status, or null when absent/invalid. */
export function parseStatus(raw: string | undefined | null): ApptStatus | null {
  return raw && (APPOINTMENT_STATUSES as readonly string[]).includes(raw) ? (raw as ApptStatus) : null;
}

/**
 * Return `raw` ONLY if it is a UUID present in `allowedIds` (the client-scoped set the
 * server loaded); otherwise undefined. This is the "ignore a foreign/forged id"
 * primitive shared by every scheduling filter.
 */
export function pickAllowedId(raw: string | undefined | null, allowedIds: Iterable<string>): string | undefined {
  if (!isUuid(raw)) return undefined;
  for (const id of allowedIds) if (id === raw) return raw;
  return undefined;
}
