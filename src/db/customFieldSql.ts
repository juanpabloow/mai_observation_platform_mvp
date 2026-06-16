import { METADATA_NODE_NAME } from '../n8n/executionData.js';

/**
 * ============================================================================
 * THE SEAM — the SOLE place that knows how to turn a custom field (node_name +
 * json_path) into a SQL expression that extracts its value from executions.raw_data.
 *
 * Every custom-field FILTER and SORT routes through here. We currently implement
 * "Approach A": extract the value live from the raw_data JSONB at query time. To
 * switch to "Approach B" (a denormalized/indexed column for custom values), change
 * ONLY this file — the executions repo, the page, and the URL contract stay put.
 *
 * SAFETY (injection): nothing user- or mapping-derived is ever concatenated into
 * SQL. The node name + json path become a BOUND text[] path parameter ($N); the
 * only literal SQL is fixed structure (the JSONB operators + the static unwrap
 * jsonpath). `rawDataCol` is a TRUSTED caller-supplied column reference (e.g.
 * 'e.raw_data'), never user input. Filter VALUES are bound too (see conditions).
 *
 * CONSISTENCY: this reproduces parseExecution/unwrapNodeData so a filter/sort
 * targets the SAME value the custom COLUMN displays (10c). For a node field the
 * displayed value is `unwrapNodeData(runData[node][0].data)` then the dotted
 * path; in raw_data (the full n8n envelope) that is:
 *   resultData.runData[<node>][0].data -> {<connKey>: [[items]]}  (one conn key)
 *   -> the single connection's value ($.* )  -> [0][0].json  (items[0].json)
 *   -> the dotted json_path.
 * The metadata pseudo-node (__metadata__) reads data.resultData.metadata instead
 * of runData, matching extractMapping's metadata branch.
 *
 * KNOWN LIMITATION (refine HERE if needed): the single-item unwrap ([0][0].json)
 * covers our fields (triggers/metadata emit one item). Multi-item node outputs
 * (output is an array of jsons) are not specially handled yet — change this one
 * function if that case arises.
 * ============================================================================
 */

export type CustomFilterOperator = 'equals' | 'contains' | 'not_empty';

export const CUSTOM_FILTER_OPERATORS: readonly CustomFilterOperator[] = [
  'equals',
  'contains',
  'not_empty',
];

/** Whitelist guard — the operator is validated, NEVER interpolated. */
export function isCustomFilterOperator(value: string): value is CustomFilterOperator {
  return (CUSTOM_FILTER_OPERATORS as readonly string[]).includes(value);
}

export interface CustomFieldRef {
  /** Real node name, or METADATA_NODE_NAME for the execution-metadata pseudo-node. */
  nodeName: string | null;
  /** Dotted path relative to the node's UNWRAPPED output (numeric seg = index). */
  jsonPath: string;
}

/**
 * SQL TEXT expression that extracts the field's value from `rawDataCol`. Pushes
 * its bound path parameter(s) onto `params` and references them by $N. Returns
 * text (#>>), so comparisons are plain text — exactly the value the column shows.
 */
export function customFieldValueExpr(
  field: CustomFieldRef,
  rawDataCol: string,
  params: unknown[],
): string {
  const segments = field.jsonPath.split('.').filter((s) => s.length > 0);

  if (field.nodeName === METADATA_NODE_NAME) {
    // data.resultData.metadata.<dotted> — no node/envelope/unwrap.
    params.push(['resultData', 'metadata', ...segments]);
    return `${rawDataCol} #>> $${params.length}::text[]`;
  }

  // 1) navigate to the node's `data` envelope (node name is a BOUND path element)
  params.push(['resultData', 'runData', field.nodeName ?? '', '0', 'data']);
  const envParam = params.length;
  // 2) dotted path within the unwrapped json (BOUND text[])
  params.push(segments);
  const pathParam = params.length;

  // jsonb_path_query_first(..., '$.*') = the single connection key's value (lax,
  // so a missing/odd shape yields NULL, not an error). '{0,0,json}' = items[0].json.
  return `(jsonb_path_query_first(${rawDataCol} #> $${envParam}::text[], '$.*') #> '{0,0,json}') #>> $${pathParam}::text[]`;
}

/**
 * A WHERE condition for one custom-field filter. The operator is whitelisted; the
 * value is BOUND. Returns a SQL boolean fragment; pushes its params onto `params`.
 */
export function customFilterCondition(
  field: CustomFieldRef,
  operator: CustomFilterOperator,
  value: string | undefined,
  rawDataCol: string,
  params: unknown[],
): string {
  const valueExpr = customFieldValueExpr(field, rawDataCol, params);

  switch (operator) {
    case 'equals':
      params.push(value ?? '');
      return `(${valueExpr}) = $${params.length}`;
    case 'contains':
      // Case-insensitive LITERAL substring (the user's text is taken literally —
      // % / _ are NOT wildcards — and is a bound param, never concatenated).
      params.push(value ?? '');
      return `position(lower($${params.length}) in lower(${valueExpr})) > 0`;
    case 'not_empty':
      // exists AND non-empty (the value expr is reused; its path params are bound once)
      return `(${valueExpr}) IS NOT NULL AND (${valueExpr}) <> ''`;
  }
}

/** ORDER BY expression for a custom-field sort — same seam, so sort matches display. */
export function customSortExpr(field: CustomFieldRef, rawDataCol: string, params: unknown[]): string {
  return customFieldValueExpr(field, rawDataCol, params);
}
