"use client";

import { useState, useTransition } from "react";
import { Icon, ICON, M_SMALL, MButton, MConfirm, MPill, MToggle, Sheet } from "@/components/scheduling/mobile/kit";
import { serviceCategory } from "@/lib/agendaCategory";
import {
  addStaffCertificationAction,
  createStaffAction,
  updateStaffAction,
} from "@/lib/schedulingAdminActions";
import {
  dirtyProfileFields,
  profileFromMember,
  profilePatch,
  publicProfileError,
  type ProfileDraft,
  type StaffMember,
  type StaffServiceOpt,
} from "@/components/scheduling/staff/StaffTab";
import { FullScreen, M_INPUT, MError, MField, MSection, MSwitchRow } from "./FullScreen";
import { StaffPhotoControl } from "@/components/scheduling/staff/StaffPhotoControl";
import { PUBLIC_BIO_MAX, PUBLIC_TITLE_MAX } from "@/lib/staffPublicProfile";
import { hoursDraftError, WEEK_ORDER, WEEKDAY_ES, type Weekly } from "./presence";

/**
 * The phone FORMS of Equipo. Every one writes through the SAME server actions the desktop
 * roster uses — createStaffAction / updateStaffAction / addStaffCertificationAction — so
 * the owner/admin gate, the client scoping and the CHECK-mirroring validation all stay on
 * the server exactly as they are. What is checked here is only said earlier, never
 * instead.
 */

/** The stored employment types (staff_employment_type_valid), in Spanish. */
export const EMPLOYMENT_ES: { value: string; label: string }[] = [
  { value: "full_time", label: "Tiempo completo" },
  { value: "part_time", label: "Medio tiempo" },
  { value: "contractor", label: "Contratista" },
];
export const employmentLabel = (v: string | null) => EMPLOYMENT_ES.find((t) => t.value === v)?.label ?? null;

/** The category dot class for a service (kit pastels: u-m-cut|grooming|color|feature). */
export function categoryClass(name: string, category?: string | null): string {
  const c = serviceCategory(name, category);
  return c === "cut" || c === "grooming" || c === "color" || c === "feature" ? `u-m-${c}` : "u-m-neutral";
}

/** "Salir con cambios pide confirmación real" — the safe option first, with the focus. */
function DiscardSheet({ open, what, onKeep, onDiscard }: { open: boolean; what: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onKeep}
      alert
      label="¿Descartar los cambios?"
      footer={
        <div className="flex flex-col gap-2">
          <MButton kind="secondary" data-autofocus onClick={onKeep}>
            Seguir editando
          </MButton>
          <MButton kind="danger" onClick={onDiscard}>
            Descartar
          </MButton>
        </div>
      }
    >
      <MConfirm title="¿Descartar los cambios?" body={`Los cambios en ${what} no se guardarán.`} />
    </Sheet>
  );
}

/** Close-with-confirmation for a form: returns the guarded close + the sheet to render. */
function useGuardedClose(dirty: boolean, onClose: () => void, what: string) {
  const [asking, setAsking] = useState(false);
  const close = () => (dirty ? setAsking(true) : onClose());
  const sheet = (
    <DiscardSheet
      open={asking}
      what={what}
      onKeep={() => setAsking(false)}
      onDiscard={() => {
        // Close the confirmation FIRST and the form on the next tick. Unmounting both in
        // one commit makes the form's focus-restore run while the sheet still holds the
        // page inert, so focus would be lost instead of returning to the opener.
        setAsking(false);
        window.setTimeout(onClose, 0);
      }}
    />
  );
  return { close, sheet };
}

// ── Weekly hours editor (split shifts are storable: working_hours is an array per day) ──

