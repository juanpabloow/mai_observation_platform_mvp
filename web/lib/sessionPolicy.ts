/**
 * SESSION POLICY — the pure rules behind «Mantener mi sesión en este equipo». No I/O, no
 * `server-only`, no process.env: web/lib/auth.ts (Better Auth hooks), the activity route,
 * the client guard (components/session/SessionGuard.tsx) and the tests all read the same
 * numbers from here, with the clock passed in.
 *
 *   persistent   («Mantener sesión» marked, and allowed): ends 30 days after authenticating.
 *                Fixed — using the platform or renewing the cookie never moves it.
 *   not persistent (the default, a shared computer): ends after 2 hours without REAL
 *                interaction, and never later than 12 hours after authenticating. The
 *                person is warned 5 minutes before; «Seguir trabajando» restarts the 2 hours
 *                but cannot move the 12-hour end.
 *
 * The server stores the result in Better Auth's own `expiresAt`, which Better Auth
 * enforces in EVERY endpoint (an expired row is deleted on the next read). So the browser
 * timer is only a courtesy; closing the tab, sleeping the laptop or blocking JavaScript
 * changes nothing on the server.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const PERSISTENT_MAX_MS = 30 * DAY_MS;
export const SHARED_MAX_MS = 12 * HOUR_MS;
export const IDLE_TIMEOUT_MS = 2 * HOUR_MS;
export const WARNING_LEAD_MS = 5 * MINUTE_MS;
/** How long a re-authentication unlocks the security actions (closing other sessions). */
export const REAUTH_WINDOW_MS = 10 * MINUTE_MS;
/** The browser reports interaction at most this often (the server deadline lags ≤ this). */
export const ACTIVITY_REPORT_INTERVAL_MS = MINUTE_MS;

/** Better Auth's session lifetime in seconds — the cookie Max-Age of a persistent session. */
export const SESSION_EXPIRES_IN_SECONDS = PERSISTENT_MAX_MS / 1000;

export type AuthMethod = "password" | "google";

export interface SessionPolicyFields {
  persistent: boolean;
  absoluteExpiresAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
}

/** The deadline a session has right now, from its policy fields. */
export function deadlineFor(p: { persistent: boolean; absoluteExpiresAt: Date; lastActivityAt: Date }): Date {
  if (p.persistent) return p.absoluteExpiresAt;
  const idle = p.lastActivityAt.getTime() + IDLE_TIMEOUT_MS;
  return new Date(Math.min(idle, p.absoluteExpiresAt.getTime()));
}

/** The fields of a session created NOW by a real authentication. */
export function newSessionPolicy({ now, persistent }: { now: Date; persistent: boolean }): SessionPolicyFields {
  const absoluteExpiresAt = new Date(now.getTime() + (persistent ? PERSISTENT_MAX_MS : SHARED_MAX_MS));
  const base = { persistent, absoluteExpiresAt, lastActivityAt: now };
  return { ...base, expiresAt: deadlineFor(base) };
}

/**
 * A REAL interaction happened at `now`: restart the idle clock. Returns null when nothing
 * changes (a persistent session has no idle clock; an expired one cannot be revived).
 * The absolute end is copied, never recomputed — that is the "límite absoluto".
 */
export function onActivity(
  p: { persistent: boolean; absoluteExpiresAt: Date; expiresAt: Date },
  now: Date,
): { lastActivityAt: Date; expiresAt: Date } | null {
  if (p.persistent) return null;
  if (p.expiresAt.getTime() <= now.getTime()) return null;
  const lastActivityAt = now;
  return { lastActivityAt, expiresAt: deadlineFor({ persistent: false, absoluteExpiresAt: p.absoluteExpiresAt, lastActivityAt }) };
}

/** Why a session ends at its deadline — picks the copy of the warning and the closed screen. */
export type EndReason = "idle" | "max" | "persist";

export function endReason(p: { persistent: boolean; absoluteExpiresAt: Date; expiresAt: Date }): EndReason {
  if (p.persistent) return "persist";
  return p.expiresAt.getTime() >= p.absoluteExpiresAt.getTime() ? "max" : "idle";
}

/** True when a re-authentication on this session still unlocks security actions. */
export function isRecentlyReauthenticated(reauthenticatedAt: Date | null | undefined, now: Date): boolean {
  if (!reauthenticatedAt) return false;
  const age = now.getTime() - reauthenticatedAt.getTime();
  return age >= -MINUTE_MS && age <= REAUTH_WINDOW_MS;
}

/**
 * Re-authentication with Google replaces the session (Better Auth mints a new one at the
 * callback). The new one INHERITS the old one's policy — a security confirmation must never
 * hand out a fresh 30 days or a fresh 12 hours.
 */
export function inheritedPolicy(
  old: { persistent: boolean; absoluteExpiresAt: Date },
  now: Date,
): SessionPolicyFields {
  const base = { persistent: old.persistent, absoluteExpiresAt: old.absoluteExpiresAt, lastActivityAt: now };
  return { ...base, expiresAt: deadlineFor(base) };
}

/** Tolerated clock difference between Google and us when reading `auth_time`. */
export const GOOGLE_CLOCK_SKEW_MS = MINUTE_MS;

