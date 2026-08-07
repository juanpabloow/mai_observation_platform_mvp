"use server";

import { revalidatePath } from "next/cache";
import { requireFullAccessForAction } from "./access";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { DEFAULT_SCHEDULING_CONFIG, type SchedulingConfig, type WeeklyHours } from "@worker/scheduling/types.js";
import { localWallClockToUtc } from "@worker/scheduling/timezone.js";
import {
  createSite,
  deactivateSite,
  getSiteById,
  reactivateSite,
  updateSite,
} from "@worker/db/repositories/scheduling/sites.js";
import {
  createStaff,
  deactivateStaff,
  getStaffById,
  reactivateStaff,
  updateStaff,
} from "@worker/db/repositories/scheduling/staff.js";
import {
  createService,
  deactivateService,
  getServiceById,
  reactivateService,
  removeStaffService,
  setSiteService,
  setStaffService,
  updateService,
  parseServiceCategory,
} from "@worker/db/repositories/scheduling/services.js";
import { countUpcomingAppointmentsForResource } from "@worker/db/repositories/scheduling/appointments.js";
import {
  createException,
  deleteException,
  getExceptionById,
} from "@worker/db/repositories/scheduling/exceptions.js";

/**
 * Owner/admin CRUD for a SINGLE CLIENT's scheduling resource model (sites, staff,
 * the client's OWN service catalogue, per-site enablement, exceptions). Services now
 * belong to the client (services.client_id) — never shared across clients. Every
 * action is validated FOUR ways,
 * in this order, before any mutation:
 *   1. owner/admin              — requireFullAccessForAction (throws for a member);
 *   2. tenant + client of route — resolveClientModuleContext (the URL clientId is
 *      validated against the session's tenant + access scope);
 *   3. non-default client       — the Unassigned client can't have scheduling;
 *   4. scheduling ENABLED       — the module must be on for that client.
 * Then the TARGET resource (site/staff/exception) must belong to that client — a
 * forged id from another client is rejected, so there is NO cross-client admin.
 * Soft-delete (deactivate) preserves appointment history.
 */

export type AdminResult = { ok: true; id?: string } | { ok: false; error: string };

/** Steps 1–4. Returns the validated tenantId, or a generic error (never revealing
 * which condition failed — matches the module gate's indistinguishable denials). */
async function requireSchedulingAdmin(
  clientId: string,
): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  await requireFullAccessForAction(); // owner/admin only — throws for a member
  const res = await resolveClientModuleContext(clientId, "scheduling");
  if (!res.ok) return { ok: false, error: "Scheduling isn’t available for this client." };
  return { ok: true, tenantId: res.context.scope.tenantId };
}

/** The target SITE must belong to this client (tenant-scoped). */
async function siteInClient(tenantId: string, clientId: string, siteId: string): Promise<boolean> {
  const s = await getSiteById(tenantId, siteId);
  return !!s && s.client_id === clientId;
}
/** The target STAFF's site must belong to this client. */
async function staffInClient(tenantId: string, clientId: string, staffId: string): Promise<boolean> {
  const st = await getStaffById(tenantId, staffId);
  return !!st && (await siteInClient(tenantId, clientId, st.site_id));
}

const FOREIGN = "Not found for this client.";

function revalidateAdmin(clientId: string): void {
  revalidatePath(`/clients/${clientId}/scheduling/admin`);
  revalidatePath(`/clients/${clientId}/scheduling/agenda`);
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
  const auth = await requireSchedulingAdmin(input.clientId);
  if (!auth.ok) return auth;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(input.slug)) {
    return { ok: false, error: "Slug must be lowercase letters, numbers and hyphens." };
  }
  try {
    const site = await createSite({
      tenantId: auth.tenantId,
      clientId: input.clientId, // the VALIDATED route client — never a form selector
      slug: input.slug,
      name: input.name.trim(),
      address: input.address ?? null,
      timezone: input.timezone,
      openingHours: input.openingHours,
      schedulingConfig: { ...DEFAULT_SCHEDULING_CONFIG, ...input.schedulingConfig },
    });
    revalidateAdmin(input.clientId);
    return { ok: true, id: site.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create site (slug may be taken).") };
  }
}

export async function updateSiteAction(
  clientId: string,
  id: string,
  patch: { slug?: string; name?: string; address?: string; timezone?: string; openingHours?: WeeklyHours; schedulingConfig?: SchedulingConfig; active?: boolean },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await siteInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  // A bad scheduling_config value silently breaks availability, so validate it here.
  if (patch.schedulingConfig) {
    const cfg = sanitizeSchedulingConfig(patch.schedulingConfig);
    if (!cfg.ok) return { ok: false, error: cfg.error };
    patch = { ...patch, schedulingConfig: cfg.value };
  }
  const row = await updateSite(auth.tenantId, id, patch);
  if (!row) return { ok: false, error: "Site not found." };
  revalidateAdmin(clientId);
  return { ok: true, id };
}

export async function deactivateSiteAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await siteInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const ok = await deactivateSite(auth.tenantId, id);
  if (!ok) return { ok: false, error: "Site not found or already inactive." };
  revalidateAdmin(clientId);
  return { ok: true };
}

