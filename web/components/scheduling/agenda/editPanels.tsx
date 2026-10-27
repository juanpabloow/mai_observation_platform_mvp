"use client";

import { useEffect, useId, useMemo, useState, useTransition, type ReactNode } from "react";
import { changeAppointmentServiceAction, correctAppointmentTimeAction, rescheduleAppointmentAction } from "@/lib/schedulingActions";
import { getAppointmentPaymentHistoryAction, voidPaymentAction } from "@/lib/paymentActions";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate, siteDayKey, siteLocalToUtc } from "@/lib/siteCalendar";
import { apptWho, durationText, findOverlap, type EditableAppt } from "@/lib/appointmentEdit";
import { AgAvatar } from "./AgendaChrome";
import { TimeSelect } from "./ScheduleFormParts";
import type { Appt } from "../AgendaView";

/**
 * JP-5 — the inline editors that open UNDER the row they change, inside the appointment card
 * (desktop panel and phone sheet alike). Each previews the outcome in plain words and checks the
 * conflict BEFORE Save; Save is enabled only when the change is valid. The vocabulary is one verb
 * from the row control to the title to the button to the toast. Every editor still calls the
 * SAME JP-4 server action, which re-checks permission and the rule and is the authority on save.
 */

export interface ServiceOption {
  id: string;
  name: string;
  duration_min: number;
  price: string | null;
}
export interface StaffOption {
  id: string;
  name: string;
  photoUrl?: string | null;
  tint?: "1" | "2" | "3" | "4";
}

/** The shared inline container: title, the control, a live preview, a conflict/error line, and
 *  the Guardar/Volver footer. No layout jump — it expands in place under the row. */
