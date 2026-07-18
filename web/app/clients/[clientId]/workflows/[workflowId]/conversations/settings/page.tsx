import { connection } from "next/server";
import Link from "next/link";
import { listConversationMappings } from "@worker/db/repositories/fieldMappings.js";
import { listRecentRawForWorkflow } from "@worker/db/repositories/executions.js";
import type { ConversationRole } from "@worker/db/types.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getAccessScope, hasFullAccess } from "@/lib/access";
import { requireWorkflowUnderClient } from "@/lib/clientWorkflow";
import { getWebhookRow } from "@worker/db/repositories/webhooks.js";
import {
  buildExecutionResolver,
  extractMapping,
  formatCellValue,
  METADATA_NODE_LABEL,
  METADATA_NODE_NAME,
} from "@/lib/fieldCatalog";
import {
  ConversationSettings,
  type RoleAssignmentView,
} from "@/components/ConversationSettings";
import { HandoffWebhook, type WebhookView } from "@/components/HandoffWebhook";

const ROLE_DEFS: { role: ConversationRole; label: string; required: boolean }[] = [
  { role: "conversation_id", label: "Conversation ID", required: true },
  { role: "user_message", label: "User message", required: true },
  { role: "ai_response", label: "AI response", required: true },
  { role: "contact_name", label: "Contact name", required: false },
];

const SAMPLE_SIZE = 10;

export default async function ConversationSettingsPage({
  params,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
}) {
  await connection();
  const { clientId, workflowId } = await params;

  const workflow = await requireWorkflowUnderClient(
    clientId,
    workflowId,
    "conversations/settings",
  );
  const linkClientId = workflow.client_id ?? clientId;

  const tenantId = await getCurrentTenantId();
  // The Human Handoff (webhook) section is owner/admin only — resolve access here so
  // a member never even receives the webhook config (the actions also re-check).
  const scope = await getAccessScope();
  const isFullAccess = hasFullAccess(scope);
  const [mappings, raws, webhookRow] = await Promise.all([
    listConversationMappings({ tenantId, n8nWorkflowId: workflowId }),
    listRecentRawForWorkflow({ tenantId, n8nWorkflowId: workflowId, limit: SAMPLE_SIZE }),
    isFullAccess ? getWebhookRow(tenantId, workflowId) : Promise.resolve(null),
  ]);
  const webhookView: WebhookView | null = webhookRow
    ? {
        url: webhookRow.url,
        enabled: webhookRow.enabled,
        lastDeliveryAt: webhookRow.last_delivery_at?.toISOString() ?? null,
        lastDeliveryStatus: webhookRow.last_delivery_status,
      }
    : null;

  const byRole = new Map(mappings.map((m) => [m.role, m]));
  const resolvers = raws.map((r) => buildExecutionResolver(r.raw_data));

  const roles: RoleAssignmentView[] = ROLE_DEFS.map((def) => {
    const mapping = byRole.get(def.role);
    if (!mapping) {
      return {
        role: def.role,
        label: def.label,
        required: def.required,
        set: false,
        nodeLabel: null,
        fieldLabel: null,
        jsonPath: null,
        example: null,
      };
    }

    // Example = first non-null extraction across the recent sample.
    let example: string | null = null;
    for (const resolver of resolvers) {
      const value = extractMapping(resolver, mapping.node_name, mapping.json_path);
      if (value !== undefined && value !== null) {
        example = formatCellValue(value).display;
        break;
      }
    }

    return {
      role: def.role,
      label: def.label,
      required: def.required,
      set: true,
      nodeLabel:
        mapping.node_name === METADATA_NODE_NAME ? METADATA_NODE_LABEL : mapping.node_name,
      fieldLabel: mapping.column_label,
      jsonPath: mapping.json_path,
      example,
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <Link
        href={`/clients/${linkClientId}/workflows/${encodeURIComponent(workflowId)}/conversations`}
        className="text-sm text-neutral-500 transition-colors hover:text-foreground"
      >
        &larr; Back to conversations
      </Link>
      <ConversationSettings workflowId={workflowId} roles={roles} />
      {isFullAccess ? <HandoffWebhook workflowId={workflowId} initial={webhookView} /> : null}
    </div>
  );
}
