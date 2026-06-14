import { createAuthClient } from "better-auth/react";

/**
 * Browser-side Better Auth client. baseURL defaults to the current origin, so it
 * talks to our /api/auth/[...all] route handler. Used by the login/signup/logout
 * UI (client components) — the route handler sets/clears the session cookie.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
