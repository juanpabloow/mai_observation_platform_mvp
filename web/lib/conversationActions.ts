"use server";

import { revalidatePath } from "next/cache";
import {
  deleteConversationMapping,
  upsertConversationMapping,
} from "@worker/db/repositories/fieldMappings.js";
import type { ConversationRole } from "@worker/db/types.js";
import { getCurrentTenantId } from "./tenant";
import { requireFullAccessForAction } from "./access";
import { getWorkflowForCurrentTenant } from "./workflow";

/**
 * Conversation-mapping server actions. These are workflow FIELD MAPPINGS — integration
 * plumbing the AGENCY owns (they define how a client's bot conversations are read), so
 * both are agency-only (hasFullAccess) AND tenant-scoped: the workflow is resolved via
 * getWorkflowForCurrentTenant (current tenant only), so a role can never be
 * written/deleted against another tenant's — or, for a client login, ANY — workflow.
 * Upsert replaces the role (one mapping per role via the partial unique index).
 */
export async function upsertConversationRoleAction(input: {
  workflowId: string;
  role: ConversationRole;
  nodeName: string;
  jsonPath: string;
  label?: string | null;
  dataType?: string | null;
}): Promise<void> {
  await requireFullAccessForAction(); // agency plumbing
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
  if (workflow.client_id) {
    const wfBase = `/clients/${workflow.client_id}/workflows/${input.workflowId}`;
    revalidatePath(`${wfBase}/conversations/settings`); // settings surface stays here
    revalidatePath(`${wfBase}/inbox`); // the derived list now renders under Inbox

  }
}

export async function deleteConversationRoleAction(input: {
  workflowId: string;
  role: ConversationRole;
}): Promise<void> {
  await requireFullAccessForAction(); // agency plumbing
  // Resolve the workflow BEFORE mutating — the old order deleted by (tenant, workflowId,
  // role) first with no access check, so a client login of another client could delete
  // any conversation-role mapping in the tenant. Resolve-then-mutate closes that.
  const workflow = await getWorkflowForCurrentTenant(input.workflowId);
  if (!workflow) {
    throw new Error("Workflow not found for the current tenant");
  }
  const tenantId = await getCurrentTenantId();
  await deleteConversationMapping({
    tenantId,
    n8nWorkflowId: input.workflowId,
    role: input.role,
  });
  if (workflow.client_id) {
    const wfBase = `/clients/${workflow.client_id}/workflows/${input.workflowId}`;
    revalidatePath(`${wfBase}/conversations/settings`); // settings surface stays here
    revalidatePath(`${wfBase}/inbox`); // the derived list now renders under Inbox

  }
}
