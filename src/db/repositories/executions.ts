import { query } from '../client.js';
import {
  customFilterCondition,
  customSortExpr,
  type CustomFilterOperator,
} from '../customFieldSql.js';
import { listColumnMappings } from './fieldMappings.js';

/** Input shape for inserting an execution. `raw_data` is any JSON-serialisable value. */
export interface NewExecution {
  tenant_id: string;
  n8n_connection_id: string;
  n8n_execution_id: string;
  n8n_workflow_id: string;
  workflow_name?: string | null;
  status: string;
  mode?: string | null;
  started_at: Date | string;
  stopped_at?: Date | string | null;
  duration_ms?: number | null;
  raw_data?: unknown;
}

// Column order used to build the multi-row INSERT. Only identifiers live in the
// SQL string; every value is bound as a $N parameter.
const INSERT_COLUMNS = [
  'tenant_id',
  'n8n_connection_id',
  'n8n_execution_id',
  'n8n_workflow_id',
  'workflow_name',
  'status',
  'mode',
  'started_at',
  'stopped_at',
  'duration_ms',
  'raw_data',
] as const;

/**
 * Insert many executions in one statement. Conflicts on
 * (n8n_connection_id, n8n_execution_id) are ignored (ON CONFLICT DO NOTHING) —
 * this is the idempotency guarantee for re-polling.
 *
 * @returns the internal UUIDs of the rows ACTUALLY inserted (excludes ignored
 * conflicts). The caller derives the inserted count from `.length` and uses the
 * ids to derive conversation turns for just-ingested executions.
 */
export async function upsertMany(executions: NewExecution[]): Promise<string[]> {
  if (executions.length === 0) {
    return [];
  }

  const params: unknown[] = [];
  const rowsSql: string[] = [];
  let p = 1;

  for (const e of executions) {
    const placeholders = INSERT_COLUMNS.map(() => `$${p++}`);
    rowsSql.push(`(${placeholders.join(', ')})`);
    params.push(
      e.tenant_id,
      e.n8n_connection_id,
      e.n8n_execution_id,
      e.n8n_workflow_id,
      e.workflow_name ?? null,
      e.status,
      e.mode ?? null,
      e.started_at,
      e.stopped_at ?? null,
      e.duration_ms ?? null,
      // Serialise explicitly so arrays/objects always land as JSONB (pg would
      // otherwise treat a top-level JS array as a Postgres array literal).
      e.raw_data === undefined || e.raw_data === null ? null : JSON.stringify(e.raw_data),
    );
  }

  const sql = `INSERT INTO executions (${INSERT_COLUMNS.join(', ')})
     VALUES ${rowsSql.join(', ')}
     ON CONFLICT (n8n_connection_id, n8n_execution_id) DO NOTHING
     RETURNING id`;

  // ON CONFLICT DO NOTHING + RETURNING returns only the rows that were inserted.
  const result = await query<{ id: string }>(sql, params);
  return result.rows.map((r) => r.id);
}

/** A row in the tenant-scoped executions list (joined to workflow + client). */
export interface ExecutionListItem {
  id: string;
  n8n_execution_id: string;
  status: string;
  mode: string | null;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: number | null;
  n8n_workflow_id: string;
  /** workflows.name, falling back to executions.workflow_name, then the raw id. */
  workflow_name: string;
  /** Assigned client's name, or null if the workflow is unassigned. */
  client_name: string | null;
}

/** Columns the list can be sorted by (whitelist — never interpolate raw input). */
export type ExecutionSortKey = 'started_at' | 'duration_ms' | 'status';
export type SortDirection = 'asc' | 'desc';

// Maps a validated sort key to a safe SQL column expression.
const SORT_COLUMNS: Record<ExecutionSortKey, string> = {
  started_at: 'e.started_at',
  duration_ms: 'e.duration_ms',
  status: 'e.status',
};