export function draftFromWeekly(w: Weekly): Weekly {
  return Object.fromEntries(WEEK_ORDER.map((d) => [d, (w[d] ?? []).map((r) => ({ ...r }))]));
}
/** Drop empty days: `{}` for a weekday is "off"; an empty map is "inherit the site". */
export function weeklyFromDraft(draft: Weekly): Weekly {
  const out: Weekly = {};
  for (const d of WEEK_ORDER) if ((draft[d] ?? []).length > 0) out[d] = draft[d];
  return out;
}

const TIME = `${M_INPUT} u-tnum px-3`;

export function HoursEditor({ draft, setDraft }: { draft: Weekly; setDraft: (fn: (prev: Weekly) => Weekly) => void }) {
  return (
    <div className="overflow-hidden rounded-[16px] border border-m-bd bg-m-sf">
      {WEEK_ORDER.map((d, i) => {
        const ranges = draft[d] ?? [];
        const on = ranges.length > 0;
        const setDay = (next: { start: string; end: string }[]) => setDraft((prev) => ({ ...prev, [d]: next }));
        return (
          <div key={d} className={`flex flex-col gap-2 px-[14px] py-2 ${i ? "border-t border-m-dv" : ""}`}>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${WEEKDAY_ES[d]}: ${on ? "trabaja" : "libre"}`}
              onClick={() => setDay(on ? [] : [{ start: "09:00", end: "18:00" }])}
              className="flex min-h-[48px] w-full items-center gap-3 border-0 bg-transparent text-left text-m-tx"
            >
              <span className="flex-1 text-[16px]">{WEEKDAY_ES[d]}</span>
              <span className="text-[13px] text-m-tx3">{on ? "Trabaja" : "Libre"}</span>
              <MToggle on={on} />
            </button>
            {ranges.map((r, k) => (
              <div key={k} className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label={`${WEEKDAY_ES[d]}, tramo ${k + 1}: desde`}
                  value={r.start}
                  onChange={(e) => setDay(ranges.map((x, j) => (j === k ? { ...x, start: e.target.value } : x)))}
                  className={TIME}
                />
                <span aria-hidden className="text-m-tx3">–</span>
                <input
                  type="time"
                  aria-label={`${WEEKDAY_ES[d]}, tramo ${k + 1}: hasta`}
                  value={r.end}
                  onChange={(e) => setDay(ranges.map((x, j) => (j === k ? { ...x, end: e.target.value } : x)))}
                  className={TIME}
                />
                {ranges.length > 1 ? (
                  <button
                    type="button"
                    aria-label={`Quitar el tramo ${k + 1} del ${WEEKDAY_ES[d].toLowerCase()}`}
                    onClick={() => setDay(ranges.filter((_, j) => j !== k))}
                    className="flex size-[44px] flex-none items-center justify-center rounded-[12px] border-0 bg-transparent text-m-tx2"
                  >
                    <Icon d={ICON.close} size={18} />
                  </button>
                ) : null}
              </div>
            ))}
            {on ? (
              <button type="button" onClick={() => setDay([...ranges, { start: "15:00", end: "19:00" }])} className={`${M_SMALL} mb-1 self-start`}>
                <Icon d={ICON.plus} size={16} />
                Añadir tramo
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function HoursForm({
  open,
  clientId,
  member,
  siteName,
  openingHours,
  onClose,
  onSaved,
}: {
  open: boolean;
  clientId: string;
  member: StaffMember;
  siteName: string;
  openingHours: Weekly;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  if (!open) return null;
  return <HoursFormBody clientId={clientId} member={member} siteName={siteName} openingHours={openingHours} onClose={onClose} onSaved={onSaved} />;
}

function HoursFormBody({
  clientId,
  member,
  siteName,
  openingHours,
  onClose,
  onSaved,
}: {
  clientId: string;
  member: StaffMember;
  siteName: string;
  openingHours: Weekly;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [draft, setDraft] = useState<Weekly>(() => draftFromWeekly(member.workingHours));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stored = draftFromWeekly(member.workingHours);
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const invalid = hoursDraftError(draft);
  const { close, sheet } = useGuardedClose(dirty, onClose, "el horario");
  const save = () =>
    start(async () => {
      setError(null);
      const r = await updateStaffAction(clientId, member.id, { workingHours: weeklyFromDraft(draft) as never });
      if (!r.ok) setError(r.error);
      else onSaved("Horario guardado");
    });
  return (
    <FullScreen
      open
      onClose={close}
      backLabel={member.name}
      title="Horario semanal"
      sub={`Si todos los días quedan libres, hereda el horario de ${siteName}.`}
      footer={
        <>
          <MButton onClick={close}>Cancelar</MButton>
          <MButton kind="primary" grow disabled={!dirty || invalid !== null} loading={pending} loadingLabel="Guardando…" onClick={save}>
            Guardar horario
          </MButton>
        </>
      }
    >
      <MError message={error ?? (dirty ? invalid : null)} />
      {Object.keys(weeklyFromDraft(draft)).length === 0 ? (
        <div className="flex flex-col gap-3 rounded-[16px] bg-m-sf2 px-[14px] py-3">
          <p className="m-0 text-[15px] leading-[1.4] text-m-tx2">
            Sin horario propio: trabaja el horario de {siteName}. Activa los días para darle uno propio.
          </p>
          {Object.keys(openingHours).length > 0 ? (
            <button type="button" onClick={() => setDraft(() => draftFromWeekly(openingHours))} className={`${M_SMALL} self-start`}>
              Empezar con el horario de la sede
            </button>
          ) : null}
        </div>
      ) : null}
      <HoursEditor draft={draft} setDraft={setDraft} />
      {sheet}
    </FullScreen>
  );
}

// ── Profile (name, role, contract, contact, skills, takes bookings) ─────────────────

/** The rules the CHECK constraints (and updateStaffAction) enforce, said in Spanish first. */
export function profileErrorEs(d: ProfileDraft): string | null {
  if (d.name.trim() === "") return "El nombre es obligatorio.";
  if (d.weeklyHours !== "") {
    const n = Number(d.weeklyHours);
    if (!Number.isInteger(n) || n < 1 || n > 168) return "Las horas semanales deben ser un número entero de 1 a 168.";
  }
  if (d.employmentType !== "" && !EMPLOYMENT_ES.some((t) => t.value === d.employmentType)) return "Tipo de contrato desconocido.";
  return publicProfileError(d, "es");
}

export function ProfileForm(props: { open: boolean; clientId: string; member: StaffMember; photoUploadEnabled?: boolean; onClose: () => void; onSaved: (msg: string) => void; onPhotoChanged?: () => void }) {
  if (!props.open) return null;
  return <ProfileFormBody {...props} />;
}

function ProfileFormBody({
  clientId,
  member,
  photoUploadEnabled = false,
  onClose,
  onSaved,
  onPhotoChanged,
}: {
  clientId: string;
  member: StaffMember;
  photoUploadEnabled?: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onPhotoChanged?: () => void;
}) {
  const [profile, setProfile] = useState<ProfileDraft>(() => profileFromMember(member));
  const [skill, setSkill] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = dirtyProfileFields(profile, member);
  const invalid = profileErrorEs(profile);
  const { close, sheet } = useGuardedClose(dirty.length > 0, onClose, "el perfil");
  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => setProfile((d) => ({ ...d, [k]: v }));
  const addSkill = () => {
    const v = skill.trim();
    if (v && !profile.skills.includes(v)) set("skills", [...profile.skills, v]);
    setSkill("");
  };
  const save = () =>
    start(async () => {
      setError(null);
      // Only the changed fields, translated exactly as the desktop panel does ("" → null).
      const r = await updateStaffAction(clientId, member.id, profilePatch(profile, dirty) as Parameters<typeof updateStaffAction>[2]);
      if (!r.ok) setError(r.error);
      else onSaved("Perfil guardado");
    });
  const text = (k: "name" | "title" | "phone" | "email" | "emergencyContactName" | "emergencyContactPhone", label: string, opts: { type?: string; placeholder?: string; auto?: string; mode?: "tel" | "email" | "text" } = {}) => (
    <MField label={label} htmlFor={`m-prof-${k}`}>
      <input
        id={`m-prof-${k}`}
        type={opts.type ?? "text"}
        inputMode={opts.mode}
        autoComplete={opts.auto ?? "off"}
        value={profile[k]}
        onChange={(e) => set(k, e.target.value)}
        placeholder={opts.placeholder}
        className={M_INPUT}
      />
    </MField>
  );
  return (
    <FullScreen
      open
      onClose={close}
      backLabel={member.name}
      title="Editar perfil"
      sub={dirty.length > 0 ? "Cambios sin guardar" : undefined}
      footer={
        <>
          <MButton onClick={close}>Cancelar</MButton>
          <MButton kind="primary" grow disabled={dirty.length === 0 || invalid !== null} loading={pending} loadingLabel="Guardando…" onClick={save}>
            Guardar cambios
          </MButton>
        </>
      }
    >
      <MError message={error ?? (dirty.length > 0 ? invalid : null)} />
      <MSection title="Identidad">
        <div className="flex flex-col gap-4">
          {text("name", "Nombre", { placeholder: "Nombre completo" })}
          {text("title", "Cargo", { placeholder: "Ej.: Barbero, Colorista" })}
        </div>
      </MSection>
      <MSection title="Contrato">
        <div className="flex flex-col gap-4">
          <MField label="Tipo de contrato" htmlFor="m-prof-emp">
            <span className="u-focus relative flex">
              <select
                id="m-prof-emp"
                value={profile.employmentType}
                onChange={(e) => set("employmentType", e.target.value)}
                className={`${M_INPUT} appearance-none pr-10 outline-none`}
              >
                <option value="">Sin definir</option>
                {EMPLOYMENT_ES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
              <span aria-hidden className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2 rotate-90 text-m-tx3">
                <Icon d={ICON.next} size={16} />
              </span>
            </span>
          </MField>
          <MField label="Horas semanales" hint="(1–168)" htmlFor="m-prof-weekly">
            <input
              id="m-prof-weekly"
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              value={profile.weeklyHours}
              onChange={(e) => set("weeklyHours", e.target.value)}
              placeholder="Sin definir"
              className={M_INPUT}
            />
          </MField>
          <MField label="Fecha de inicio" htmlFor="m-prof-start">
            <input id="m-prof-start" type="date" value={profile.startDate} onChange={(e) => set("startDate", e.target.value)} className={M_INPUT} />
          </MField>
          <MSwitchRow
            on={profile.takesBookings}
            onChange={(v) => set("takesBookings", v)}
            label="Recibe citas"
            hint="Apágalo para recepción o administración: trabaja aquí, pero no tiene silla."
          />
        </div>
      </MSection>
      <MSection title="Perfil público">
        <div className="flex flex-col gap-4">
          <p className="text-[14px] leading-[1.45] text-m-tx2">Se muestra en la página de reservas. No incluyas teléfonos, correos ni enlaces.</p>
          <StaffPhotoControl
            clientId={clientId}
            staffId={member.id}
            name={member.name}
            photoUrl={member.publicPhotoUrl}
            enabled={photoUploadEnabled}
            lang="es"
            onChanged={() => onPhotoChanged?.()}
          />
          <MField label="Título público" htmlFor="m-prof-ptitle">
            <input
              id="m-prof-ptitle"
              value={profile.publicTitle}
              onChange={(e) => set("publicTitle", e.target.value)}
              placeholder="Ej.: Barbero profesional"
              maxLength={PUBLIC_TITLE_MAX + 10}
              className={M_INPUT}
            />
          </MField>
          <MField label="Presentación" hint={`(${profile.publicBio.trim().length}/${PUBLIC_BIO_MAX})`} htmlFor="m-prof-pbio">
            <textarea
              id="m-prof-pbio"
              value={profile.publicBio}
              onChange={(e) => set("publicBio", e.target.value)}
              rows={5}
              maxLength={PUBLIC_BIO_MAX + 40}
              placeholder="Una presentación breve que el cliente lee antes de elegir."
              className={`${M_INPUT} h-auto min-h-[120px] py-3 leading-[1.5]`}
            />
          </MField>
        </div>
      </MSection>
      <MSection title="Contacto">
        <div className="flex flex-col gap-4">
          {text("phone", "Teléfono", { type: "tel", mode: "tel", auto: "off" })}
          {text("email", "Correo", { type: "email", mode: "email" })}
          {text("emergencyContactName", "Contacto de emergencia")}
          {text("emergencyContactPhone", "Teléfono de emergencia", { type: "tel", mode: "tel" })}
        </div>
      </MSection>
      <MSection title="Habilidades">
        <div className="flex flex-col gap-3">
          {profile.skills.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {profile.skills.map((sk) => (
                <span key={sk} className="inline-flex min-h-[44px] items-center gap-1 rounded-[12px] border border-m-bd bg-m-sf pl-[14px] text-[15px]">
                  {sk}
                  <button
                    type="button"
                    aria-label={`Quitar ${sk}`}
                    onClick={() => set("skills", profile.skills.filter((x) => x !== sk))}
                    className="flex size-[44px] items-center justify-center border-0 bg-transparent text-m-tx2"
                  >
                    <Icon d={ICON.close} size={16} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <input
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSkill();
                }
              }}
              placeholder="Nueva habilidad"
              aria-label="Añadir una habilidad"
              className={M_INPUT}
            />
            <button type="button" onClick={addSkill} disabled={!skill.trim()} className={`${M_SMALL} h-12`}>
              Añadir
            </button>
          </div>
        </div>
      </MSection>
      {sheet}
    </FullScreen>
  );
}

// ── Certification (its own row: a create, not a field edit) ─────────────────────────

export function CertForm(props: { open: boolean; clientId: string; member: StaffMember; onClose: () => void; onSaved: (msg: string) => void }) {
  if (!props.open) return null;
  return <CertFormBody {...props} />;
}

function CertFormBody({ clientId, member, onClose, onSaved }: { clientId: string; member: StaffMember; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = Boolean(name || issuer || issuedOn || expiresOn);
  const bad = issuedOn && expiresOn && expiresOn < issuedOn ? "La fecha de vencimiento no puede ser anterior a la de emisión." : null;
  const { close, sheet } = useGuardedClose(dirty, onClose, "la certificación");
  const save = () =>
    start(async () => {
      setError(null);
      const r = await addStaffCertificationAction({ clientId, staffId: member.id, name: name.trim(), issuer: issuer.trim() || null, issuedOn: issuedOn || null, expiresOn: expiresOn || null });
      if (!r.ok) setError(r.error);
      else onSaved("Certificación añadida");
    });
  return (
    <FullScreen
      open
      onClose={close}
      backLabel={member.name}
      title="Nueva certificación"
      footer={
        <>
          <MButton onClick={close}>Cancelar</MButton>
          <MButton kind="primary" grow disabled={!name.trim() || bad !== null} loading={pending} loadingLabel="Guardando…" onClick={save}>
            Añadir certificación
          </MButton>
        </>
      }
    >
      <MError message={error ?? bad} />
      <MField label="Nombre" htmlFor="m-cert-name">
        <input id="m-cert-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Colorimetría avanzada" className={M_INPUT} />
      </MField>
      <MField label="Emisor" hint="(opcional)" htmlFor="m-cert-issuer">
        <input id="m-cert-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} className={M_INPUT} />
      </MField>
      <div className="grid grid-cols-2 gap-2">
        <MField label="Emitida" htmlFor="m-cert-issued">
          <input id="m-cert-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} className={M_INPUT} />
        </MField>
        <MField label="Vence" htmlFor="m-cert-expires">
          <input id="m-cert-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} className={M_INPUT} />
        </MField>
      </div>
      {sheet}
    </FullScreen>
  );
}

// ── Create a professional (the existing create flow: one create + the hours patch) ──

export function CreateForm(props: {
  open: boolean;
  clientId: string;
  siteId?: string;
  siteName: string;
  services: StaffServiceOpt[];
  onClose: () => void;
  onCreated: (id: string | undefined) => void;
}) {
  if (!props.open) return null;
  return <CreateFormBody {...props} />;
}

function CreateFormBody({
  clientId,
  siteId,
  siteName,
  services,
  onClose,
  onCreated,
}: {
  clientId: string;
  siteId?: string;
  siteName: string;
  services: StaffServiceOpt[];
  onClose: () => void;
  onCreated: (id: string | undefined) => void;
}) {
  const [name, setName] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<Weekly>(() => draftFromWeekly({}));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const active = services.filter((s) => s.active);
  const hoursBad = hoursDraftError(draft);
  const dirty = Boolean(name.trim()) || serviceIds.length > 0 || Object.keys(weeklyFromDraft(draft)).length > 0;
  const { close, sheet } = useGuardedClose(dirty, onClose, "el nuevo profesional");
  const save = () =>
    start(async () => {
      setError(null);
      const trimmed = name.trim();
      if (!trimmed) return setError("El nombre es obligatorio.");
      if (!siteId) return setError("Este cliente todavía no tiene sede.");
      // The same two calls the desktop create drawer makes.
      const r = await createStaffAction({ clientId, siteId, name: trimmed, serviceIds });
      if (!r.ok) return setError(r.error);
      const workingHours = weeklyFromDraft(draft);
      if (Object.keys(workingHours).length > 0 && r.id) {
        const h = await updateStaffAction(clientId, r.id, { workingHours: workingHours as never });
        if (!h.ok) return setError(h.error);
      }
      onCreated(r.id);
    });
  return (
    <FullScreen
      open
      onClose={close}
      backLabel="Equipo"
      title="Nuevo profesional"
      sub={`En ${siteName}. Cargo, contacto y habilidades se editan en su perfil después.`}
      footer={
        <>
          <MButton onClick={close}>Cancelar</MButton>
          <MButton kind="primary" grow disabled={!name.trim() || hoursBad !== null} loading={pending} loadingLabel="Guardando…" onClick={save}>
            Añadir profesional
          </MButton>
        </>
      }
    >
      <MError message={error ?? hoursBad} />
      <MField label="Nombre" htmlFor="m-new-name">
        <input id="m-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre completo" autoComplete="off" className={M_INPUT} />
      </MField>
      <MField label="Sede" htmlFor="m-new-site">
        <input id="m-new-site" value={siteName} disabled readOnly className={M_INPUT} />
      </MField>
      <MSection title="Servicios" meta={active.length > 0 ? `${serviceIds.length} de ${active.length}` : undefined}>
        {active.length === 0 ? (
          <p className="m-0 text-[14px] text-m-tx3">Este cliente todavía no tiene servicios activos.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {active.map((s) => (
              <span key={s.id} className={categoryClass(s.name, s.category)}>
                <MPill
                  selected={serviceIds.includes(s.id)}
                  dot="flex-none"
                  onClick={() => setServiceIds((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))}
                >
                  {s.name}
                </MPill>
              </span>
            ))}
          </div>
        )}
      </MSection>
      <MSection title="Horario semanal" meta="Todo libre = horario de la sede">
        <HoursEditor draft={draft} setDraft={setDraft} />
      </MSection>
      {sheet}
    </FullScreen>
  );
}
