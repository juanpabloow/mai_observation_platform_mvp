"use server";

import { revalidatePath } from "next/cache";
import { canManageClient } from "./access";
import { writeTimeOff, deleteTimeOffAction } from "./timeOffActions";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { normalizeServiceDescription } from "./serviceDescription";
import { checkPublicTitle, publicProfileMessage } from "./staffPublicProfile";
import { deleteLogo, isR2Configured, uploadServiceImage, uploadStaffPhoto } from "./r2";
import { DEFAULT_SCHEDULING_CONFIG, type SchedulingConfig, type WeeklyHours } from "@worker/scheduling/types.js";
import { localWallClockToUtc, utcToZonedParts } from "@worker/scheduling/timezone.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { dialingRegionForTimezone, normalizeE164 } from "@worker/scheduling/phone.js";
import { checkCategoryInput, checkIncludes, E164_RE, safeMapsUrl } from "./bookingPage";
import { checkPublicBio, checkPublicLine } from "./staffPublicProfile";
import {
  createPromotion,
  duplicatePromotion,
  getPromotion,
  listPromotionEvents,
  setPromotionImage,
  setPromotionStatus,
  updatePromotion,
  type PromotionInput,
  type WriteResult,
} from "@worker/db/repositories/scheduling/promotions.js";
import type { PromotionStatus } from "@worker/scheduling/promotions.js";
import {
  BookingCategoryNameTaken,
  createBookingCategory,
  deleteBookingCategory,
  setServiceImage,
  updateBookingCategory,
  updateServicePresentation,
} from "@worker/db/repositories/scheduling/bookingCategories.js";
import {
  createSite,
  deactivateSite,
  getSiteById,
  listSites,
  reactivateSite,
  updateSite,
} from "@worker/db/repositories/scheduling/sites.js";
import {
  activeStaffNameTaken,
  createStaff,
  deactivateStaff,
  getStaffById,
  reactivateStaff,
  updateStaff,
  type EmploymentType,
} from "@worker/db/repositories/scheduling/staff.js";
import {
  createStaffCertification,
  deleteStaffCertification,
} from "@worker/db/repositories/scheduling/staffCertifications.js";
import {
  createServiceWithSites,
  ServiceSiteLinkError,
  deactivateService,
  getServiceById,
  reactivateService,
  removeStaffService,
  setSiteService,
  setStaffService,
  updateService,
  parseServiceCategory,
} from "@worker/db/repositories/scheduling/services.js";
import { countUpcomingAppointmentsForResource, listAppointments } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * CLIENT-ADMIN CRUD for a SINGLE CLIENT's scheduling resource model (sites, staff, the
 * client's OWN service catalogue, per-site enablement, exceptions). Services belong to
 * the client (services.client_id) — never shared across clients. Every action is
 * validated in this order, before any mutation:
 *   1. tenant + client of route — resolveClientModuleContext (the URL clientId is
 *      validated against the session's tenant + access scope; non-default; module ON);
 *   2. client-admin capability  — canManageClient: the agency (owner/admin) OR this
 *      client's OWNER. An Editor or Staff login is refused (they operate the agenda but
 *      never configure it).
 * Then the TARGET resource (site/staff/exception) must belong to that client — a forged
 * id from another client is rejected, so there is NO cross-client admin. Soft-delete
 * (deactivate) preserves appointment history.
 */

export type AdminResult = { ok: true; id?: string } | { ok: false; error: string };

/** Steps 1–4. Returns the validated tenantId, or a generic error (never revealing
 * which condition failed — matches the module gate's indistinguishable denials). */
