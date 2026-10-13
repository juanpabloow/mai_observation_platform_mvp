"use client";

import { useRef, useState, useTransition } from "react";
import { removeStaffPhotoAction, uploadStaffPhotoAction } from "@/lib/schedulingAdminActions";
import { initialsOf } from "@/lib/staffTone";

/**
 * The professional's PUBLIC photo (booking page). It saves immediately — like a
 * certification — rather than riding the profile draft: an upload is a file, not a field.
 *
 * The picture is DOWNSIZED IN THE BROWSER first (longest side ≤ 1200 px, JPEG 0.85) so a
 * phone photo fits the Server Actions body limit without changing it; the server still
 * validates the bytes (PNG/JPEG/WebP only) and the size. Without object storage
 * configured the control says so and the page keeps showing initials.
 */

const COPY = {
  es: {
    upload: "Subir foto",
    replace: "Cambiar foto",
    remove: "Quitar foto",
    busy: "Guardando…",
    off: "La subida de fotos no está configurada en este entorno. La página de reservas muestra las iniciales.",
    hint: "JPG, PNG o WebP. Se muestra en la página de reservas.",
    unreadable: "No pudimos leer esa imagen. Prueba con un JPG o PNG.",
  },
  en: {
    upload: "Upload photo",
    replace: "Replace photo",
    remove: "Remove photo",
    busy: "Saving…",
    off: "Photo upload is not configured in this environment. The booking page shows initials.",
    hint: "JPG, PNG or WebP. Shown on the public booking page.",
    unreadable: "That image could not be read. Try a JPG or PNG.",
  },
} as const;

const MAX_SIDE = 1200;

/** Longest side ≤ 1200 px, re-encoded as JPEG. Throws when the browser cannot decode it. */
export async function downscaleImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("encode");
  return new File([blob], "photo.jpg", { type: "image/jpeg" });
}

export function StaffPhotoControl({
  clientId,
  staffId,
  name,
  photoUrl,
  enabled,
  lang,
  onChanged,
}: {
  clientId: string;
  staffId: string;
  name: string;
  photoUrl: string | null;
  enabled: boolean;
  lang: "es" | "en";
  onChanged: () => void;
}) {
  const t = COPY[lang];
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const upload = (file: File) =>
    start(async () => {
      setError(null);
      let small: File;
      try {
        small = await downscaleImage(file);
      } catch {
        setError(t.unreadable);
        return;
      }
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("staffId", staffId);
      fd.set("photo", small);
      const r = await uploadStaffPhotoAction(fd);
      if (!r.ok) setError(r.error);
      else onChanged();
    });

  const remove = () =>
    start(async () => {
      setError(null);
      const r = await removeStaffPhotoAction(clientId, staffId);
      if (!r.ok) setError(r.error);
      else onChanged();
    });

  return (
    <div className="flex items-start gap-3">
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
        <img src={photoUrl} alt="" className="size-16 shrink-0 rounded-xl border border-line object-cover" />
      ) : (
        <span aria-hidden className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-subtle text-base font-semibold text-muted">
          {initialsOf(name)}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {enabled ? (
          <>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => input.current?.click()}
                className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] border border-line-strong bg-surface px-3.5 text-sm text-foreground disabled:opacity-60 md:min-h-[36px]"
              >
                {pending ? t.busy : photoUrl ? t.replace : t.upload}
              </button>
              {photoUrl ? (
                <button
                  type="button"
                  disabled={pending}
                  onClick={remove}
                  className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] px-3 text-sm text-muted underline underline-offset-2 disabled:opacity-60 md:min-h-[36px]"
                >
                  {t.remove}
                </button>
              ) : null}
            </div>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) upload(f);
              }}
            />
            <span className="text-xs text-muted">{t.hint}</span>
          </>
        ) : (
          <span className="text-xs text-muted">{t.off}</span>
        )}
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}