/** Type guard so callers can validate a raw query-param value. */
export function isExecutionSortKey(value: string): value is ExecutionSortKey {
  return value === 'started_at' || value === 'duration_ms' || value === 'status';
}

export interface ExecutionFilters {
  /** Exact status match (e.g. 'success', 'error'). Omit/undefined = all. */
  status?: string;
  /** Exact n8n_workflow_id match. */
  workflowId?: string;
  /** A client UUID, or the literal 'unassigned' (workflow with no client). */
  clientId?: string;
  /** Inclusive lower bound on started_at, as 'YYYY-MM-DD'. */
  fromDate?: string;
  /** Inclusive upper bound on started_at (whole day), as 'YYYY-MM-DD'. */
  toDate?: string;
}

export interface ExecutionSort {
  key: ExecutionSortKey;
  direction: SortDirection;
}

/**
 * A custom-field filter. The field is referenced by its field_mappings id (NOT a
 * raw node/path), so it is resolved tenant+workflow-scoped before any SQL is
 * built — a mappingId that isn't this tenant+workflow's is ignored, never trusted.
 */
export interface CustomFieldFilter {
  mappingId: string;
  operator: CustomFilterOperator;
  value?: string;
}

/** A custom-field sort, referenced (and validated) by field_mappings id. */
export interface CustomFieldSort {
  mappingId: string;
  direction: SortDirection;
}

export interface ListExecutionsPageParams {
  tenantId: string;
  limit: number;
  offset: number;
  filters?: ExecutionFilters;
  sort?: ExecutionSort;
  /** Custom-field filters (ANDed with each other + the fixed filters). */
  customFilters?: CustomFieldFilter[];
  /** Custom-field sort; when present + valid, replaces the fixed-column sort. */
  customSort?: CustomFieldSort;
}

export interface ExecutionsPage {
  rows: ExecutionListItem[];
  total: number;
}

/**
 * Fetch one page of executions for a tenant with optional filtering and sorting,
 * all applied in SQL (server-side, never client-side). `total` reflects the SAME
 * filters so pagination stays correct. Always tenant-scoped; never loads more
 * than `limit` rows. Backed by the (tenant_id, started_at DESC) index.
 */
