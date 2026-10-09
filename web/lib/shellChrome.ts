/**
 * Which routes render WITHOUT the app chrome (no rail, no header, no framed panel).
 * Pure so the layout and the tests share one list. Mirrors AppHeader's AUTH_PREFIXES
 * and the public booking page; the real gates stay at the data layer.
 */
export const CHROMELESS_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password", "/book"] as const;

export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