/**
 * The ONLY proof of a recent Google authentication we accept: the ID token's `auth_time`
 * (seconds since the epoch — when the person last actually authenticated WITH GOOGLE).
 *
 * Google does not support re-authentication requests (no prompt=login, no max_age — "Google
 * does not support Google Account reauth requests", Sign in with Google → Security bundle,
 * 2026-06-15), and it only sends `auth_time` when the request asks for it as an essential claim
 * AND the app has "Session age claims" enabled in Google Auth Platform. So a completed OAuth
 * round-trip proves only that the browser can still use a Google session — possibly days old.
 *
 * Returns the moment of that authentication when it is recent (within REAUTH_WINDOW_MS of
 * `now`, and not in the future beyond the clock skew); null when it is absent, malformed,
 * stale or future. Null means: NOT a recent authentication.
 */
export function googleRecentAuthAt(authTimeSeconds: unknown, now: Date): Date | null {
  if (typeof authTimeSeconds !== "number" || !Number.isFinite(authTimeSeconds) || authTimeSeconds <= 0) return null;
  const at = authTimeSeconds * 1000;
  if (at > now.getTime() + GOOGLE_CLOCK_SKEW_MS) return null;
  if (at < now.getTime() - REAUTH_WINDOW_MS) return null;
  return new Date(Math.min(at, now.getTime()));
}

// ---------------------------------------------------------------------------------------
// Presentation helpers (pure) for Seguridad → Sesiones.

/** "Chrome · macOS" from a User-Agent — only what the header actually says, never guessed. */
export function describeUserAgent(ua: string | null | undefined): { label: string; kind: "phone" | "computer" | "unknown" } {
  const s = (ua ?? "").trim();
  if (!s) return { label: "Navegador no identificado", kind: "unknown" };
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser\//.test(s)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(s)
          ? "Firefox"
          : /CriOS\/|Chrome\//.test(s)
            ? "Chrome"
            : /Safari\//.test(s) && /Version\//.test(s)
              ? "Safari"
              : null;
  const os = /iPhone|iPad|iPod/.test(s)
    ? "iOS"
    : /Android/.test(s)
      ? "Android"
      : /Windows NT/.test(s)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(s)
          ? "macOS"
          : /CrOS/.test(s)
            ? "ChromeOS"
            : /Linux/.test(s)
              ? "Linux"
              : null;
  if (!browser && !os) return { label: "Navegador no identificado", kind: "unknown" };
  const kind = /iPhone|iPod|Android.*Mobile|Mobile Safari/.test(s) ? "phone" : os ? "computer" : "unknown";
  return { label: [browser ?? "Navegador", os].filter(Boolean).join(" · "), kind };
}

const DATE_FMT = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "America/Bogota" });

/** "Activa hace 2 h" — relative to `now`, coarse on purpose. */
export function activeAgo(at: Date, now: Date): string {
  const diff = Math.max(0, now.getTime() - at.getTime());
  if (diff < 2 * MINUTE_MS) return "Activa ahora";
  // Non-breaking spaces keep "33 min" / "2 h" together on a narrow phone.
  if (diff < HOUR_MS) return `Activa hace ${Math.floor(diff / MINUTE_MS)}\u00a0min`;
  if (diff < DAY_MS) return `Activa hace ${Math.floor(diff / HOUR_MS)}\u00a0h`;
  const days = Math.floor(diff / DAY_MS);
  return days === 1 ? "Activa hace 1\u00a0día" : `Activa hace ${days}\u00a0días`;
}

/** "Mantener sesión · hasta 25 nov" / "Sesión de 12 h". */
export function sessionTypeLabel(p: { persistent: boolean; absoluteExpiresAt: Date | null; authMethod: string | null }): string {
  if (p.authMethod === "legacy") return "Sesión anterior a la política actual";
  if (p.persistent) return p.absoluteExpiresAt ? `Mantener sesión · hasta ${DATE_FMT.format(p.absoluteExpiresAt)}` : "Mantener sesión";
  return "Sesión de 12\u00a0h";
}

/** "4:59" for the warning countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The deadline a STORED session really has under the policy, whatever wrote it (this code, or
 * the previous one during a deploy / rollback). Never later than its stored expiresAt:
 *   legacy (no absolute end) → min(expiresAt, createdAt + 30 days);
 *   persistent               → min(expiresAt, absolute end);
 *   not persistent           → min(expiresAt, absolute end, last recorded activity + 2 h).
 * Only RECORDED interaction counts (lastActivityAt); when it is missing, creation is used.
 */
export function storedSessionDeadline(row: {
  createdAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date | null;
  persistent: boolean;
  lastActivityAt: Date | null;
}): Date {
  const ends = [row.expiresAt.getTime()];
  if (!row.absoluteExpiresAt) {
    ends.push(row.createdAt.getTime() + PERSISTENT_MAX_MS);
  } else {
    ends.push(row.absoluteExpiresAt.getTime());
    if (!row.persistent) ends.push((row.lastActivityAt ?? row.createdAt).getTime() + IDLE_TIMEOUT_MS);
  }
  return new Date(Math.min(...ends));
}
