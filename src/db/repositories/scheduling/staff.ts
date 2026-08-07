import { query, firstRowOrThrow } from '../../client.js';
import type { WeeklyHours } from '../../../scheduling/types.js';
import { matchByName, type NameMatch } from '../../../scheduling/nameMatch.js';

/**
 * Staff repository — agendable resources (a barber), each belonging to exactly one
 * site in V1. working_hours = {} means "inherit the site's opening hours".
 * Tenant-scoped throughout.
 *
 * ── PII: WHY THERE IS NO `SELECT *` IN THIS FILE ────────────────────────────────
 * `staff` now carries employee personal data (phone, email, emergency contact). This
 * repository is read by surfaces at very different trust levels — the PUBLIC booking
 * API, machine-API tokens, the operator UI — so "remember to project only what you
 * need" at each call site is one forgotten `...s` away from publishing an employee's
 * phone number on a booking page.
 *
 * So the projection is the permission. There are exactly two shapes:
 *   StaffRow      — the OPERATIONAL row. What every existing caller already gets, plus
 *                   the non-sensitive new fields. Selected via STAFF_COLS, an explicit
 *                   list that CANNOT pick up a PII column, today or after the next
 *                   migration. This is the default: no caller opts out of it.
 *   StaffAdminRow — StaffRow + the PII. Returned ONLY by the two functions suffixed
 *                   `...Admin`, which must be called behind the owner/admin gate
 *                   (requireFullAccessOrLand / requireFullAccessForAction). Nothing in
 *                   the public or machine API imports them, and a source-level test
 *                   (test/unit/staffPiiContract.test.ts) fails the build if that changes.
 *
 * TypeScript then does the rest of the work: a route holding a StaffRow has no `.phone`
 * to leak, so exposure requires deliberately switching to the admin read.
 */

/** The operational projection — every staff column EXCEPT the personal ones. */
const STAFF_COLS = `s.id, s.tenant_id, s.site_id, s.name, s.working_hours, s.active,
       s.title, s.employment_type, s.weekly_hours, s.start_date,
       COALESCE(s.skills, '{}') AS skills, s.takes_bookings,
       s.created_at, s.updated_at`;
/** The same list for queries with no `s` alias. */
const STAFF_COLS_BARE = STAFF_COLS.replace(/\bs\./g, '');
/** Appended to STAFF_COLS by the admin reads only. */
const STAFF_PII_COLS = `s.phone, s.email, s.emergency_contact_name, s.emergency_contact_phone`;

export interface StaffRow {
  id: string;
  tenant_id: string;
  site_id: string;
  name: string;
  working_hours: WeeklyHours;
  active: boolean;
  /** Free-text label ("Colour specialist"). NOT a permission — see the migration. */
  title: string | null;
  employment_type: EmploymentType | null;
  /** Contracted hours per week. The ROSTER's capacity still comes from working_hours;
   *  this is what the contract says, which is a different (and comparable) number. */
  weekly_hours: number | null;
  /** Seniority is DERIVED from this — never stored. */
  start_date: Date | null;
  /** Never null on the way out: the projection coalesces NULL to an empty array. */
  skills: string[];
  /** Works here AND has a chair. `active` is the harder state (no longer employed);
   *  a front-desk hire is active with takes_bookings = false. */
  takes_bookings: boolean;
  created_at: Date;
  updated_at: Date;
}

/** The closed set the CHECK constraint enforces. */
export type EmploymentType = 'full_time' | 'part_time' | 'contractor';

/**
 * StaffRow + employee personal data. Only ever produced by listStaffAdmin /
 * getStaffByIdAdmin. Do NOT widen a public or machine-API handler to accept this type
 * — reach for StaffRow instead.
 */
export interface StaffAdminRow extends StaffRow {
  phone: string | null;
  email: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}

