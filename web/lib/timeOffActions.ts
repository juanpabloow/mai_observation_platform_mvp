"use server";

import { revalidatePath } from "next/cache";
import { canAccessClient, canManageClient } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { normalizeReason, normalizeTimeOff, type TimeOffInput } from "./timeOffValidation";
import { parsePublicReason } from "./publicAbsenceReason";
import { localWallClockToUtc } from "@worker/scheduling/timezone.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getStaffById } from "@worker/db/repositories/scheduling/staff.js";
import {
  createException,
  deleteException,
  getExceptionById,
  updateException,
} from "@worker/db/repositories/scheduling/exceptions.js";
import { listActiveAppointmentsOverlapping } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * TIME OFF — one-off blocks that remove availability WITHOUT editing the weekly schedule.
 * They are stored as `schedule_exceptions` rows (staff_id NULL = a SITE closure; non-null =
 * one staff member), so the availability engine subtracts them and EVERY write path (machine
 * create/reschedule, public booking, manual agenda booking) already refuses a slot inside a
 * block — no change to the booking engine.
 *
 * PERMISSIONS (server-side, the UI only hides controls):
 *   - STAFF time off (staff_id set): agency, Client Owner, OR Setter (canAccessClient — the
 *     Setter runs the agenda day to day: "Falla no viene hoy"). Staff logins are excluded.
 *   - SITE closures (staff_id null): agency or Client Owner only (canManageClient) — closing
 *     the whole site is a business decision.
 *
 * CONFLICTS: a new/edited block that overlaps booked appointments is NEVER created silently
 * and NEVER auto-cancels. The action returns the conflicting appointments; the caller decides
 * to keep them (pass confirm=true — they stay and the agenda flags them) or cancel each first.
 *
 * Times are entered as LOCAL wall-clock and anchored to the SITE timezone via the one tz
 * system (localWallClockToUtc). The reason is INTERNAL — it is stored but the machine API
 * never returns it. `publicReason` is the SEPARATE, explicit choice of what a customer may
 * be told (a controlled code, default none) — see web/lib/publicAbsenceReason.ts.
 */

export interface TimeOffConflict {
  id: string;
  staff_name: string | null;
  service_name: string;
  contact_name: string | null;
  start_at: string; // ISO UTC
  service_end_at: string; // ISO UTC
}

export type TimeOffResult =
  | { ok: true; id: string }
  | { ok: false; error: string }
  | { ok: false; conflicts: TimeOffConflict[] };

const UNAVAILABLE = "La agenda no está disponible para este cliente.";
const FORBIDDEN = "No tienes permiso para esta acción.";
const FOREIGN = "No encontrado para este cliente.";

type Scoped = { ok: true; tenantId: string } | { ok: false; error: string };

/** Gate: a SITE closure needs canManageClient (agency/owner); a STAFF block needs
 *  canAccessClient (agency/owner/setter, never staff). Both require the module on. */
async function requireTimeOff(clientId: string, siteWide: boolean): Promise<Scoped> {
  const res = await resolveClientModuleContext(clientId, "scheduling");
  if (!res.ok) return { ok: false, error: UNAVAILABLE };
  const scope = res.context.scope;
  const allowed = siteWide ? canManageClient(scope, clientId) : canAccessClient(scope, clientId);
  if (!allowed) return { ok: false, error: FORBIDDEN };
  return { ok: true, tenantId: scope.tenantId };
}

function toConflict(a: Awaited<ReturnType<typeof listActiveAppointmentsOverlapping>>[number]): TimeOffConflict {
  return {
    id: a.id,
    staff_name: a.staff_name,
    service_name: a.service_name,
    contact_name: a.contact_name,
    start_at: a.start_at.toISOString(),
    service_end_at: a.service_end_at.toISOString(),
  };
}

function revalidate(clientId: string): void {
  revalidatePath(`/clients/${clientId}/scheduling/agenda`);
  revalidatePath(`/clients/${clientId}/scheduling/hours`);
  revalidatePath(`/clients/${clientId}/scheduling/exceptions`);
  revalidatePath(`/clients/${clientId}/scheduling/staff`);
}

export interface WriteTimeOffInput {
  clientId: string;
  siteId: string;
  staffId?: string | null;
  /** LOCAL wall-clock "YYYY-MM-DDTHH:MM" — anchored to the SITE timezone here. */
  startLocal: string;
  endLocal: string;
  reason?: string | null;
  /** What a customer may be told — a controlled code, or null (the default: nothing). */
  publicReason?: string | null;
  /** Keep overlapping appointments (they stay; the agenda flags them as conflicting). */
  confirm?: boolean;
}

/**
 * MF-1 item 7 — THE single writer of a time-off block (schedule_exceptions) and its rules:
 * tiered permissions (SITE closure = canManageClient; STAFF block = canAccessClient),
 * site/staff ownership checks, tz anchoring, and the conflict flow. Both createTimeOffAction
 * (the structured TimeOffForm) and the legacy schedulingAdminActions.createExceptionAction
 * adapter route through this, so there is exactly one writer with one set of rules.
 */
