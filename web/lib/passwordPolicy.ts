/**
 * THE rule for a NEW password (sign-up, invitation profile, password reset, change) — pure, so
 * the form shows the same checklist the server enforces (lib/auth-password-policy.ts and
 * createProfileFromInvitationAction).
 *
 * Follows NIST SP 800-63B instead of composition rules: length is what makes a password hard
 * to guess, and «one uppercase + one symbol» mostly produces predictable shapes like
 * «Barberia2026!». So: at least 12 characters (up to 128, passphrases welcome), not a common /
 * guessable password, and not built from the person's own email or name. Existing passwords
 * are untouched — sign-in never checks this; it applies the next time a password is set.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordRuleId = "length" | "common" | "personal";
export type PasswordRule = { id: PasswordRuleId; label: string; ok: boolean };
export type PasswordStrength = "empty" | "weak" | "good" | "strong";
export type PasswordContext = { email?: string | null; name?: string | null };

export const PASSWORD_RULE_ERRORS: Record<PasswordRuleId, string> = {
  length: `Usa al menos ${PASSWORD_MIN} caracteres.`,
  common: "Esa contraseña es muy común o fácil de adivinar. Prueba con una frase de varias palabras.",
  personal: "No uses tu correo ni tu nombre en la contraseña.",
};
export const PASSWORD_TOO_LONG_ERROR = `Usa como máximo ${PASSWORD_MAX} caracteres.`;

/** Lowercase, no accents, letters and digits only — the form every comparison uses. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Words that, padded with digits and symbols, make up most leaked passwords (plus the obvious
// ones for this product and its businesses). Compared against the password's LETTERS only.
const COMMON_WORDS = new Set([
  "password", "passw", "pass", "contrasena", "clave", "secreto", "secret", "usuario", "user",
  "admin", "administrador", "qwerty", "asdf", "zxcv", "abc", "abcd", "iloveyou", "teamo",
  "welcome", "bienvenido", "bienvenida", "hola", "holamundo", "letmein", "login", "test",
  "prueba", "dragon", "monkey", "master", "princess", "princesa", "sunshine", "superman",
  "batman", "football", "futbol", "colombia", "mexico", "argentina", "espana", "montserrat",
  "montserratai", "mai", "barberia", "peluqueria", "salon", "spa", "negocio", "empresa",
  "qwertyuiop", "asdfghjkl", "zxcvbnm", "qazwsx", "qwe", "asd",
]);

// Leaked passwords that survive the length rule and the patterns below.
const COMMON_PASSWORDS = new Set([
  "1q2w3e4r5t6y", "1q2w3e4r5t6y7u", "1qaz2wsx3edc", "1qaz2wsx3edc4rfv", "zaq12wsxcde3",
  "q1w2e3r4t5y6", "a1b2c3d4e5f6", "123qweasdzxc", "qweasdzxc123",
]);

const SEQUENCES = ["01234567890123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"];

function isGuessable(password: string): boolean {
  const n = normalize(password);
  if (!n) return true;
  if (COMMON_PASSWORDS.has(n)) return true;
  if (/^(.{1,4})\1+.{0,3}$/.test(n)) return true; // aaaa…, abcabc…, 20262026…
  if (SEQUENCES.some((s) => s.includes(n) || [...s].reverse().join("").includes(n))) return true;
  const letters = n.replace(/[0-9]/g, "");
  return letters.length === 0 || COMMON_WORDS.has(letters);
}

/** The pieces of the email / name a password must not contain (4+ characters each). */
function personalTokens({ email, name }: PasswordContext): string[] {
  const tokens: string[] = [];
  const [local = "", domain = ""] = (email ?? "").split("@");
  tokens.push(normalize(local), ...local.split(/[._+-]/).map(normalize));
  const label = domain.split(".")[0] ?? "";
  if (!["gmail", "hotmail", "outlook", "yahoo", "icloud", "live"].includes(label)) tokens.push(normalize(label));
  tokens.push(...(name ?? "").split(/\s+/).map(normalize));
  return [...new Set(tokens.filter((t) => t.length >= 4))];
}

export function checkNewPassword(password: string, context: PasswordContext = {}) {
  const n = normalize(password);
  const rules: PasswordRule[] = [
    { id: "length", label: `Al menos ${PASSWORD_MIN} caracteres`, ok: password.length >= PASSWORD_MIN },
    { id: "common", label: "No es una contraseña común", ok: password.length > 0 && !isGuessable(password) },
    {
      id: "personal",
      label: "No incluye tu correo ni tu nombre",
      ok: password.length > 0 && !personalTokens(context).some((t) => n.includes(t)),
    },
  ];
  const tooLong = password.length > PASSWORD_MAX;
  const ok = !tooLong && rules.every((r) => r.ok);
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const strength: PasswordStrength = !password
    ? "empty"
    : !ok
      ? "weak"
      : password.length >= 16 || classes >= 3
        ? "strong"
        : "good";
  return { ok, rules, tooLong, strength };
}

/** The first problem, as the sentence a form or server action shows — null when it passes. */
export function passwordProblem(password: string, context: PasswordContext = {}): { id: PasswordRuleId | "too-long"; error: string } | null {
  const result = checkNewPassword(password, context);
  if (result.tooLong) return { id: "too-long", error: PASSWORD_TOO_LONG_ERROR };
  const failed = result.rules.find((r) => !r.ok);
  return failed ? { id: failed.id, error: PASSWORD_RULE_ERRORS[failed.id] } : null;
}
