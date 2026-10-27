import { createHash } from 'node:crypto';
import { query } from '../client.js';

/**
 * ACCESO-1 — the PERSON's own profile: name (Better Auth's "user".name), phone and photo.
 * Personal data of whoever signs in — NOT a CRM contact and NOT a professional's public
 * booking profile (staff.* columns); nothing here is read by the booking page.
 *
 * Every write is keyed by the user id the SERVER resolved from the session; there is no
 * "edit someone else's profile" path.
 */

export interface UserProfileRow {
  phone_e164: string | null;
  phone_country: string | null;
  onboarded_at: Date | null;
}

export async function getUserProfile(userId: string): Promise<UserProfileRow | null> {
  const r = await query<UserProfileRow>(
    `SELECT phone_e164, phone_country, onboarded_at FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Set (or clear, with nulls) the phone — already validated + normalized by the caller. */
export async function setUserPhone(userId: string, phone: { e164: string; country: string } | null): Promise<void> {
  await query(
    `INSERT INTO user_profiles (user_id, phone_e164, phone_country)
          VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
          SET phone_e164 = EXCLUDED.phone_e164, phone_country = EXCLUDED.phone_country, updated_at = now()`,
    [userId, phone?.e164 ?? null, phone?.country ?? null],
  );
}

/** The optional "Completa tu perfil" step was finished or skipped («Ahora no»). Idempotent. */
export async function markUserOnboarded(userId: string): Promise<void> {
  await query(
    `INSERT INTO user_profiles (user_id, onboarded_at) VALUES ($1, now())
     ON CONFLICT (user_id) DO UPDATE SET onboarded_at = COALESCE(user_profiles.onboarded_at, now()), updated_at = now()`,
    [userId],
  );
}

/** The display name (one free field — validated by web/lib/personName.ts). */
export async function setUserName(userId: string, name: string): Promise<void> {
  await query(`UPDATE "user" SET name = $2, "updatedAt" = now() WHERE id = $1`, [userId, name]);
}

/** Stop using the provider photo (Google's picture link, kept in "user".image). */
export async function clearUserProviderImage(userId: string): Promise<void> {
  await query(`UPDATE "user" SET image = NULL, "updatedAt" = now() WHERE id = $1`, [userId]);
}

export interface AvatarMeta {
  content_type: string;
  sha256: string;
  updated_at: Date;
}

export async function getUserAvatarMeta(userId: string): Promise<AvatarMeta | null> {
  const r = await query<AvatarMeta>(`SELECT content_type, sha256, updated_at FROM user_avatars WHERE user_id = $1`, [userId]);
  return r.rows[0] ?? null;
}

export async function getUserAvatar(userId: string): Promise<(AvatarMeta & { bytes: Buffer }) | null> {
  const r = await query<AvatarMeta & { bytes: Buffer }>(
    `SELECT content_type, sha256, updated_at, bytes FROM user_avatars WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Store an ALREADY VALIDATED image (type decided by magic bytes, size capped). */
export async function setUserAvatar(userId: string, contentType: string, bytes: Uint8Array): Promise<string> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await query(
    `INSERT INTO user_avatars (user_id, content_type, bytes, sha256) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
          SET content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, updated_at = now()`,
    [userId, contentType, Buffer.from(bytes), sha256],
  );
  return sha256;
}

export async function deleteUserAvatar(userId: string): Promise<void> {
  await query(`DELETE FROM user_avatars WHERE user_id = $1`, [userId]);
}

/**
 * May `viewerId` see `targetId`'s photo? Themselves, or someone in the SAME tenant (the team
 * that works together). Never across tenants, never anonymously.
 */
export async function canViewUserAvatar(viewerId: string, targetId: string): Promise<boolean> {
  if (viewerId === targetId) return true;
  const r = await query(
    `SELECT 1 FROM tenant_members a JOIN tenant_members b ON b.tenant_id = a.tenant_id
      WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
    [viewerId, targetId],
  );
  return (r.rowCount ?? 0) > 0;
}
