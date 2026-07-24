import { getSessionScope } from "@/lib/access";
import { latestEventSeq, listEventsSince } from "@worker/db/repositories/scheduling/events.js";

/**
 * GET /api/scheduling/internal/events?since=&site_id= — SESSION-authed realtime
 * cursor. Any tenant role; a member only sees their client's events. The agenda/
 * contacts views poll this to know WHEN to refresh (the authoritative data is
 * re-read on refresh, so a missed event just means a slightly later refresh — the
 * reload always recovers true state).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope) return Response.json({ error: "forbidden" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const since = p.get("since");
  const siteId = p.get("site_id") ?? undefined;

  if (!since) {
    // First poll: hand back the current cursor without any events.
    return Response.json({ cursor: await latestEventSeq(scope.tenantId), events: [] });
  }
  const events = await listEventsSince(scope.tenantId, since, { siteId, clientId: scope.memberClientId });
  const cursor = events.length > 0 ? events[events.length - 1].seq : since;
  return Response.json({ cursor, events });
}
