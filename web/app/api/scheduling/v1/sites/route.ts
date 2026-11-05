import { authenticateScheduling } from "@/lib/schedulingApi";
import { DEFAULT_LABEL_LOCALE } from "@/lib/localTime";
import { projectPublicSite } from "@/lib/publicBookingApi";
import { projectSiteClosures, SITE_CLOSURE_WINDOW_DAYS } from "@/lib/siteClosures";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { loadExplainExceptions } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/v1/sites — active sites for the RESOLVED client only.
 * MACHINE endpoint (Bearer token + X-Workflow-Ref). Tenant AND client are derived
 * from the token+workflow, never input — a token never lists another client's sites.
 *
 * Besides the ids, each site carries what an assistant needs to answer "¿a qué hora
 * abren?" from the agenda itself (edited in Horarios y ausencias), never from a prompt:
 * the weekly hours as the booking page shows them, the public contact, and the
 * whole-site closures of the next SITE_CLOSURE_WINDOW_DAYS days with their PUBLIC
 * reason only (the internal block text is never read).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const sites = await listSites(auth.auth.tenantId, { clientId: auth.auth.clientId });
  const now = new Date();
  const to = new Date(now.getTime() + SITE_CLOSURE_WINDOW_DAYS * 86_400_000);
  const out = await Promise.all(
    sites.map(async (s) => {
      const pub = projectPublicSite(s);
      const exc = await loadExplainExceptions({ tenantId: auth.auth.tenantId, siteId: s.id, from: now, to, staffIds: [] });
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        address: s.address,
        timezone: s.timezone,
        scheduling_config: s.scheduling_config,
        hours: pub.hours,
        closed_weekdays: pub.closed_weekdays,
        whatsapp: pub.whatsapp,
        directions_url: pub.directions_url,
        upcoming_closures: projectSiteClosures(exc.site, s.timezone, now, DEFAULT_LABEL_LOCALE),
      };
    }),
  );
  return Response.json({ sites: out, closures_window_days: SITE_CLOSURE_WINDOW_DAYS });
}
