"use client";

import { useRef, useState, useTransition } from "react";
import { createStaffAction, updateStaffAction } from "@/lib/schedulingAdminActions";
import { Button, INPUT } from "../ui/system";
import { SidePanel, PanelSection, type SidePanelHandle } from "../agenda/SidePanel";
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
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const dirty = Boolean(name.trim() || title.trim() || phone.trim() || email.trim() || serviceIds.length || !takesBookings);
  const nameError = touched && !name.trim() ? "Escribe el nombre." : null;
  const emailError = email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Revisa el correo." : null;
  const activeServices = services.filter((s) => s.active);
  const toggle = (id: string) => setServiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = () => {
    setTouched(true);
    if (!name.trim() || emailError || !site || sending.current) return;
    sending.current = true;
    setError(null);
    start(async () => {
      try {
        const r = await createStaffAction({ clientId, siteId: site, name: name.trim(), serviceIds });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        const patch: Parameters<typeof updateStaffAction>[2] = {};
        if (title.trim()) patch.title = title.trim();
        if (!takesBookings) patch.takesBookings = false;
        if (phone.trim()) patch.phone = phone.trim();
        if (email.trim()) patch.email = email.trim();
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
      subtitle="Servicios y horario se ajustan después en su ficha."
      dirty={dirty}
      onClose={onClose}
      handleRef={handle}
      footer={
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{name.trim() ? `Atiende con el horario de la sede` : "El nombre es obligatorio"}</span>
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} disabled={pending} loading={pending} loadingLabel="Creando…">
            {error ? "Reintentar" : "Crear profesional"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col">
        <PanelSection title="Identidad" id="sc-id">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Nombre</span>
            <input data-autofocus className={INPUT} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setTouched(true)} placeholder="Nombre completo" aria-invalid={Boolean(nameError)} aria-describedby={nameError ? "sc-name-err" : undefined} />
            {nameError ? <span id="sc-name-err" className="text-[12.5px] text-danger">{nameError}</span> : null}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Rol <span className="font-normal text-muted">· opcional</span></span>
            <input className={INPUT} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ej. Barbero, Colorista" maxLength={80} />
          </label>
          {sites.length > 1 ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Sede</span>
              <select className={INPUT} value={site} onChange={(e) => setSite(e.target.value)}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <span className="text-[12.5px] text-muted">Un profesional pertenece a una sola sede.</span>
            </label>
          ) : (
            <p className="text-[13px] text-muted">Sede: {sites[0]?.name ?? "—"}</p>
          )}
          <label className="flex min-h-[44px] items-start gap-2.5 text-[13px]">
            <input type="checkbox" checked={takesBookings} onChange={(e) => setTakesBookings(e.target.checked)} className="mt-0.5 size-4 accent-[var(--foreground)]" />
            <span>
              <span className="font-medium">Recibe citas</span>
              <span className="block text-[12.5px] text-muted">Aparece en la agenda y se le pueden asignar reservas.</span>
            </span>
          </label>
        </PanelSection>

        <PanelSection title={<>Contacto de trabajo <span className="font-normal text-muted">· opcional</span></>} id="sc-contact" hint="Solo lo ve el equipo administrador. No le da acceso al sistema: eso se hace en Usuarios y accesos.">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Teléfono</span>
              <input className={INPUT} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Correo</span>
              <input className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" aria-invalid={Boolean(emailError)} />
              {emailError ? <span className="text-[12.5px] text-danger">{emailError}</span> : null}
            </label>
          </div>
        </PanelSection>

        <PanelSection title="Servicios" id="sc-services" hint={`${serviceIds.length} de ${activeServices.length}`}>
          {activeServices.length === 0 ? (
            <p className="text-[13px] text-muted">Este negocio todavía no tiene servicios activos.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {activeServices.map((s) => {
                const on = serviceIds.includes(s.id);
                return (
                  <button key={s.id} type="button" aria-pressed={on} onClick={() => toggle(s.id)} className={`u-focus inline-flex h-11 items-center rounded-full border px-3 text-[13px] transition-colors md:h-9 ${on ? "border-foreground bg-foreground text-background" : "border-line hover:bg-subtle"}`}>
                    {s.name}
                  </button>
                );
              })}
            </div>
          )}
        </PanelSection>
        {error ? <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p> : null}
      </div>
    </SidePanel>
  );
}
