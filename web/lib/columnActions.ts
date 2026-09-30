"use server";

import { revalidatePath } from "next/cache";
import {
  deleteColumnMapping,
  insertColumnMapping,
} from "@worker/db/repositories/fieldMappings.js";
import { listRecentRawForWorkflow } from "@worker/db/repositories/executions.js";
import { getCurrentTenantId } from "./tenant";
import { getAccessScope, hasFullAccess, requireFullAccessForAction } from "./access";
import { getWorkflowForCurrentTenant } from "./workflow";
import { buildFieldCatalog, type FieldCatalog } from "./fieldCatalog";

/** How many recent executions to sample when building the field catalog. */
const CATALOG_SAMPLE_SIZE = 10;

/**
 * Server actions for the column picker. Column mappings are workflow FIELD MAPPINGS —
 * integration plumbing the AGENCY owns (a client breaking them silently changes what
 * their executions show), so every one of these is agency-only (hasFullAccess) AND
 * tenant-scoped: the workflow is resolved via getWorkflowForCurrentTenant (current
 * tenant only), so a column can never be read/created/deleted against another tenant's —
 * or, for a client login, ANY — workflow.
 */

/** Build the available-fields catalog for a workflow (empty for non-agency / other tenant). */
export async function getFieldCatalogAction(workflowId: string): Promise<FieldCatalog> {
  if (!hasFullAccess(await getAccessScope())) return []; // agency-only picker
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

/** Persist a 'column' mapping for the workflow (agency-only, tenant-scoped). */
export async function addColumnAction(input: AddColumnInput): Promise<void> {
  await requireFullAccessForAction(); // field mappings are agency plumbing
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

/** Delete a 'column' mapping by id (agency-only, tenant-scoped). */
export async function deleteColumnAction(input: {
  workflowId: string;
  id: string;
}): Promise<void> {
  await requireFullAccessForAction(); // field mappings are agency plumbing
  // Resolve the workflow BEFORE mutating: this is the access + existence check. The old
  // order deleted by (tenant, id) first, so a client login of another client could
  // delete any column mapping in the tenant by id. Resolve-then-mutate closes that.
  const workflow = await getWorkflowForCurrentTenant(input.workflowId);
  if (!workflow) {
    throw new Error("Workflow not found for the current tenant");
  }
  const tenantId = await getCurrentTenantId();
  await deleteColumnMapping({ tenantId, id: input.id });
  if (workflow.client_id) {
    revalidatePath(`/clients/${workflow.client_id}/workflows/${input.workflowId}/executions`);
  }
}
