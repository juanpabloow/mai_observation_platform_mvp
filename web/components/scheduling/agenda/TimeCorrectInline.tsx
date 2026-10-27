"use client";

import { useEffect, useId, useMemo, useState, useTransition, type ReactNode } from "react";
import { correctAppointmentTimeAction } from "@/lib/schedulingActions";
import { fmtTime, longDate, siteDayKey, siteLocalToUtc } from "@/lib/siteCalendar";
import { Button } from "../ui/system";
import { AgAvatar } from "./AgendaChrome";
import { FieldRow, TimeSelect } from "./ScheduleFormParts";
import { formatDuration } from "./AppointmentCard";
import type { Appt } from "../AgendaView";

/**
 * JP-4 «Corregir hora o profesional» — a CORRECTION, not a reschedule. It records what REALLY
 * happened: the Setter booked 7:00 but it was at 8:00, or it was actually done by another artist.
 * Distinct from Reagendar — it applies NO booking-window / lead-time / availability rule and is
 * allowed on PAST and COMPLETED appointments. The one hard rule is no overlap with another active
 * appointment of the target professional (the server checks it and names the clash). The booked
 * duration is preserved. No customer message is sent (the platform sends none on any change).
 *
 * Changing the ARTIST of an appointment with a recorded payment is refused by the server (the
 * payment snapshots the artist + commission → void → re-charge).
 */
export function TimeCorrectInline(props: {
  clientId: string;
  timezone: string;
  appt: Appt;
  staff: Array<{ id: string; name: string; photoUrl?: string | null; tint?: "1" | "2" | "3" | "4" }>;
  /** A staff login is locked to its own column: no artist change. */
  lockStaffId: string | null;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
  onDone: (message: string) => void;
  /** The parent panel draws the body and the footer. */
  frame: (body: ReactNode, footer: ReactNode) => ReactNode;
}) {
  const { appt, timezone: tz } = props;
  const startDay = siteDayKey(appt.start_at, tz);
  const startTime = fmtTime(appt.start_at, tz); // "HH:MM", 24 h
  const [day, setDay] = useState(startDay);
  const [time, setTime] = useState(startTime);
  const [staffId, setStaffId] = useState(appt.staff_id);
  const [reason, setReason] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dayFieldId = useId();

  const canChangeStaff = !props.lockStaffId && props.staff.length > 1;
  const newStart = useMemo(() => siteLocalToUtc(day, time, tz), [day, time, tz]);
  const newEnd = useMemo(() => (newStart ? new Date(newStart.getTime() + appt.duration_min * 60_000) : null), [newStart, appt.duration_min]);
  const staffChanged = staffId !== appt.staff_id;
  const timeChanged = Boolean(newStart) && newStart!.getTime() !== new Date(appt.start_at).getTime();
  const dirty = timeChanged || staffChanged || reason.trim().length > 0;
  const hasChange = (timeChanged || staffChanged) && Boolean(newStart);

  const onDirty = props.onDirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const staffName = props.staff.find((s) => s.id === staffId)?.name ?? (staffId === appt.staff_id ? appt.staff_name : null);

  const submit = () => {
    if (!hasChange || !newStart || pending) return;
    setFailed(null);
    startTransition(async () => {
      try {
        const r = await correctAppointmentTimeAction(
          props.clientId,
          appt.id,
          newStart.toISOString(),
          staffChanged ? staffId : null,
          reason.trim() || null,
        );
        if (!r.ok) {
          setFailed(r.error);
          return;
        }
        props.onDone("Hora corregida");
      } catch {
        setFailed("No se pudo guardar: revisa la conexión. Tu selección se conserva.");
      }
    });
  };

  const body = (
    <div className="flex flex-col gap-5">
      <p className="rounded-[10px] bg-subtle px-3 py-2.5 text-[12.5px] leading-5 text-muted">
        Corrige cuándo pasó realmente la cita (puede ser una hora ya pasada) o quién la atendió. No la reagenda ni avisa al
        cliente. Mantiene la duración reservada.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <FieldRow label="Día" htmlFor={dayFieldId}>
          <input
            id={dayFieldId}
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value || startDay);
              setFailed(null);
            }}
            className="u-focus u-tnum h-[44px] rounded-sch-control border border-line-strong bg-surface px-2.5 text-[13px] md:h-[36px]"
          />
        </FieldRow>
        <FieldRow label="Hora de inicio">
          <TimeSelect
            label="Hora de inicio"
            value={time}
            onChange={(v) => {
              setTime(v);
              setFailed(null);
            }}
            step={5}
          />
        </FieldRow>
      </div>

      {canChangeStaff ? (
        <section aria-labelledby="tc-staff" className="flex flex-col gap-2">
          <h3 id="tc-staff" className="text-[13px] font-semibold">Profesional</h3>
          <div role="radiogroup" aria-labelledby="tc-staff" className="flex flex-wrap gap-2">
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
                    setFailed(null);
                  }}
                  className={`u-focus flex h-[44px] items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[13px] transition-[box-shadow] duration-150 md:h-[36px] ${
                    sel ? "border-foreground font-semibold shadow-[inset_0_0_0_1px_var(--foreground)]" : "border-line hover:bg-subtle"
                  }`}
                >
                  <AgAvatar name={s.name} id={s.id} size={24} tint={s.tint} photoUrl={s.photoUrl ?? null} />
                  {firstName(s.name)}
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <FieldRow label="Motivo · opcional" hint="Queda en el historial de la cita.">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="p. ej. empezó tarde, la registró el setter con otra hora"
          className="u-focus rounded-sch-control border border-line-strong bg-surface px-2.5 py-2 text-[13px] resize-none"
        />
      </FieldRow>

      <section aria-label="Antes y después" className="rounded-[12px] border border-line px-3.5 py-3 text-[13px]">
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Antes</dt>
          <dd className="u-tnum text-muted line-through decoration-1">
            {longDate(appt.start_at, tz)} · {fmtTime(appt.start_at, tz)}–{fmtTime(appt.service_end_at, tz)}
            {appt.staff_name ? ` · ${appt.staff_name}` : ""}
          </dd>
          <dt className="text-muted">Después</dt>
          <dd className="u-tnum font-semibold">
            {newStart && newEnd
              ? `${longDate(newStart.toISOString(), tz)} · ${fmtTime(newStart.toISOString(), tz)}–${fmtTime(newEnd.toISOString(), tz)}${staffName ? ` · ${staffName}` : ""}`
              : "Hora no válida"}
          </dd>
        </dl>
        <p className="mt-2 text-[12.5px] leading-5 text-muted">Duración: {formatDuration(appt.duration_min)}. El estado no cambia.</p>
      </section>
      {failed ? (
        <p role="alert" className="rounded-[10px] bg-[var(--danger-soft,rgba(192,38,45,0.08))] px-3 py-2.5 text-[13px] text-danger">
          {failed}
        </p>
      ) : null}
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button onClick={props.onCancel} disabled={pending}>Volver</Button>
      <Button variant="primary" onClick={submit} disabled={!hasChange || pending} loading={pending} loadingLabel="Guardando…">
        {failed ? "Reintentar" : "Guardar corrección"}
      </Button>
    </div>
  );

  return <>{props.frame(body, footer)}</>;
}

function firstName(name: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] || "Sin profesional";
}
