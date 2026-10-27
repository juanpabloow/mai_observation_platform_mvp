/**
 * OAuth-state keys we put in Better Auth's `additionalData` (it stores them inside the
 * encrypted state, bound to the state cookie). Its own tiny module so client components can
 * name them without importing the Better Auth server pieces.
 */
export const KEEP_SESSION_STATE_KEY = "maiKeepSession";
export const REAUTH_STATE_KEY = "maiReauth";