async function requireSchedulingAdmin(
  clientId: string,
): Promise<{ ok: true; tenantId: string; /** who is acting — for audit trails (promotion_events) */ userId: string } | { ok: false; error: string }> {
  const res = await resolveClientModuleContext(clientId, "scheduling");
  // Editors/Staff can reach the scheduling module but MUST NOT configure it — only the
  // client OWNER (or the agency) manages sites/services/staff/hours/rules.
  if (!res.ok || !canManageClient(res.context.scope, clientId)) {
    return { ok: false, error: "Scheduling isn’t available for this client." };
  }
  return { ok: true, tenantId: res.context.scope.tenantId, userId: res.context.scope.userId };
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
const DUP_STAFF_NAME = "Ya existe un profesional activo con ese nombre en esta sede.";

/** Mirrors the staff_employment_type_valid CHECK. */
const EMPLOYMENT_TYPES: readonly string[] = ["full_time", "part_time", "contractor"];

function revalidateAdmin(clientId: string): void {
  revalidatePath(`/clients/${clientId}/scheduling/admin`);
  revalidatePath(`/clients/${clientId}/scheduling/agenda`);
  // The roster moved to Team, so a staff edit has to invalidate that page too —
  // otherwise a saved profile keeps showing the old values until a hard reload.
  revalidatePath(`/clients/${clientId}/team`);
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
  patch: {
    slug?: string;
    name?: string;
    address?: string;
    timezone?: string;
    openingHours?: WeeklyHours;
    schedulingConfig?: SchedulingConfig;
    active?: boolean;
    /** Booking page contact (migration 1804). "" clears it. */
    publicWhatsapp?: string;
    publicMapsUrl?: string;
  },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await siteInClient(auth.tenantId, clientId, id))) return { ok: false, error: FOREIGN };
  const contact = validatePublicContact(patch, patch.timezone ?? (await getSiteById(auth.tenantId, id))?.timezone ?? "America/Bogota");
  if (!contact.ok) return { ok: false, error: contact.error };

  // A bad scheduling_config value silently breaks availability, so validate it here.
  if (patch.schedulingConfig) {
    const cfg = sanitizeSchedulingConfig(patch.schedulingConfig);
    if (!cfg.ok) return { ok: false, error: cfg.error };
    patch = { ...patch, schedulingConfig: cfg.value };
  }
  const row = await updateSite(auth.tenantId, id, {
    slug: patch.slug,
    name: patch.name,
    timezone: patch.timezone,
    openingHours: patch.openingHours,
    schedulingConfig: patch.schedulingConfig,
    active: patch.active,
    ...contact.value,
  });
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
  const desc = normalizeServiceDescription(input.description);
  if (!desc.ok) return { ok: false, error: desc.error };
  // Every enablement target must be one of THIS client's sites.
  for (const siteId of input.siteIds ?? []) {
    if (!(await siteInClient(auth.tenantId, input.clientId, siteId))) return { ok: false, error: FOREIGN };
  }
  // The service and its initial site links are ONE transaction: if any link fails the
  // whole create rolls back, so a retry can never leave a duplicate or an orphan. The
  // id is returned only after COMMIT.
  let svc;
  try {
    svc = await createServiceWithSites(
      {
        tenantId: auth.tenantId,
        clientId: input.clientId, // the VALIDATED route client — the service's owner
        name: input.name.trim(),
        description: desc.value,
        durationMin: input.durationMin,
        price: input.price ?? null,
        bufferBeforeMin: input.bufferBeforeMin ?? 0,
        bufferAfterMin: input.bufferAfterMin ?? 0,
        category: parseServiceCategory(input.category),
      },
      input.siteIds ?? [],
    );
  } catch (err) {
    if (err instanceof ServiceSiteLinkError) return { ok: false, error: FOREIGN };
    throw err;
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
  // `category` and `description` are pulled OUT of the spread so raw values never reach the
  // repository unvalidated: category is narrowed to a storable family (or NULL = infer from
  // name); description is trimmed, whitespace→NULL, and rejected over the shared limit (naming the
  // field). Absent = not in the patch (left unchanged).
  const { category, description, ...rest } = patch;
  let descriptionPatch: { description?: string | null } = {};
  if (description !== undefined) {
    const d = normalizeServiceDescription(description);
    if (!d.ok) return { ok: false, error: d.error };
    descriptionPatch = { description: d.value };
  }
  const row = await updateService(auth.tenantId, clientId, id, {
    ...rest,
    ...descriptionPatch,
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
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  if (!(await siteInClient(auth.tenantId, input.clientId, input.siteId))) return { ok: false, error: FOREIGN };
  // Display name must be unique among ACTIVE staff of the site (case-insensitive) — the bot
  // reads it to customers, so two active "Andrés" make the offer ambiguous.
  if (await activeStaffNameTaken(auth.tenantId, input.siteId, name)) return { ok: false, error: DUP_STAFF_NAME };
  try {
    const st = await createStaff({ tenantId: auth.tenantId, siteId: input.siteId, name, workingHours: input.workingHours });
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
  // The profile fields the Staff screen edits. PII (phone/email/emergency contact) is
  // WRITTEN here — behind the same owner/admin + client-scope gate as everything else —
  // but is only ever READ back through listStaffAdmin/getStaffByIdAdmin.
  patch: {
    name?: string;
    workingHours?: WeeklyHours;
    active?: boolean;
    title?: string | null;
    employmentType?: string | null;
    weeklyHours?: number | null;
    startDate?: string | null;
    skills?: string[];
    takesBookings?: boolean;
    phone?: string | null;
    email?: string | null;
    emergencyContactName?: string | null;
    emergencyContactPhone?: string | null;
    // PUBLIC profile shown on /book/{slug}. Plain text, content-checked below. The photo
    // has its own actions (uploadStaffPhotoAction / removeStaffPhotoAction).
    publicTitle?: string | null;
    publicBio?: string | null;
  },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const current = await getStaffById(auth.tenantId, id);
  if (!current || !(await siteInClient(auth.tenantId, clientId, current.site_id))) return { ok: false, error: FOREIGN };
  // Narrow what the CHECK constraints already restrict, so a bad value is a readable
  // error here instead of a 500 from Postgres. Same rule, stated twice on purpose.
  const { employmentType, weeklyHours, name, publicTitle, publicBio, ...rest } = patch;
  const publicPatch: { publicTitle?: string | null; publicBio?: string | null } = {};
  if (publicTitle !== undefined) {
    const r = checkPublicTitle(publicTitle);
    if (!r.ok) return { ok: false, error: publicProfileMessage(r.error, "Public title", r.max, "en") };
    publicPatch.publicTitle = r.value;
  }
  if (publicBio !== undefined) {
    const r = checkPublicBio(publicBio);
    if (!r.ok) return { ok: false, error: publicProfileMessage(r.error, "Public presentation", r.max, "en") };
    publicPatch.publicBio = r.value;
  }
  let namePatch: { name?: string } = {};
  if (name !== undefined) {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: "Name is required." };
    namePatch = { name: trimmed };
  }
  if (employmentType !== undefined && employmentType !== null && !EMPLOYMENT_TYPES.includes(employmentType)) {
    return { ok: false, error: "Unknown employment type." };
  }
  if (weeklyHours !== undefined && weeklyHours !== null && !(Number.isInteger(weeklyHours) && weeklyHours >= 1 && weeklyHours <= 168)) {
    return { ok: false, error: "Weekly hours must be between 1 and 168." };
  }
  // Uniqueness only binds ACTIVE staff: check the RESULTING name + active state (excluding
  // self), so a rename-into-a-namesake or a reactivation-into-a-namesake is refused, but a
  // no-op save or renaming a deactivated member is fine. Renaming is otherwise free —
  // appointments reference staff by id, never by the name.
  const resultingName = namePatch.name ?? current.name;
  const resultingActive = patch.active ?? current.active;
  if (resultingActive && (await activeStaffNameTaken(auth.tenantId, current.site_id, resultingName, id))) {
    return { ok: false, error: DUP_STAFF_NAME };
  }
  const row = await updateStaff(auth.tenantId, id, {
    ...rest,
    ...namePatch,
    ...publicPatch,
    ...(employmentType !== undefined ? { employmentType: employmentType as EmploymentType | null } : {}),
    ...(weeklyHours !== undefined ? { weeklyHours } : {}),
  });
  if (!row) return { ok: false, error: "Staff not found." };
  revalidateAdmin(clientId);
  return { ok: true, id };
}

/**
 * Upload (or replace) a professional's PUBLIC photo — shown on the booking page.
 * FormData { clientId, staffId, photo: File }. Same gate as every staff edit (client
 * owner/agency + module), the staff member must belong to the client, and the file is
 * validated by its bytes (PNG/JPEG/WebP) in uploadStaffPhoto. A replaced photo's old
 * object is deleted best-effort.
 */
export async function uploadStaffPhotoAction(formData: FormData): Promise<AdminResult & { url?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const staffId = String(formData.get("staffId") ?? "");
  const file = formData.get("photo");
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!isR2Configured) return { ok: false, error: "Photo upload is not configured." };
  if (!(file instanceof File)) return { ok: false, error: "No image selected." };
  const current = await getStaffById(auth.tenantId, staffId);
  if (!current || !(await siteInClient(auth.tenantId, clientId, current.site_id))) return { ok: false, error: FOREIGN };
  const up = await uploadStaffPhoto(auth.tenantId, clientId, staffId, file);
  if (!up.ok) return { ok: false, error: up.error };
  const row = await updateStaff(auth.tenantId, staffId, { publicPhotoUrl: up.url });
  if (!row) return { ok: false, error: "Staff not found." };
  if (current.public_photo_url && current.public_photo_url !== up.url) {
    try {
      await deleteLogo(current.public_photo_url);
    } catch {
      /* an orphaned old object is tolerable; never fail the upload over it */
    }
  }
  revalidateAdmin(clientId);
  return { ok: true, id: staffId, url: up.url };
}

/** Remove the public photo (the page falls back to initials). */
export async function removeStaffPhotoAction(clientId: string, staffId: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const current = await getStaffById(auth.tenantId, staffId);
  if (!current || !(await siteInClient(auth.tenantId, clientId, current.site_id))) return { ok: false, error: FOREIGN };
  if (!current.public_photo_url) return { ok: true, id: staffId };
  await updateStaff(auth.tenantId, staffId, { publicPhotoUrl: null });
  try {
    await deleteLogo(current.public_photo_url);
  } catch {
    /* best effort */
  }
  revalidateAdmin(clientId);
  return { ok: true, id: staffId };
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
// ── Staff certifications ───────────────────────────────────────────────────────
// Separate rows, so they are created and deleted one at a time rather than riding
// the profile patch. Same four-way gate, plus the staff-belongs-to-this-client check.

export async function addStaffCertificationAction(input: {
  clientId: string;
  staffId: string;
  name: string;
  issuer?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
}): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(input.clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, input.clientId, input.staffId))) return { ok: false, error: FOREIGN };
  if (!input.name.trim()) return { ok: false, error: "A certification needs a name." };
  // The CHECK enforces this too; saying it here gives the operator a sentence.
  if (input.issuedOn && input.expiresOn && input.expiresOn < input.issuedOn) {
    return { ok: false, error: "The expiry date can’t be before the issue date." };
  }
  try {
    const row = await createStaffCertification({
      tenantId: auth.tenantId,
      staffId: input.staffId,
      name: input.name,
      issuer: input.issuer ?? null,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
    });
    revalidateAdmin(input.clientId);
    return { ok: true, id: row.id };
  } catch (err) {
    return { ok: false, error: errText(err, "Could not add the certification.") };
  }
}

