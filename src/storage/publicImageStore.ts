import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * AT-2c — PUBLIC R2 image store for the WORKER (ad-cover auto-capture). The web app has its own
 * server-only uploader (web/lib/r2.ts) for person-uploaded images; the worker cannot import that
 * (`server-only` + the web boundary), so this is the worker-side writer for the SAME public bucket,
 * reading the SAME R2_* env, under the SAME "ads/…" key scheme. Gracefully optional: if any R2_* var
 * is missing, isPublicImageStoreConfigured is false and the cover reconcile no-ops — no crash, exactly
 * like isR2Configured gates the web path.
 *
 * OPERATOR NOTE: for auto-capture to run, the WORKER service must have R2_ACCESS_KEY_ID /
 * R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_URL / (R2_ENDPOINT | R2_ACCOUNT_ID) set — the
 * same values the web service already uses. Without them, person-uploaded covers still work (web).
 */
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;
const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/+$/, '');
const endpoint =
  process.env.R2_ENDPOINT ??
  (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);

export const isPublicImageStoreConfigured = Boolean(endpoint && accessKeyId && secretAccessKey && bucket && publicUrl);

const globalForStore = globalThis as unknown as { __obsPublicImageClient?: S3Client };
function client(): S3Client {
  if (!isPublicImageStoreConfigured) throw new Error('Public image store is not configured');
  return (
    globalForStore.__obsPublicImageClient ??
    (globalForStore.__obsPublicImageClient = new S3Client({
      region: 'auto',
      endpoint,
      credentials: { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string },
    }))
  );
}

/** The public URL for a stored key, or null when the store (or key) is absent. */
export function publicUrlForKey(key: string | null): string | null {
  return key && publicUrl ? `${publicUrl}/${key}` : null;
}

export interface AdCoverStore {
  /** Store validated bytes under a server-chosen "ads/<tenant>/<client>/<ad>/<uuid>.<ext>" key. */
  put(input: { tenantId: string; clientId: string; adId: string; bytes: Uint8Array; ext: string; contentType: string }): Promise<string>;
  del(key: string): Promise<void>;
}

/** The real R2-backed store used by the cover reconcile (tests inject a fake). */
export const adCoverStore: AdCoverStore = {
  async put({ tenantId, clientId, adId, bytes, ext, contentType }) {
    const key = `ads/${tenantId}/${clientId}/${adId}/${randomUUID()}.${ext}`;
    await client().send(
      new PutObjectCommand({
        Bucket: bucket as string,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return key;
  },
  async del(key) {
    if (!isPublicImageStoreConfigured) return;
    await client().send(new DeleteObjectCommand({ Bucket: bucket as string, Key: key }));
  },
};
