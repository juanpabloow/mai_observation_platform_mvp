import { query } from '../client.js';

/**
 * Custom-field DEFINITIONS per client (the CRM analogue of workflow field mappings).
 * Owner/admin define fields; contact writes validate their `custom_fields` blob against
 * these on every write (unknown key / wrong type → 422). `key` is immutable once
 * created; `label`, `options`, `position`, `enabled` are editable. `type` is immutable
 * too (changing it would strand stored values).
 */

export type FieldType = 'text' | 'number' | 'date' | 'select' | 'boolean';
export const FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'date', 'select', 'boolean'];

export interface FieldDefinition {
  id: string;
  tenant_id: string;
  client_id: string;
  entity: 'contact';
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  position: number;
  enabled: boolean;
}

export async function listFieldDefinitions(
  tenantId: string,
  clientId: string,
  opts: { entity?: 'contact'; enabledOnly?: boolean } = {},
): Promise<FieldDefinition[]> {
  const params: unknown[] = [tenantId, clientId, opts.entity ?? 'contact'];
  let where = 'tenant_id=$1 AND client_id=$2 AND entity=$3';
  if (opts.enabledOnly) where += ' AND enabled = true';
  const r = await query<FieldDefinition>(
    `SELECT * FROM client_field_definitions WHERE ${where} ORDER BY position ASC, created_at ASC`,
    params,
  );
  return r.rows;
}

/** `key` matches identifier rules; immutable + unique per (client, entity). */
const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

export async function createFieldDefinition(input: {
  tenantId: string;
  clientId: string;
  key: string;
  label: string;
  type: FieldType;
  options?: string[] | null;
  position?: number;
}): Promise<{ ok: true; def: FieldDefinition } | { ok: false; error: string }> {
  if (!KEY_RE.test(input.key)) return { ok: false, error: 'key must be lowercase letters/numbers/underscore, starting with a letter' };
  if (!FIELD_TYPES.includes(input.type)) return { ok: false, error: 'invalid type' };
  if (!input.label.trim()) return { ok: false, error: 'label required' };
  const options = input.type === 'select' ? (input.options ?? []).map((o) => String(o).trim()).filter(Boolean) : null;
  if (input.type === 'select' && (!options || options.length === 0)) return { ok: false, error: 'select needs at least one option' };
  try {
    const r = await query<FieldDefinition>(
      `INSERT INTO client_field_definitions (tenant_id, client_id, entity, key, label, type, options, position)
         VALUES ($1,$2,'contact',$3,$4,$5,$6,$7) RETURNING *`,
      [input.tenantId, input.clientId, input.key, input.label.trim(), input.type, options ? JSON.stringify(options) : null, input.position ?? 0],
    );
    return { ok: true, def: r.rows[0] };
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
      return { ok: false, error: 'a field with that key already exists' };
    }
    throw err;
  }
}

/** Edit the mutable attributes only (never key or type). */
export async function updateFieldDefinition(
  tenantId: string,
  clientId: string,
  id: string,
  patch: { label?: string; options?: string[] | null; position?: number; enabled?: boolean },
): Promise<FieldDefinition | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId, clientId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col}=$${params.length}`);
  };
  if (patch.label !== undefined) add('label', patch.label.trim());
  if (patch.options !== undefined) {
    params.push(patch.options ? JSON.stringify(patch.options) : null);
    sets.push(`options=$${params.length}::jsonb`);
  }
  if (patch.position !== undefined) add('position', patch.position);
  if (patch.enabled !== undefined) add('enabled', patch.enabled);
  if (sets.length === 0) return null;
  sets.push('updated_at=now()');
  const r = await query<FieldDefinition>(
    `UPDATE client_field_definitions SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

/**
 * Validate a `custom_fields` blob against the (enabled) definitions. Unknown key or
 * wrong type → error (the caller returns 422). Empty/null values CLEAR the field (are
 * dropped from the stored blob). Returns the clean, validated object to store.
 */
export function validateCustomFieldValues(
  defs: FieldDefinition[],
  values: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, error: 'custom_fields must be an object' };
  }
  const byKey = new Map(defs.filter((d) => d.enabled).map((d) => [d.key, d]));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const def = byKey.get(k);
    if (!def) return { ok: false, error: `unknown custom field: ${k}` };
    if (v === null || v === undefined || v === '') continue; // clear
    switch (def.type) {
      case 'text':
        if (typeof v !== 'string') return { ok: false, error: `${k} must be text` };
        out[k] = v;
        break;
      case 'number':
        if (typeof v !== 'number' || Number.isNaN(v)) return { ok: false, error: `${k} must be a number` };
        out[k] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, error: `${k} must be true/false` };
        out[k] = v;
        break;
      case 'date':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return { ok: false, error: `${k} must be a date` };
        out[k] = v;
        break;
      case 'select':
        if (typeof v !== 'string' || !(def.options ?? []).includes(v)) return { ok: false, error: `${k} must be one of its options` };
        out[k] = v;
        break;
    }
  }
  return { ok: true, value: out };
}
