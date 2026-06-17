"use server";

import { revalidatePath } from "next/cache";
import {
  deleteColumnMapping,
  insertColumnMapping,
} from "@worker/db/repositories/fieldMappings.js";
import { listRecentRawForWorkflow } from "@worker/db/repositories/executions.js";
import { getCurrentTenantId } from "./tenant";
import { getWorkflowForCurrentTenant } from "./workflow";
import { buildFieldCatalog, type FieldCatalog } from "./fieldCatalog";

/** How many recent executions to sample when building the field catalog. */
const CATALOG_SAMPLE_SIZE = 10;

/**
 * Server actions for the column picker. All tenant-scoped: the workflow is
 * resolved via getWorkflowForCurrentTenant (which filters by the current
 * tenant), so a column can never be read/created/deleted against another
 * tenant's workflow.
 */

/** Build the available-fields catalog for a workflow (empty if not this tenant's). */
export async function getFieldCatalogAction(workflowId: string): Promise<FieldCatalog> {
  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) return [];
  const tenantId = await getCurrentTenantId();
  const rows = await listRecentRawForWorkflow({
    tenantId,
    n8nWorkflowId: workflowId,
    limit: CATALOG_SAMPLE_SIZE,
  });
  return buildFieldCatalog(rows.map((r) => r.raw_data));
}

export interface AddColumnInput {
  workflowId: string;
  nodeName: string;
  jsonPath: string;
  columnLabel: string;
  dataType?: string | null;
}

/** Persist a 'column' mapping for the workflow (tenant-scoped). */
export async function addColumnAction(input: AddColumnInput): Promise<void> {
  const workflow = await getWorkflowForCurrentTenant(input.workflowId);
  if (!workflow) {
    throw new Error("Workflow not found for the current tenant");
  }
  const tenantId = await getCurrentTenantId();
  await insertColumnMapping({
    tenantId,
    n8nWorkflowId: input.workflowId,
    nodeName: input.nodeName,
    columnLabel: input.columnLabel,
    jsonPath: input.jsonPath,
    dataType: input.dataType ?? null,
  });
  if (workflow.client_id) {
    revalidatePath(`/clients/${workflow.client_id}/workflows/${input.workflowId}/executions`);
  }
}

/** Delete a 'column' mapping by id (tenant-scoped). */
export async function deleteColumnAction(input: {
  workflowId: string;
  id: string;
}): Promise<void> {
  const tenantId = await getCurrentTenantId();
  await deleteColumnMapping({ tenantId, id: input.id });
  // Resolve the workflow's client to revalidate the canonical nested path.
  const workflow = await getWorkflowForCurrentTenant(input.workflowId);
  if (workflow?.client_id) {
    revalidatePath(`/clients/${workflow.client_id}/workflows/${input.workflowId}/executions`);
  }
}
