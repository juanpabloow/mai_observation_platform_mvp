/**
 * The Better Auth wiring of the SESSION POLICY (rules: ./sessionPolicy.ts). Pure module like
 * ./auth-verification.ts — no `server-only`, no process.env — so the test suite builds a real
 * Better Auth instance with exactly these hooks and options.
 *
 * WHAT IT DOES
 * - `session` options: refresh is OFF (Better Auth never slides `expiresAt` on a read — not on
 *   polling, not on a page load), the cookie of a persistent session lives 30 days, and the
 *   policy columns are declared `input: false` so no client body can ever set them.
 * - `sessionCreateBefore`: every session Better Auth mints gets its policy here, from HOW it
 *   was minted:
 *     /sign-in/email      «Mantener sesión» = the body's rememberMe === true. The before hook
 *                         rewrites anything else — false, a string, or the field MISSING
 *                         (which Better Auth itself defaults to true) — to false, so 30
 *                         days always need an explicit choice;
 *     /callback/<google>  «Mantener sesión» = the flag the login page put in the OAuth state
 *                         (Better Auth encrypts it into the state and binds it to the state
 *                         cookie, so it survives the Google round-trip intact);
 *     an authenticated request that re-mints the session (change-password)
 *                         → inherits the current session's policy;
 *     anything else       → the strict default (not persistent).
 *   A Google RE-AUTHENTICATION (Seguridad → Sesiones) is recognised by a single-use nonce the
 *   server issued for THIS session; the new session replaces the old one and inherits its
 *   policy (a security confirmation never hands out a new 30 days / 12 hours).
 * - RECENT AUTHENTICATION (reauthenticatedAt — unlocks closing other sessions): a password
 *   sign-in proves it; a Google sign-in does NOT by itself (Google may reuse a days-old
 *   session). Only a Google re-authentication whose ID token carries a recent `auth_time`
 *   counts, and reauthenticatedAt is then that real moment, not "now".
 * - `afterHook`: asks Google for the account chooser and for `auth_time` as an essential
 *   claim on a re-authentication URL,
 *   and gives a non-persistent Google session a browser-session cookie (as the password
 *   path already gets from Better Auth's rememberMe:false).
 * - DISABLED_SESSION_PATHS: Better Auth's own list/revoke endpoints would let any valid
 *   session close the others WITHOUT re-authentication. They are switched off over HTTP; the
 *   server actions in ./sessionActions.ts replace them (they call the same internal adapter).
 */
import { APIError, createAuthMiddleware, getOAuthState } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  SESSION_EXPIRES_IN_SECONDS,
  googleRecentAuthAt,
  inheritedPolicy,
  newSessionPolicy,
} from "./sessionPolicy";

import { KEEP_SESSION_STATE_KEY, REAUTH_STATE_KEY } from "./authStateKeys";

export { KEEP_SESSION_STATE_KEY, REAUTH_STATE_KEY };
/** Written by our Google mapProfileToUser for the session hook (same request). */
export const GOOGLE_AUTH_TIME_STATE_KEY = "maiGoogleAuthTime";

/** Verification-table identifier of a pending Google re-authentication. */
export const reauthIdentifier = (nonce: string) => `mai-reauth:${nonce}`;
/** What the server stores under that identifier (never sent to the browser). */
export interface ReauthChallenge {
  token: string;
  email: string;
}

export const SESSION_ADDITIONAL_FIELDS = {
  persistent: { type: "boolean", required: false, defaultValue: false, input: false },
  absoluteExpiresAt: { type: "date", required: false, input: false },
  lastActivityAt: { type: "date", required: false, input: false },
  reauthenticatedAt: { type: "date", required: false, input: false },
  authMethod: { type: "string", required: false, input: false },
} as const;

export const SESSION_OPTIONS = {
  expiresIn: SESSION_EXPIRES_IN_SECONDS,
  disableSessionRefresh: true,
  additionalFields: SESSION_ADDITIONAL_FIELDS,
} as const;

export const DISABLED_SESSION_PATHS = [
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/update-session",
];

type MiddlewareCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