function EditorShell(props: {
  title: string;
  children: ReactNode;
  /** The plain-words outcome, e.g. "Termina 19:40 · 40 min · $45.000". */
  preview?: ReactNode;
  /** A quiet note shown above the footer (e.g. the correction notice). */
  note?: ReactNode;
  /** A live conflict (not yet a server error) — blocks Save. */
  conflict?: string | null;
  /** A server error after a failed save. */
  error?: string | null;
  saveLabel: string;
  savingLabel?: string;
  canSave: boolean;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="c5-edit mt-2 flex flex-col gap-3 rounded-[12px] border border-[var(--c5-ctrl-bd)] bg-[var(--c5-field)] p-3">
      <h4 className="text-[13px] font-[590]">{props.title}</h4>
      {props.children}
      {props.conflict ? (
        <p role="alert" className="c5-box c5-amber text-[13px]">
          {props.conflict}
        </p>
      ) : props.preview ? (
        <p className="c5-num text-[13px] text-[var(--c5-tx2)]">{props.preview}</p>
      ) : null}
      {props.note ? <p className="c5-note">{props.note}</p> : null}
      {props.error ? (
        <p role="alert" className="c5-box c5-red text-[13px]">
          {props.error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" data-size="sm" className="u-focus c5-btn" onClick={props.onCancel} disabled={props.pending}>
          Volver
        </button>
        <button
          type="button"
          data-size="sm"
          data-kind="primary"
          aria-busy={props.pending || undefined}
          className="u-focus c5-btn"
          onClick={props.onSave}
          disabled={!props.canSave || props.pending}
        >
          {props.pending ? props.savingLabel ?? "Guardando…" : props.saveLabel}
        </button>
      </div>
    </div>
  );
}

/** "Choca con la cita de Ana a las 19:30 con Federico." — names the clash the person can act on. */
function conflictLine(a: EditableAppt, tz: string): string {
  return `Choca con la cita de ${apptWho(a)} a las ${fmtTime(a.start_at, tz)}${a.staff_name ? ` con ${a.staff_name}` : ""}.`;
}

// ── Servicio ────────────────────────────────────────────────────────────────────────────────
export function ServiceEditor(props: {
  clientId: string;
  appt: Appt;
  services: ServiceOption[];
  others: EditableAppt[];
  timezone: string;
  onCancel: () => void;
  onDone: (verb: string) => void;
}) {
  const { appt, timezone: tz } = props;
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const options = useMemo(() => {
    const list = [...props.services];
    if (!list.some((s) => s.id === appt.service_id)) {
      list.unshift({ id: appt.service_id, name: appt.service_name, duration_min: appt.duration_min, price: appt.price });
    }
    return list;
  }, [props.services, appt.service_id, appt.service_name, appt.duration_min, appt.price]);

  const picked = choice && choice !== appt.service_id ? options.find((s) => s.id === choice) ?? null : null;
  const startMs = Date.parse(appt.start_at);
  const newEndMs = picked ? startMs + picked.duration_min * 60_000 : startMs;
  const clash = picked ? findOverlap(props.others, { staffId: appt.staff_id, startMs, endMs: newEndMs, excludeId: appt.id }) : null;
  const preview = picked
    ? `Termina ${fmtTime(new Date(newEndMs).toISOString(), tz)} · ${durationText(picked.duration_min)}${picked.price ? ` · ${priceLabelCOP(picked.price)}` : ""}`
    : null;

  const save = () => {
    if (!picked || clash || pending) return;
    setError(null);
    const id = picked.id;
    startTransition(async () => {
      try {
        const r = await changeAppointmentServiceAction(props.clientId, appt.id, id);
        if (!r.ok) return setError(r.error);
        props.onDone("Servicio cambiado");
      } catch {
        setError("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      }
    });
  };

  return (
    <EditorShell
      title="Cambiar servicio"
      preview={preview}
      conflict={clash ? conflictLine(clash, tz) : null}
      error={error}
      saveLabel="Guardar cambio"
      canSave={Boolean(picked) && !clash}
      pending={pending}
      onSave={save}
      onCancel={props.onCancel}
    >
      <div role="radiogroup" aria-label="Servicio" className="flex max-h-[240px] flex-col gap-1.5 overflow-y-auto pr-0.5">
        {options.map((s) => {
          const current = s.id === appt.service_id;
          const sel = s.id === (choice ?? appt.service_id);
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={sel}
              onClick={() => {
                setChoice(s.id);
                setError(null);
              }}
              className={`u-focus flex min-h-[44px] items-center gap-3 rounded-[10px] border px-3 py-2 text-left transition-colors ${
                sel ? "border-[var(--c5-pri)] shadow-[inset_0_0_0_1px_var(--c5-pri)]" : "border-[var(--c5-ctrl-bd)] bg-[var(--c5-bg)] hover:bg-[var(--c5-hover)]"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {s.name}
                  {current ? <span className="ml-2 text-[11.5px] font-normal text-[var(--c5-sec)]">Actual</span> : null}
                </span>
                <span className="block text-[12px] text-[var(--c5-sec)]">{durationText(s.duration_min)}</span>
              </span>
              <span className="c5-num shrink-0 text-[12px] text-[var(--c5-sec)]">{s.price ? priceLabelCOP(s.price) : "Sin precio"}</span>
            </button>
          );
        })}
      </div>
    </EditorShell>
  );
}

// ── Profesional ─────────────────────────────────────────────────────────────────────────────
export function StaffEditor(props: {
  clientId: string;
  appt: Appt;
  staff: StaffOption[];
  others: EditableAppt[];
  timezone: string;
  /** Future appointment → reschedule (availability rules); past/completed → a correction. */
  reschedule: boolean;
  onCancel: () => void;
  onDone: (verb: string) => void;
}) {
  const { appt, timezone: tz } = props;
  const [staffId, setStaffId] = useState(appt.staff_id);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changed = staffId !== appt.staff_id;
  const startMs = Date.parse(appt.start_at);
  const endMs = Date.parse(appt.service_end_at);
  const clash = changed ? findOverlap(props.others, { staffId, startMs, endMs, excludeId: appt.id }) : null;
  const target = props.staff.find((s) => s.id === staffId);
  const preview = changed ? `Pasa a ${target?.name ?? "otro profesional"} · misma hora, ${fmtTime(appt.start_at, tz)}–${fmtTime(appt.service_end_at, tz)}` : null;

  const save = () => {
    if (!changed || clash || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = props.reschedule
          ? await rescheduleAppointmentAction(props.clientId, appt.id, appt.start_at, staffId, { startAt: appt.start_at, staffId: appt.staff_id })
          : await correctAppointmentTimeAction(props.clientId, appt.id, appt.start_at, staffId, null);
        if (!r.ok) return setError(r.error);
        props.onDone("Profesional cambiado");
      } catch {
        setError("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      }
    });
  };

  return (
    <EditorShell
      title="Cambiar profesional"
      preview={preview}
      conflict={clash ? conflictLine(clash, tz) : null}
      note={props.reschedule ? null : "Es una corrección: no se le avisa al cliente."}
      error={error}
      saveLabel="Guardar cambio"
      canSave={changed && !clash}
      pending={pending}
      onSave={save}
      onCancel={props.onCancel}
    >
      <div role="radiogroup" aria-label="Profesional" className="flex flex-wrap gap-2">
        {props.staff.map((s) => {
          const sel = s.id === staffId;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={sel}
              onClick={() => {
                setStaffId(s.id);
                setError(null);
              }}
              className={`u-focus flex h-[40px] items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[13px] transition-[box-shadow] ${
                sel ? "border-[var(--c5-pri)] font-[590] shadow-[inset_0_0_0_1px_var(--c5-pri)]" : "border-[var(--c5-ctrl-bd)] hover:bg-[var(--c5-hover)]"
              }`}
            >
              <AgAvatar name={s.name} id={s.id} size={22} tint={s.tint} photoUrl={s.photoUrl ?? null} />
              {firstName(s.name)}
              {s.id === appt.staff_id ? <span className="text-[11px] font-normal text-[var(--c5-sec)]">Actual</span> : null}
            </button>
          );
        })}
      </div>
    </EditorShell>
  );
}

// ── Fecha y hora · correction (past / completed) ────────────────────────────────────────────
export function TimeCorrectionEditor(props: {
  clientId: string;
  appt: Appt;
  others: EditableAppt[];
  timezone: string;
  onCancel: () => void;
  onDone: (verb: string) => void;
}) {
  const { appt, timezone: tz } = props;
  const startDay = siteDayKey(appt.start_at, tz);
  const [day, setDay] = useState(startDay);
  const [time, setTime] = useState(fmtTime(appt.start_at, tz));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dayId = useId();

  const newStart = useMemo(() => siteLocalToUtc(day, time, tz), [day, time, tz]);
  const changed = Boolean(newStart) && newStart!.getTime() !== Date.parse(appt.start_at);
  const newEnd = newStart ? new Date(newStart.getTime() + appt.duration_min * 60_000) : null;
  const clash = changed && newStart && newEnd ? findOverlap(props.others, { staffId: appt.staff_id, startMs: newStart.getTime(), endMs: newEnd.getTime(), excludeId: appt.id }) : null;
  const preview = newStart && newEnd ? `${longDate(newStart.toISOString(), tz)} · ${fmtTime(newStart.toISOString(), tz)}–${fmtTime(newEnd.toISOString(), tz)} · ${durationText(appt.duration_min)}` : "Hora no válida";

  const save = () => {
    if (!changed || !newStart || clash || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await correctAppointmentTimeAction(props.clientId, appt.id, newStart.toISOString(), null, reason.trim() || null);
        if (!r.ok) return setError(r.error);
        props.onDone("Fecha y hora cambiadas");
      } catch {
        setError("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      }
    });
  };

  return (
    <EditorShell
      title="Cambiar fecha y hora"
      preview={changed ? preview : null}
      conflict={clash ? conflictLine(clash, tz) : null}
      note="Es una corrección: no se le avisa al cliente."
      error={error}
      saveLabel="Guardar cambio"
      canSave={changed && !clash && Boolean(newStart)}
      pending={pending}
      onSave={save}
      onCancel={props.onCancel}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-[12.5px] font-[590]">
          Día
          <input
            id={dayId}
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value || startDay);
              setError(null);
            }}
            className="u-focus u-tnum h-[40px] rounded-[10px] border border-[var(--c5-ctrl-bd)] bg-[var(--c5-bg)] px-2.5 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] font-[590]">
          Hora de inicio
          <TimeSelect label="Hora de inicio" value={time} onChange={(v) => { setTime(v); setError(null); }} step={5} />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[12.5px] font-[590]">
        Motivo · opcional
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="p. ej. empezó tarde"
          className="u-focus resize-none rounded-[10px] border border-[var(--c5-ctrl-bd)] bg-[var(--c5-bg)] px-2.5 py-2 text-[13px]"
        />
      </label>
    </EditorShell>
  );
}

// ── Anular cobro (shared danger confirm; standalone + guided) ───────────────────────────────
export function GuidedVoid(props: {
  clientId: string;
  appt: Appt;
  /** The verb for what follows the void, e.g. "el servicio" / "el profesional". */
  nextNoun: string;
  onVoided: () => void;
  onCancel: () => void;
}) {
  const { appt } = props;
  const [loaded, setLoaded] = useState<{ id: string; total: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    getAppointmentPaymentHistoryAction(props.clientId, appt.id)
      .then((r) => {
        if (!alive) return;
        if (!r.ok) return setLoadError(r.error);
        const rec = r.value.find((p) => p.status === "recorded");
        if (!rec) return setLoadError("Ya no hay un cobro registrado para anular.");
        setLoaded({ id: rec.id, total: rec.total });
      })
      .catch(() => alive && setLoadError("No pudimos cargar el cobro."));
    return () => {
      alive = false;
    };
  }, [props.clientId, appt.id]);

  const save = () => {
    if (!loaded || !reason.trim() || pending) return;
    setError(null);
    startTransition(async () => {
      try {
        const r = await voidPaymentAction(props.clientId, loaded.id, reason.trim());
        if (!r.ok) return setError(r.error);
        props.onVoided();
      } catch {
        setError("No se pudo anular: revisa la conexión. Nada cambió.");
      }
    });
  };

  const amount = loaded ? priceLabelCOP(loaded.total) : null;
  return (
    <div className="c5-edit mt-2 flex flex-col gap-3 rounded-[12px] border border-[var(--c5-red-fg)] bg-[var(--c5-field)] p-3">
      <h4 className="text-[13px] font-[590]">Anular cobro y cambiar {props.nextNoun}</h4>
      {loadError ? (
        <p role="alert" className="c5-box c5-red text-[13px]">{loadError}</p>
      ) : !loaded ? (
        <p role="status" className="c5-small flex items-center gap-2 text-[var(--c5-sec)]">
          <span aria-hidden className="u-ag-busy-dot size-[7px] rounded-full bg-current" />
          Cargando el cobro…
        </p>
      ) : (
        <>
          <p className="text-[13px] leading-[1.45]">
            El cobro de {amount} quedará anulado y la cita volverá a cobro pendiente. Después eliges {props.nextNoun} y registras el nuevo cobro. Anular no devuelve dinero al cliente.
          </p>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            rows={2}
            aria-label="Motivo de la anulación"
            placeholder="Motivo (obligatorio)"
            className="u-focus resize-none rounded-[10px] border border-[var(--c5-ctrl-bd)] bg-[var(--c5-bg)] px-2.5 py-2 text-[13px]"
          />
          {error ? <p role="alert" className="c5-box c5-red text-[13px]">{error}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <button type="button" data-size="sm" className="u-focus c5-btn" onClick={props.onCancel} disabled={pending}>
              Volver
            </button>
            <button type="button" data-size="sm" data-kind="danger" aria-busy={pending || undefined} className="u-focus c5-btn" onClick={save} disabled={!reason.trim() || pending}>
              {pending ? "Anulando…" : "Anular cobro"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function firstName(name: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "Sin profesional";
}
