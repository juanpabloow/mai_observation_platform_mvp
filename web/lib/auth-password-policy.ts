import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { passwordProblem, type PasswordContext } from "./passwordPolicy";

type MiddlewareCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type PolicyAdapter = {
  findVerificationValue(identifier: string): Promise<{ value: string } | null>;
  findUserById(id: string): Promise<{ email: string; name: string } | null>;
};

/** One Better Auth code per broken rule — mapped to Spanish in lib/auth-errors.ts. */
export const PASSWORD_POLICY_CODES = {
  length: "PASSWORD_TOO_SHORT",
  "too-long": "PASSWORD_TOO_LONG",
  common: "PASSWORD_TOO_COMMON",
  personal: "PASSWORD_HAS_PERSONAL_INFO",
} as const;

/**
 * Before-hook: every Better Auth endpoint that SETS a password applies lib/passwordPolicy.ts,
 * so the rule cannot be skipped by calling the API directly. The person behind the password
 * is the body's email/name on sign-up, the token's user on reset (looked up WITHOUT consuming
 * the token — Better Auth still answers an invalid one with INVALID_TOKEN), and the session's
 * user on change. Sign-in is never checked: existing passwords keep working.
 */
export async function enforcePasswordPolicy(ctx: MiddlewareCtx): Promise<void> {
  const body = (ctx.body && typeof ctx.body === "object" ? ctx.body : {}) as Record<string, unknown>;
  let password: unknown;
  let person: PasswordContext = {};
  if (ctx.path === "/sign-up/email") {
    password = body.password;
    person = { email: str(body.email), name: str(body.name) };
  } else if (ctx.path === "/reset-password") {
    password = body.newPassword;
    if (typeof password !== "string") return;
    rejectIfWeak(password, {}); // the cheap rules first: no database read for those
    const token = str(body.token) ?? str((ctx.query as Record<string, unknown> | undefined)?.token);
    if (token) {
      const adapter = ctx.context.internalAdapter as unknown as PolicyAdapter;
      const found = await adapter.findVerificationValue(`reset-password:${token}`);
      const user = found ? await adapter.findUserById(found.value) : null;
      if (user) person = { email: user.email, name: user.name };
    }
  } else if (ctx.path === "/change-password") {
    password = body.newPassword;
    const session = await getSessionFromCtx(ctx).catch(() => null);
    if (session) person = { email: session.user.email, name: session.user.name };
  } else {
    return;
  }
  if (typeof password !== "string") return; // Better Auth's own body validation answers.
  rejectIfWeak(password, person);
}

function rejectIfWeak(password: string, person: PasswordContext) {
  const problem = passwordProblem(password, person);
  if (problem) throw new APIError("BAD_REQUEST", { message: problem.error, code: PASSWORD_POLICY_CODES[problem.id] });
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
