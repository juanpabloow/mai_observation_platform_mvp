/**
 * Client-safe ALLOWLIST mapping of auth error codes to user-facing copy (Spanish — the access
 * screens are Spanish since ACCESO-1). Anything not in the allowlist gets a generic fallback —
 * raw error messages (result.error.message, provider payloads) are never rendered. Copy
 * contains no internals, tokens, or provider details, and never confirms whether an account
 * exists for an email (a wrong password and an unknown email read the same).
 *
 * Producers of ?error= on our pages:
 * - The OAuth callback (via errorCallbackURL) with snake_case codes, e.g.
 *   account_not_linked, email_doesn't_match, reauth_failed.
 * - Better Auth's GET /verify-email and GET /reset-password/:token redirects
 *   with UPPER_SNAKE codes, e.g. TOKEN_EXPIRED, INVALID_TOKEN.
 */

export const GENERIC_RESET_NOTICE =
  "Si existe una cuenta con ese correo, te enviamos un enlace para cambiar la contraseña. Revisa tu bandeja de entrada (y la de spam).";

export const PASSWORD_RESET_DONE_NOTICE =
  "Contraseña actualizada. Cerramos todas las sesiones anteriores: entra con tu nueva contraseña.";

export const EMAIL_VERIFIED_NOTICE = "Correo verificado. Ya puedes iniciar sesión.";

export const RATE_LIMITED_NOTICE = "Demasiados intentos. Espera un minuto e inténtalo otra vez.";

/** The Better Auth code for a sign-in refused because the email isn't verified
 *  (FORBIDDEN/403). The login form special-cases it to offer a "resend" action
 *  rather than the generic failure. */
export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED";

export const EMAIL_NOT_VERIFIED_NOTICE =
  "Tu correo aún no está verificado. Abre el enlace que te enviamos y vuelve a entrar, o pide uno nuevo aquí abajo.";

export const VERIFICATION_RESENT_NOTICE =
  "Si esa cuenta necesita verificarse, te enviamos un enlace nuevo. Revisa tu bandeja de entrada (y la de spam).";

const RECOVER_HINT =
  "Entra con tu contraseña, o usa «¿La olvidaste?» para recuperar el acceso. Después podrás conectar Google desde Seguridad.";

/** Codes arriving as ?error= via redirects (OAuth callback / token links). */
const REDIRECT_MESSAGES: Record<string, string> = {
  account_not_linked: `Esta cuenta existe, pero Google todavía no está conectado a ella. ${RECOVER_HINT}`,
  unable_to_link_account: "No pudimos conectar Google a tu cuenta. Inténtalo otra vez.",
  account_already_linked_to_different_user: "Esa cuenta de Google ya está conectada a otro usuario.",
  "email_doesn't_match": "Solo puedes conectar una cuenta de Google con el mismo correo.",
  email_not_found: "Tu cuenta de Google no compartió un correo, así que no podemos usarla para entrar.",
  access_denied: "Cancelaste el inicio de sesión con Google.",
  reauth_failed:
    "No pudimos confirmar tu identidad con Google. Usa la misma cuenta de Google de tu perfil e inténtalo otra vez.",
  reauth_not_recent:
    "Google no confirmó que hayas iniciado sesión en los últimos minutos, así que no podemos usarlo para cerrar otras sesiones. Usa tu contraseña si la tienes.",
  TOKEN_EXPIRED: "Ese enlace venció. Pide uno nuevo.",
  INVALID_TOKEN: "Ese enlace no es válido o ya se usó. Pide uno nuevo.",
  USER_NOT_FOUND: "Ese enlace ya no es válido. Pide uno nuevo.",
};

export const GENERIC_SIGN_IN_FAILED = "No pudimos iniciar la sesión. Inténtalo otra vez.";

export function mapAuthErrorParam(code: string | null): string | null {
  if (!code) return null;
  return REDIRECT_MESSAGES[code] ?? GENERIC_SIGN_IN_FAILED;
}

/** Codes returned in-band by the auth client (result.error.code). */
const CLIENT_MESSAGES: Record<string, string> = {
  PROVIDER_NOT_FOUND: "El inicio de sesión con Google no está disponible ahora.",
  INVALID_TOKEN: "Ese enlace no es válido o ya se usó. Pide uno nuevo.",
  PASSWORD_TOO_SHORT: "La contraseña debe tener al menos 8 caracteres.",
  PASSWORD_TOO_LONG: "Esa contraseña es demasiado larga.",
  LINKING_NOT_ALLOWED: "No se permite conectar esta cuenta.",
  LINKING_DIFFERENT_EMAILS_NOT_ALLOWED: "Solo puedes conectar una cuenta de Google con el mismo correo.",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "Esa cuenta de Google ya está conectada.",
  // Covers both a wrong password AND a Google-only account with no password set
  // (Better Auth returns the same code for both, so we never reveal which) — the
  // hint steers a Google-only user without enumerating accounts.
  INVALID_EMAIL_OR_PASSWORD:
    "Correo o contraseña incorrectos. Si tu cuenta entra con Google, usa «Continuar con Google».",
  EMAIL_NOT_VERIFIED: EMAIL_NOT_VERIFIED_NOTICE,
  // Sign-up: Better Auth's own answer for a taken email. Shown only on the business sign-up.
  USER_ALREADY_EXISTS: "No pudimos crear la cuenta con ese correo. Si ya tienes una, inicia sesión.",
  TOO_MANY_REQUESTS: RATE_LIMITED_NOTICE,
};

export function mapClientAuthError(
  code: string | null | undefined,
  fallback = "Algo salió mal. Inténtalo otra vez.",
): string {
  return (code && CLIENT_MESSAGES[code]) || fallback;
}
