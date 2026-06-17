import "server-only";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  IMAGE_CONTENT_TYPE,
  IMAGE_EXTENSION,
  validateImageFile,
} from "./imageValidation";

/**
 * Cloudflare R2 (S3-compatible) storage for client logos. SERVER-ONLY — the
 * `server-only` import makes importing this from a Client Component a build
 * error, so R2 credentials can never reach the browser. The worker never imports
 * this module (logos are a web concern).
 *
 * GRACEFULLY OPTIONAL: if any R2_* var is missing, `isR2Configured` is false and
 * upload is disabled — the rest of the clients feature works unchanged (same
 * pattern as the optional Google OAuth provider). The S3 client is a globalThis
 * singleton so `next dev` HMR re-evaluations don't leak clients (like our DB pools).
 */

const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME;
// Public base for building logo links (e.g. https://pub-<hash>.r2.dev).
const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/+$/, "");
// The S3 API endpoint: either given directly, or derived from the account id.
const endpoint =
  process.env.R2_ENDPOINT ??
  (process.env.R2_ACCOUNT_ID
    ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined);

/** True only when EVERY piece needed to upload + serve a logo is present. */
export const isR2Configured = Boolean(
  endpoint && accessKeyId && secretAccessKey && bucket && publicUrl,
);

// Singleton S3 client reused across HMR re-evaluations.
const globalForR2 = globalThis as unknown as { __obsR2Client?: S3Client };
function r2(): S3Client {
  if (!isR2Configured) throw new Error("R2 is not configured");
  return (
    globalForR2.__obsR2Client ??
    (globalForR2.__obsR2Client = new S3Client({
      region: "auto",
      endpoint,
      credentials: {
        accessKeyId: accessKeyId as string,
        secretAccessKey: secretAccessKey as string,
      },
    }))
  );
}

export type UploadLogoResult =
  | { ok: true; url: string; key: string }
  | { ok: false; error: string };

/**
 * Validate and upload a logo to R2 under a tenant+client-scoped key. Validation
 * (size + magic-byte type) is done by validateImageFile. The stored filename is
 * SERVER-GENERATED (random uuid) with a safe extension derived from the validated
 * type — the user's filename is never used (path-traversal safe). Returns the
 * public URL on success.
 */
export async function uploadLogo(
  tenantId: string,
  clientId: string,
  file: File,
): Promise<UploadLogoResult> {
  if (!isR2Configured) return { ok: false, error: "Logo upload is not configured." };

  const valid = await validateImageFile(file);
  if (!valid.ok) return { ok: false, error: valid.error };

  const key = `logos/${tenantId}/${clientId}/${randomUUID()}.${IMAGE_EXTENSION[valid.type]}`;
  await r2().send(
    new PutObjectCommand({
      Bucket: bucket as string,
      Key: key,
      Body: valid.bytes,
      ContentType: IMAGE_CONTENT_TYPE[valid.type],
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return { ok: true, url: `${publicUrl}/${key}`, key };
}

/** Derive the object key from a stored public URL (null if it isn't ours). */
function keyFromPublicUrl(url: string): string | null {
  if (!publicUrl) return null;
  const prefix = `${publicUrl}/`;
  return url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

/**
 * Best-effort delete of a previously-stored logo object (called when a logo is
 * replaced, so we don't accumulate orphans). Silently no-ops if R2 is unset or
 * the URL isn't one of ours; the caller treats failure as non-fatal.
 */
export async function deleteLogo(url: string): Promise<void> {
  if (!isR2Configured) return;
  const key = keyFromPublicUrl(url);
  if (!key) return;
  await r2().send(new DeleteObjectCommand({ Bucket: bucket as string, Key: key }));
}
