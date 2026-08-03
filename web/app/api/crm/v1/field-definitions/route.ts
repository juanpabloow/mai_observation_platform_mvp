import { authenticateCrm } from "@/lib/crmApi";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";

/**
 * GET /api/crm/v1/field-definitions   [crm.read]
 *
 * The client's enabled contact field definitions (key, label, type, options) — makes the
 * API self-describing so a workflow builder can discover what a given client tracks
 * without asking anyone. Channel-blind.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateCrm(req, "crm.read");
  if (!auth.ok) return auth.response;

  const defs = await listFieldDefinitions(auth.auth.tenantId, auth.auth.clientId, { enabledOnly: true });
  return Response.json({
    field_definitions: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options })),
  });
}