export async function deleteStaffCertificationAction(
  clientId: string,
  staffId: string,
  id: string,
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, staffId))) return { ok: false, error: FOREIGN };
  const ok = await deleteStaffCertification(auth.tenantId, staffId, id);
  if (!ok) return { ok: false, error: "Certification not found." };
  revalidateAdmin(clientId);
  return { ok: true };
}

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

/** The LIST behind the deactivation confirmation (3d): future active appointments for a
 *  staff member, so the operator sees exactly whom they'd affect before deactivating. The
 *  appointments are NEVER cancelled — deactivation only stops NEW bookings. Owner/admin +
 *  client scoping; a foreign/forged id yields an empty list. */
export interface UpcomingApptView {
  id: string;
  start_at: string; // ISO UTC
  service_name: string;
  contact_name: string | null;
  site_timezone: string;
}
export type UpcomingListResult = { ok: true; appointments: UpcomingApptView[] } | { ok: false; error: string };

export async function listStaffUpcomingAppointmentsAction(
  clientId: string,
  staffId: string,
): Promise<UpcomingListResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await staffInClient(auth.tenantId, clientId, staffId))) return { ok: true, appointments: [] };
  const rows = await listAppointments(auth.tenantId, {
    clientId,
    staffId,
    status: ["scheduled", "confirmed"],
    from: new Date(),
  });
  return {
    ok: true,
    appointments: rows.map((a) => ({
      id: a.id,
      start_at: a.start_at.toISOString(),
      service_name: a.service_name_snapshot,
      contact_name: a.contact_name,
      site_timezone: a.site_timezone,
    })),
  };
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

