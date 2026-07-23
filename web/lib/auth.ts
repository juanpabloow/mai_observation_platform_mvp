import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import {
  createTenantWithOwner,
  deleteAuthUserById,
  getTenantIdForUser,
} from "@worker/db/repositories/tenantMembers.js";
import { hasValidPendingInvitationForEmail } from "@worker/db/repositories/invitations.js";
import { sendEmail, isEmailConfigured } from "./email";
import {
  ACCOUNT_LINKING_POLICY,
  buildEmailVerification,
  buildPasswordReset,
  validateBetterAuthUrl,
} from "./auth-verification";

/**
 * Better Auth server instance.
 *
 * - DATABASE: a dedicated pg Pool against the SAME Postgres database as the rest
 *   of the app (DATABASE_URL — single source of truth, NOT a separate DB).
 *   Better Auth owns its tables (user / session / account / verification) and
 *   manages them through Kysely internally, so our application code stays
 *   no-ORM. Env is loaded from the repo-root .env by web/next.config.ts before
 *   any module reads process.env. The Pool is a globalThis SINGLETON: under
 *   `next dev` this module is re-evaluated on recompiles, and a fresh `new Pool`
 *   each time would leak Postgres connections (the cause of the logout hang), so
 *   we create it once and reuse it. Tagged with application_name for visibility
 *   in pg_stat_activity.
 * - PASSWORDS: emailAndPassword uses Better Auth's built-in hashing (scrypt) —
 *   we never store or compare plaintext, and never roll our own.
 * - GOOGLE: OPTIONAL. The provider is only registered when BOTH GOOGLE_CLIENT_ID
 *   and GOOGLE_CLIENT_SECRET are present, so the app boots and email/password
 *   works with no Google config. `isGoogleConfigured` lets the UI render the
 *   button as inert until creds are added.
 */
export const isGoogleConfigured = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

// Single Pool reused across HMR re-evaluations (see DATABASE note above).
const globalForAuthPool = globalThis as unknown as { __obsAuthPool?: Pool };
const authPool =
  globalForAuthPool.__obsAuthPool ??
  (globalForAuthPool.__obsAuthPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    application_name: "obs-web-auth",
  }));

// Public base URL — BETTER_AUTH_URL drives OAuth callbacks + the CSRF trusted
// origin; the Google redirect URI is <baseURL>/api/auth/callback/google.
// Format is validated everywhere (markdown paste / not-a-URL throws at boot);
// https + non-localhost is enforced only on a deployed production runtime
// (NODE_ENV=production AND a Railway env marker), so local `next build` —
// which also runs with NODE_ENV=production — keeps working with localhost.
const isDeployedProduction =
  process.env.NODE_ENV === "production" &&
  Boolean(
    process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID,
  );

const baseURL = validateBetterAuthUrl(process.env.BETTER_AUTH_URL, {
  enforceProduction: isDeployedProduction,
});

// Account recovery (password reset + verification emails) depends on Resend.
// Fail fast at boot in deployed production if the email env is missing —
// variable NAMES only, values are never logged or returned.
if (isDeployedProduction && !isEmailConfigured) {
  throw new Error(
    "Email sending is required in production: set RESEND_API_KEY and INVITE_FROM_EMAIL on the web service.",
  );
}

export const auth = betterAuth({
  database: authPool,
  baseURL,
  // RECOVERY + LINKING MODEL: implicit account linking is fully disabled
  // (disableImplicitLinking: true) — a Google sign-in against an existing
  // not-yet-linked email always returns account_not_linked, verified or not.
  // A public "verify → implicit link" path would enable pre-hijacking: an
  // attacker who pre-registered the victim's email would keep their password
  // and sessions after the victim verifies. Instead, users recover via the
  // official password-reset flow — it replaces the credential AND
  // (revokeSessionsOnPasswordReset) revokes every session — then sign in and
  // connect Google EXPLICITLY from that authenticated session (linkSocial →
  // /settings/security). Same user row throughout (no insert → the
  // tenant-provisioning create-hook below never fires), so
  // userId/tenant/memberships/roles are preserved.
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
    // sendResetPassword / resetPasswordTokenExpiresIn /
    // revokeSessionsOnPasswordReset — names verified against the installed
    // 1.6.19 types. Better Auth owns the token lifecycle (single-use,
    // stored in `verification`).
    ...buildPasswordReset(sendEmail),
    // DEBT (deliberately out of this hotfix): requireEmailVerification stays
    // OFF, so unverified accounts can still sign in with a password and new
    // unverified accounts can still accumulate (sendOnSignUp only *offers*
    // verification). Turning it on would lock out legacy unverified users at
    // sign-in and needs its own UX + comms before flipping.
  },
  emailVerification: buildEmailVerification(sendEmail),
  // Pin the secure linking policy explicitly instead of relying on upstream
  // defaults (see auth-verification.ts for the rationale per field).
  // trustedProviders is deliberately left unset (empty) in production.
  account: {
    accountLinking: { ...ACCOUNT_LINKING_POLICY },
  },
  // Better Auth rate-limits these public endpoints out of the box in
  // production (3/min); pinned here so the abuse protection is visible and
  // survives upstream default changes. NOTE: storage is in-memory, which is
  // only correct while the web service runs a SINGLE replica — with N
  // replicas the effective limit multiplies by N (move to
  // rateLimit.storage: "database" before scaling out).
  rateLimit: {
    customRules: {
      "/send-verification-email": { window: 60, max: 3 },
      "/request-password-reset": { window: 60, max: 3 },
    },
  },
  socialProviders: isGoogleConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID as string,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
        },
      }
    : {},
  // Provision a tenant for every NEW user. This fires on user creation for BOTH
  // providers — email/password signup AND a Google user's first login (a row in
  // `user` is created once, never on subsequent logins), so it is inherently
  // idempotent: returning users never get a second tenant.
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            // Defensive idempotency: never create a second tenant for a user.
            if (await getTenantIdForUser(user.id)) return;
            // INVITE OVERRIDE (RBAC-2): when this email has a VALID pending
            // invitation, the user is joining the INVITING tenant on accept — do
            // NOT spawn a personal tenant here (which would make them an owner of a
            // new empty workspace). Works for both providers. The membership is
            // created when they accept the invite; until then they're tenant-less,
            // which the /invite/accept page handles (and getAccessScope denies).
            if (await hasValidPendingInvitationForEmail(user.email)) return;
            const workspace = `${(user.name && user.name.trim()) || user.email}'s workspace`;
            // createTenantWithOwner is one transaction → never a tenant w/o owner.
            await createTenantWithOwner({ userId: user.id, tenantName: workspace });
          } catch (err) {
            // A user with no tenant is an invalid state. Compensate by deleting
            // the just-created auth user (cascades account/session) so signup
            // fails cleanly instead of leaving a dangling, tenant-less user.
            await deleteAuthUserById(user.id).catch(() => {});
            throw err;
          }
        },
      },
    },
  },
  // Honors Set-Cookie from server-side auth calls in the Next App Router
  // (server actions / RSC). Must be the last plugin.
  plugins: [nextCookies()],
});
