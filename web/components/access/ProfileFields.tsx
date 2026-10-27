"use client";

import { useId, useRef, useState } from "react";
import type { CountryOption } from "@/lib/phone";
import { initialsOf } from "@/lib/personName";
import { downscaleImage } from "@/components/scheduling/staff/StaffPhotoControl";
import { removeMyAvatarAction, uploadMyAvatarAction } from "@/lib/accountActions";

/**
 * The two OPTIONAL personal fields of "Completa tu perfil" (5a/5b) and of the account page:
 * an international phone and a photo. Two looks — the access screens' fixed light style and
 * the app's themed controls — same behaviour.
 */
export type FieldLook = "access" | "app";

const LOOK = {
  access: {
    label: "text-[13px] text-[#3A3A3C]",
    muted: "text-[#6E6E73]",
    select:
      "u-focus h-12 w-[132px] flex-none rounded-xl border border-[#D6D7DA] bg-white px-2 text-base text-[#111] lg:h-11 lg:w-[148px] lg:rounded-[10px] lg:px-2.5",
    input:
      "u-focus h-12 min-w-0 flex-1 rounded-xl border border-[#D6D7DA] bg-white px-3.5 text-base text-[#111] outline-none placeholder:text-[#8E8E93] aria-[invalid=true]:border-[#C62828] lg:h-11 lg:rounded-[10px]",
    hint: "text-[13px] leading-[1.45] text-[#6E6E73]",
    error: "text-[13px] leading-[1.45] text-[#C62828]",
    button:
      "u-focus h-11 whitespace-nowrap rounded-xl border border-[#D6D7DA] bg-white px-4 text-[15px] text-[#111] hover:bg-[#F5F5F7] disabled:opacity-60 lg:h-9 lg:rounded-[10px] lg:px-3.5 lg:text-sm",
    avatar: "bg-[#F2F2F4] text-[#111]",
  },
  app: {
    label: "text-[13px] font-medium text-foreground",
    muted: "text-muted",
    select:
      "u-focus h-[44px] w-[132px] flex-none rounded-sch-control border border-line-strong bg-surface px-2 text-sm text-foreground lg:h-[40px] lg:w-[148px]",
    input:
      "u-field u-focus h-[44px] min-w-0 flex-1 rounded-sch-control border border-line-strong bg-surface px-3 text-sm text-foreground outline-none placeholder:text-faint aria-[invalid=true]:border-danger lg:h-[40px]",
    hint: "text-xs leading-[1.45] text-muted",
    error: "text-xs leading-[1.45] text-danger",
    button:
      "u-focus h-[44px] whitespace-nowrap rounded-sch-control border border-line-strong bg-surface px-3.5 text-sm text-foreground hover:bg-subtle disabled:opacity-50 lg:h-[36px]",
    avatar: "bg-chip text-foreground",
  },
} as const;

export function PhoneField({
  look,
  countries,
  country,
  onCountry,
  national,
  onNational,
  error,
  hint,
}: {
  look: FieldLook;
  countries: { priority: CountryOption[]; rest: CountryOption[] };
  country: string;
  onCountry: (c: string) => void;
  national: string;
  onNational: (v: string) => void;
  error?: string | null;
  hint: string;
}) {
  const id = useId();
  const c = LOOK[look];
  const all = [...countries.priority, ...countries.rest];
  const example = all.find((x) => x.code === country)?.example;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-n`} className={c.label}>
        Teléfono <span className={c.muted}>· opcional</span>
      </label>
      <div className="flex gap-2">
        <select
          aria-label="País y prefijo"
          value={country}
          onChange={(e) => onCountry(e.target.value)}
          autoComplete="tel-country-code"
          className={c.select}
        >
          <optgroup label="Frecuentes">
            {countries.priority.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} {o.dial}
              </option>
            ))}
          </optgroup>
          <optgroup label="Todos los países">
            {countries.rest.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name} {o.dial}
              </option>
            ))}
          </optgroup>
        </select>
        <input
          id={`${id}-n`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          value={national}
          onChange={(e) => onNational(e.target.value)}
          placeholder={example || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-h`}
          className={c.input}
        />
      </div>
      <span id={`${id}-h`} role={error ? "alert" : undefined} className={error ? c.error : c.hint}>
        {error ?? hint}
      </span>
    </div>
  );
}

export interface AvatarState {
  userId: string;
  name: string;
  /** sha of the uploaded photo, when there is one (cache-busts the private URL). */
  uploaded: string | null;
  /** The provider (Google) picture link, when the account has one. */
  providerImage: string | null;
}

export function Avatar({ state, size = 56, look }: { state: AvatarState; size?: number; look: FieldLook }) {
  const src = state.uploaded
    ? `/api/account/avatar/${encodeURIComponent(state.userId)}?v=${state.uploaded.slice(0, 12)}`
    : state.providerImage;
  const initials = initialsOf(state.name) || "·";
  return (
    <span
      className={`flex flex-none items-center justify-center overflow-hidden rounded-full ${LOOK[look].avatar}`}
      style={{ width: size, height: size, fontSize: Math.round(size / 3.1) }}
      aria-hidden
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, session-gated route / provider link
        <img src={src} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}

export function PhotoControl({
  look,
  state,
  onChange,
  hint,
}: {
  look: FieldLook;
  state: AvatarState;
  onChange: (next: AvatarState) => void;
  hint: string;
}) {
  const c = LOOK[look];
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"up" | "rm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const has = Boolean(state.uploaded || state.providerImage);
  const label = state.uploaded ? "Foto subida" : state.providerImage ? "Usando tu foto de Google" : "Sin foto · se muestran tus iniciales";

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy("up");
    try {
      const small = await downscaleImage(file).catch(() => file);
      const fd = new FormData();
      fd.set("photo", small);
      const r = await uploadMyAvatarAction(fd);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // The new sha is not needed exactly: any change of the key re-fetches the private URL.
      onChange({ ...state, uploaded: `${Date.now().toString(16)}` });
    } catch {
      setError("No pudimos subir la foto. Inténtalo otra vez.");
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  }

  async function onRemove() {
    setError(null);
    setBusy("rm");
    try {
      const r = await removeMyAvatarAction();
      if (!r.ok) setError(r.error);
      else onChange({ ...state, uploaded: null, providerImage: null });
    } catch {
      setError("No pudimos quitar la foto. Inténtalo otra vez.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className={c.label}>
        Foto <span className={c.muted}>· opcional</span>
      </span>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className={`min-w-[160px] flex-1 text-sm ${look === "access" ? "text-[#111]" : "text-foreground"}`} aria-live="polite">
          {busy === "up" ? "Subiendo…" : busy === "rm" ? "Quitando…" : label}
        </span>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <button type="button" className={c.button} disabled={busy !== null} onClick={() => input.current?.click()}>
          {has ? "Cambiar" : "Subir foto"}
        </button>
        {has ? (
          <button type="button" className={c.button} disabled={busy !== null} onClick={onRemove}>
            Quitar
          </button>
        ) : null}
      </div>
      <span role={error ? "alert" : undefined} className={error ? c.error : c.hint}>
        {error ?? hint}
      </span>
    </div>
  );
}

/** Honest copy: what the model + permissions actually guarantee (see the report). */
export const PHOTO_HINT = "Solo la ven tú y las personas de tu negocio. No se publica en la página de reservas.";
export const PHONE_HINT = "Es un dato de tu cuenta. No se usa para escribir a clientes ni se publica en reservas.";
