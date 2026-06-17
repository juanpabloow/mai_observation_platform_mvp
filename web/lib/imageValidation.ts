/**
 * Pure, dependency-free image validation for untrusted uploads. Kept separate
 * from the R2 storage module so it has no `server-only`/SDK imports and can be
 * unit-tested directly. The TYPE is decided by the file's MAGIC BYTES, never the
 * filename or the client-supplied MIME — a non-image renamed .png, or an SVG
 * renamed .png, is rejected here.
 *
 * SVG is deliberately NOT accepted: it's XML that can embed <script>, and logos
 * are served from a public origin, so we restrict to raster formats (PNG, JPEG,
 * WebP) for V1.
 */

/** Max accepted logo size — logos are tiny; anything larger is rejected. */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB

export type ImageType = "png" | "jpeg" | "webp";

/** Safe extension per validated type (server-chosen; never the user's name). */
export const IMAGE_EXTENSION: Record<ImageType, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

export const IMAGE_CONTENT_TYPE: Record<ImageType, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Detect the image type from leading magic bytes; null if unrecognized. */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

export type ImageValidation =
  | { ok: true; type: ImageType; bytes: Uint8Array }
  | { ok: false; error: string };

/**
 * Validate an untrusted uploaded file as a logo: enforce size, then confirm it
 * is genuinely a PNG/JPEG/WebP by its bytes. Returns the validated bytes + type.
 */
export async function validateImageFile(file: File): Promise<ImageValidation> {
  if (!file || file.size === 0) return { ok: false, error: "No image selected." };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "Image too large (max 2 MB)." };

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, error: "Image too large (max 2 MB)." };

  const type = detectImageType(bytes);
  if (!type) return { ok: false, error: "Unsupported image. Use PNG, JPEG, or WebP." };

  return { ok: true, type, bytes };
}