export async function listStaff(
  tenantId: string,
  opts: { siteId?: string; includeInactive?: boolean; clientId?: string | null } = {},
): Promise<StaffRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['s.tenant_id = $1'];
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`s.site_id = $${params.length}`);
  }
  if (opts.clientId) {
    // Client scope flows through the site (staff belong to a site of a client).
    params.push(opts.clientId);
    where.push(`si.client_id = $${params.length}`);
  }
  if (!opts.includeInactive) where.push('s.active = true');
  const r = await query<StaffRow>(
    `SELECT ${STAFF_COLS} FROM staff s JOIN sites si ON si.id = s.site_id
      WHERE ${where.join(' AND ')} ORDER BY s.name`,
    params,
  );
  return r.rows;
}

export async function getStaffById(tenantId: string, id: string): Promise<StaffRow | null> {
  const r = await query<StaffRow>(
    `SELECT ${STAFF_COLS_BARE} FROM staff WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

// ── ADMIN READS (PII) ─────────────────────────────────────────────────────────
// The only two functions that project phone/email/emergency contact. Both are
// tenant-scoped like everything else here; the OWNER/ADMIN check is the caller's
// (requireFullAccessOrLand on a page, requireFullAccessForAction in a server action),
// because this layer has no session. Call them from nowhere else.

/** listStaff, plus the employee's personal data. Owner/admin surfaces only. */
export async function listStaffAdmin(
  tenantId: string,
  opts: { siteId?: string; includeInactive?: boolean; clientId?: string | null } = {},
): Promise<StaffAdminRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['s.tenant_id = $1'];
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`s.site_id = $${params.length}`);
  }
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`si.client_id = $${params.length}`);
  }
  if (!opts.includeInactive) where.push('s.active = true');
  const r = await query<StaffAdminRow>(
    `SELECT ${STAFF_COLS}, ${STAFF_PII_COLS} FROM staff s JOIN sites si ON si.id = s.site_id
      WHERE ${where.join(' AND ')} ORDER BY s.name`,
    params,
  );
  return r.rows;
}

/** getStaffById, plus the employee's personal data. Owner/admin surfaces only. */
export async function getStaffByIdAdmin(tenantId: string, id: string): Promise<StaffAdminRow | null> {
  const r = await query<StaffAdminRow>(
    `SELECT ${STAFF_COLS}, ${STAFF_PII_COLS} FROM staff s WHERE s.id = $1 AND s.tenant_id = $2`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

/** Active staff at a site who can perform a service. Hardened: requires a VALID
 * site (exists, active, in tenant), the service ENABLED at that site (site_services
 * active) and same-tenant/active, the staff belonging to that site+tenant, and an
 * active same-tenant staff_services row. Any inconsistent relation fails closed. */
export async function listStaffForService(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<StaffRow[]> {
  const r = await query<StaffRow>(
    `SELECT ${STAFF_COLS}
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id AND sv.active = true
       JOIN staff s
         ON s.site_id = si.id AND s.tenant_id = si.tenant_id AND s.active = true
       JOIN staff_services sts
         ON sts.staff_id = s.id AND sts.service_id = sv.id AND sts.tenant_id = si.tenant_id AND sts.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true
      ORDER BY s.id`,
    [tenantId, siteId, serviceId],
  );
  return r.rows;
}

/** Is `staffId` an ACTIVE staff member of this site (same tenant)? Used by the
 * machine API to 404 a staff_id filter that belongs to another site/client. */
export async function isActiveStaffOfSite(tenantId: string, siteId: string, staffId: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok FROM staff
      WHERE id = $3 AND tenant_id = $1 AND site_id = $2 AND active = true`,
    [tenantId, siteId, staffId],
  );
  return r.rows.length > 0;
}

/** Resolve a staff NAME (case/accent-insensitive) to its id, among the ACTIVE staff at
 * this site (the set that can take new bookings). Discriminated result → the route emits
 * not_found (valid names) or ambiguous_match (candidates), never a silent pick. Whether the
 * staff can perform the chosen service is validated downstream by the engine. */
export async function resolveStaffByNameAtSite(
  tenantId: string,
  siteId: string,
  name: string | null | undefined,
): Promise<NameMatch> {
  const rows = await listStaff(tenantId, { siteId });
  return matchByName(rows.map((r) => ({ id: r.id, name: r.name })), name);
}

/** Does `staffId` belong to this client (via its site), REGARDLESS of active state?
 * Used by the appointments-list filter to fail loudly on a fabricated/foreign staff_id
 * (§3) instead of returning an empty list. Historical reads must still resolve a
 * deactivated staff member, so this deliberately does NOT filter on active. */
