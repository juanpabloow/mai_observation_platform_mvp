"use server";

import { getServerSession } from "./session";
import { normalizePersonName } from "./personName";
import { normalizePhone } from "./phone";
import { MAX_STAFF_PHOTO_BYTES, IMAGE_CONTENT_TYPE, validateImageFile } from "./imageValidation";
import {
  clearUserProviderImage,
  deleteUserAvatar,
  markUserOnboarded,
  setUserAvatar,
  setUserName,
  setUserPhone,
} from "@worker/db/repositories/userProfiles.js";

/**
 * The person's OWN profile (Crear/Completar perfil, and later Cuenta). Every action resolves
 * the user from the validated session — there is no user id parameter to tamper with — and
 * none of them touches business, role or permissions: those belong to the administrator.
 * No revalidatePath: the account page is dynamic, and a re-render triggered from the
 * invitation flow would reset what the person is typing in "Completa tu perfil".
 */

type Result = { ok: true } | { ok: false; error: string; field?: "name" | "phone" | "photo" };

async function me(): Promise<string | null> {
  const s = await getServerSession();
  return s?.user?.id ?? null;
}

const SIGNED_OUT: Result = { ok: false, error: "Tu sesión terminó. Vuelve a entrar." };

export async function updateMyNameAction(name: string): Promise<Result> {
  const userId = await me();
  if (!userId) return SIGNED_OUT;
  const n = normalizePersonName(name);
  if (!n.ok) return { ok: false, error: n.error, field: "name" };
  await setUserName(userId, n.name);
  return { ok: true };
}

/** Save (or clear) the phone. Empty number = no phone. */
export async function saveMyPhoneAction(input: { country: string; national: string }): Promise<Result & { e164?: string | null }> {
  const userId = await me();
  if (!userId) return SIGNED_OUT;
  const p = normalizePhone(input);
  if (!p.ok) return { ok: false, error: p.error, field: "phone" };
  await setUserPhone(userId, p.phone);
  return { ok: true, e164: p.phone?.e164 ?? null };
}

/**
 * "Completa tu perfil" → «Guardar y entrar» (phone optional) or «Ahora no» (skip = true,
 * saves nothing more). Either way the step is done and is not shown again.
 */
export async function completeProfileAction(input: { country: string; national: string; skip: boolean }): Promise<Result> {
  const userId = await me();
  if (!userId) return SIGNED_OUT;
  if (!input.skip) {
    const p = normalizePhone(input);
    if (!p.ok) return { ok: false, error: p.error, field: "phone" };
    if (p.phone) await setUserPhone(userId, p.phone);
  }
  await markUserOnboarded(userId);
  return { ok: true };
}

/**
 * Upload the photo. The browser downsizes it first (≤ 1200 px JPEG), and the server still
 * decides the type by MAGIC BYTES (PNG/JPEG/WebP only — no SVG) and caps the size. Stored
 * privately (user_avatars) and served only to the person and their team
 * (app/api/account/avatar/[userId]).
 */
export async function uploadMyAvatarAction(form: FormData): Promise<Result> {
  const userId = await me();
  if (!userId) return SIGNED_OUT;
  const file = form.get("photo");
  if (!(file instanceof File)) return { ok: false, error: "Elige una imagen.", field: "photo" };
  const v = await validateImageFile(file, MAX_STAFF_PHOTO_BYTES);
  if (!v.ok) {
    return {
      ok: false,
      field: "photo",
      error: /too large/i.test(v.error)
        ? "La imagen es demasiado grande (máximo 900 KB)."
        : "Usa una imagen JPG, PNG o WebP.",
    };
  }
  await setUserAvatar(userId, IMAGE_CONTENT_TYPE[v.type], v.bytes);
  return { ok: true };
}

/** «Quitar»: drop the uploaded photo AND stop using the Google one — initials remain. */
export async function removeMyAvatarAction(): Promise<Result> {
  const userId = await me();
  if (!userId) return SIGNED_OUT;
  await deleteUserAvatar(userId);
  await clearUserProviderImage(userId);
  return { ok: true };
}
