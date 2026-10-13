"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSiteAction } from "@/lib/schedulingAdminActions";
import type { Site } from "../../AdminPanel";
import { MButton, Sheet } from "../kit";
import { RULE_DESC, RULE_KEYS, RULE_TITLE, firstOpening, ruleExample, ruleLabel, ruleOptions, tzLabel, zonedParts, type RuleKey } from "./logic";
import { CARD_M, Chevron, ErrorNote, Field, ROW_M, SELECT_M, Screen, SubHeader, type ConfigNav } from "./ui";

/**
 * 4.13 Reglas de reserva · 4.14 Editar regla — the three REAL booking rules of a site
 * (sites.scheduling_config: min_notice_min, booking_horizon_days, slot_interval_min),
 * saved with updateSiteAction (which sanitises them). The other keys of the config (the
 * default buffers) are merged through untouched.
 */
export function RulesScreen({ nav, clientId, sites, toast }: { nav: ConfigNav; clientId: string; sites: Site[]; toast: (m: string) => void }) {
  const router = useRouter();
  const active = sites.filter((s) => s.active);
  const choices = active.length > 0 ? active : sites;
  const site = choices.find((s) => s.id === nav.id) ?? choices[0];
  const [edit, setEdit] = useState<{ key: RuleKey; value: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  if (!site) {
    return (
      <Screen label="Reglas de reserva" header={<SubHeader backLabel="Configuración" onBack={() => nav.back(null)} title="Reglas de reserva" />}>
        <div className={`${CARD_M} px-[18px] py-[24px] text-[14px] text-m-tx3`}>Crea o activa una sede para configurar sus reglas de reserva.</div>
      </Screen>
    );
  }
  const cfg = site.scheduling_config;
  const ctx = { todayKey: zonedParts(new Date(), site.timezone).key, firstOpen: firstOpening(site.opening_hours) };

  const save = () =>
    startSaving(async () => {
      if (!edit) return;
      if (edit.value === cfg[edit.key]) {
        setEdit(null);
        return;
      }
      setError(null);
      const r = await updateSiteAction(clientId, site.id, { schedulingConfig: { ...cfg, [edit.key]: edit.value } });
      if (!r.ok) {
        setError(r.error ?? "No se pudo guardar la regla.");
        return;
      }
      toast(`${RULE_TITLE[edit.key]}: ${ruleLabel(edit.key, edit.value)}`);
      setEdit(null);
      router.refresh();
    });

  return (
    <Screen
      label="Reglas de reserva"
      header={<SubHeader backLabel="Configuración" onBack={() => nav.back(null)} title="Reglas de reserva" sub={`${site.name} · ${tzLabel(site.timezone)}`} />}
    >
      {error && !edit ? <ErrorNote>{error}</ErrorNote> : null}
      {choices.length > 1 ? (
        <Field id="rl-s" label="Sede">
          <select id="rl-s" value={site.id} onChange={(e) => nav.setParam("id", e.target.value)} className={SELECT_M}>
            {choices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className={CARD_M}>
        {RULE_KEYS.map((k) => (
          <button key={k} type="button" onClick={() => setEdit({ key: k, value: cfg[k] })} className={`${ROW_M} min-h-[84px]`}>
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-[16px]">{RULE_TITLE[k]}</span>
              <span className="text-[13px] leading-[1.4] text-m-tx3">{ruleExample(k, cfg[k], ctx)}</span>
            </span>
            <span className="whitespace-nowrap text-[15px] font-semibold">{ruleLabel(k, cfg[k])}</span>
            <Chevron />
          </button>
        ))}
      </div>
      <p className="m-0 text-[14px] leading-[1.45] text-m-tx3">Aplican a la reserva en línea, al asistente y a las citas creadas desde la agenda.</p>

      <Sheet
        open={edit !== null}
        onClose={() => setEdit(null)}
        label={edit ? RULE_TITLE[edit.key] : "Regla"}
        footer={
          <div className="flex gap-[8px]">
            <MButton kind="secondary" onClick={() => setEdit(null)} disabled={saving}>
              Cancelar
            </MButton>
            <MButton kind="primary" grow onClick={save} loading={saving} loadingLabel="Guardando…">
              Guardar
            </MButton>
          </div>
        }
      >
        {edit ? (
          <div className="flex flex-col gap-[14px] px-[16px] pb-[14px]">
            <div className="flex flex-col gap-[4px]">
              <span className="text-[18px] font-semibold">{RULE_TITLE[edit.key]}</span>
              <span className="text-[14px] text-m-tx3">{RULE_DESC[edit.key]}</span>
            </div>
            <div role="radiogroup" aria-label={RULE_TITLE[edit.key]} className="grid grid-cols-3 gap-[8px]">
              {ruleOptions(edit.key, cfg[edit.key]).map((v) => {
                const sel = edit.value === v;
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={sel}
                    onClick={() => setEdit({ key: edit.key, value: v })}
                    className={`flex min-h-[44px] min-w-0 items-center justify-center rounded-[12px] border px-[6px] text-[15px] ${sel ? "border-m-pri bg-m-pri font-semibold text-m-onpri" : "border-m-bd bg-m-sf text-m-tx"}`}
                  >
                    {ruleLabel(edit.key, v)}
                  </button>
                );
              })}
            </div>
            <div aria-live="polite" className="rounded-[12px] bg-m-sf2 px-[14px] py-[12px] text-[14px] leading-[1.45] text-m-tx2">
              {ruleExample(edit.key, edit.value, ctx)}
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </div>
        ) : null}
      </Sheet>
    </Screen>
  );
}
