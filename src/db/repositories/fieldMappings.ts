import { firstRowOrThrow, query } from '../client.js';
import type { FieldMappingRow, MappingKind } from '../types.js';

export interface NewFieldMapping {
  client_id: string;
  n8n_workflow_id: string;
  mapping_kind: MappingKind;
  column_label?: string | null;
  role?: string | null;
  json_path: string;
  data_type?: string | null;
}

/** List all field mappings configured for a client + workflow, oldest first. */
export async function listMappings(
  clientId: string,
  workflowId: string,
): Promise<FieldMappingRow[]> {
  const result = await query<FieldMappingRow>(
    `SELECT * FROM field_mappings
     WHERE client_id = $1 AND n8n_workflow_id = $2
     ORDER BY created_at ASC`,
    [clientId, workflowId],
  );
  return result.rows;
}

/** Insert a single field mapping and return the created row. */
export async function insertMapping(input: NewFieldMapping): Promise<FieldMappingRow> {
  const result = await query<FieldMappingRow>(
    `INSERT INTO field_mappings
       (client_id, n8n_workflow_id, mapping_kind, column_label, role, json_path, data_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.client_id,
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
