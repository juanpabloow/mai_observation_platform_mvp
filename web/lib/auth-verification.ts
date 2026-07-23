/**
 * Recovery + account-linking policy shared between the Better Auth server
 * config (web/lib/auth.ts) and the test suite. Pure module: NO `server-only`
 * import and NO process.env reads at module scope, so tests can exercise the
 * exact policy/config that production runs — auth.ts injects the real Resend
 * sender, tests inject a capture stub.
 *
 * SECURITY MODEL (why recovery is password reset, not email verification):
 * an attacker can pre-register victim@example.com with an attacker-known
 * password. If the victim later merely *verifies* that email, the row keeps
 * the attacker's password and the attacker's sessions stay alive — and any
 * Google identity linked into the row is then shared with the attacker
 * (account pre-hijacking). Recovery therefore goes through the official
 * password-reset flow (which replaces the credential AND revokes every
 * session — see buildPasswordReset), and Google is connected EXPLICITLY from
 * an authenticated session via linkSocial, never implicitly from an
 * unauthenticated one.
 */

/**
 * Account-linking policy for production. Pinned explicitly (and asserted in
 * tests) rather than depending on upstream defaults staying put.
 * `trustedProviders` is deliberately NOT set (defaults to empty): no provider
 * gets to bypass the checks below.
 *
 * - disableImplicitLinking: true — Google is NEVER attached to an existing
 *   user row during an unauthenticated OAuth sign-in, not even when both the
 *   local and the provider email are verified. The ONLY way to connect
 *   Google is the explicit linkSocial call from an authenticated session
 *   (ConnectGoogle → /settings/security), where ownership is proven by the
 *   session itself.
 * - requireLocalEmailVerified: true — defense in depth for the implicit
 *   path; moot while disableImplicitLinking is on, but pinned so a future
 *   re-enable of implicit linking doesn't silently drop the anti-takeover
 *   gate.
 * - allowDifferentEmails: false — a provider identity can only ever be
 *   linked when its email equals the local user's email (enforced for the
 *   explicit link flow server-side).
 */
export const ACCOUNT_LINKING_POLICY = {
  enabled: true,
  disableImplicitLinking: true,
  requireLocalEmailVerified: true,
  allowDifferentEmails: false,
} as const;

/** Where the email-verification link drops the user (success banner). */
export const VERIFIED_LOGIN_CALLBACK = "/login?verified=1";

/** Page that consumes the password-reset token (Better Auth redirects here). */
export const RESET_PASSWORD_PATH = "/reset-password";

/**
 * Result-shape of web/lib/email.ts#sendEmail — kept structural so this module
 * never has to import the server-only email module.
 */
export type SendEmailFn = (params: {
  to: string;
  subject: string;
  html: string;
}) => Promise<{ ok: true; id: string } | { ok: false; error: string }>;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

/**
 * Log-safe slice of a sendEmail error: keeps the category ("Email send failed
 * (HTTP 422)", "Email sending is not configured.") and drops everything after
 * the first colon — i.e. any excerpt of the Resend response body. Tokens and
 * URLs never appear in these strings to begin with.
 */
export const sanitizeSendError = (error: string): string => error.split(":")[0]!.trim();

function emailShell(title: string, body: string, buttonLabel: string, url: string): string {
  const safeUrl = escapeHtml(url);
  return [
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">`,
    `<h2 style="font-size:18px;margin:0 0 12px">${title}</h2>`,
    `<p style="font-size:14px;line-height:1.6;margin:0 0 20px">${body}</p>`,
    `<p style="margin:0 0 20px"><a href="${safeUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">${buttonLabel}</a></p>`,
    `<p style="font-size:12px;color:#6b7280;line-height:1.6;margin:0">This link expires in 1 hour. If you didn't request it, you can safely ignore this email.</p>`,
    `</div>`,
  ].join("");
}

export const VERIFICATION_EMAIL_SUBJECT = "Verify your email address";

export function verificationEmailHtml(url: string): string {
  return emailShell(
    "Verify your email",
    "Confirm this email address for your account.",
    "Verify email",
    url,
  );
}

export const RESET_PASSWORD_EMAIL_SUBJECT = "Reset your password";

export function resetPasswordEmailHtml(url: string): string {
  return emailShell(
    "Reset your password",
    "We received a request to reset the password for your account. Setting a new password signs out every existing session.",
    "Set a new password",
    url,
  );
}

