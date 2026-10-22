/**
 * Where a client MEMBER lands — one pure rule shared by the server bounce
 * (access.ts memberLandingHref) and the rail's brand link, so the two can never disagree.
 * It reads WHAT THE LOGIN MAY DO (its permissions), never the role's name:
 *
 *   results (analytics.view)            → the client's Dashboard de valor  (Dueño)
 *   a professional login (agenda.view)  → their agenda                     (Profesional)
 *   inbox.view                          → the client inbox                 (Recepción)
 *   then contacts → agenda → products → campaigns → users, whichever the role has;
 *   nothing at all                      → /no-access (an explanation, never a 404).
 *
 * Navigation only: every destination still enforces its own server gate.
 */

export interface LandingAccess {
  /** The login's permission keys on this client. */
  permissions: ReadonlySet<string> | readonly string[];
  /** Bound to one staff resource (a professional login). */
  staffBound: boolean;
}

export function memberLandingPath(memberClientId: string, access: LandingAccess): string {
  const has = (k: string) =>
    access.permissions instanceof Set ? access.permissions.has(k) : (access.permissions as readonly string[]).includes(k);
  const c = (p: string) => `/clients/${memberClientId}${p}`;
  if (has("analytics.view")) return c("/analytics");
  if (access.staffBound && has("agenda.view")) return c("/scheduling/agenda");
  if (has("inbox.view")) return c("/inbox");
  if (has("contacts.view")) return c("/contacts");
  if (has("agenda.view")) return c("/scheduling/agenda");
  if (has("products.view")) return c("/catalog");
  if (has("campaigns.view")) return c("/campaigns");
  if (has("access.users.view")) return c("/team");
  return "/no-access";
}