/**
 * MF-1 item 7 — these two legacy actions (desktop AdminPanel + mobile BlocksMobile) are now
 * thin ADAPTERS over the single time-off writer in timeOffActions.ts, so there is exactly one
 * writer of schedule_exceptions with one set of rules (tiered permissions + the conflict
 * flow). They keep their wall-clock-pair signature so the two legacy forms are unchanged.
 * confirm:true preserves this path's create-unconditionally behavior — the interactive
 * conflict flow lives in the new TimeOffForm. NOTE the unified rules now permit a Setter to
 * create a STAFF block here (as the agenda already does); SITE closures stay owner-only.
 */
export async function createExceptionAction(input: {
  clientId: string;
  siteId: string;
  staffId?: string | null;
  /** Local wall-clock "YYYY-MM-DDTHH:MM" as typed — interpreted in the SITE tz. */
  startsAt: string;
  endsAt: string;
  reason?: string;
  /** What a customer may be told — a controlled code, or null (the default: nothing). */
  publicReason?: string | null;
}): Promise<AdminResult> {
  const r = await writeTimeOff({
    clientId: input.clientId,
    siteId: input.siteId,
    staffId: input.staffId ?? null,
    startLocal: input.startsAt,
    endLocal: input.endsAt,
    reason: input.reason,
    publicReason: input.publicReason,
    confirm: true, // legacy forms create unconditionally; the agenda flags any overlap
  });
  // With confirm:true the writer never returns conflicts; keep AdminResult's shape anyway.
  if (!r.ok && "conflicts" in r) return { ok: false, error: "Hay citas en ese horario." };
  return r;
}

