import { canAccessSchedulingSite, canAny, getSessionScope, isSchedulingStaff } from "@/lib/access";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { latestEventSeq, listEventsSince } from "@worker/db/repositories/scheduling/events.js";

/**
 * GET /api/scheduling/internal/events?since=&site_id= — SESSION-authed realtime
 * cursor. A member only sees their client's events (clientId = memberClientId), and a
 * STAFF login is additionally pinned to its OWN site — otherwise it could poll another
 * site's columns, which the agenda deliberately withholds. The agenda/contacts views
 * poll this to know WHEN to refresh (the authoritative data is re-read on refresh, so a
 * missed event just means a slightly later refresh — the reload always recovers state).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope) return Response.json({ error: "forbidden" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const since = p.get("since");
  // A member polls ITS client's events only if it may see the agenda or contacts there
  // AND the scheduling module is on — otherwise there is nothing for it to refresh.
  if (scope.memberClientId) {
    if (!canAny(scope, ["agenda.view", "contacts.view"], scope.memberClientId)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!(await isClientModuleEnabled(scope.tenantId, scope.memberClientId, "scheduling"))) {
      return Response.json({ cursor: since ?? (await latestEventSeq(scope.tenantId)), events: [] });
    }
  }
  let siteId = p.get("site_id") ?? undefined;
  // A malformed or cross-scope site is ignored (never trusted). A staff login is then
  // pinned to its own site regardless of the param, so it can't poll another site.
  if (siteId && (!isUuid(siteId) || !canAccessSchedulingSite(scope, siteId))) siteId = undefined;
  if (isSchedulingStaff(scope) && scope.schedulingSiteId) siteId = scope.schedulingSiteId;

  if (!since) {
    // First poll: hand back the current cursor without any events.
    return Response.json({ cursor: await latestEventSeq(scope.tenantId), events: [] });
  }
  const events = await listEventsSince(scope.tenantId, since, { siteId, clientId: scope.memberClientId });
  const cursor = events.length > 0 ? events[events.length - 1].seq : since;
  return Response.json({ cursor, events });
}