type StoredSession = {
  token: string;
  userId: string;
  expiresAt: Date;
  persistent?: boolean | null;
  absoluteExpiresAt?: Date | null;
  reauthenticatedAt?: Date | null;
};
interface PolicyAdapter {
  consumeVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date; createdAt: Date } | null>;
  findVerificationValue(identifier: string): Promise<{ value: string; expiresAt: Date } | null>;
  findSession(token: string): Promise<{ session: StoredSession } | null>;
  deleteSession(token: string): Promise<void>;
}
type HookCtx = {
  path?: string;
  body?: Record<string, unknown> | null;
  context: { internalAdapter: unknown; session?: { session?: StoredSession } | null };
} | null;

export function parseChallenge(raw: string | null | undefined): ReauthChallenge | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ReauthChallenge>;
    return typeof v.token === "string" && typeof v.email === "string" ? { token: v.token, email: v.email } : null;
  } catch {
    return null;
  }
}

const isOAuthCallback = (path: string) => path.startsWith("/callback/") || path.startsWith("/oauth2/callback/");

/** The error code a refused re-authentication lands with (web/lib/auth-errors.ts maps it). */
export const REAUTH_FAILED_CODE = "reauth_failed";
/** Google answered, but without a recent auth_time (or none at all). */
export const REAUTH_NOT_RECENT_CODE = "reauth_not_recent";

/**
 * Refuse a Google re-authentication by sending the browser back to the flow's error URL
 * (origin-checked by Better Auth when the flow started) — never a bare JSON error page.
 */
function refuseReauth(st: Record<string, unknown> | null, code: string = REAUTH_FAILED_CODE): never {
  const target = typeof st?.errorURL === "string" ? st.errorURL : "/";
  const sep = target.includes("?") ? "&" : "?";
  throw new APIError("FOUND", undefined, { Location: `${target}${sep}error=${code}` });
}