export async function listExecutionsPage(
  params: ListExecutionsPageParams,
): Promise<ExecutionsPage> {
  const { tenantId, limit, offset, filters = {}, sort, customFilters = [], customSort } = params;

  // ONE growing bound-params array. Order in the rows query: WHERE params first
  // ($1..), then any custom-SORT params, then LIMIT/OFFSET — so the count query
  // (WHERE only) reuses exactly the leading prefix. Every value is a bound $N
  // parameter; nothing user/mapping-derived is concatenated into SQL.
  const queryParams: unknown[] = [tenantId]; // $1
  const conditions: string[] = ['e.tenant_id = $1'];

  if (filters.status && filters.status !== 'all') {
    queryParams.push(filters.status);
    conditions.push(`e.status = $${queryParams.length}`);
  }
  if (filters.workflowId) {
    queryParams.push(filters.workflowId);
    conditions.push(`e.n8n_workflow_id = $${queryParams.length}`);
  }
  if (filters.clientId) {
    if (filters.clientId === 'unassigned') {
      conditions.push('w.client_id IS NULL');
    } else {
      queryParams.push(filters.clientId);
      conditions.push(`w.client_id = $${queryParams.length}`);
    }
  }
  if (filters.fromDate) {
    queryParams.push(filters.fromDate);
    conditions.push(`e.started_at >= $${queryParams.length}::timestamptz`);
  }
  if (filters.toDate) {
    queryParams.push(filters.toDate);
    conditions.push(`e.started_at < ($${queryParams.length}::timestamptz + INTERVAL '1 day')`);
  }

  // Resolve custom-field mappings TENANT+WORKFLOW-SCOPED (only when needed and a
  // workflow is in scope). A mappingId that isn't in this set is silently ignored
  // — it never reaches the seam, so no SQL is ever built from an unvalidated id.
  const wantsCustom = customFilters.length > 0 || customSort != null;
  const customCols =
    wantsCustom && filters.workflowId
      ? new Map(
          (await listColumnMappings({ tenantId, n8nWorkflowId: filters.workflowId })).map((c) => [
            c.id,
            { nodeName: c.node_name, jsonPath: c.json_path },
          ]),
        )
      : new Map<string, { nodeName: string | null; jsonPath: string }>();

  for (const cf of customFilters) {
    const field = customCols.get(cf.mappingId);
    if (!field) continue;
    conditions.push(customFilterCondition(field, cf.operator, cf.value, 'e.raw_data', queryParams));
  }

  const whereSql = conditions.join(' AND ');
  const whereParamCount = queryParams.length; // count query binds exactly these

  // ORDER BY — a valid custom sort (resolvable mapping) replaces the fixed sort.
  let orderSql: string;
  const sortField = customSort ? customCols.get(customSort.mappingId) : undefined;
  if (customSort && sortField) {
    const expr = customSortExpr(sortField, 'e.raw_data', queryParams);
    const dir = customSort.direction === 'asc' ? 'ASC' : 'DESC';
    orderSql = `ORDER BY (${expr}) ${dir} NULLS LAST, e.n8n_execution_id DESC`;
  } else {
    const sortKey: ExecutionSortKey = sort?.key ?? 'started_at';
    const sortDir = sort?.direction === 'asc' ? 'ASC' : 'DESC';
    orderSql = `ORDER BY ${SORT_COLUMNS[sortKey]} ${sortDir} NULLS LAST, e.n8n_execution_id DESC`;
  }

  const fromJoin = `FROM executions e
     LEFT JOIN workflows w
       ON w.n8n_connection_id = e.n8n_connection_id
      AND w.n8n_workflow_id = e.n8n_workflow_id
     LEFT JOIN clients c ON c.id = w.client_id`;

  queryParams.push(limit);
  const limitParam = queryParams.length;
  queryParams.push(offset);
  const offsetParam = queryParams.length;

  const rowsSql = `SELECT
       e.id,
       e.n8n_execution_id,
       e.status,
       e.mode,
       e.started_at,
       e.stopped_at,
       e.duration_ms,
       e.n8n_workflow_id,
       COALESCE(w.name, e.workflow_name, e.n8n_workflow_id) AS workflow_name,
       c.name AS client_name
     ${fromJoin}
     WHERE ${whereSql}
     ${orderSql}
     LIMIT $${limitParam} OFFSET $${offsetParam}`;

  const countSql = `SELECT COUNT(*)::text AS count ${fromJoin} WHERE ${whereSql}`;

  const [rowsResult, totalResult] = await Promise.all([
    query<ExecutionListItem>(rowsSql, queryParams),
    query<{ count: string }>(countSql, queryParams.slice(0, whereParamCount)),
  ]);

  return {
    rows: rowsResult.rows,
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}

/**
 * Raw payloads of the most recent executions for a workflow (tenant-scoped,
 * newest first). Used to sample available fields for the column picker.
 */
export async function listRecentRawForWorkflow(params: {
  tenantId: string;
  n8nWorkflowId: string;
  limit: number;
}): Promise<Array<{ raw_data: unknown }>> {
  const result = await query<{ raw_data: unknown }>(
    `SELECT raw_data
       FROM executions
      WHERE tenant_id = $1 AND n8n_workflow_id = $2
      ORDER BY started_at DESC, n8n_execution_id DESC
      LIMIT $3`,
    [params.tenantId, params.n8nWorkflowId, params.limit],
  );
  return result.rows;
}

/**
 * Fetch raw_data for a specific set of execution ids (tenant-scoped). Used to
 * extract custom-column values for ONLY the executions on the current page —
 * never the whole table.
 */
export async function getRawDataByIds(params: {
  tenantId: string;
  ids: string[];
}): Promise<Array<{ id: string; raw_data: unknown }>> {
  if (params.ids.length === 0) {
    return [];
  }
  const result = await query<{ id: string; raw_data: unknown }>(
    `SELECT id, raw_data FROM executions
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [params.tenantId, params.ids],
  );
  return result.rows;
}

/**
 * The minimal execution shape needed to derive a conversation turn: the internal
 * id (turn FK + upsert key), workflow + tenant (to load mappings), the raw
 * payload (to extract fields), and started_at (the turn timestamp).
 */
export interface ExecutionForDerivation {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  started_at: Date;
  raw_data: unknown;
}

const DERIVATION_COLUMNS = 'id, tenant_id, n8n_workflow_id, started_at, raw_data';

/**
 * Fetch executions for turn derivation by their internal ids (tenant-scoped).
 * Used by the derive-on-ingest worker step for ONLY the just-ingested rows.
 */
export async function getExecutionsForDerivationByIds(params: {
  tenantId: string;
  ids: string[];
}): Promise<ExecutionForDerivation[]> {
  if (params.ids.length === 0) {
    return [];
  }
  const result = await query<ExecutionForDerivation>(
    `SELECT ${DERIVATION_COLUMNS} FROM executions
      WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [params.tenantId, params.ids],
  );
  return result.rows;
}

/**
 * One keyset page of a workflow's executions for turn derivation (tenant-scoped),
 * ordered by id ASC. Pass the previous page's last id as `afterId` to continue.
 * Ordering is by id (a stable, total order) because backfill only needs to visit
 * every row once — not chronologically.
 */
export async function listExecutionsForDerivationPage(params: {
  tenantId: string;
  n8nWorkflowId: string;
  afterId: string | null;
  limit: number;
}): Promise<ExecutionForDerivation[]> {
  const conditions = ['tenant_id = $1', 'n8n_workflow_id = $2'];
  const values: unknown[] = [params.tenantId, params.n8nWorkflowId];
  if (params.afterId) {
    conditions.push(`id > $${values.length + 1}::uuid`);
    values.push(params.afterId);
  }
  const result = await query<ExecutionForDerivation>(
    `SELECT ${DERIVATION_COLUMNS} FROM executions
      WHERE ${conditions.join(' AND ')}
      ORDER BY id ASC
      LIMIT $${values.length + 1}`,
    [...values, params.limit],
  );
  return result.rows;
}

/** Full execution row including the raw payload, for the detail view. */
export interface ExecutionDetailRow extends ExecutionListItem {
  raw_data: unknown | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch a single execution (with raw_data) by its internal UUID, but ONLY if it
 * belongs to the given tenant — otherwise null. Callers should treat null as
 * "not found" without distinguishing "doesn't exist" from "not yours". A
 * malformed (non-UUID) id returns null without touching the database.
 */
export async function getExecutionByIdForTenant(params: {
  tenantId: string;
  id: string;
}): Promise<ExecutionDetailRow | null> {
  const { tenantId, id } = params;
  if (!UUID_RE.test(id)) {
    return null;
  }
  const result = await query<ExecutionDetailRow>(
    `SELECT
       e.id,
       e.n8n_execution_id,
       e.status,
       e.mode,
       e.started_at,
       e.stopped_at,
       e.duration_ms,
       e.n8n_workflow_id,
       COALESCE(w.name, e.workflow_name, e.n8n_workflow_id) AS workflow_name,
       c.name AS client_name,
       e.raw_data
     FROM executions e
     LEFT JOIN workflows w
       ON w.n8n_connection_id = e.n8n_connection_id
      AND w.n8n_workflow_id = e.n8n_workflow_id
     LEFT JOIN clients c ON c.id = w.client_id
     WHERE e.id = $1 AND e.tenant_id = $2`,
    [id, tenantId],
  );
  return result.rows[0] ?? null;
}
