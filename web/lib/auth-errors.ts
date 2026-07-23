/**
 * Client-safe ALLOWLIST mapping of auth error codes to user-facing copy.
 * Anything not in the allowlist gets a generic fallback — raw error messages
 * (result.error.message, provider payloads) are never rendered. Copy contains
 * no internals, tokens, or provider details.
 *
 * Producers of ?error= on our pages:
 * - The OAuth callback (via errorCallbackURL) with snake_case codes, e.g.
 *   account_not_linked, email_doesn't_match.
 * - Better Auth's GET /verify-email and GET /reset-password/:token redirects
 *   with UPPER_SNAKE codes, e.g. TOKEN_EXPIRED, INVALID_TOKEN.
 */

export const GENERIC_RESET_NOTICE =
  "If an account exists for that email, a password-reset link is on its way. Check your inbox (and spam folder).";

export const PASSWORD_RESET_DONE_NOTICE =
  "Password updated. Every previous session was signed out — log in with your new password.";

export const EMAIL_VERIFIED_NOTICE = "Email verified. You can now log in.";

export const RATE_LIMITED_NOTICE = "Too many requests — wait a minute and try again.";

const RECOVER_HINT =
  "Log in with your password, or use “Forgot password?” to recover access. Once logged in, you can connect Google from Settings → Sign-in & security.";

/** Codes arriving as ?error= via redirects (OAuth callback / token links). */
const REDIRECT_MESSAGES: Record<string, string> = {
  account_not_linked: `This account exists, but Google isn't connected to it yet. ${RECOVER_HINT}`,
  unable_to_link_account: "We couldn't connect Google to your account. Please try again.",
  account_already_linked_to_different_user:
    "That Google account is already connected to a different user.",
  "email_doesn't_match": "You can only connect a Google account that uses the same email address.",
  email_not_found: "Your Google account didn't share an email address, so we can't sign you in with it.",
  access_denied: "Google sign-in was cancelled.",
  TOKEN_EXPIRED: "That link has expired. Request a new one.",
  INVALID_TOKEN: "That link is invalid or was already used. Request a new one.",
  USER_NOT_FOUND: "That link is no longer valid. Request a new one.",
};

export function mapAuthErrorParam(code: string | null): string | null {
  if (!code) return null;
  return REDIRECT_MESSAGES[code] ?? "Sign-in failed. Please try again.";
}

/** Codes returned in-band by the auth client (result.error.code). */
const CLIENT_MESSAGES: Record<string, string> = {
  PROVIDER_NOT_FOUND: "Google sign-in is not available right now.",
  INVALID_TOKEN: "That link is invalid or was already used. Request a new one.",
  PASSWORD_TOO_SHORT: "Password must be at least 8 characters.",
  PASSWORD_TOO_LONG: "That password is too long.",
  LINKING_NOT_ALLOWED: "Connecting this account is not allowed.",
  LINKING_DIFFERENT_EMAILS_NOT_ALLOWED:
    "You can only connect a Google account that uses the same email address.",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "That Google account is already connected.",
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password.",
  USER_ALREADY_EXISTS: "An account with this email already exists.",
};

export function mapClientAuthError(
  code: string | null | undefined,
  fallback = "Something went wrong. Please try again.",
): string {
  return (code && CLIENT_MESSAGES[code]) || fallback;
}