async function oauthState(): Promise<Record<string, unknown> | null> {
  try {
    return ((await getOAuthState()) as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

export function buildSessionPolicy(deps: {
  /** May this user keep a persistent session? (A business policy would plug in here.) */
  allowPersistent: (userId: string) => Promise<boolean>;
  now?: () => Date;
}) {
  const clock = deps.now ?? (() => new Date());

  /**
   * Google RE-AUTHENTICATION: called from Google's mapProfileToUser, BEFORE Better Auth looks
   * up or creates any user. A re-authentication that comes back with a different Google
   * account must not create a stray user (and a stray workspace) — so it is refused here.
   */
  async function checkGoogleProfile(adapter: PolicyAdapter, profile: { email?: string | null; auth_time?: unknown }) {
    const st = await oauthState();
    if (!st) return;
    st[GOOGLE_AUTH_TIME_STATE_KEY] = profile.auth_time ?? null;
    const nonce = st[REAUTH_STATE_KEY];
    if (typeof nonce !== "string") return;
    const pending = await adapter.findVerificationValue(reauthIdentifier(nonce));
    const challenge = parseChallenge(pending?.value);
    if (!challenge || (profile.email ?? "").toLowerCase() !== challenge.email.toLowerCase()) refuseReauth(st);
  }

  async function sessionCreateBefore(session: { userId: string } & Record<string, unknown>, ctx: HookCtx) {
    const now = clock();
    const path = ctx?.path ?? "";
    const st = isOAuthCallback(path) ? await oauthState() : null;
    const adapter = ctx?.context.internalAdapter as PolicyAdapter | undefined;

    // Google re-authentication of an EXISTING session.
    const nonce = st?.[REAUTH_STATE_KEY];
    if (nonce !== undefined) {
      if (typeof nonce !== "string" || !adapter) refuseReauth(st);
      const pending = await adapter.consumeVerificationValue(reauthIdentifier(nonce));
      const challenge = parseChallenge(pending?.value);
      if (!pending || !challenge || pending.expiresAt.getTime() <= now.getTime()) refuseReauth(st);
      const old = await adapter.findSession(challenge.token);
      if (!old || old.session.userId !== session.userId || old.session.expiresAt.getTime() <= now.getTime()) refuseReauth(st);
      // No recent auth_time → no proof: refuse BEFORE touching the old session.
      const authAt = googleRecentAuthAt(st?.[GOOGLE_AUTH_TIME_STATE_KEY], now);
      if (!authAt) refuseReauth(st, REAUTH_NOT_RECENT_CODE);
      await adapter.deleteSession(old.session.token);
      const inherited = inheritedPolicy(
        { persistent: old.session.persistent === true, absoluteExpiresAt: old.session.absoluteExpiresAt ?? old.session.expiresAt },
        now,
      );
      return { data: { ...inherited, reauthenticatedAt: authAt, authMethod: "google" } };
    }

    // An authenticated request re-minting its own session (change-password with
    // revokeOtherSessions): keep the current policy, never extend it.
    const current = ctx?.context.session?.session;
    if (current && current.userId === session.userId && current.expiresAt.getTime() > now.getTime()) {
      const inherited = inheritedPolicy(
        { persistent: current.persistent === true, absoluteExpiresAt: current.absoluteExpiresAt ?? current.expiresAt },
        now,
      );
      // change-password proves the current password; an OAuth callback proves nothing new.
      return {
        data: {
          ...inherited,
          reauthenticatedAt: isOAuthCallback(path) ? (current.reauthenticatedAt ?? null) : now,
          authMethod: isOAuthCallback(path) ? "google" : "password",
        },
      };
    }

    const wantsKeep =
      path === "/sign-in/email" ? ctx?.body?.rememberMe === true : st ? st[KEEP_SESSION_STATE_KEY] === true : false;
    const persistent = wantsKeep && (await deps.allowPersistent(session.userId));
    return {
      data: {
        ...newSessionPolicy({ now, persistent }),
        // A password sign-in IS a fresh authentication (no second proof for a few minutes).
        // A normal Google sign-in is NOT: Google may have reused a days-old session, and this
        // login did not ask for auth_time — so it must never unlock closing other sessions.
        reauthenticatedAt: isOAuthCallback(path) ? null : now,
        authMethod: isOAuthCallback(path) ? "google" : "password",
      },
    };
  }

  const afterHandler = async (ctx: MiddlewareCtx) => {
    if (ctx.path === "/sign-in/social") {
      const additional = (ctx.body as { additionalData?: Record<string, unknown> } | undefined)?.additionalData;
      const returned = ctx.context.returned as { url?: string; redirect?: boolean } | undefined;
      if (additional && typeof additional[REAUTH_STATE_KEY] === "string" && returned && typeof returned.url === "string") {
        const url = new URL(returned.url);
        if (url.hostname === "accounts.google.com") {
          url.searchParams.set("prompt", "select_account");
          // The only freshness signal Google offers (needs "Session age claims" enabled).
          url.searchParams.set("claims", JSON.stringify({ id_token: { auth_time: { essential: true } } }));
          return ctx.json({ ...returned, url: url.toString() });
        }
      }
      return;
    }
    if (isOAuthCallback(ctx.path)) {
      const fresh = ctx.context.newSession as { session: { persistent?: boolean }; user: unknown } | null | undefined;
      if (fresh && fresh.session.persistent !== true) {
        // A browser-session cookie (no Max-Age) — the server deadline still governs.
        await setSessionCookie(ctx, fresh as Parameters<typeof setSessionCookie>[1], true);
      }
    }
  };

  /** Only our server actions may change the photo (validated, private); the plain
   *  /update-user endpoint would accept any external URL. */
  const beforeHandler = async (ctx: MiddlewareCtx) => {
    // «Mantener sesión» is opt-in: only an explicit boolean true keeps the session 30 days.
    // Better Auth defaults a MISSING rememberMe to true; rewrite it here, before its own body
    // validation runs, so Better Auth also issues the browser-session cookie.
    if (ctx.path === "/sign-in/email" && ctx.body && typeof ctx.body === "object") {
      const body = ctx.body as Record<string, unknown>;
      if (body.rememberMe !== true) return { context: { body: { ...body, rememberMe: false } } };
      return;
    }
    if (ctx.path === "/update-user" && ctx.body && typeof ctx.body === "object" && "image" in ctx.body) {
      throw new APIError("BAD_REQUEST", { message: "The photo is changed from your account page", code: "IMAGE_NOT_EDITABLE" });
    }
  };

  return {
    session: SESSION_OPTIONS,
    sessionCreateBefore,
    checkGoogleProfile,
    /** Plain handlers — auth.ts composes them into its own hooks. */
    afterHandler,
    beforeHandler,
    /** Ready-made hooks for an instance that has no other hooks (the tests). */
    afterHook: createAuthMiddleware(afterHandler),
    beforeHook: createAuthMiddleware(beforeHandler),
  };
}