export async function deleteExceptionAction(clientId: string, id: string): Promise<AdminResult> {
  const r = await deleteTimeOffAction(clientId, id);
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "No se pudo eliminar el bloqueo." };
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

/**
 * The booking page's public contact, validated before any write: the WhatsApp number in
 * E.164 (a local number is read in the site's dialing region), the Maps link only when it
 * is https AND Google Maps, the address as plain text. "" clears a value; an absent key
 * leaves it unchanged. Messages are for the operator, in Spanish.
 */
function validatePublicContact(
  patch: { address?: string; publicWhatsapp?: string; publicMapsUrl?: string },
  timezone: string,
): { ok: true; value: { address?: string | null; publicWhatsapp?: string | null; publicMapsUrl?: string | null } } | { ok: false; error: string } {
  const value: { address?: string | null; publicWhatsapp?: string | null; publicMapsUrl?: string | null } = {};
  if (patch.address !== undefined) {
    const a = patch.address.replace(/\s+/g, " ").trim();
    if (a.length > 200) return { ok: false, error: "La dirección admite hasta 200 caracteres." };
    value.address = a || null;
  }
  if (patch.publicWhatsapp !== undefined) {
    const raw = patch.publicWhatsapp.trim();
    if (!raw) value.publicWhatsapp = null;
    else {
      const e164 = normalizeE164(raw, { defaultRegion: dialingRegionForTimezone(timezone) });
      if (!e164 || !E164_RE.test(e164)) return { ok: false, error: "Revisa el número de WhatsApp: escríbelo con el indicativo, por ejemplo +57 300 123 4567." };
      value.publicWhatsapp = e164;
    }
  }
  if (patch.publicMapsUrl !== undefined) {
    const raw = patch.publicMapsUrl.trim();
    if (!raw) value.publicMapsUrl = null;
    else {
      const safe = safeMapsUrl(raw);
      if (!safe) return { ok: false, error: "El enlace de «Cómo llegar» debe ser de Google Maps (https://maps.app.goo.gl/… o https://www.google.com/maps/…)." };
      value.publicMapsUrl = safe;
    }
  }
  return { ok: true, value };
}

// ── Booking page catalog (migration 1804) — presentation only ─────────────────────
// Same gate as every catalogue edit (agency or this client's OWNER). None of these
// touches a service's name, duration, price, active flag or site enablement, so the
// agenda and the bot are unaffected by how the page shows a service.

