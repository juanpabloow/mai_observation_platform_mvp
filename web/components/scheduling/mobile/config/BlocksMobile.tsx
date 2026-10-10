"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createExceptionAction, deleteExceptionAction } from "@/lib/schedulingAdminActions";
import type { Exception, Site, Staff } from "../../AdminPanel";
import { MButton, MSegmented, MStaffAvatar, Sheet } from "../kit";
import { BLOCK_TEMPLATES, blockDraft, blockPayload, blockWhen, dayLabel, tzLabel, zonedParts, type BlockDraft } from "./logic";
import {
  CARD_M,
  Chevron,
  ConfirmSheet,
  ErrorNote,
  Field,
  INPUT_M,
  LABEL_M,
  ROW_M,
  SELECT_M,
  Screen,
  SubHeader,
  SwitchRow,
  siteStaffColors,
  type ConfigNav,
} from "./ui";

const todayIn = (tz: string) => zonedParts(new Date(), tz).key;

function TemplatePills({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="flex flex-wrap gap-[8px]">
      {BLOCK_TEMPLATES.map((t) => (
        <button key={t} type="button" onClick={() => onPick(t)} className="flex min-h-[44px] items-center rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[15px] text-m-tx">
          {t}
        </button>
      ))}
    </div>
  );
}

// ── 4.10 Bloqueos · 4.11 vacío ───────────────────────────────────────────────────

