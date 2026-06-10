import { firstRowOrThrow, query } from '../client.js';
import type { ConversationRole, FieldMappingRow, MappingKind } from '../types.js';

export interface NewFieldMapping {
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  mapping_kind: MappingKind;
  column_label?: string | null;
  role?: string | null;
  json_path: string;
  data_type?: string | null;
}

/** List all field mappings configured for a connection + workflow, oldest first. */
export async function listMappings(
  connectionId: string,
  workflowId: string,
): Promise<FieldMappingRow[]> {
  const result = await query<FieldMappingRow>(
    `SELECT * FROM field_mappings
     WHERE n8n_connection_id = $1 AND n8n_workflow_id = $2
     ORDER BY created_at ASC`,
    [connectionId, workflowId],
  );
  return result.rows;
}

/** Insert a single field mapping and return the created row. */
export async function insertMapping(input: NewFieldMapping): Promise<FieldMappingRow> {
  const result = await query<FieldMappingRow>(
    `INSERT INTO field_mappings
       (tenant_id, n8n_connection_id, n8n_workflow_id, mapping_kind, column_label, role, json_path, data_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.tenant_id,
      input.n8n_connection_id,
      input.n8n_workflow_id,
      input.mapping_kind,
      input.column_label ?? null,
      input.role ?? null,
      input.json_path,
      input.data_type ?? null,
    ],
  );
  return firstRowOrThrow(result, 'insertMapping');
}

// ---- 'column' mappings: workflow-scoped custom columns -------------------

/** A custom-column mapping (mapping_kind='column'), keyed by tenant + workflow. */
export interface ColumnMappingRow {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  node_name: string | null;
  column_label: string | null;
  json_path: string;
  data_type: string | null;
  created_at: Date;
}

const COLUMN_MAPPING_COLUMNS =
  'id, tenant_id, n8n_workflow_id, node_name, column_label, json_path, data_type, created_at';

export interface InsertColumnMappingInput {
  tenantId: string;
  n8nWorkflowId: string;
  nodeName: string;
  columnLabel: string;
  jsonPath: string;
  dataType?: string | null;
}

/** Insert a 'column' mapping (n8n_connection_id stays NULL — keyed by tenant+workflow). */
export async function insertColumnMapping(
  input: InsertColumnMappingInput,
): Promise<ColumnMappingRow> {
  const result = await query<ColumnMappingRow>(
    `INSERT INTO field_mappings
       (tenant_id, n8n_workflow_id, mapping_kind, node_name, column_label, json_path, data_type)
     VALUES ($1, $2, 'column', $3, $4, $5, $6)
     RETURNING ${COLUMN_MAPPING_COLUMNS}`,
    [
      input.tenantId,
      input.n8nWorkflowId,
      input.nodeName,
      input.columnLabel,
      input.jsonPath,
      input.dataType ?? null,
    ],
  );
  return firstRowOrThrow(result, 'insertColumnMapping');
}

/** List a workflow's custom columns for a tenant, oldest first. */
export async function listColumnMappings(params: {
  tenantId: string;
  n8nWorkflowId: string;
}): Promise<ColumnMappingRow[]> {
  const result = await query<ColumnMappingRow>(
    `SELECT ${COLUMN_MAPPING_COLUMNS}
       FROM field_mappings
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND mapping_kind = 'column'
      ORDER BY created_at ASC`,
    [params.tenantId, params.n8nWorkflowId],
  );
  return result.rows;
}

/** Delete a column mapping by id, tenant-scoped. Returns true if a row was removed. */
export async function deleteColumnMapping(params: {
  tenantId: string;
  id: string;
}): Promise<boolean> {
  const result = await query(
    `DELETE FROM field_mappings
      WHERE id = $1 AND tenant_id = $2 AND mapping_kind = 'column'`,
    [params.id, params.tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---- 'conversation' mappings: one per role per workflow ------------------

/** A conversation role mapping (mapping_kind='conversation'). */
export interface ConversationMappingRow {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  role: ConversationRole;
  node_name: string | null;
  column_label: string | null;
  json_path: string;
  data_type: string | null;
  created_at: Date;
}

const CONVERSATION_MAPPING_COLUMNS =
  'id, tenant_id, n8n_workflow_id, role, node_name, column_label, json_path, data_type, created_at';

/** List a workflow's conversation role mappings for a tenant. */
export async function listConversationMappings(params: {
  tenantId: string;
  n8nWorkflowId: string;
}): Promise<ConversationMappingRow[]> {
  const result = await query<ConversationMappingRow>(
    `SELECT ${CONVERSATION_MAPPING_COLUMNS}
       FROM field_mappings
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND mapping_kind = 'conversation'
      ORDER BY role`,
    [params.tenantId, params.n8nWorkflowId],
  );
  return result.rows;
}

export interface UpsertConversationMappingInput {
  tenantId: string;
  n8nWorkflowId: string;
  role: ConversationRole;
  nodeName: string;
  jsonPath: string;
  label?: string | null;
  dataType?: string | null;
}

/**
 * Upsert one role's mapping (replace-on-role) via the partial unique index on
 * (tenant_id, n8n_workflow_id, role) WHERE mapping_kind='conversation'.
 */
export async function upsertConversationMapping(
  input: UpsertConversationMappingInput,
): Promise<ConversationMappingRow> {
  const result = await query<ConversationMappingRow>(
    `INSERT INTO field_mappings
       (tenant_id, n8n_workflow_id, mapping_kind, role, node_name, column_label, json_path, data_type)
     VALUES ($1, $2, 'conversation', $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, n8n_workflow_id, role) WHERE mapping_kind = 'conversation'
     DO UPDATE SET
       node_name = EXCLUDED.node_name,
       column_label = EXCLUDED.column_label,
       json_path = EXCLUDED.json_path,
       data_type = EXCLUDED.data_type
     RETURNING ${CONVERSATION_MAPPING_COLUMNS}`,
    [
      input.tenantId,
      input.n8nWorkflowId,
      input.role,
      input.nodeName,
      input.label ?? null,
      input.jsonPath,
      input.dataType ?? null,
    ],
  );
  return firstRowOrThrow(result, 'upsertConversationMapping');
}

/** Delete one role's mapping (tenant-scoped). Returns true if a row was removed. */
export async function deleteConversationMapping(params: {
  tenantId: string;
  n8nWorkflowId: string;
  role: ConversationRole;
}): Promise<boolean> {
  const result = await query(
    `DELETE FROM field_mappings
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND role = $3 AND mapping_kind = 'conversation'`,
    [params.tenantId, params.n8nWorkflowId, params.role],
  );
  return (result.rowCount ?? 0) > 0;
}