/** The inverse of deactivateSiteAction (3a). Owner/admin only, same client scoping. */
export async function activateSiteAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await siteInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const ok = await reactivateSite(auth.tenantId, id);
  if (!ok) return { ok: false, error: "Site not found or already active." };
  revalidateAdmin(clientId);
  return { ok: true };
}

// ── Services (this CLIENT's own catalogue, enabled per THIS client's sites) ─────

export async function createServiceAction(input: {
  clientId: string;
  name: string;
  description?: string;
  durationMin: number;
  price?: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  siteIds?: string[];
  /** Colour family. Anything unrecognised is stored as NULL rather than rejected —
   *  the agenda then falls back to inferring it from the name, which is the old
   *  behaviour, so a bad value degrades instead of failing a save. */
  category?: string | null;
}): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(input.clientId);
  if (!auth.ok) return auth;
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (!(input.durationMin > 0)) return { ok: false, error: "Duration must be positive." };
  // Every enablement target must be one of THIS client's sites.
  for (const siteId of input.siteIds ?? []) {
    if (!(await siteInClient(auth.tenantId, input.clientId, siteId))) return { ok: false, error: FOREIGN };
  }
  const svc = await createService({
    tenantId: auth.tenantId,
    clientId: input.clientId, // the VALIDATED route client — the service's owner
    name: input.name.trim(),
    description: input.description ?? null,
    durationMin: input.durationMin,
    price: input.price ?? null,
    bufferBeforeMin: input.bufferBeforeMin ?? 0,
    bufferAfterMin: input.bufferAfterMin ?? 0,
    category: parseServiceCategory(input.category),
  });
  for (const siteId of input.siteIds ?? []) {
    await setSiteService(auth.tenantId, siteId, svc.id);
  }
  revalidateAdmin(input.clientId);
  return { ok: true, id: svc.id };
}

export async function updateServiceAction(
  clientId: string,
  id: string,
  patch: { name?: string; description?: string; durationMin?: number; price?: number | null; bufferBeforeMin?: number; bufferAfterMin?: number; active?: boolean; featured?: boolean; category?: string | null },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  // `category` is pulled OUT of the spread so the raw string never reaches the
  // repository: absent = not in the patch, present = narrowed to a storable family
  // (or NULL, which means "go back to inferring it from the name").
  const { category, ...rest } = patch;
  const row = await updateService(auth.tenantId, clientId, id, {
    ...rest,
    ...(category !== undefined ? { category: parseServiceCategory(category) } : {}),
  });
  if (!row) return { ok: false, error: "Service not found." };
  revalidateAdmin(clientId);
  return { ok: true, id };
}

export async function deactivateServiceAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const ok = await deactivateService(auth.tenantId, clientId, id);
  if (!ok) return { ok: false, error: "Service not found or already inactive." };
  revalidateAdmin(clientId);
  return { ok: true };
}

/** The inverse of deactivateServiceAction (3a). Owner/admin only, same client scoping. */
export async function activateServiceAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const ok = await reactivateService(auth.tenantId, clientId, id);
  if (!ok) return { ok: false, error: "Service not found or already active." };
  revalidateAdmin(clientId);
  return { ok: true };
}

export async function setSiteServiceAction(
  clientId: string,
  siteId: string,
  serviceId: string,
  active: boolean,
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await siteInClient(auth.tenantId, clientId, siteId))) return { ok: false, error: FOREIGN };
  await setSiteService(auth.tenantId, siteId, serviceId, { active });
  revalidateAdmin(clientId);
  return { ok: true };
}

// ── Staff ──────────────────────────────────────────────────────────────────────

export async function createStaffAction(input: {
  clientId: string;
  siteId: string;
  name: string;
  workingHours?: WeeklyHours;
  serviceIds?: string[];
}): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(input.clientId);
  if (!auth.ok) return auth;
  if (!input.name.trim()) return { ok: false, error: "Name is required." };
  if (!(await siteInClient(auth.tenantId, input.clientId, input.siteId))) return { ok: false, error: FOREIGN };
  try {
    const st = await createStaff({ tenantId: auth.tenantId, siteId: input.siteId, name: input.name.trim(), workingHours: input.workingHours });
    for (const serviceId of input.serviceIds ?? []) {
      await setStaffService(auth.tenantId, st.id, serviceId);
    }
    revalidateAdmin(input.clientId);
    return { ok: true, id: st.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create staff.") };
  }
}

export async function updateStaffAction(
  clientId: string,
  id: string,
  patch: { name?: string; workingHours?: WeeklyHours; active?: boolean },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const row = await updateStaff(auth.tenantId, id, patch);
  if (!row) return { ok: false, error: "Staff not found." };
  revalidateAdmin(clientId);
  return { ok: true, id };
}

export async function deactivateStaffAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const ok = await deactivateStaff(auth.tenantId, id);
  if (!ok) return { ok: false, error: "Staff not found or already inactive." };
  revalidateAdmin(clientId);
  return { ok: true };
}

