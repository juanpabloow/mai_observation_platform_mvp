"use server";

import { revalidatePath } from "next/cache";
import {
  deleteConversationMapping,
  upsertConversationMapping,
} from "@worker/db/repositories/fieldMappings.js";
import type { ConversationRole } from "@worker/db/types.js";
import { getCurrentTenantId } from "./tenant";
import { getWorkflowForCurrentTenant } from "./workflow";

/**
 * Conversation-mapping server actions. Tenant-scoped: the workflow is resolved
 * via getWorkflowForCurrentTenant (current tenant only), so a role can never be
 * written/deleted against another tenant's workflow. Upsert replaces the role
 * (one mapping per role via the partial unique index).
 */
export async function upsertConversationRoleAction(input: {
  workflowId: string;
  role: ConversationRole;
  nodeName: string;
  jsonPath: string;
  label?: string | null;
  dataType?: string | null;
}): Promise<void> {
  const workflow = await getWorkflowForCurrentTenant(input.workflowId);
  if (!workflow) {
    throw new Error("Workflow not found for the current tenant");
  }
  const tenantId = await getCurrentTenantId();
  await upsertConversationMapping({
    tenantId,
    n8nWorkflowId: input.workflowId,
    role: input.role,
    nodeName: input.nodeName,
    jsonPath: input.jsonPath,
    label: input.label ?? null,
    dataType: input.dataType ?? null,
  });
  // Refresh both the settings screen and the list (mapping changes flip the
  // list between its setup-prompt and chat-list states).
  revalidatePath(`/workflows/${input.workflowId}/conversations/settings`);
  revalidatePath(`/workflows/${input.workflowId}/conversations`);
}

export async function deleteConversationRoleAction(input: {
  workflowId: string;
  role: ConversationRole;
}): Promise<void> {
  const tenantId = await getCurrentTenantId();
  await deleteConversationMapping({
    tenantId,
    n8nWorkflowId: input.workflowId,
    role: input.role,
  });
  revalidatePath(`/workflows/${input.workflowId}/conversations/settings`);
  revalidatePath(`/workflows/${input.workflowId}/conversations`);
}