export async function staffBelongsToClient(tenantId: string, clientId: string, staffId: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM staff s JOIN sites si ON si.id = s.site_id AND si.tenant_id = s.tenant_id
      WHERE s.id = $3 AND s.tenant_id = $1 AND si.client_id = $2`,
    [tenantId, clientId, staffId],
  );
  return r.rows.length > 0;
}

export interface CreateStaffInput {
  tenantId: string;
  siteId: string;
  name: string;
  workingHours?: WeeklyHours;
}

export async function createStaff(input: CreateStaffInput): Promise<StaffRow> {
  const r = await query<StaffRow>(
    // RETURNING the explicit list, not `*`: an INSERT is not a licence to hand PII
    // back to whoever called it. The profile fields are set by a follow-up update
    // through the owner/admin action, so creation stays exactly as narrow as it was.
    `INSERT INTO staff (tenant_id, site_id, name, working_hours)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = $2 AND tenant_id = $1)
     RETURNING ${STAFF_COLS_BARE}`,
    [input.tenantId, input.siteId, input.name, JSON.stringify(input.workingHours ?? {})],
  );
  if (!r.rows[0]) throw new Error('createStaff: site not found for tenant');
  return firstRowOrThrow(r, 'createStaff');
}

export interface UpdateStaffInput {
  name?: string;
  workingHours?: WeeklyHours;
  active?: boolean;
  siteId?: string;
  // ── Profile (all nullable in the schema; `null` CLEARS the field) ────────────
  title?: string | null;
  employmentType?: EmploymentType | null;
  weeklyHours?: number | null;
  /** ISO yyyy-mm-dd, or null. Seniority is derived from it at read time. */
  startDate?: string | null;
  skills?: string[];
  takesBookings?: boolean;
  // ── PII. Writable here, readable only through the ...Admin reads ─────────────
  phone?: string | null;
  email?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

export async function updateStaff(tenantId: string, id: string, patch: UpdateStaffInput): Promise<StaffRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.workingHours !== undefined) add('working_hours', JSON.stringify(patch.workingHours));
  if (patch.active !== undefined) add('active', patch.active);
  if (patch.siteId !== undefined) add('site_id', patch.siteId);
  if (patch.title !== undefined) add('title', emptyToNull(patch.title));
  if (patch.employmentType !== undefined) add('employment_type', patch.employmentType);
  if (patch.weeklyHours !== undefined) add('weekly_hours', patch.weeklyHours);
  if (patch.startDate !== undefined) add('start_date', emptyToNull(patch.startDate));
  // Tags: trimmed, blanks dropped, de-duplicated. An empty array stores '{}' (asked,
  // none) rather than NULL (never asked) — the distinction the column exists for.
  if (patch.skills !== undefined) {
    add('skills', [...new Set(patch.skills.map((s) => s.trim()).filter(Boolean))]);
  }
  if (patch.takesBookings !== undefined) add('takes_bookings', patch.takesBookings);
  if (patch.phone !== undefined) add('phone', emptyToNull(patch.phone));
  if (patch.email !== undefined) add('email', emptyToNull(patch.email));
  if (patch.emergencyContactName !== undefined) add('emergency_contact_name', emptyToNull(patch.emergencyContactName));
  if (patch.emergencyContactPhone !== undefined) add('emergency_contact_phone', emptyToNull(patch.emergencyContactPhone));
  if (sets.length === 0) return getStaffById(tenantId, id);
  sets.push('updated_at = now()');
  const r = await query<StaffRow>(
    `UPDATE staff SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING ${STAFF_COLS_BARE}`,
    params,
  );
  return r.rows[0] ?? null;
}

/** A cleared input arrives as "" from a form; the column's empty state is NULL. */
function emptyToNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

export async function deactivateStaff(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE staff SET active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = true`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The inverse of deactivateStaff — reactivation restores availability + new bookings
 * for this staff member with no data migration and no side effects. Returns true if a
 * staff member was reactivated (false if not found / already active). */
export async function reactivateStaff(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE staff SET active = true, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = false`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