/** The inverse of deactivateStaffAction (3a). Owner/admin only, same client scoping. */
export async function activateStaffAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const ok = await reactivateStaff(auth.tenantId, id);
  if (!ok) return { ok: false, error: "Staff not found or already active." };
  revalidateAdmin(clientId);
  return { ok: true };
}

/**
 * The deactivation GUARD (3d): count FUTURE active appointments for a resource so the UI
 * can warn before deactivating ("Padre G has 3 upcoming appointments"). READ-ONLY — it
 * never blocks, cascades, or cancels. Owner/admin + client scoping like every action; a
 * forged/foreign id returns 0 (nothing to warn about) rather than leaking existence.
 */
export type UpcomingCountResult = { ok: true; count: number } | { ok: false; error: string };
export async function countUpcomingAppointmentsAction(
  clientId: string,
  kind: "staff" | "service" | "site",
  id: string,
): Promise<UpcomingCountResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const belongs =
    kind === "site"
      ? await siteInClient(auth.tenantId, clientId, id)
      : kind === "staff"
        ? await staffInClient(auth.tenantId, clientId, id)
        : !!(await getServiceById(auth.tenantId, clientId, id));
  if (!belongs) return { ok: true, count: 0 };
  const filter =
    kind === "site" ? { clientId, siteId: id } : kind === "staff" ? { clientId, staffId: id } : { clientId, serviceId: id };
  const count = await countUpcomingAppointmentsForResource(auth.tenantId, filter);
  return { ok: true, count };
}

export async function setStaffServiceAction(
  clientId: string,
  staffId: string,
  serviceId: string,
  enabled: boolean,
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, staffId))) return { ok: false, error: FOREIGN };
  // The service must belong to THIS client (per-client catalogue).
  if (enabled && !(await getServiceById(auth.tenantId, clientId, serviceId))) return { ok: false, error: FOREIGN };
  if (enabled) await setStaffService(auth.tenantId, staffId, serviceId, { active: true });
  else await removeStaffService(auth.tenantId, staffId, serviceId);
  revalidateAdmin(clientId);
  return { ok: true };
}

// ── Exceptions ───────────────────────────────────────────────────────────────

export async function createExceptionAction(input: {
  clientId: string;
  siteId: string;
  staffId?: string | null;
  /** Local wall-clock "YYYY-MM-DDTHH:MM" as typed — interpreted in the SITE tz. */
  startsAt: string;
  endsAt: string;
  reason?: string;
}): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(input.clientId);
  if (!auth.ok) return auth;
  // Anchor the entered wall-clock to the SITE's timezone (not the browser's), and
  // confirm the site belongs to this client in the same lookup.
  const site = await getSiteById(auth.tenantId, input.siteId);
  if (!site || site.client_id !== input.clientId) return { ok: false, error: FOREIGN };
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
    const row = await createException({ tenantId: auth.tenantId, siteId: input.siteId, staffId: input.staffId ?? null, startsAt: s, endsAt: e, reason: input.reason ?? undefined });
    revalidateAdmin(input.clientId);
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not create exception.") };
  }
}

export async function deleteExceptionAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  // The exception's site must belong to this client (a forged id → not found).
  const exc = await getExceptionById(auth.tenantId, id);
  if (!exc || !(await siteInClient(auth.tenantId, clientId, exc.site_id))) return { ok: false, error: FOREIGN };
  const ok = await deleteException(auth.tenantId, id);
  if (!ok) return { ok: false, error: "Exception not found." };
  revalidateAdmin(clientId);
  return { ok: true };
}

function errText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Validate + coerce a scheduling_config to safe integers (a bad value would silently
 * break availability). min_notice/buffers ≥ 0; slot_interval + booking_horizon ≥ 1; sane
 * upper bounds. Returns the sanitized config or a readable error. */
function sanitizeSchedulingConfig(
  c: SchedulingConfig,
): { ok: true; value: SchedulingConfig } | { ok: false; error: string } {
  const field = (label: string, v: unknown, min: number, max: number): number | null => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
    return n;
  };
  const slot = field("slot_interval_min", c.slot_interval_min, 1, 24 * 60);
  const notice = field("min_notice_min", c.min_notice_min, 0, 365 * 24 * 60);
  const horizon = field("booking_horizon_days", c.booking_horizon_days, 1, 365);
  const bBefore = field("default_buffer_before_min", c.default_buffer_before_min, 0, 24 * 60);
  const bAfter = field("default_buffer_after_min", c.default_buffer_after_min, 0, 24 * 60);
  if (slot === null) return { ok: false, error: "Slot granularity must be a whole number of minutes (1–1440)." };
  if (notice === null) return { ok: false, error: "Minimum notice must be a whole number of minutes (0 or more)." };
  if (horizon === null) return { ok: false, error: "Booking horizon must be a whole number of days (1–365)." };
  if (bBefore === null || bAfter === null) return { ok: false, error: "Buffers must be a whole number of minutes (0 or more)." };
  return { ok: true, value: { slot_interval_min: slot, min_notice_min: notice, booking_horizon_days: horizon, default_buffer_before_min: bBefore, default_buffer_after_min: bAfter } };
}
