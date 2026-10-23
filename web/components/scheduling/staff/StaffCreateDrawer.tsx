"use client";

import { useRef, useState, useTransition } from "react";
import { createStaffAction, updateStaffAction } from "@/lib/schedulingAdminActions";
import { PUBLIC_BIO_MAX, checkPublicBio, publicProfileMessage } from "@/lib/staffPublicProfile";
import { Button, INPUT } from "../ui/system";
import { SidePanel, type SidePanelHandle } from "../agenda/SidePanel";
import type { StaffServiceOpt, StaffSiteOpt } from "./StaffTab";

/**
 * NUEVO PROFESIONAL — the minimum a professional needs to exist: name, site, role, whether
 * they take bookings, optional work contact and the services they perform. They start on
 * the site's hours (inherited); hours, breaks, profile, certifications and absences are
 * edited afterwards in their ficha, which opens right after creating.
 *
 * A professional is a BOOKABLE RESOURCE, not a login: giving someone access to the system
 * is «Usuarios y accesos», a separate decision (and a separate permission).
 *
 * Same server actions as always (createStaffAction, then updateStaffAction for the fields
 * create does not take), behind the same gate (team.manage) and client scoping.
 */
export function StaffCreateDrawer({
  clientId,
  siteId,
  services,
  sites,
  onClose,
  onSaved,
}: {
  clientId: string;
  siteId?: string;
  services: StaffServiceOpt[];
  sites: StaffSiteOpt[];
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [site, setSite] = useState(siteId ?? sites[0]?.id ?? "");
  const [takesBookings, setTakesBookings] = useState(true);
  const [bio, setBio] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const dirty = Boolean(name.trim() || title.trim() || bio.trim() || !takesBookings);
  const nameError = touched && !name.trim() ? "Escribe el nombre." : null;
  const bioCheck = checkPublicBio(bio);
  const bioError = bioCheck.ok ? null : publicProfileMessage(bioCheck.error, "Presentación", PUBLIC_BIO_MAX);
  void services;

  const save = () => {
    setTouched(true);
    if (!name.trim() || bioError || !site || sending.current) return;
    sending.current = true;
    setError(null);
    start(async () => {
      try {
        const r = await createStaffAction({ clientId, siteId: site, name: name.trim(), serviceIds: [] });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const patch: Parameters<typeof updateStaffAction>[2] = {};
        if (title.trim()) patch.title = title.trim();
        if (!takesBookings) patch.takesBookings = false;
        if (bio.trim()) patch.publicBio = bio.trim();
        if (r.id && Object.keys(patch).length > 0) {
          const u = await updateStaffAction(clientId, r.id, patch);
          if (!u.ok) {
            // The person exists; say what did not save instead of inviting a duplicate.
            setError(`Se creó ${name.trim()}, pero no se guardó el resto: ${u.error} Complétalo en su ficha.`);
            onSaved(r.id);
            return;
          }
        }
        onSaved(r.id);
      } catch {
        setError("No se pudo crear. Tus datos siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

  return (
    <SidePanel
      name="staff-create"
      title="Nuevo profesional"
      subtitle={sites.find((x) => x.id === site)?.name ?? ""}
      dirty={dirty}
      onClose={onClose}
      handleRef={handle}
      footer={
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-[1.35] text-muted">Servicios y horario se ajustan después en su ficha</span>
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} disabled={pending} loading={pending} loadingLabel="Creando…">
            {error ? "Reintentar" : "Crear profesional"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <div className="flex items-center gap-4">
          <span aria-hidden className="flex size-[64px] shrink-0 items-center justify-center rounded-[14px] bg-[var(--chip)] text-[20px] text-muted">+</span>
          <p className="text-[12.5px] leading-[1.45] text-muted">La foto (cuadrada, mínimo 400 px) se sube desde su ficha, una vez creado. Se ve en la reserva pública.</p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Nombre completo</span>
          <input data-autofocus className={INPUT} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "sc-name-err" : undefined} />
          {nameError ? <span id="sc-name-err" role="alert" className="text-[12.5px] font-medium text-danger">{nameError}</span> : null}
        </label>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium">Cargo</span>
            <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Barbero" maxLength={80} />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium">Sede</span>
            <select className={INPUT} value={site} disabled={sites.length < 2} onChange={(e) => setSite(e.target.value)}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">
            Presentación pública <span className="font-normal text-muted">(opcional)</span>
          </span>
          <textarea className={`${INPUT} h-auto min-h-[84px] py-2.5`} rows={3} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="Una o dos frases sobre su estilo" aria-invalid={Boolean(bioError)} />
          {bioError ? <span role="alert" className="text-[12.5px] font-medium text-danger">{bioError}</span> : null}
        </label>
        <label className="flex min-h-[44px] cursor-pointer items-start gap-3">
          <input type="checkbox" role="switch" checked={takesBookings} onChange={(e) => setTakesBookings(e.target.checked)} className="u-ag-switch mt-0.5" />
          <span className="flex flex-col">
            <span className="text-[14px]">Recibe citas</span>
            <span className="text-[12.5px] leading-[1.45] text-muted">Si está apagado, aparece en Equipo pero no en la agenda ni en la reserva.</span>
          </span>
        </label>
        <p className="rounded-[10px] bg-[var(--chip)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--ag-ink2)]">
          Empieza con el horario de la sede y sin servicios asignados. Los ajustas en su ficha después de crearlo. Un profesional no es una cuenta de usuario: los accesos se gestionan en Usuarios y accesos.
        </p>
        {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      </div>
    </SidePanel>
  );
}
