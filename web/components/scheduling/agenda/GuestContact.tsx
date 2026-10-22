"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { findContactMatchesAction, saveAppointmentContactAction } from "@/lib/appointmentContactActions";
import type { ContactMatch, GuestField } from "@/lib/walkInContact";
import { Button, INPUT } from "../ui/system";

/**
 * The CLIENT of an appointment with NO linked contact (a walk-in registered as a guest).
 * Whether it has a contact is its contact_id — never its display name. Nombre, then
 * Teléfono and Correo below it, prefilled with what was saved. Three outcomes:
 *   Guardar datos     keep / correct what is typed, still without a contact
 *   Guardar contacto  create one — needs a valid phone or email; if a contact already
 *                     holds it, it is offered to LINK instead (nothing is duplicated)
 *   Vincular          attach the matching contact
 * Errors keep every value and sit under their field; one request at a time.
 */
export function GuestContact(props: {
  clientId: string;
  siteId: string;
  appointmentId: string;
  canModify: boolean;
  initial: { name: string | null; phone: string | null; email: string | null };
  onDirty: (dirty: boolean) => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(props.initial.name ?? "");
  const [phone, setPhone] = useState(props.initial.phone ?? "");
  const [email, setEmail] = useState(props.initial.email ?? "");
  const [errors, setErrors] = useState<Partial<Record<GuestField, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ContactMatch[]>([]);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);

  const dirty =
    name.trim() !== (props.initial.name ?? "") || phone.trim() !== (props.initial.phone ?? "") || email.trim() !== (props.initial.email ?? "");
  const onDirty = props.onDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Duplicate check while typing (read-only, debounced): who already has this phone/email.
  useEffect(() => {
    if (!props.canModify) return;
    const p = phone.trim();
    const e = email.trim();
    if (p.replace(/\D/g, "").length < 7 && !/@.+\./.test(e)) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await findContactMatchesAction(props.clientId, { siteId: props.siteId, phone: p || null, email: e || null });
      if (!cancelled) setMatches(r.ok ? r.matches : []);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, email, props.clientId, props.siteId, props.canModify]);

  const send = (mode: "guest" | "create" | "link", contactId?: string) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await saveAppointmentContactAction(props.clientId, props.appointmentId, { mode, name, phone, email, contactId });
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          if (r.matches) setMatches(r.matches);
          setError(r.fieldErrors ? null : r.error);
          return;
        }
        setErrors({});
        props.onSaved(mode === "guest" ? "Datos guardados" : mode === "create" ? "Contacto creado y vinculado" : "Contacto vinculado");
      } catch {
        setError("No se pudo guardar. Tus datos siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

  const emailOnly = !phone.trim() && email.trim().length > 0;

  if (!props.canModify) {
    return (
      <div className="flex flex-col gap-1 text-[13px]">
        <p className="font-medium">{props.initial.name ?? "Sin nombre"}</p>
        {props.initial.phone ? <p className="u-mono text-muted">{props.initial.phone}</p> : null}
        {props.initial.email ? <p className="text-muted">{props.initial.email}</p> : null}
        <p className="text-muted">Sin contacto vinculado.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Nombre</span>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "gc-name-err" : undefined} />
        {errors.name ? <span id="gc-name-err" className="text-[12.5px] text-danger">{errors.name}</span> : null}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Teléfono</span>
          <input className={INPUT} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="+57 300 000 0000" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? "gc-phone-err" : undefined} />
          {errors.phone ? <span id="gc-phone-err" className="text-[12.5px] text-danger">{errors.phone}</span> : null}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Correo</span>
          <input className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoComplete="off" placeholder="nombre@correo.com" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "gc-email-err" : undefined} />
          {errors.email ? <span id="gc-email-err" className="text-[12.5px] text-danger">{errors.email}</span> : null}
        </label>
      </div>
      {emailOnly ? <p className="text-[12.5px] text-muted">Con solo un correo no se le puede escribir por WhatsApp.</p> : null}

      {matches.length > 0 ? (
        <div role="status" className="flex flex-col gap-2 rounded-[12px] border border-line px-3.5 py-3">
          <p className="text-[13px] font-medium">
            {matches.length === 1 ? "Ya existe un contacto con estos datos" : `Ya existen ${matches.length} contactos con estos datos`}
          </p>
          {matches.map((m) => (
            <div key={m.contactId} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{m.name ?? "Sin nombre"}</p>
                <p className="u-mono truncate text-[12px] text-muted">
                  {m.matchedBy === "phone" ? "Teléfono" : "Correo"} · {m.matchedValue}
                </p>
              </div>
              <Button size="sm" onClick={() => send("link", m.contactId)} disabled={pending}>
                Vincular
              </Button>
            </div>
          ))}
          <p className="text-[12.5px] text-muted">Vincula en lugar de crear otro contacto con el mismo dato.</p>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => send("guest")} disabled={pending || !dirty}>
          Guardar datos
        </Button>
        <Button size="sm" variant="primary" onClick={() => send("create")} disabled={pending || matches.length > 0} loading={pending} loadingLabel="Guardando…">
          Guardar contacto
        </Button>
      </div>
      <p className="text-[12.5px] leading-5 text-muted">«Guardar datos» los deja en esta cita sin crear un contacto. Para un contacto basta un teléfono o un correo.</p>
    </div>
  );
}
