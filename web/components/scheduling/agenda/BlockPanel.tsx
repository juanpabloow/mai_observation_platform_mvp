"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createBlockSeriesAction } from "@/lib/scheduleSeriesActions";
import { createTimeOffAction, deleteTimeOffAction, previewTimeOffAction, updateTimeOffAction, type TimeOffConflict } from "@/lib/timeOffActions";
import type { PublicAbsenceReason } from "@/lib/publicAbsenceReason";
import { PUBLIC_REASON_LABEL } from "@/lib/publicAbsenceReason";
import { draftHolds, rangeHold } from "@/lib/scheduleDraft";
import { fmtTime, siteDayKey, siteMidnight, todayAtSite } from "@/lib/siteCalendar";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { Button, INPUT } from "../ui/system";
import { PublicReasonField, effectivePublicReason } from "../timeoff/PublicReasonField";
import { SidePanel, PanelSection, type SidePanelHandle } from "./SidePanel";
import { AffectedList, Choice, FieldRow, TimeSelect, WeekdayPicker, type AffectedItem } from "./ScheduleFormParts";

/**
 * NUEVA AUSENCIA / BLOQUEO — and editing a dated one. One form for the calendar's «Bloquear
 * horario», Equipo's «Ausencias» and «Horarios y ausencias».
 *
 *   A quién afecta  one professional | the whole site (a closure: hours.manage only).
 *                   A professional's vacation never closes the site.
 *   Frecuencia      once (a date or a date range, all day or from–to) | repeats (days,
 *                   start, no end / on a date / after N times — a schedule_series row).
 *   Motivo interno  only the team sees it.  Qué verá el cliente  a controlled public code.
 *
 * The scope summary and the affected appointments are recalculated as you type (read-only
 * previews). Nothing is moved or cancelled; creating with appointments inside needs an
 * explicit «Crear igualmente» and they show «Requiere revisión» until resolved.
 */
