"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { findContactMatchesAction, saveAppointmentContactAction } from "@/lib/appointmentContactActions";
import type { ContactMatch, GuestField } from "@/lib/walkInContact";
import { INPUT } from "../ui/system";

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
  const [matchState, setMatches] = useState<{ forKey: string; list: ContactMatch[] }>({ forKey: "", list: [] });
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);

  const dirty =
    name.trim() !== (props.initial.name ?? "") || phone.trim() !== (props.initial.phone ?? "") || email.trim() !== (props.initial.email ?? "");
  const onDirty = props.onDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // Duplicate check while typing (read-only, debounced): who already has this phone/email.
  const typedKey = `${phone.trim()}|${email.trim()}`;
  const searchable = phone.trim().replace(/\D/g, "").length >= 7 || /@.+\./.test(email.trim());
  const matches = searchable && matchState.forKey === typedKey ? matchState.list : [];
  useEffect(() => {
    if (!props.canModify || !searchable) return;
    const p = phone.trim();
    const e = email.trim();
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await findContactMatchesAction(props.clientId, { siteId: props.siteId, phone: p || null, email: e || null });
      if (!cancelled) setMatches({ forKey: `${p}|${e}`, list: r.ok ? r.matches : [] });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, email, searchable, props.clientId, props.siteId, props.canModify]);

  const send = (mode: "guest" | "create" | "link", contactId?: string) => {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const r = await saveAppointmentContactAction(props.clientId, props.appointmentId, { mode, name, phone, email, contactId });
        if (!r.ok) {
          setErrors(r.fieldErrors ?? {});
          if (r.matches) setMatches({ forKey: typedKey, list: r.matches });
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
      <div className="flex flex-col gap-1 text-[13.5px]">
        <p className="font-medium">{props.initial.name ?? "Sin nombre"}</p>
        {props.initial.phone ? <p className="tabular-nums text-muted">{props.initial.phone}</p> : null}
        {props.initial.email ? <p className="text-muted">{props.initial.email}</p> : null}
        <p className="text-muted">Sin contacto vinculado.</p>
      </div>
    );
  }

  const SMALL = "u-focus inline-flex h-[32px] items-center gap-1.5 self-start whitespace-nowrap rounded-[9px] border border-[var(--line-strong)] bg-[var(--surface)] px-3 text-[13px] text-foreground transition-colors hover:bg-[var(--subtle)] disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-[13px] text-[var(--ag-ink2)]">Sin contacto vinculado · añade un teléfono o un correo para crear su ficha</span>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">
          Nombre <span className="font-normal text-muted">(opcional)</span>
        </span>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "gc-name-err" : undefined} />
        {errors.name ? <span id="gc-name-err" role="alert" className="text-[12.5px] font-medium text-danger">{errors.name}</span> : null}
      </label>
      <div className="grid grid-cols-2 gap-2.5">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium">Teléfono</span>
          <input className={INPUT} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="off" placeholder="+57 300 000 0000" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? "gc-phone-err" : undefined} />
          {errors.phone ? <span id="gc-phone-err" role="alert" className="text-[12.5px] font-medium text-danger">{errors.phone}</span> : null}
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[13px] font-medium">Correo</span>
          <input className={INPUT} type="email" value={email} onChange={(e) => setEmail(e.target.value)} inputMode="email" autoComplete="off" placeholder="nombre@correo.com" aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? "gc-email-err" : undefined} />
          {errors.email ? <span id="gc-email-err" role="alert" className="text-[12.5px] font-medium text-danger">{errors.email}</span> : null}
        </label>
      </div>
      {emailOnly ? <p className="text-[12.5px] text-muted">Con solo un correo no se le puede escribir por WhatsApp.</p> : null}

      {matches.length > 0 ? (
        <div role="alert" className="flex flex-col gap-2 rounded-[10px] bg-[var(--warn-soft)] px-3 py-2.5 text-[13px] leading-[1.45] text-[var(--warn)]">
          <span>
            {matches.length === 1
              ? `Ya existe un contacto con ${matches[0].matchedBy === "phone" ? "este teléfono" : "este correo"}: ${matches[0].name ?? "Sin nombre"} (${matches[0].matchedValue}).`
              : `Ya existen ${matches.length} contactos con estos datos.`}{" "}
            Vincula en lugar de crear otro.
          </span>
          <div className="flex flex-wrap gap-2">
            {matches.map((m) => (
              <button key={m.contactId} type="button" className={SMALL} onClick={() => send("link", m.contactId)} disabled={pending}>
                Vincular a {m.name ?? m.matchedValue}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-[12.5px] font-medium text-danger">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={SMALL} onClick={() => send("create")} disabled={pending || matches.length > 0}>
          {pending ? "Guardando…" : "Guardar contacto"}
        </button>
        <button type="button" className={SMALL} onClick={() => send("guest")} disabled={pending || !dirty}>
          Guardar sin crear contacto
        </button>
      </div>
    </div>
  );
}