/** Create (id = null) or update one of this client's booking-page categories. */
export async function saveBookingCategoryAction(
  clientId: string,
  id: string | null,
  input: { name: string; tagline: string; layout: string; sortOrder: number | string; visible: boolean },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const checked = checkCategoryInput(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  try {
    if (id) {
      const ok = await updateBookingCategory(auth.tenantId, clientId, id, checked.value);
      if (!ok) return { ok: false, error: FOREIGN };
      revalidateAdmin(clientId);
      return { ok: true, id };
    }
    const newId = await createBookingCategory(auth.tenantId, clientId, checked.value);
    revalidateAdmin(clientId);
    return { ok: true, id: newId };
  } catch (err) {
    if (err instanceof BookingCategoryNameTaken) return { ok: false, error: "Ya hay una categoría con ese nombre." };
    throw err;
  }
}

/** Delete a category: its services stay published, just ungrouped. */
export async function deleteBookingCategoryAction(clientId: string, id: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const ok = await deleteBookingCategory(auth.tenantId, clientId, id);
  if (!ok) return { ok: false, error: FOREIGN };
  revalidateAdmin(clientId);
  return { ok: true };
}

/** A service's presentation on the booking page (group, visibility, order, badge,
 *  "Qué incluye", its better alternative). The image has its own upload action. */
export async function updateServicePresentationAction(
  clientId: string,
  serviceId: string,
  input: { categoryId: string | null; visible: boolean; sort: number | string; recommended: boolean; includes: string; upgradeServiceId: string | null },
): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const includes = checkIncludes(input.includes ?? "");
  if (!includes.ok) return { ok: false, error: includes.error };
  const sort = Number(input.sort);
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) return { ok: false, error: "El orden debe ser un número entre 0 y 999." };
  if (input.upgradeServiceId && input.upgradeServiceId === serviceId) return { ok: false, error: "Un servicio no puede ser su propia alternativa." };
  const ok = await updateServicePresentation(auth.tenantId, clientId, serviceId, {
    categoryId: input.categoryId || null,
    visible: Boolean(input.visible),
    sort,
    recommended: Boolean(input.recommended),
    includes: includes.value,
    upgradeServiceId: input.upgradeServiceId || null,
  });
  if (!ok) return { ok: false, error: FOREIGN };
  revalidateAdmin(clientId);
  return { ok: true, id: serviceId };
}

/**
 * Upload (or replace) a service's booking-page image. FormData { clientId, serviceId,
 * image: File }. Validated by its bytes in uploadServiceImage; the service must be this
 * client's. A replaced image's old object is deleted best-effort.
 */
export async function uploadServiceImageAction(formData: FormData): Promise<AdminResult & { url?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const serviceId = String(formData.get("serviceId") ?? "");
  const file = formData.get("image");
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!isR2Configured) return { ok: false, error: "La subida de imágenes no está configurada." };
  if (!(file instanceof File)) return { ok: false, error: "Elige una imagen." };
  if (!(await getServiceById(auth.tenantId, clientId, serviceId))) return { ok: false, error: FOREIGN };
  const up = await uploadServiceImage(auth.tenantId, clientId, serviceId, file);
  if (!up.ok) return { ok: false, error: up.error };
  const set = await setServiceImage(auth.tenantId, clientId, serviceId, up.url);
  if (!set.ok) return { ok: false, error: FOREIGN };
  if (set.previous && set.previous !== up.url) {
    try {
      await deleteLogo(set.previous);
    } catch {
      /* best-effort cleanup */
    }
  }
  revalidateAdmin(clientId);
  return { ok: true, id: serviceId, url: up.url };
}

export async function removeServiceImageAction(clientId: string, serviceId: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const set = await setServiceImage(auth.tenantId, clientId, serviceId, null);
  if (!set.ok) return { ok: false, error: FOREIGN };
  if (set.previous) {
    try {
      await deleteLogo(set.previous);
    } catch {
      /* best-effort cleanup */
    }
  }
  revalidateAdmin(clientId);
  return { ok: true, id: serviceId };
}

// ── Promotions (migration 1805) ─────────────────────────────────────────────────
// The rules (publishable? eligible?) live in src/scheduling/promotions.ts and are applied
// by the repository on every write; these actions validate the INPUT, resolve the site's
// timezone for the two windows and translate results into the operator's Spanish.

export interface PromotionForm {
  name: string;
  description: string;
  conditions: string;
  siteId: string;
  sortOrder: string;
  benefitType: string;
  serviceIds: string[];
  staffIds: string[];
  /** A. When the booking can be made — local wall clock "YYYY-MM-DDTHH:MM" in the site's tz. */
  bookableFrom: string;
  bookableUntil: string;
  /** B. When the appointment must happen. ISO weekdays 1–7; dates YYYY-MM-DD; times HH:MM. */
  weekdays: number[];
  appointmentFrom: string;
  appointmentUntil: string;
  timeFrom: string;
  timeUntil: string;
}

