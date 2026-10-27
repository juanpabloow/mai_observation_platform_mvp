"use client";

import { useState } from "react";
import type { CountryOption } from "@/lib/phone";
import { normalizePersonName } from "@/lib/personName";
import { saveMyPhoneAction, updateMyNameAction } from "@/lib/accountActions";
import { Button, Field, INPUT } from "@/components/ui/controls";
import { Avatar, PHONE_HINT, PHOTO_HINT, PhoneField, PhotoControl, type AvatarState } from "@/components/access/ProfileFields";

/**
 * Cuenta → Tu perfil: the same personal data as "Completa tu perfil", editable any time.
 * Name and phone save with one button; the photo saves on its own (a file, not a field).
 * Business, role and permissions are not here — they belong to the administrator.
 */
export function AccountProfileForm({
  email,
  initial,
  countries,
}: {
  email: string;
  initial: { userId: string; name: string; country: string; national: string; uploaded: string | null; providerImage: string | null };
  countries: { priority: CountryOption[]; rest: CountryOption[] };
}) {
  const [name, setName] = useState(initial.name);
  const [country, setCountry] = useState(initial.country);
  const [national, setNational] = useState(initial.national);
  const [nameError, setNameError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ name: string; country: string; national: string }>({
    name: initial.name,
    country: initial.country,
    national: initial.national,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarState>({
    userId: initial.userId,
    name: initial.name,
    uploaded: initial.uploaded,
    providerImage: initial.providerImage,
  });
  const dirty = name !== saved.name || country !== saved.country || national !== saved.national;

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !dirty) return;
    setStatus(null);
    setNameError(null);
    setPhoneError(null);
    const n = normalizePersonName(name);
    if (!n.ok) {
      setNameError(n.error);
      return;
    }
    setBusy(true);
    try {
      if (n.name !== saved.name) {
        const r = await updateMyNameAction(n.name);
        if (!r.ok) {
          setNameError(r.error);
          return;
        }
      }
      if (country !== saved.country || national !== saved.national) {
        const r = await saveMyPhoneAction({ country, national });
        if (!r.ok) {
          setPhoneError(r.error);
          return;
        }
      }
      setName(n.name);
      setSaved({ name: n.name, country, national });
      setAvatar((a) => ({ ...a, name: n.name }));
      setStatus("Cambios guardados.");
    } catch {
      setStatus("No pudimos guardar. Tus datos siguen aquí; inténtalo otra vez.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSave} className="flex flex-col gap-5" noValidate>
      <div className="flex items-center gap-3.5">
        <Avatar state={avatar} look="app" size={52} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[15px] text-foreground">{avatar.name || "Sin nombre"}</span>
          <span className="truncate text-[13px] text-muted">{email}</span>
        </span>
      </div>
      <Field label="Nombre completo" error={nameError ?? undefined}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          aria-invalid={nameError ? true : undefined}
          className={INPUT}
        />
      </Field>
      <Field label="Correo" hint="Es el correo con el que entras. Para cambiarlo, pídeselo a tu administrador.">
        <input value={email} readOnly className={`${INPUT} bg-chip text-muted`} />
      </Field>
      <PhoneField
        look="app"
        countries={countries}
        country={country}
        onCountry={(c) => {
          setCountry(c);
          setPhoneError(null);
        }}
        national={national}
        onNational={setNational}
        error={phoneError}
        hint={PHONE_HINT}
      />
      <PhotoControl look="app" state={avatar} onChange={setAvatar} hint={PHOTO_HINT} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={busy} loadingLabel="Guardando…" disabled={!dirty}>
          Guardar cambios
        </Button>
        <span role="status" className="text-sm text-muted">
          {status}
        </span>
      </div>
    </form>
  );
}