export async function writeTimeOff(input: WriteTimeOffInput): Promise<TimeOffResult> {
  const siteWide = !input.staffId;
  const auth = await requireTimeOff(input.clientId, siteWide);
  if (!auth.ok) return auth;
  const publicReason = parsePublicReason(input.publicReason, siteWide ? "site" : "staff");
  if (!publicReason.ok) return { ok: false, error: publicReason.error };

  const site = await getSiteById(auth.tenantId, input.siteId);
  if (!site || site.client_id !== input.clientId) return { ok: false, error: FOREIGN };
  if (input.staffId) {
    const st = await getStaffById(auth.tenantId, input.staffId);
    if (!st || st.site_id !== input.siteId) return { ok: false, error: FOREIGN };
  }

  let startsAt: Date;
  let endsAt: Date;
  try {
    startsAt = localWallClockToUtc(input.startLocal, site.timezone);
    endsAt = localWallClockToUtc(input.endLocal, site.timezone);
  } catch {
    return { ok: false, error: "Fechas inválidas." };
  }
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "El fin debe ser después del inicio." };

  // Conflict flow: surface overlapping appointments unless the caller already confirmed.
  if (!input.confirm) {
    const overlapping = await listActiveAppointmentsOverlapping(auth.tenantId, {
      clientId: input.clientId,
      siteId: input.siteId,
      staffId: input.staffId ?? null,
      from: startsAt,
      to: endsAt,
    });
    if (overlapping.length > 0) return { ok: false, conflicts: overlapping.map(toConflict) };
  }

  const row = await createException({
    tenantId: auth.tenantId,
    siteId: input.siteId,
    staffId: input.staffId ?? null,
    startsAt,
    endsAt,
    reason: normalizeReason(input.reason),
    publicReason: publicReason.value,
  });
  revalidate(input.clientId);
  return { ok: true, id: row.id };
}

export async function createTimeOffAction(
  input: {
    clientId: string;
    siteId: string;
    staffId?: string | null;
    reason?: string | null;
    /** What a customer may be told — a controlled code, or null (the default: nothing). */
    publicReason?: string | null;
    /** Keep overlapping appointments (they stay; the agenda flags them as conflicting). */
    confirm?: boolean;
  } & TimeOffInput,
): Promise<TimeOffResult> {
  const shape = normalizeTimeOff(input);
  if (!shape.ok) return { ok: false, error: shape.error };
  return writeTimeOff({
    clientId: input.clientId,
    siteId: input.siteId,
    staffId: input.staffId ?? null,
    startLocal: shape.startLocal,
    endLocal: shape.endLocal,
    reason: input.reason,
    publicReason: input.publicReason,
    confirm: input.confirm,
  });
}

export async function updateTimeOffAction(
  clientId: string,
  id: string,
  patch: { reason?: string | null; publicReason?: string | null; confirm?: boolean } & TimeOffInput,
): Promise<TimeOffResult> {
  // Resolve the block first (tenant-scoped) via the owning client's scope to learn its
  // site + staff scope, then gate by that scope.
  const ctx = await resolveClientModuleContext(clientId, "scheduling");
  if (!ctx.ok) return { ok: false, error: UNAVAILABLE };
  const tenantId = ctx.context.scope.tenantId;
  const block = await getExceptionById(tenantId, id);
  if (!block) return { ok: false, error: FOREIGN };
  const site = await getSiteById(tenantId, block.site_id);
  if (!site || site.client_id !== clientId) return { ok: false, error: FOREIGN };

  const siteWide = block.staff_id === null;
  const auth = await requireTimeOff(clientId, siteWide);
  if (!auth.ok) return auth;
  // Past blocks are history (read-only).
  if (block.ends_at.getTime() <= Date.now()) return { ok: false, error: "Un bloqueo pasado no se puede editar." };
  // Omitted = keep what the block has; an explicit value (or "") replaces it.
  const publicReason = patch.publicReason === undefined ? null : parsePublicReason(patch.publicReason, siteWide ? "site" : "staff");
  if (publicReason && !publicReason.ok) return { ok: false, error: publicReason.error };

  const shape = normalizeTimeOff(patch);
  if (!shape.ok) return { ok: false, error: shape.error };
  let startsAt: Date;
  let endsAt: Date;
  try {
    startsAt = localWallClockToUtc(shape.startLocal, site.timezone);
    endsAt = localWallClockToUtc(shape.endLocal, site.timezone);
  } catch {
    return { ok: false, error: "Fechas inválidas." };
  }
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "El fin debe ser después del inicio." };

  if (!patch.confirm) {
    const overlapping = await listActiveAppointmentsOverlapping(tenantId, {
      clientId,
      siteId: block.site_id,
      staffId: block.staff_id,
      from: startsAt,
      to: endsAt,
    });
    if (overlapping.length > 0) return { ok: false, conflicts: overlapping.map(toConflict) };
  }

  const row = await updateException(tenantId, id, {
    startsAt,
    endsAt,
    reason: normalizeReason(patch.reason),
    ...(publicReason ? { publicReason: publicReason.value } : {}),
  });
  if (!row) return { ok: false, error: FOREIGN };
  revalidate(clientId);
  return { ok: true, id };
}

export async function deleteTimeOffAction(clientId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await resolveClientModuleContext(clientId, "scheduling");
  if (!ctx.ok) return { ok: false, error: UNAVAILABLE };
  const tenantId = ctx.context.scope.tenantId;
  const block = await getExceptionById(tenantId, id);
  if (!block) return { ok: false, error: FOREIGN };
  const site = await getSiteById(tenantId, block.site_id);
  if (!site || site.client_id !== clientId) return { ok: false, error: FOREIGN };

  const auth = await requireTimeOff(clientId, block.staff_id === null);
  if (!auth.ok) return { ok: false, error: auth.error };
  // A past block is history; deleting it would rewrite the record. Keep it.
  if (block.ends_at.getTime() <= Date.now()) return { ok: false, error: "Un bloqueo pasado no se puede eliminar." };

  const ok = await deleteException(tenantId, id);
  if (!ok) return { ok: false, error: FOREIGN };
  revalidate(clientId);
  return { ok: true };
}
