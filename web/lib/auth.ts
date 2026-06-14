import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";
import {
  createTenantWithOwner,
  deleteAuthUserById,
  getTenantIdForUser,
} from "@worker/db/repositories/tenantMembers.js";

/**
 * Better Auth server instance.
 *
 * - DATABASE: a dedicated pg Pool against the SAME Postgres database as the rest
 *   of the app (DATABASE_URL — single source of truth, NOT a separate DB).
 *   Better Auth owns its tables (user / session / account / verification) and
 *   manages them through Kysely internally, so our application code stays
 *   no-ORM. Env is loaded from the repo-root .env by web/next.config.ts before
 *   any module reads process.env.
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

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: {
    enabled: true,
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