export function BlocksList({
  nav,
  clientId,
  sites,
  staff,
  exceptions,
  past,
  toast,
}: {
  nav: ConfigNav;
  clientId: string;
  sites: Site[];
  staff: Staff[];
  exceptions: Exception[];
  /** Ended in the last 90 days (read-only history). */
  past: Exception[];
  toast: (m: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Exception | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  // Soonest first (the page loads per site; see the desktop list).
  const upcoming = useMemo(() => [...exceptions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at)), [exceptions]);
  // Pasados: most recent first.
  const ended = useMemo(() => [...past].sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at)), [past]);
  const [tab, setTab] = useState<"next" | "past">("next");
  // Read once (render must stay pure): what has already ended is history.
  const [nowMs] = useState(() => Date.now());
  const list = tab === "next" ? upcoming : ended;
  const multiSite = sites.length > 1;

  const describe = (e: Exception) => {
    const site = sites.find((s) => s.id === e.site_id);
    const tz = site?.timezone ?? "UTC";
    const member = e.staff_id ? staff.find((p) => p.id === e.staff_id) : undefined;
    return {
      site,
      member,
      when: blockWhen(e, tz, todayIn(tz)),
      colors: siteStaffColors(staff, e.site_id),
    };
  };

  const remove = () =>
    startBusy(async () => {
      if (!open) return;
      setError(null);
      const r = await deleteExceptionAction(clientId, open.id);
      setConfirm(false);
      setOpen(null);
      if (!r.ok) setError(r.error ?? "No se pudo eliminar el bloqueo.");
      else {
        toast("Bloqueo eliminado");
        router.refresh();
      }
    });

  const sel = open ? describe(open) : null;
  return (
    <Screen
      label="Bloqueos"
      header={<SubHeader backLabel="Configuración" onBack={() => nav.back(null)} title="Bloqueos" sub="Horas en las que no se aceptan citas" />}
      footer={
        <MButton kind="primary" grow onClick={() => nav.go("bloqueo-nuevo")} disabled={sites.length === 0}>
          Nuevo bloqueo
        </MButton>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {sites.length > 0 ? (
        <MSegmented
          label="Bloqueos"
          stretch
          value={tab}
          options={[
            { value: "next", label: `Próximos ${upcoming.length}` },
            { value: "past", label: `Pasados ${ended.length}` },
          ]}
          onChange={setTab}
        />
      ) : null}
      {sites.length === 0 ? (
        <div className={`${CARD_M} px-[18px] py-[24px] text-[14px] text-m-tx3`}>Crea una sede para poder bloquear horarios.</div>
      ) : tab === "past" && ended.length === 0 ? (
        <div className={`${CARD_M} px-[18px] py-[24px] text-[14px] text-m-tx3`}>Todavía no hay bloqueos pasados.</div>
      ) : list.length === 0 ? (
        <div className={`${CARD_M} flex flex-col gap-[14px] px-[18px] py-[24px]`}>
          <div className="flex flex-col gap-[4px]">
            <span className="text-[16px] font-semibold">No hay bloqueos próximos</span>
            <span className="text-[14px] leading-[1.45] text-m-tx3">Empieza con una plantilla. Solo rellena el formulario: nada se guarda hasta que lo confirmes.</span>
          </div>
          <TemplatePills onPick={(t) => nav.go("bloqueo-nuevo", null, { plantilla: t })} />
        </div>
      ) : (
        <section className="flex flex-col gap-[8px]">
          <h2 className="sr-only">{tab === "next" ? "Próximos" : "Pasados"}</h2>
          <div className={CARD_M}>
            {list.map((e) => {
              const d = describe(e);
              return (
                <button key={e.id} type="button" onClick={() => setOpen(e)} className={`${ROW_M} min-h-[76px]`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
                    <span className="text-[16px] font-semibold [overflow-wrap:anywhere]">{e.reason || "Bloqueo de agenda"}</span>
                    <span className="u-tnum text-[14px] text-m-tx2">{d.when}</span>
                    <span className="flex min-w-0 items-center gap-[6px] text-[13px] text-m-tx3">
                      {d.member ? <MStaffAvatar id={d.member.id} name={d.member.name} size={28} color={d.colors.get(d.member.id)} /> : <span aria-hidden>⌂</span>}
                      <span className="truncate">
                        {d.member ? d.member.name : "Toda la sede"}
                        {multiSite && d.site ? ` · ${d.site.name}` : ""}
                      </span>
                    </span>
                  </span>
                  <Chevron />
                </button>
              );
            })}
          </div>
        </section>
      )}

      <Sheet open={open !== null} onClose={() => setOpen(null)} label={open?.reason || "Bloqueo de agenda"}>
        {open && sel ? (
          <div className="flex flex-col gap-[14px] px-[16px] pb-[max(20px,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-[4px]">
              <span className="text-[18px] font-semibold [overflow-wrap:anywhere]">{open.reason || "Bloqueo de agenda"}</span>
              <span className="u-tnum text-[15px] text-m-tx2">{sel.when}</span>
            </div>
            <div className={CARD_M}>
              {[
                ["Alcance", sel.member ? sel.member.name : "Toda la sede"],
                ["Sede", sel.site?.name ?? "—"],
              ].map(([k, v], i) => (
                <div key={k} className={`flex min-h-[48px] items-center gap-[12px] px-[14px] py-[10px] ${i ? "border-t border-m-dv" : ""}`}>
                  <span className="w-[90px] flex-none text-[14px] text-m-tx3">{k}</span>
                  <span className="min-w-0 text-[15px]">{v}</span>
                </div>
              ))}
            </div>
            <span className="text-[13px] leading-[1.4] text-m-tx3">Mientras dure, esas horas no se ofrecen en la agenda, el asistente ni la reserva en línea.</span>
            <div className="flex flex-col gap-[8px]">
              {/* A past block is history: it is shown, not deleted. */}
              {Date.parse(open.ends_at) > nowMs ? (
                <button type="button" onClick={() => setConfirm(true)} className="flex h-[52px] items-center justify-center rounded-[12px] border border-m-dnbd bg-transparent text-[16px] text-m-dn">
                  Eliminar bloqueo
                </button>
              ) : null}
              <MButton kind="soft" className="w-full" onClick={() => setOpen(null)}>
                Cerrar
              </MButton>
            </div>
          </div>
        ) : null}
      </Sheet>
      <ConfirmSheet
        open={confirm}
        title="¿Eliminar este bloqueo?"
        body="Esas horas vuelven a ofrecerse para reservas. No se puede deshacer; si lo necesitas otra vez, crea uno nuevo."
        cancelLabel="Volver"
        okLabel="Eliminar bloqueo"
        busy={busy}
        busyLabel="Eliminando…"
        onCancel={() => setConfirm(false)}
        onOk={remove}
      />
    </Screen>
  );
}

// ── 4.12 Nuevo bloqueo (desde plantilla) ─────────────────────────────────────────

export function BlockForm({
  nav,
  clientId,
  sites,
  staff,
  template,
  toast,
}: {
  nav: ConfigNav;
  clientId: string;
  sites: Site[];
  staff: Staff[];
  template: string | null;
  toast: (m: string) => void;
}) {
  const router = useRouter();
  const firstSite = sites.find((s) => s.active) ?? sites[0];
  const initial = useMemo(
    () => blockDraft(firstSite?.id ?? "", todayIn(firstSite?.timezone ?? "UTC"), template && (BLOCK_TEMPLATES as readonly string[]).includes(template) ? template : null),
    [firstSite, template],
  );
  const [d, setD] = useState<BlockDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const site = sites.find((s) => s.id === d.siteId);
  const tz = site?.timezone ?? "UTC";
  const today = todayIn(tz);
  const people = staff.filter((p) => p.site_id === d.siteId && p.active);
  const colors = siteStaffColors(staff, d.siteId);
  const payload = blockPayload(d);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const set = (patch: Partial<BlockDraft>) => setD((x) => ({ ...x, ...patch }));
  const leave = () => nav.back("bloqueos");
  const requestLeave = () => (dirty && !saving ? setDiscard(true) : leave());

  const save = async () => {
    if (!payload.ok) return;
    setSaving(true);
    setError(null);
    const r = await createExceptionAction({
      clientId,
      siteId: d.siteId,
      staffId: d.scope === "staff" ? d.staffId : null,
      startsAt: payload.startsAt,
      endsAt: payload.endsAt,
      reason: d.reason.trim() || undefined,
    });
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "No se pudo guardar el bloqueo.");
      return;
    }
    toast("Bloqueo guardado");
    router.refresh();
    leave();
  };

  const err = (f: string) => (!payload.ok && payload.field === f ? payload.error : null);
  // A timed block over several days is ONE continuous block — say so in words.
  const spanNote =
    !d.allDay && payload.ok && d.from !== d.to ? `Un solo bloqueo continuo: del ${dayLabel(d.from, today).toLowerCase()} a las ${d.h1} al ${dayLabel(d.to, today).toLowerCase()} a las ${d.h2}.` : null;

  return (
    <Screen
      label="Nuevo bloqueo"
      header={<SubHeader backLabel="Bloqueos" onBack={requestLeave} title="Nuevo bloqueo" />}
      footer={
        <>
          <MButton kind="secondary" onClick={requestLeave} disabled={saving}>
            Cancelar
          </MButton>
          <MButton kind="primary" grow onClick={save} disabled={!payload.ok} loading={saving} loadingLabel="Guardando…">
            Guardar bloqueo
          </MButton>
        </>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {d.tpl ? (
        <div role="status" className="rounded-[12px] bg-m-sf2 px-[14px] py-[12px] text-[14px] leading-[1.45] text-m-tx2">
          Plantilla «{d.tpl}» aplicada. Revisa los datos: nada se guarda hasta pulsar Guardar.
        </div>
      ) : !dirty ? (
        <section className="flex flex-col gap-[8px]">
          <h2 className={`m-0 ${LABEL_M}`}>Empezar con una plantilla</h2>
          <TemplatePills onPick={(t) => setD(blockDraft(d.siteId, today, t))} />
        </section>
      ) : null}

      <Field id="bf-s" label="Sede" error={err("site")}>
        <select id="bf-s" value={d.siteId} onChange={(e) => set({ siteId: e.target.value, staffId: "" })} className={SELECT_M}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active ? "" : " (inactiva)"}
            </option>
          ))}
        </select>
      </Field>

      <section className="flex flex-col gap-[8px]">
        <h2 className={`m-0 ${LABEL_M}`}>Alcance</h2>
        <MSegmented
          label="Alcance"
          stretch
          value={d.scope}
          onChange={(v) => set({ scope: v })}
          options={[
            { value: "site", label: "Toda la sede" },
            { value: "staff", label: "Un profesional" },
          ]}
        />
        {d.scope === "staff" ? (
          people.length === 0 ? (
            <span className="text-[14px] text-m-tx3">Esta sede no tiene profesionales activos.</span>
          ) : (
            <div role="radiogroup" aria-label="Profesional" className="grid grid-cols-3 gap-[8px]">
              {people.map((p) => {
                const on = d.staffId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ staffId: p.id })}
                    className={`flex min-h-[76px] min-w-0 flex-col items-center justify-center gap-[6px] rounded-[12px] border bg-m-sf px-[2px] py-[6px] text-m-tx ${
                      on ? "border-m-tx shadow-[inset_0_0_0_1px_var(--m-tx)]" : "border-m-bd"
                    }`}
                  >
                    <MStaffAvatar id={p.id} name={p.name} size={40} color={colors.get(p.id)} />
                    <span className={`max-w-full truncate px-[4px] text-[13px] ${on ? "font-semibold" : ""}`}>{p.name.replace(/^\s*\[[^\]]*\]\s*/, "").split(/\s+/)[0]}</span>
                  </button>
                );
              })}
            </div>
          )
        ) : null}
        {err("staff") && d.scope === "staff" && people.length > 0 ? <span className="text-[13px] text-m-tx3">Elige a quién afecta.</span> : null}
      </section>

      <section className="flex flex-col gap-[8px]">
        <h2 className={`m-0 ${LABEL_M}`}>Fechas</h2>
        <div className="grid grid-cols-2 gap-[8px]">
          <label className="flex min-w-0 flex-col gap-[4px] text-[13px] text-m-tx3">
            Desde
            <input type="date" value={d.from} min={today} onChange={(e) => set({ from: e.target.value, to: e.target.value > d.to ? e.target.value : d.to })} className={`${INPUT_M} px-[10px]`} />
          </label>
          <label className="flex min-w-0 flex-col gap-[4px] text-[13px] text-m-tx3">
            Hasta
            <input type="date" value={d.to} min={d.from} onChange={(e) => set({ to: e.target.value })} aria-invalid={Boolean(err("dates"))} className={`${INPUT_M} px-[10px]`} />
          </label>
        </div>
        {err("dates") ? (
          <span role="alert" className="text-[13px] text-m-dn">
            {err("dates")}
          </span>
        ) : null}
        <SwitchRow checked={d.allDay} onChange={() => set({ allDay: !d.allDay })} label="Todo el día" className="min-h-[56px] rounded-[12px] py-[6px]" />
        {!d.allDay ? (
          <div className="grid grid-cols-2 gap-[8px]">
            <label className="flex min-w-0 flex-col gap-[4px] text-[13px] text-m-tx3">
              Hora inicio
              <input type="time" value={d.h1} onChange={(e) => set({ h1: e.target.value })} className={`${INPUT_M} u-tnum px-[10px]`} />
            </label>
            <label className="flex min-w-0 flex-col gap-[4px] text-[13px] text-m-tx3">
              Hora fin
              <input type="time" value={d.h2} onChange={(e) => set({ h2: e.target.value })} aria-invalid={Boolean(err("hours"))} className={`${INPUT_M} u-tnum px-[10px]`} />
            </label>
          </div>
        ) : null}
        {err("hours") ? (
          <span role="alert" className="text-[13px] text-m-dn">
            {err("hours")}
          </span>
        ) : null}
        {spanNote ? <span className="text-[13px] leading-[1.4] text-m-tx3">{spanNote}</span> : null}
        <span className="text-[13px] text-m-tx3">Fechas y horas en la zona de la sede · {tzLabel(tz)}</span>
      </section>

      <Field id="bf-r" label="Motivo" optional hint="Lo ve el equipo en la agenda; no se muestra a los clientes.">
        <input id="bf-r" value={d.reason} onChange={(e) => set({ reason: e.target.value })} placeholder="Ej.: Vacaciones" maxLength={200} className={INPUT_M} />
      </Field>

      <ConfirmSheet
        open={discard}
        title="¿Descartar el bloqueo?"
        body="No se ha guardado nada todavía. Si sales, se pierden los datos del formulario."
        cancelLabel="Seguir editando"
        okLabel="Descartar"
        onCancel={() => setDiscard(false)}
        onOk={() => {
          setDiscard(false);
          leave();
        }}
      />
    </Screen>
  );
}
