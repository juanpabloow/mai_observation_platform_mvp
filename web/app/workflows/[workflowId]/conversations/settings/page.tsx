import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listConversationMappings } from "@worker/db/repositories/fieldMappings.js";
import { listRecentRawForWorkflow } from "@worker/db/repositories/executions.js";
import type { ConversationRole } from "@worker/db/types.js";
import { getCurrentTenantId } from "@/lib/tenant";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
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
  params: Promise<{ workflowId: string }>;
}) {
  await connection();
  const { workflowId } = await params;

  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) {
    notFound();
  }

  const tenantId = await getCurrentTenantId();
  const [mappings, raws] = await Promise.all([
    listConversationMappings({ tenantId, n8nWorkflowId: workflowId }),
    listRecentRawForWorkflow({ tenantId, n8nWorkflowId: workflowId, limit: SAMPLE_SIZE }),
  ]);

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
        href={`/workflows/${encodeURIComponent(workflowId)}/conversations`}
        className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
      >
        &larr; Back to conversations
      </Link>
      <ConversationSettings workflowId={workflowId} roles={roles} />
    </div>
  );
}