export interface DatedBlock {
  id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
  public_reason?: PublicAbsenceReason | null;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const WD = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const dLabel = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${WD[new Date(`${d}T00:00:00Z`).getUTCDay()].slice(0, 3)} ${day} ${MON[m - 1]}`;
};

export function BlockPanel(props: {
  clientId: string;
  siteId: string;
  siteName: string;
  timezone: string;
  staff: Array<{ id: string; name: string }>;
  canSiteClosure: boolean;
  canStaffTimeOff: boolean;
  /** Prefill: a professional (Equipo) and/or a date (calendar). */
  fixedStaffId?: string | null;
  initialDate?: string;
  /** Preset from a click on the calendar grid (still editable). */
  initialStaffId?: string | null;
  initialStart?: string;
  initialEnd?: string;
  /** A template's starting values (the phone's «Almuerzo», «Vacaciones»…): it only fills
   *  the form — nothing is saved until the person confirms, and no template sets what the
   *  client is told. */
  prefill?: { reason?: string; who?: "site" | "staff"; date?: string; endDate?: string; allDay?: boolean; start?: string; end?: string };
  edit?: DatedBlock;
  title?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onReschedule: (item: AffectedItem, holds: string[]) => void;
  recheck: number;
  hidden?: boolean;
}) {
  const tz = props.timezone;
  const today = todayAtSite(tz);
  const edit = props.edit;
  const editAllDay = edit ? fmtTime(edit.starts_at, tz) === "00:00" && fmtTime(edit.ends_at, tz) === "00:00" : false;
  const pre = edit ? undefined : props.prefill;
  const preWho = pre?.who === "site" && props.canSiteClosure ? "site" : pre?.who === "staff" && props.canStaffTimeOff ? "staff" : undefined;
  const initial = useMemo(
    () => ({
      who: (edit ? (edit.staff_id ? "staff" : "site") : preWho ?? (props.canStaffTimeOff ? "staff" : "site")) as "staff" | "site",
      staffId: edit?.staff_id ?? props.fixedStaffId ?? props.initialStaffId ?? props.staff[0]?.id ?? "",
      freq: "once" as "once" | "repeat",
      date: edit ? siteDayKey(edit.starts_at, tz) : pre?.date && pre.date >= today ? pre.date : props.initialDate && props.initialDate >= today ? props.initialDate : today,
      endDate: edit ? siteDayKey(new Date(Date.parse(edit.ends_at) - 1).toISOString(), tz) : pre?.endDate && pre.endDate >= today ? pre.endDate : props.initialDate && props.initialDate >= today ? props.initialDate : today,
      allDay: edit ? editAllDay : pre?.allDay ?? false,
      start: edit && !editAllDay ? fmtTime(edit.starts_at, tz) : pre?.start ?? props.initialStart ?? "14:00",
      end: edit && !editAllDay ? (fmtTime(edit.ends_at, tz) === "00:00" ? "24:00" : fmtTime(edit.ends_at, tz)) : pre?.end ?? props.initialEnd ?? "15:00",
      weekdays: [] as number[],
      endKind: "never" as "never" | "on" | "after",
      endsOn: "",
      count: "8",
      reason: edit?.reason ?? pre?.reason ?? "",
      publicReason: (edit?.public_reason ?? null) as PublicAbsenceReason | null,
    }),
    // The form is mounted per open; its initial values are fixed for that open.
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [f, setF] = useState(initial);
  const set = <K extends keyof typeof initial>(k: K, v: (typeof initial)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [affectedState, setAffected] = useState<{ forKey: string; loading: boolean; items: AffectedItem[] | null; error: string | null; pre?: AffectedItem[] }>({ forKey: "", loading: false, items: null, error: null });
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field?: string; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);

  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const siteWide = f.who === "site";
  const staffId = siteWide ? null : f.staffId || null;
  const staffName = props.staff.find((s) => s.id === staffId)?.name ?? null;
  const repeat = f.freq === "repeat" && !edit;
  const timesValid = f.allDay || f.end > f.start;
  const datesValid = repeat ? f.date >= today : f.date >= today && (!f.allDay || f.endDate >= f.date);
  const valid = timesValid && datesValid && (!repeat || f.weekdays.length > 0) && (siteWide || Boolean(staffId));

  const timeOffInput = () =>
    f.allDay ? ({ mode: "full_day" as const, startDate: f.date, endDate: f.endDate }) : ({ mode: "partial" as const, date: f.date, startTime: f.start, endTime: f.end === "24:00" ? "23:59" : f.end });
  const seriesInput = () => ({
    clientId: props.clientId,
    siteId: props.siteId,
    staffId,
    weekdays: f.weekdays,
    allDay: f.allDay,
    start: f.start,
    end: f.end,
    startsOn: f.date,
    endKind: f.endKind,
    endsOn: f.endKind === "on" ? f.endsOn : null,
    count: f.endKind === "after" ? Number(f.count) : null,
    reason: f.reason,
    publicReason: effectivePublicReason(f.publicReason, siteWide ? "site" : "staff"),
  });

  // Affected appointments (read-only), recalculated as the form changes and after a reschedule.
  // Each answer is tagged with the input it answers, so "loading" and a stale list are derived.
  const key = JSON.stringify([f, props.recheck]);
  const affected = !valid
    ? { loading: false, items: null as AffectedItem[] | null, error: null as string | null }
    : affectedState.forKey === key
      ? affectedState
      : { loading: true, items: affectedState.items, error: null as string | null };
  useEffect(() => {
    if (!valid) return;
    let cancelled = false;
    const done = (v: { items: AffectedItem[] | null; error: string | null; pre?: AffectedItem[] }) => setAffected({ forKey: key, loading: false, ...v });
    const t = setTimeout(async () => {
      try {
        if (repeat) {
          const r = await createBlockSeriesAction({ ...seriesInput(), dryRun: true });
          if (cancelled) return;
          if (!r.ok) {
            done({ items: null, error: null });
            setFieldError({ field: r.field, message: r.error });
            return;
          }
          setFieldError(null);
          done({ items: r.affected, error: null, pre: r.preexisting });
        } else {
          const r = await previewTimeOffAction({ clientId: props.clientId, siteId: props.siteId, staffId, ...timeOffInput() });
          if (cancelled) return;
          if (!r.ok) return done({ items: null, error: r.error });
          setFieldError(null);
          done({ error: null, items: r.conflicts.map(conflictItem) });
        }
      } catch {
        if (!cancelled) done({ items: null, error: "x" });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key, valid]); // eslint-disable-line react-hooks/exhaustive-deps

  const n = affected.items?.length ?? 0;
  const holds = (): string[] => {
    if (repeat) {
      return draftHolds({ staffId, timeZone: tz, weekdays: f.weekdays, startMin: f.allDay ? 0 : toMin(f.start), endMin: f.allDay ? 1440 : toMin(f.end), startsOn: f.date, endsOn: f.endKind === "on" ? f.endsOn || null : null });
    }
    const from = f.allDay ? siteMidnight(f.date, tz) : new Date(siteMidnight(f.date, tz).getTime() + toMin(f.start) * 60_000);
    const until = f.allDay ? siteMidnight(addDay(f.endDate), tz) : new Date(siteMidnight(f.date, tz).getTime() + toMin(f.end) * 60_000);
    return rangeHold(staffId, from, until);
  };

  const submit = () => {
    if (!valid || sending.current) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const confirm = n > 0;
        if (repeat) {
          const r = await createBlockSeriesAction({ ...seriesInput(), confirm });
          if (!r.ok) {
            setFieldError({ field: r.field, message: r.error });
            return;
          }
          if (!r.written) {
            setAffected({ forKey: key, loading: false, items: r.affected, error: null, pre: r.preexisting });
            return;
          }
          props.onSaved("Bloqueo recurrente creado");
          return;
        }
        const base = { reason: f.reason, publicReason: effectivePublicReason(f.publicReason, siteWide ? "site" : "staff"), confirm, ...timeOffInput() };
        const r = edit
          ? await updateTimeOffAction(props.clientId, edit.id, base)
          : await createTimeOffAction({ clientId: props.clientId, siteId: props.siteId, staffId, ...base });
        if (!r.ok) {
          if ("conflicts" in r) {
            setAffected({ forKey: key, loading: false, error: null, items: r.conflicts.map(conflictItem) });
            return;
          }
          setError(r.error);
          return;
        }
        props.onSaved(edit ? "Bloqueo actualizado" : siteWide ? "Cierre de la sede creado" : "Ausencia creada");
      } catch {
        setError("No se pudo guardar. Tus cambios siguen aquí; vuelve a intentarlo.");
      } finally {
        sending.current = false;
      }
    });
  };

  const remove = () => {
    if (!edit || sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const r = await deleteTimeOffAction(props.clientId, edit.id);
        if (!r.ok) setError(r.error ?? "No se pudo eliminar.");
        else props.onSaved("Bloqueo eliminado");
      } catch {
        setError("No se pudo eliminar. Vuelve a intentarlo.");
      } finally {
        sending.current = false;
        setConfirmDelete(false);
      }
    });
  };

  const whenLine = repeat
    ? `${f.weekdays.length ? `Cada ${[...f.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD[d]).join(", ")}` : "Elige los días"} · ${f.allDay ? "todo el día" : `${f.start} – ${f.end}`} · desde el ${dLabel(f.date)} · ${
        f.endKind === "never" ? "sin fecha de fin" : f.endKind === "on" ? (f.endsOn ? `hasta el ${dLabel(f.endsOn)}` : "elige la fecha de fin") : `${f.count} veces`
      }`
    : f.allDay
      ? f.endDate === f.date
        ? `${dLabel(f.date)} · todo el día`
        : `Del ${dLabel(f.date)} al ${dLabel(f.endDate)} · todo el día`
      : `${dLabel(f.date)} · ${f.start} – ${f.end}`;
  const pr = effectivePublicReason(f.publicReason, siteWide ? "site" : "staff");

  return (
    <div hidden={props.hidden}>
      <SidePanel
        name="block"
        title={edit ? "Editar bloqueo" : props.title ?? "Nuevo bloqueo"}
        subtitle={`${props.siteName} · ${tzLabel(tz)}`}
        dirty={dirty}
        covered={confirmDelete}
        onClose={props.onClose}
        handleRef={handle}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {n > 0 ? <span className="w-full text-[12.5px] text-[var(--warn)] sm:hidden">{n} {n === 1 ? "cita requiere" : "citas requieren"} revisión</span> : null}
            {edit ? (
              <button type="button" className="u-focus rounded px-1 text-[13px] font-medium text-danger hover:underline" onClick={() => setConfirmDelete(true)} disabled={pending}>
                Eliminar
              </button>
            ) : null}
            <span className="hidden min-w-0 flex-1 truncate text-[12.5px] text-[var(--warn)] sm:block">{n > 0 ? `${n} ${n === 1 ? "cita requiere" : "citas requieren"} revisión` : ""}</span>
            <span className="flex-1 sm:hidden" />
            <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={submit} disabled={!valid || pending || (edit ? !dirty : false)} loading={pending} loadingLabel="Guardando…">
              {error ? "Reintentar" : n > 0 ? (edit ? "Guardar igualmente" : "Crear igualmente") : edit ? "Guardar" : siteWide ? "Crear cierre" : props.title?.includes("ausencia") ? "Crear ausencia" : "Crear bloqueo"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col">
          <PanelSection title="A quién afecta" id="block-who">
            {!edit && props.canSiteClosure && props.canStaffTimeOff ? (
              <Choice
                label="A quién afecta"
                hideLabel
                value={f.who}
                onChange={(v) => set("who", v)}
                options={[
                  { value: "staff", label: "Un profesional" },
                  { value: "site", label: "Toda la sede" },
                ]}
              />
            ) : null}
            {!siteWide ? (
              <select
                aria-label="Profesional"
                value={f.staffId}
                disabled={Boolean(edit) || Boolean(props.fixedStaffId)}
                onChange={(e) => set("staffId", e.target.value)}
                className={INPUT}
              >
                {props.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[13px] text-muted">Cierra {props.siteName} para todo el equipo. Las vacaciones de una persona no cierran la sede: para eso elige «Un profesional».</p>
            )}
          </PanelSection>

          <PanelSection title="Cuándo" id="block-when">
            {!edit ? (
              <Choice
                label="Frecuencia"
                value={f.freq}
                onChange={(v) => set("freq", v)}
                options={[
                  { value: "once", label: "Una vez" },
                  { value: "repeat", label: "Se repite" },
                ]}
              />
            ) : null}
            {repeat ? (
              <>
                <WeekdayPicker value={f.weekdays} onChange={(v) => set("weekdays", v)} error={fieldError?.field === "weekdays" ? fieldError.message : null} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldRow label="Empieza" htmlFor="block-starts" error={fieldError?.field === "startsOn" ? fieldError.message : null}>
                    <input id="block-starts" type="date" className={INPUT} value={f.date} min={today} onChange={(e) => set("date", e.target.value)} />
                  </FieldRow>
                  <FieldRow label="Termina" htmlFor="block-endkind">
                    <select id="block-endkind" className={INPUT} value={f.endKind} onChange={(e) => set("endKind", e.target.value as typeof f.endKind)}>
                      <option value="never">Sin fecha de fin</option>
                      <option value="on">En una fecha</option>
                      <option value="after">Tras varias veces</option>
                    </select>
                  </FieldRow>
                </div>
                {f.endKind === "on" ? (
                  <FieldRow label="Fecha de fin" htmlFor="block-endson" error={fieldError?.field === "endsOn" ? fieldError.message : null}>
                    <input id="block-endson" type="date" className={INPUT} value={f.endsOn} min={f.date} onChange={(e) => set("endsOn", e.target.value)} />
                  </FieldRow>
                ) : f.endKind === "after" ? (
                  <FieldRow label="Número de veces" htmlFor="block-count" error={fieldError?.field === "count" ? fieldError.message : null}>
                    <input id="block-count" type="number" min={1} max={520} className={INPUT} value={f.count} onChange={(e) => set("count", e.target.value)} />
                  </FieldRow>
                ) : null}
              </>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow label={f.allDay ? "Desde" : "Fecha"} htmlFor="block-date" error={!datesValid && f.date < today ? "La fecha no puede estar en el pasado." : null}>
                  <input id="block-date" type="date" className={INPUT} value={f.date} min={today} onChange={(e) => setF((x) => ({ ...x, date: e.target.value, endDate: x.endDate < e.target.value ? e.target.value : x.endDate }))} />
                </FieldRow>
                {f.allDay ? (
                  <FieldRow label="Hasta" htmlFor="block-enddate" error={f.endDate < f.date ? "Debe ser igual o posterior al inicio." : null}>
                    <input id="block-enddate" type="date" className={INPUT} value={f.endDate} min={f.date} onChange={(e) => set("endDate", e.target.value)} />
                  </FieldRow>
                ) : null}
              </div>
            )}
            <label className="flex min-h-[44px] items-center justify-between gap-3 text-[13px] md:min-h-[36px]">
              <span className="font-medium">Todo el día</span>
              <input type="checkbox" role="switch" checked={f.allDay} onChange={(e) => set("allDay", e.target.checked)} className="size-5 accent-[var(--foreground)]" />
            </label>
            {!f.allDay ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-semibold">Horario</span>
                <div className="flex items-center gap-2">
                  <TimeSelect label="Desde" value={f.start} onChange={(v) => set("start", v)} />
                  <span aria-hidden className="text-muted">–</span>
                  <TimeSelect label="Hasta" value={f.end} onChange={(v) => set("end", v)} />
                </div>
                {!timesValid ? <span role="alert" className="text-[12.5px] text-danger">La hora de fin debe ser posterior a la de inicio.</span> : null}
              </div>
            ) : null}
          </PanelSection>

          <PanelSection title={<>Motivo interno <span className="font-normal text-muted">· opcional, solo lo ve el equipo</span></>} id="block-reason">
            <input aria-label="Motivo interno" className={INPUT} value={f.reason} maxLength={200} onChange={(e) => set("reason", e.target.value)} placeholder="Ej. Formación externa" />
            <span className="text-[12.5px] text-muted">No escribas datos médicos ni personales sensibles.</span>
          </PanelSection>

          <PanelSection title="Qué verá el cliente" id="block-public">
            <PublicReasonField scope={siteWide ? "site" : "staff"} value={f.publicReason} onChange={(v) => set("publicReason", v)} who={staffName} />
          </PanelSection>

          <PanelSection title="Resumen del alcance" id="block-summary">
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 rounded-[12px] bg-subtle px-3.5 py-3 text-[13px]">
              <dt className="text-muted">Afecta a</dt>
              <dd>{siteWide ? `Toda la sede · ${props.siteName}` : staffName ?? "Elige un profesional"}</dd>
              <dt className="text-muted">Cuándo</dt>
              <dd className="u-tnum">{whenLine}</dd>
              <dt className="text-muted">Se retira</dt>
              <dd>{siteWide ? "Toda la disponibilidad de la sede en ese horario" : `La disponibilidad de ${staffName ?? "esa persona"}; los demás siguen disponibles`}</dd>
              <dt className="text-muted">Qué ve el cliente</dt>
              <dd>{pr ? PUBLIC_REASON_LABEL[pr] : "Sin motivo («no hay disponibilidad»)"}</dd>
            </dl>
          </PanelSection>

          <PanelSection title="Citas afectadas" id="block-affected">
            {valid ? (
              <AffectedList
                items={affected.items}
                preexisting={"pre" in affected ? affected.pre ?? null : null}
                loading={affected.loading}
                error={affected.error}
                timezone={tz}
                what={siteWide ? "el cierre" : "la ausencia"}
                onReschedule={(item) => props.onReschedule(item, holds())}
                onRetry={() => setF((x) => ({ ...x }))}
              />
            ) : (
              <p className="text-[13px] text-muted">Completa fecha y horario para revisar las citas.</p>
            )}
          </PanelSection>
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
          {fieldError && !fieldError.field ? <p role="alert" className="text-[13px] text-danger">{fieldError.message}</p> : null}
        </div>
      </SidePanel>
      {confirmDelete && edit ? (
        <ConfirmLayer
          id="block-delete"
          title="¿Eliminar el bloqueo?"
          body={`El horario vuelve a ofrecerse para reservas: ${whenLine}.`}
          cancelLabel="Volver"
          confirmLabel="Eliminar"
          pending={pending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={remove}
        />
      ) : null}
    </div>
  );
}

function conflictItem(c: TimeOffConflict): AffectedItem {
  return { id: c.id, customerName: c.contact_name, serviceName: c.service_name, staffName: c.staff_name, startAt: c.start_at, endAt: c.service_end_at, staffId: c.staff_id, serviceId: c.service_id, durationMin: c.duration_min, status: c.status };
}

function addDay(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function tzLabel(tz: string): string {
  const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "";
  const city = (tz.split("/").pop() ?? tz).replace(/_/g, " ").replace("Bogota", "Bogotá");
  return `${city} (${off})`;
}