const PROMO_ERRORS: Record<Exclude<WriteResult, { ok: true }>["error"], string> = {
  not_found: "No encontramos esta promoción.",
  stale: "Otra persona cambió esta promoción mientras la editabas. Recarga para ver la última versión; tus cambios no se guardaron.",
  foreign: "Revisa los servicios, artistas y sede elegidos: alguno no pertenece a este negocio.",
  invalid_move: "Ese cambio de estado no está permitido.",
  cannot_publish: "Todavía no se puede publicar.",
};
const promoResult = (r: WriteResult): AdminResult & { version?: number } =>
  r.ok ? { ok: true, id: r.id, version: r.version } : { ok: false, error: r.error === "cannot_publish" && r.problems?.length ? r.problems.join(" ") : PROMO_ERRORS[r.error] };

async function promotionInput(tenantId: string, clientId: string, f: PromotionForm): Promise<{ ok: true; value: PromotionInput } | { ok: false; error: string }> {
  const name = checkPublicLine(f.name, 80);
  if (!name.ok) return { ok: false, error: publicProfileMessage(name.error, "Nombre", name.max) };
  if (!name.value) return { ok: false, error: "Escribe el nombre de la promoción." };
  const desc = checkPublicBio(f.description);
  if (!desc.ok) return { ok: false, error: publicProfileMessage(desc.error, "Descripción", desc.max) };
  const cond = checkPublicBio(f.conditions);
  if (!cond.ok) return { ok: false, error: publicProfileMessage(cond.error, "Condiciones", cond.max) };
  if (f.benefitType !== "two_for_one") return { ok: false, error: "Elige un tipo de beneficio disponible." };
  const sort = Number(f.sortOrder || 0);
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) return { ok: false, error: "El orden debe ser un número entre 0 y 999." };
  const sites = await listSites(tenantId, { clientId });
  const site = f.siteId ? sites.find((x) => x.id === f.siteId) : sites[0];
  if (f.siteId && !site) return { ok: false, error: PROMO_ERRORS.foreign };
  const tz = site?.timezone ?? "America/Bogota";
  const instant = (v: string, label: string): Date | null | "bad" => {
    if (!v.trim()) return null;
    try {
      return localWallClockToUtc(v.trim(), tz);
    } catch {
      return label ? "bad" : null;
    }
  };
  const from = instant(f.bookableFrom, "desde");
  const until = instant(f.bookableUntil, "hasta");
  if (from === "bad" || until === "bad") return { ok: false, error: "Revisa las fechas de vigencia." };
  if (from && until && until <= from) return { ok: false, error: "La vigencia termina antes de empezar." };
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  if ((f.appointmentFrom && !day.test(f.appointmentFrom)) || (f.appointmentUntil && !day.test(f.appointmentUntil))) return { ok: false, error: "Revisa las fechas de las citas." };
  if (f.appointmentFrom && f.appointmentUntil && f.appointmentUntil < f.appointmentFrom) return { ok: false, error: "Las fechas de las citas terminan antes de empezar." };
  if (Boolean(f.timeFrom) !== Boolean(f.timeUntil)) return { ok: false, error: "Escribe las dos horas de la franja de las citas, o ninguna." };
  if (f.timeFrom && (!time.test(f.timeFrom) || !time.test(f.timeUntil) || f.timeUntil <= f.timeFrom)) return { ok: false, error: "Revisa la franja horaria de las citas." };
  const weekdays = [...new Set(f.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
  return {
    ok: true,
    value: {
      site_id: site && f.siteId ? site.id : null,
      name: name.value,
      description: desc.value,
      conditions: cond.value,
      sort_order: sort,
      benefit_type: "two_for_one",
      benefit_params: {},
      bookable_from: from,
      bookable_until: until,
      appointment_weekdays: weekdays.length && weekdays.length < 7 ? weekdays : null,
      appointment_from: f.appointmentFrom || null,
      appointment_until: f.appointmentUntil || null,
      appointment_time_from: f.timeFrom || null,
      appointment_time_until: f.timeUntil || null,
      service_ids: f.serviceIds,
      staff_ids: f.staffIds,
    },
  };
}

/** Create (id = null) or edit a promotion. An edit names the version it read. */
export async function savePromotionAction(clientId: string, id: string | null, version: number | null, form: PromotionForm): Promise<AdminResult & { version?: number }> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const input = await promotionInput(auth.tenantId, clientId, form);
  if (!input.ok) return { ok: false, error: input.error };
  const r = id
    ? await updatePromotion(auth.tenantId, clientId, id, version ?? -1, input.value, auth.userId)
    : await createPromotion(auth.tenantId, clientId, input.value, auth.userId);
  if (r.ok) revalidateAdmin(clientId);
  return promoResult(r);
}

