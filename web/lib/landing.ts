/**
 * Where a client MEMBER lands — one pure rule shared by the server bounce
 * (access.ts memberLandingHref), the invitation acceptance and the rail's brand link, so
 * the three can no longer disagree (they did: the brand sent owners AND setters to
 * Workflows, and an accepted invitation sent setters to Analytics — both 404 for a setter).
 *
 *   staff  → their agenda (the only surface they have)
 *   setter → the client inbox (their job is the chats; no insights)
 *   owner  → the client's Analytics (the value dashboard)
 *
 * Navigation only: every destination still enforces its own server gate.
 */
export function memberLandingPath(memberClientId: string, clientRole: string | null): string {
  if (clientRole === "staff") return `/clients/${memberClientId}/scheduling/agenda`;
  if (clientRole === "setter") return `/clients/${memberClientId}/inbox`;
  return `/clients/${memberClientId}/analytics`;
}