/**
 * Delivers a Better Auth-generated link and AWAITS the send, so the endpoint
 * only responds once Resend has accepted (or refused) the email — a fire-and-
 * forget send would let the server answer before delivery was even attempted.
 * The endpoint's public response stays generic either way: a failure is
 * logged by category only (sanitizeSendError — never the URL, the token, or
 * the Resend response body) and NOT rethrown. The await does mean the
 * "account exists" branch spends extra time in the Resend call — a residual
 * timing signal (see the rate-limit note in auth.ts); accepted for this
 * hotfix in exchange for delivery reliability.
 */
async function deliver(send: SendEmailFn, kind: string, params: Parameters<SendEmailFn>[0]) {
  try {
    const result = await send(params);
    if (!result.ok) {
      console.error(`[auth] ${kind} email send failed: ${sanitizeSendError(result.error)}`);
    }
  } catch {
    console.error(`[auth] ${kind} email send failed: unexpected error`);
  }
}

/**
 * Better Auth `emailVerification` options. Verification exists for hygiene
 * (offered to fresh signups via sendOnSignUp) — it is NOT an account-recovery
 * mechanism (that's buildPasswordReset below) and, with implicit linking
 * disabled, it grants nothing towards Google linking either. Note
 * sendOnSignUp alone does NOT prevent unverified accounts from existing:
 * users can ignore the email and keep signing in, because
 * `requireEmailVerification` is not enabled (see the debt note in auth.ts).
 */
export function buildEmailVerification(send: SendEmailFn) {
  return {
    sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
      await deliver(send, "verification", {
        to: user.email,
        subject: VERIFICATION_EMAIL_SUBJECT,
        html: verificationEmailHtml(url),
      });
    },
    sendOnSignUp: true,
    // The link's contract is "land on /login with a banner and sign in
    // yourself" — no session is minted by the link.
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60,
  };
}

/**
 * Better Auth `emailAndPassword` recovery options (option names verified
 * against the installed 1.6.19 types). This is the account-recovery path:
 * POST /reset-password replaces the credential hash (old password dies) and,
 * with revokeSessionsOnPasswordReset, deletes EVERY session of the user —
 * so an attacker who pre-registered the email loses both footholds at once.
 * Better Auth generates, stores (verification table), and single-use-consumes
 * the token itself.
 */
export function buildPasswordReset(send: SendEmailFn) {
  return {
    sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
      await deliver(send, "reset-password", {
        to: user.email,
        subject: RESET_PASSWORD_EMAIL_SUBJECT,
        html: resetPasswordEmailHtml(url),
      });
    },
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
  };
}

/**
 * Validates BETTER_AUTH_URL. Format problems (markdown paste, whitespace, not
 * a URL) throw EVERYWHERE — a malformed value is never right. The https +
 * not-localhost rules throw only when `enforceProduction` (deployed prod),
 * because local `next build` runs with NODE_ENV=production and a localhost
 * URL, and must keep working.
 *
 * Returns the normalized origin+path (no trailing slash).
 */
export function validateBetterAuthUrl(
  raw: string | undefined,
  { enforceProduction }: { enforceProduction: boolean },
): string {
  if (!raw || !raw.trim()) {
    if (enforceProduction) {
      throw new Error("BETTER_AUTH_URL must be set in production (https URL of the web app).");
    }
    return "http://localhost:3000";
  }
  const value = raw.trim();
  // Markdown-paste artifacts ("[url](url)", backticks) and inner whitespace
  // are config mistakes; fail fast with an actionable message.
  if (/[\s<>[\]()`"']/.test(value)) {
    throw new Error(
      `BETTER_AUTH_URL contains whitespace or markdown characters: ${JSON.stringify(value)}. Set it to a plain URL like https://your-app.up.railway.app`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`BETTER_AUTH_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`BETTER_AUTH_URL must be http(s), got ${url.protocol}//`);
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]" ||
    url.hostname.endsWith(".localhost");
  if (enforceProduction) {
    if (url.protocol !== "https:") {
      throw new Error(`BETTER_AUTH_URL must be https in production, got ${JSON.stringify(value)}`);
    }
    if (isLoopback) {
      throw new Error(`BETTER_AUTH_URL cannot be localhost in production, got ${JSON.stringify(value)}`);
    }
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
}