/** Publish, pause, resume or archive (only allowed moves; publishing re-validates). */
export async function setPromotionStatusAction(clientId: string, id: string, version: number, to: PromotionStatus): Promise<AdminResult & { version?: number }> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const r = await setPromotionStatus(auth.tenantId, clientId, id, version, to, auth.userId);
  if (r.ok) revalidateAdmin(clientId);
  return promoResult(r);
}

export async function duplicatePromotionAction(clientId: string, id: string): Promise<AdminResult & { version?: number }> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const r = await duplicatePromotion(auth.tenantId, clientId, id, auth.userId);
  if (r.ok) revalidateAdmin(clientId);
  return promoResult(r);
}

/** Who changed what, newest first (names only — never an e-mail). */
export async function listPromotionHistoryAction(
  clientId: string,
  id: string,
): Promise<{ ok: true; events: Array<{ type: string; actor: string | null; at: string; version: number; detail: Record<string, unknown> }> } | { ok: false; error: string }> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const rows = await listPromotionEvents(auth.tenantId, clientId, id);
  return { ok: true, events: rows.map((e) => ({ type: e.event_type, actor: e.actor_name, at: e.created_at.toISOString(), version: e.version, detail: e.detail })) };
}

export async function uploadPromotionImageAction(formData: FormData): Promise<AdminResult & { url?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const promotionId = String(formData.get("promotionId") ?? "");
  const file = formData.get("image");
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!isR2Configured) return { ok: false, error: "La subida de imágenes no está configurada." };
  if (!(file instanceof File)) return { ok: false, error: "Elige una imagen." };
  // The promotion must be THIS client's before anything is stored for it.
  if (!(await getPromotion(auth.tenantId, clientId, promotionId))) return { ok: false, error: FOREIGN };
  const up = await uploadServiceImage(auth.tenantId, clientId, promotionId, file, "promotions");
  if (!up.ok) return { ok: false, error: up.error };
  const set = await setPromotionImage(auth.tenantId, clientId, promotionId, up.url);
  if (!set.ok) return { ok: false, error: FOREIGN };
  if (set.previous && set.previous !== up.url) {
    try {
      await deleteLogo(set.previous);
    } catch {
      /* best-effort cleanup */
    }
  }
  revalidateAdmin(clientId);
  return { ok: true, id: promotionId, url: up.url };
}

export async function removePromotionImageAction(clientId: string, promotionId: string): Promise<AdminResult> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  const set = await setPromotionImage(auth.tenantId, clientId, promotionId, null);
  if (!set.ok) return { ok: false, error: FOREIGN };
  if (set.previous) {
    try {
      await deleteLogo(set.previous);
    } catch {
      /* best-effort cleanup */
    }
  }
  revalidateAdmin(clientId);
  return { ok: true, id: promotionId };
}

/**
 * "¿Tiene horarios?" — separate from "¿aparece en la página?": for each active site where
 * the service is enabled, the first day (site calendar) with a bookable time in the next
 * 14 days, from the SAME engine the page and the bot use. Read-only.
 */
export async function serviceUpcomingAvailabilityAction(
  clientId: string,
  serviceId: string,
): Promise<{ ok: true; sites: Array<{ id: string; name: string; firstDay: string | null }> } | { ok: false; error: string }> {
  const auth = await requireSchedulingAdmin(clientId);
  if (!auth.ok) return auth;
  if (!(await getServiceById(auth.tenantId, clientId, serviceId))) return { ok: false, error: FOREIGN };
  const now = new Date();
  const to = new Date(now.getTime() + 14 * 86_400_000);
  const sites = await listSites(auth.tenantId, { clientId });
  const out: Array<{ id: string; name: string; firstDay: string | null }> = [];
  for (const site of sites) {
    const avail = await loadAvailability({ tenantId: auth.tenantId, siteId: site.id, serviceId, staffId: null, from: now, to, now });
    if (!avail) continue; // not enabled at this site
    const first = avail.slots[0]?.start_at ?? null;
    const z = first ? utcToZonedParts(first, site.timezone) : null;
    out.push({ id: site.id, name: site.name, firstDay: z ? `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}` : null });
  }
  return { ok: true, sites: out };
}
