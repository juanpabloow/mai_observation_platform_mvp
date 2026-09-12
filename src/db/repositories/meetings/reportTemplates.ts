import { query, withTransaction } from '../../client.js';
import type { Queryable } from './types.js';

/**
 * Las plantillas de reporte y su historial.
 *
 * Todo acotado por tenant y cliente, siempre, aunque el `id` sea un uuid único
 * — el mismo criterio que el resto del módulo: un uuid de otro cliente no debe
 * existir aquí ni tras una refactorización.
 *
 * ── Versionar es una operación TRANSACCIONAL ───────────────────────────────
 *
 * Editar una plantilla son dos escrituras que no pueden separarse: subir la
 * versión vigente y anotar la fila de auditoría. Si sólo ocurriera la primera,
 * habría una versión 3 sin constancia de quién la escribió; si sólo la segunda,
 * un historial que miente sobre lo que la pantalla muestra. Van en la misma
 * transacción.
 *
 * ── Y con testigo, para no perder ediciones ────────────────────────────────
 *
 * `version` es además el testigo de concurrencia. El UPDATE exige la versión que
 * el editor creía estar editando: si otra persona guardó primero, no coinciden,
 * no se actualiza ninguna fila y la llamada falla LIMPIAMENTE en vez de
 * sobrescribir. Es la diferencia entre «tu cambio no se guardó, vuelve a
 * mirarlo» y perder el trabajo de otro en silencio.
 */

const q = (executor?: Queryable) => executor ?? { query };

export type TemplateChangeKind = 'create' | 'edit' | 'restore';

export interface TemplateRow {
  id: string;
  tenant_id: string;
  client_id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  version: number;
  is_builtin: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by_user_id: string | null;
}

const COLUMNAS = `id, tenant_id, client_id, slug, name, description, instructions,
                  version, is_builtin, created_at, updated_at, updated_by_user_id`;

export interface TemplateVersionRow {
  template_id: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  change_kind: TemplateChangeKind;
  changed_by_user_id: string | null;
  changed_at: Date;
}

/** Las plantillas de un cliente, por slug. */
export async function listForClient(
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<TemplateRow[]> {
  const r = await q(executor).query<TemplateRow>(
    `SELECT ${COLUMNAS} FROM meeting_report_templates
      WHERE tenant_id = $1 AND client_id = $2
      ORDER BY slug ASC`,
    [tenantId, clientId],
  );
  return r.rows;
}

export async function findByIdScoped(
  id: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<TemplateRow | null> {
  const r = await q(executor).query<TemplateRow>(
    `SELECT ${COLUMNAS} FROM meeting_report_templates
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

export interface SeedInput {
  readonly tenantId: string;
  readonly clientId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly userId: string | null;
}

/**
 * Materializa las plantillas predeterminadas que falten, sin tocar las que ya
 * estén.
 *
 * `ON CONFLICT DO NOTHING` sobre `(tenant_id, client_id, slug)`: dos pestañas
 * abiertas a la vez entran las dos y ninguna duplica ni sobrescribe una
 * plantilla ya editada. Es idempotente por construcción, que es lo que permite
 * llamarlo en cada lectura del catálogo sin pensarlo.
 *
 * La versión 1 se anota en el historial en la MISMA transacción, para que
 * ninguna plantilla exista sin constancia de su origen.
 */
export async function seedMissing(inputs: readonly SeedInput[]): Promise<TemplateRow[]> {
  if (inputs.length === 0) return [];
  return withTransaction(async (client) => {
    const creadas: TemplateRow[] = [];
    for (const input of inputs) {
      const r = await client.query<TemplateRow>(
        `INSERT INTO meeting_report_templates
           (tenant_id, client_id, slug, name, description, instructions,
            version, is_builtin, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,true,$7)
         ON CONFLICT (tenant_id, client_id, slug) DO NOTHING
         RETURNING ${COLUMNAS}`,
        [
          input.tenantId, input.clientId, input.slug, input.name,
          input.description, input.instructions, input.userId,
        ],
      );
      const fila = r.rows[0];
      if (!fila) continue;
      await client.query(
        `INSERT INTO meeting_report_template_versions
           (template_id, version, tenant_id, client_id, name, description, instructions,
            change_kind, changed_by_user_id)
         VALUES ($1,1,$2,$3,$4,$5,$6,'create',$7)
         ON CONFLICT (template_id, version) DO NOTHING`,
        [
          fila.id, input.tenantId, input.clientId, input.name,
          input.description, input.instructions, input.userId,
        ],
      );
      creadas.push(fila);
    }
    return creadas;
  });
}

export interface WriteVersionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly clientId: string;
  /** La versión que el editor creía estar editando. El testigo. */
  readonly expectedVersion: number;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly changeKind: 'edit' | 'restore';
  readonly userId: string | null;
}

export type WriteVersionResult =
  | { readonly ok: true; readonly row: TemplateRow }
  /** La plantilla cambió por debajo: hay que releerla y reintentar. */
  | { readonly ok: false; readonly reason: 'stale'; readonly current: TemplateRow | null };

/**
 * Sube la versión y anota la auditoría, atómicamente y con testigo.
 *
 * El `WHERE … AND version = $expected` es lo que convierte la pérdida
 * silenciosa en un fallo explícito. No se reintenta aquí a propósito: quien
 * reintente tiene que volver a LEER, porque el texto que quería guardar se
 * escribió sobre una versión que ya no existe y mezclarlos a ciegas es
 * exactamente el daño que esto evita.
 */
export async function writeNewVersion(input: WriteVersionInput): Promise<WriteVersionResult> {
  return withTransaction(async (client) => {
    const actualizado = await client.query<TemplateRow>(
      `UPDATE meeting_report_templates
          SET name = $5, description = $6, instructions = $7,
              version = version + 1, updated_at = now(), updated_by_user_id = $8
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND version = $4
        RETURNING ${COLUMNAS}`,
      [
        input.id, input.tenantId, input.clientId, input.expectedVersion,
        input.name, input.description, input.instructions, input.userId,
      ],
    );
    const fila = actualizado.rows[0];
    if (!fila) {
      const current = await client.query<TemplateRow>(
        `SELECT ${COLUMNAS} FROM meeting_report_templates
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
        [input.id, input.tenantId, input.clientId],
      );
      return { ok: false, reason: 'stale', current: current.rows[0] ?? null };
    }

    await client.query(
      `INSERT INTO meeting_report_template_versions
         (template_id, version, tenant_id, client_id, name, description, instructions,
          change_kind, changed_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        fila.id, fila.version, input.tenantId, input.clientId, fila.name,
        fila.description, fila.instructions, input.changeKind, input.userId,
      ],
    );
    return { ok: true, row: fila };
  });
}

/** El historial de una plantilla, de la versión más nueva a la más vieja. */
export async function listVersions(
  templateId: string,
  tenantId: string,
  clientId: string,
  executor?: Queryable,
): Promise<TemplateVersionRow[]> {
  const r = await q(executor).query<TemplateVersionRow>(
    `SELECT template_id, version, name, description, instructions,
            change_kind, changed_by_user_id, changed_at
       FROM meeting_report_template_versions
      WHERE template_id = $1 AND tenant_id = $2 AND client_id = $3
      ORDER BY version DESC`,
    [templateId, tenantId, clientId],
  );
  return r.rows;
}
