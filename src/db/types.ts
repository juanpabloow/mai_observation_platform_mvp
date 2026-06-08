/**
 * Row shapes mirroring the database schema (see migrations/).
 * `snake_case` field names intentionally match the columns so query results map
 * directly onto these types.
 */

export interface TenantRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** An n8n instance we poll (base url + encrypted key). */
export interface N8nConnectionRow {
  id: string;
  tenant_id: string;
  name: string;
  n8n_base_url: string;
  n8n_api_key_encrypted: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A platform-managed logical group of workflows (no connection details). */
export interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

/** A workflow synced from n8n, optionally assigned to one client. */
export interface WorkflowRow {
  id: string;
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  name: string | null;
  client_id: string | null;
  active: boolean | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExecutionRow {
  id: string;
  tenant_id: string;
  n8n_connection_id: string;
  n8n_execution_id: string;
  n8n_workflow_id: string;
  workflow_name: string | null;
  status: string;
  mode: string | null;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: number | null;
  raw_data: unknown | null;
  ingested_at: Date;
}

/** Discriminator for a field mapping. */
export type MappingKind = 'column' | 'conversation';

/** Recognised roles when `mapping_kind = 'conversation'`. */
export type ConversationRole =
  | 'conversation_id'
  | 'user_message'
  | 'ai_response'
  | 'contact_name'
  | 'timestamp';

export interface FieldMappingRow {
  id: string;
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  mapping_kind: MappingKind;
  column_label: string | null;
  role: string | null;
  json_path: string;
  data_type: string | null;
  created_at: Date;
}

export interface IngestionStateRow {
  n8n_connection_id: string;
  tenant_id: string;
  last_seen_execution_id: string | null;
  last_polled_at: Date | null;
  last_successful_poll_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
}
