import { query, firstRowOrThrow } from '../../client.js';

/**
 * Staff certifications — a barber's credentials, one row each.
 *
 * A separate table rather than another text[] beside `skills` because a certification
 * has DATES: "Wella Master Colorist, expires March" is operationally different from
 * "Wella Master Colorist", and a tag cannot say which.
 *
 * Not PII in the sense the contact columns are (a credential is something a shop
 * advertises), so there is no split projection here — but every read is still
 * tenant-scoped, and the composite FK on (staff_id, tenant_id) means a row physically
 * cannot point at another tenant's staff.
 */

export interface StaffCertificationRow {
  id: string;
  tenant_id: string;
  staff_id: string;
  name: string;
  issuer: string | null;
  issued_on: Date | null;
  /** NULL = does not expire. Expiry is compared at read time, never stored as a flag. */
  expires_on: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLS = `id, tenant_id, staff_id, name, issuer, issued_on, expires_on, created_at, updated_at`;

/** Every certification for a set of staff, in one query — the roster needs them all
 *  at once and N+1 over a shop's barbers is a query per row for no reason. */
export async function listStaffCertifications(
  tenantId: string,
  staffIds: string[],
): Promise<Map<string, StaffCertificationRow[]>> {
  const out = new Map<string, StaffCertificationRow[]>();
  if (staffIds.length === 0) return out;
  const r = await query<StaffCertificationRow>(
    `SELECT ${COLS} FROM staff_certifications
      WHERE tenant_id = $1 AND staff_id = ANY($2::uuid[])
      ORDER BY expires_on NULLS LAST, name`,
    [tenantId, staffIds],
  );
  for (const row of r.rows) {
    const list = out.get(row.staff_id) ?? [];
    list.push(row);
    out.set(row.staff_id, list);
  }
  return out;
}

export interface CreateStaffCertificationInput {
  tenantId: string;
  staffId: string;
  name: string;
  issuer?: string | null;
  /** ISO yyyy-mm-dd. */
  issuedOn?: string | null;
  expiresOn?: string | null;
}

/** The INSERT is guarded in SQL: the staff member must exist in THIS tenant, so a
 *  forged staff_id writes nothing instead of creating an orphan. */
export async function createStaffCertification(
  input: CreateStaffCertificationInput,
): Promise<StaffCertificationRow> {
  const r = await query<StaffCertificationRow>(
    `INSERT INTO staff_certifications (tenant_id, staff_id, name, issuer, issued_on, expires_on)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE EXISTS (SELECT 1 FROM staff WHERE id = $2 AND tenant_id = $1)
     RETURNING ${COLS}`,
    [
      input.tenantId,
      input.staffId,
      input.name.trim(),
      input.issuer?.trim() || null,
      input.issuedOn || null,
      input.expiresOn || null,
    ],
  );
  if (!r.rows[0]) throw new Error('createStaffCertification: staff not found for tenant');
  return firstRowOrThrow(r, 'createStaffCertification');
}

/** Hard delete: a certification entered by mistake has no history worth keeping. */
export async function deleteStaffCertification(tenantId: string, id: string): Promise<boolean> {
  const r = await query(`DELETE FROM staff_certifications WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return (r.rowCount ?? 0) > 0;
}
