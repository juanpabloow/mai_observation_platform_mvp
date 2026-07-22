"use server";

import { revalidatePath } from "next/cache";
import { getCurrentTenantId } from "./tenant";
import { requireFullAccessForAction } from "./access";
import { DEFAULT_SCHEDULING_CONFIG, type SchedulingConfig, type WeeklyHours } from "@worker/scheduling/types.js";
import { localWallClockToUtc } from "@worker/scheduling/timezone.js";
import {
  createSite,
  deactivateSite,
  getSiteById,
  updateSite,
} from "@worker/db/repositories/scheduling/sites.js";
import { createStaff, deactivateStaff, updateStaff } from "@worker/db/repositories/scheduling/staff.js";
import {
  createService,
  deactivateService,
  removeStaffService,
  setSiteService,
  setStaffService,
  updateService,
} from "@worker/db/repositories/scheduling/services.js";
import { createException, deleteException } from "@worker/db/repositories/scheduling/exceptions.js";

/**
 * Owner/admin CRUD for the scheduling resource model (sites, services, staff,
 * enablements, exceptions). Every action gates on requireFullAccessForAction() and
 * scopes to the session tenant; the repos validate ownership so a foreign id can
 * never take effect. Sites/services/staff are SOFT-deleted (deactivated) to
 * preserve appointment history.
 */

export type AdminResult = { ok: true; id?: string } | { ok: false; error: string };

function revalidateAdmin(): void {
  revalidatePath("/scheduling/admin");
  revalidatePath("/scheduling/agenda");
}

// ── Sites ──────────────────────────────────────────────────────────────────────

export async function createSiteAction(input: {
  clientId: string;
  slug: string;
  name: string;
  address?: string;
  timezone: string;
  openingHours: WeeklyHours;
  schedulingConfig?: Partial<SchedulingConfig>;
}): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  if (!input.clientId) return { ok: false, error: "A business (client) is required." };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.slug)) {
    return { ok: false, error: "Slug must be lowercase letters, numbers and hyphens." };
  }
  try {
    const site = await createSite({
      tenantId,
      clientId: input.clientId,
      slug: input.slug,
      name: input.name.trim(),
      address: input.address ?? null,
      timezone: input.timezone,
      openingHours: input.openingHours,
      schedulingConfig: { ...DEFAULT_SCHEDULING_CONFIG, ...input.schedulingConfig },
    });
    revalidateAdmin();
    return { ok: true, id: site.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create site (slug may be taken).") };
  }
}

export async function updateSiteAction(
  id: string,
  patch: { name?: string; address?: string; timezone?: string; openingHours?: WeeklyHours; schedulingConfig?: SchedulingConfig; active?: boolean },
): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const row = await updateSite(tenantId, id, patch);
  if (!row) return { ok: false, error: "Site not found." };
  revalidateAdmin();
  return { ok: true, id };
}

export async function deactivateSiteAction(id: string): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const ok = await deactivateSite(tenantId, id);
  if (!ok) return { ok: false, error: "Site not found or already inactive." };
  revalidateAdmin();
  return { ok: true };
}

// ── Services ─────────────────────────────────────────────────────────────────

export async function createServiceAction(input: {
  name: string;
  description?: string;
  durationMin: number;
  price?: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  siteIds?: string[];
}): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (!(input.durationMin > 0)) return { ok: false, error: "Duration must be positive." };
  const svc = await createService({
    tenantId,
    name: input.name.trim(),
    description: input.description ?? null,
    durationMin: input.durationMin,
    price: input.price ?? null,
    bufferBeforeMin: input.bufferBeforeMin ?? 0,
    bufferAfterMin: input.bufferAfterMin ?? 0,
  });
  for (const siteId of input.siteIds ?? []) {
    await setSiteService(tenantId, siteId, svc.id);
  }
  revalidateAdmin();
  return { ok: true, id: svc.id };
}

export async function updateServiceAction(
  id: string,
  patch: { name?: string; description?: string; durationMin?: number; price?: number | null; bufferBeforeMin?: number; bufferAfterMin?: number; active?: boolean },
): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const row = await updateService(tenantId, id, patch);
  if (!row) return { ok: false, error: "Service not found." };
  revalidateAdmin();
  return { ok: true, id };
}

export async function deactivateServiceAction(id: string): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const ok = await deactivateService(tenantId, id);
  if (!ok) return { ok: false, error: "Service not found or already inactive." };
  revalidateAdmin();
  return { ok: true };
}

export async function setSiteServiceAction(siteId: string, serviceId: string, active: boolean): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  await setSiteService(tenantId, siteId, serviceId, { active });
  revalidateAdmin();
  return { ok: true };
}

// ── Staff ──────────────────────────────────────────────────────────────────────

export async function createStaffAction(input: {
  siteId: string;
  name: string;
  workingHours?: WeeklyHours;
  serviceIds?: string[];
}): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  try {
    const st = await createStaff({ tenantId, siteId: input.siteId, name: input.name.trim(), workingHours: input.workingHours });
    for (const serviceId of input.serviceIds ?? []) {
      await setStaffService(tenantId, st.id, serviceId);
    }
    revalidateAdmin();
    return { ok: true, id: st.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create staff.") };
  }
}

export async function updateStaffAction(
  id: string,
  patch: { name?: string; workingHours?: WeeklyHours; active?: boolean },
): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const row = await updateStaff(tenantId, id, patch);
  if (!row) return { ok: false, error: "Staff not found." };
  revalidateAdmin();
  return { ok: true, id };
}

export async function deactivateStaffAction(id: string): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const ok = await deactivateStaff(tenantId, id);
  if (!ok) return { ok: false, error: "Staff not found or already inactive." };
  revalidateAdmin();
  return { ok: true };
}

export async function setStaffServiceAction(staffId: string, serviceId: string, enabled: boolean): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  if (enabled) await setStaffService(tenantId, staffId, serviceId, { active: true });
  else await removeStaffService(tenantId, staffId, serviceId);
  revalidateAdmin();
  return { ok: true };
}

// ── Exceptions ───────────────────────────────────────────────────────────────

export async function createExceptionAction(input: {
  siteId: string;
  staffId?: string | null;
  /** Local wall-clock "YYYY-MM-DDTHH:MM" as typed — interpreted in the SITE tz. */
  startsAt: string;
  endsAt: string;
  reason?: string;
}): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  // Anchor the entered wall-clock to the SITE's timezone (not the browser's).
  const site = await getSiteById(tenantId, input.siteId);
  if (!site) return { ok: false, error: "Site not found." };
  let s: Date;
  let e: Date;
  try {
    s = localWallClockToUtc(input.startsAt, site.timezone);
    e = localWallClockToUtc(input.endsAt, site.timezone);
  } catch {
    return { ok: false, error: "Invalid dates." };
  }
  if (e.getTime() <= s.getTime()) return { ok: false, error: "End must be after start." };
  try {
    const row = await createException({ tenantId, siteId: input.siteId, staffId: input.staffId ?? null, startsAt: s, endsAt: e, reason: input.reason ?? undefined });
    revalidateAdmin();
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create exception.") };
  }
}

export async function deleteExceptionAction(id: string): Promise<AdminResult> {
  await requireFullAccessForAction();
  const tenantId = await getCurrentTenantId();
  const ok = await deleteException(tenantId, id);
  if (!ok) return { ok: false, error: "Exception not found." };
  revalidateAdmin();
  return { ok: true };
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
