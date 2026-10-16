import "server-only";
import { getServerSession } from "./session";

/**
 * PLATFORM ADMINISTRATOR — an M_AI operator, ABOVE every tenant. Not a tenant role:
 * tenant `owner` / `admin` is whoever owns that account (every signup gets its own tenant
 * as owner, web/lib/auth.ts), and client roles (owner / setter / staff) belong to a
 * business. None of them is, or implies, this.
 *
 * The codebase had NO platform-level identity before this module. It is deliberately
 * the narrowest possible one: an explicit allow-list of Better Auth user ids in the
 * server environment (PLATFORM_ADMIN_USER_IDS, comma-separated). Unset or empty means
 * NOBODY — the gate is closed by default and no existing user gains anything. Granting
 * it is a deliberate deploy-time decision by M_AI, outside any tenant's reach.
 *
 * Every privileged operation calls requirePlatformAdmin() ON THE SERVER, per call —
 * hiding a button is never the control.
 */

function allowList(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => /^[A-Za-z0-9_-]{8,128}$/.test(x)),
  );
}

/** Pure check (also used by tests): is this user id on the platform allow-list? */
export function isPlatformAdminId(userId: string | null | undefined): boolean {
  return Boolean(userId) && allowList().has(userId as string);
}

/** The signed-in platform administrator, or null — never throws, never reveals why. */
export async function requirePlatformAdmin(): Promise<{ userId: string } | null> {
  const session = await getServerSession();
  const userId = session?.user?.id ?? null;
  return isPlatformAdminId(userId) ? { userId: userId as string } : null;
}
