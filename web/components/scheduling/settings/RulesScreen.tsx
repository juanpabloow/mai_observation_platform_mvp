"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { updateSiteAction } from "@/lib/schedulingAdminActions";
import { RULE_DESC, RULE_KEYS, RULE_TITLE, ruleLabel, ruleOptions, type RuleKey } from "../mobile/config/logic";
import type { Site } from "../AdminPanel";
import { Alert, Button } from "../ui/system";
import { ModuleSurface, SurfaceHeader, SurfaceToolbar } from "@/components/ui/module/ModuleSurface";
import { EditorFrame, EditorSection, ErrorSummary, SaveBar, SaveNote, changesLabel, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { AffixInput, Notice } from "@/components/ui/module/FormKit";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { usePageFormGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { SitePicker } from "./SitePicker";

/**
 * «Reglas de reserva» (Configuración) — the three rules that exist, PER SITE
 * (sites.scheduling_config): minimum notice, booking horizon and slot interval. Each one
 * shows its effect with a concrete example, and a summary combines them. There are no
 * cancellation or confirmation rules in the product, so none are offered.
 *
 * Saves through updateSiteAction with ONLY `schedulingConfig`, merged over the stored
 * config so the default buffers (not shown here) are preserved; the server sanitizes the
 * ranges again (0–525600 min, 1–365 days, 1–1440 min).
 */

const LIMITS: Record<RuleKey, { min: number; max: number; unit: string }> = {
  min_notice_min: { min: 0, max: 525600, unit: "min" },
  booking_horizon_days: { min: 1, max: 365, unit: "días" },
  slot_interval_min: { min: 1, max: 1440, unit: "min" },
};

type Form = Record<RuleKey, string>;
const fromSite = (s: Site): Form => ({
  min_notice_min: String(s.scheduling_config.min_notice_min),
  booking_horizon_days: String(s.scheduling_config.booking_horizon_days),
  slot_interval_min: String(s.scheduling_config.slot_interval_min),
});

function checkRule(k: RuleKey, v: string): string | null {
  if (!/^\d+$/.test(v.trim())) return "Escribe un número entero.";
  const n = Number(v);
  const { min, max, unit } = LIMITS[k];
  if (n < min || n > max) return `Entre ${min} y ${max} ${unit}.`;
  return null;
}

export function RulesScreen({ clientId, sites }: { clientId: string; sites: Site[] }) {
  const [siteParam, setSiteParam] = useUrlState("sede", "");
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const site = sites.find((s) => s.id === siteParam) ?? sites.find((s) => s.active) ?? sites[0];
  const pick = (id: string) => {
    if (id === site?.id) return;
    if (dirty) setSwitchTo(id);
    else setSiteParam(id);
  };
  return (
    <ModuleSurface label="Reglas de reserva">
      <SurfaceHeader title="Reglas de reserva" summary="Con cuánta anticipación y hasta cuándo se puede reservar, y cada cuánto se ofrecen horarios. Se configuran por sede." />
      {sites.length > 1 && site ? (
        <SurfaceToolbar>
          <SitePicker sites={sites} value={site.id} onChange={pick} what="las reglas" />
        </SurfaceToolbar>
      ) : null}
      {site ? (
        <RulesForm key={site.id} clientId={clientId} site={site} onDirtyChange={setDirty} />
      ) : (
        <div className="p-6">
          <Notice>Aún no hay sedes: las reglas se configuran por sede.</Notice>
        </div>
      )}
      {switchTo ? (
        <DiscardChanges
          body={`Las reglas de ${site?.name} tienen cambios sin guardar. Si cambias de sede, se pierden.`}
          onKeep={() => setSwitchTo(null)}
          onDiscard={() => {
            setDirty(false);
            setSiteParam(switchTo);
            setSwitchTo(null);
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

function RulesForm({ clientId, site, onDirtyChange }: { clientId: string; site: Site; onDirtyChange: (d: boolean) => void }) {
  const router = useRouter();
  const initial = useMemo(() => fromSite(site), [site]);
  const [f, setF] = useState<Form>(initial);
  const [attempted, setAttempted] = useState(false);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const changes = countChanges(initial, f);
  const dirty = changes > 0;
  const report = useRef(onDirtyChange);
  useEffect(() => {
    report.current = onDirtyChange;
  });
  useEffect(() => {
    report.current(dirty);
  }, [dirty]);
  const guard = usePageFormGuard(dirty && state !== "saving");

  const errors = Object.fromEntries(RULE_KEYS.map((k) => [k, checkRule(k, f[k])]).filter(([, e]) => e)) as Partial<Record<RuleKey, string>>;
  const show = (k: RuleKey) => ((attempted || f[k] !== initial[k]) && errors[k]) || "";
  const n = (k: RuleKey) => (errors[k] ? null : Number(f[k]));

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length) return;
    setState("saving");
    setError(null);
    const r = await updateSiteAction(clientId, site.id, {
      // Merge over the existing config so the buffers (not shown here) are preserved.
      schedulingConfig: {
        ...site.scheduling_config,
        min_notice_min: Number(f.min_notice_min),
        booking_horizon_days: Number(f.booking_horizon_days),
        slot_interval_min: Number(f.slot_interval_min),
      },
    });
    if (!r.ok) {
      setState("idle");
      setError(`${r.error ?? "No se pudo guardar."} Lo que escribiste se conserva.`);
      return;
    }
    setState("saved");
    router.refresh();
  };
  const reset = () => {
    setF(initial);
    setAttempted(false);
    setError(null);
  };

  // Concrete examples, from the values on screen.
  const notice = n("min_notice_min");
  const horizon = n("booking_horizon_days");
  const slot = n("slot_interval_min");
  const exampleNotice =
    notice === null ? "—" : notice === 0 ? "Se puede reservar un horario que empieza ahora mismo." : `Si son las 10:00, el primer horario que se ofrece es a partir de las ${clock(600 + notice)}${notice >= 1440 ? " (otro día)" : ""}.`;
  const until = horizon === null ? null : (() => {
    const d = new Date();
    d.setDate(d.getDate() + horizon);
    return d.toLocaleDateString("es-CO", { day: "numeric", month: "long" });
  })();
  const exampleHorizon = horizon === null ? "—" : `Hoy se puede reservar hasta el ${until}.`;
  const exampleSlot = slot === null ? "—" : `Horarios de inicio: 10:00, ${clock(600 + slot)}, ${clock(600 + slot * 2)}…`;

  const summary: SummaryError[] = attempted ? RULE_KEYS.filter((k) => errors[k]).map((k) => ({ target: `rule-${k}`, message: `${RULE_TITLE[k]}: ${errors[k]}` })) : [];
  const examples: Record<RuleKey, string> = { min_notice_min: exampleNotice, booking_horizon_days: exampleHorizon, slot_interval_min: exampleSlot };
  const sectionId: Record<RuleKey, string> = { min_notice_min: "rules-notice", booking_horizon_days: "rules-horizon", slot_interval_min: "rules-slot" };

  return (
    <>
      {/* Three rules and a summary: a short form, no section index. */}
      <EditorFrame
        layout="rows"
        sections={[
          ...RULE_KEYS.map((k) => ({ id: sectionId[k], label: RULE_TITLE[k], dirty: f[k] !== initial[k], errors: attempted && errors[k] ? 1 : 0 })),
          { id: "rules-summary", label: "Resumen" },
        ]}
        saveBar={<SaveBar changes={changes} onCancel={reset} onSave={save} saving={state === "saving"} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {RULE_KEYS.map((k) => (
          <EditorSection key={k} id={sectionId[k]} title={RULE_TITLE[k]} description={RULE_DESC[k]} summary={errors[k] ? "Revisar" : ruleLabel(k, Number(f[k]))} error={show(k) || undefined}>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={`Valores frecuentes de ${RULE_TITLE[k].toLocaleLowerCase("es")}`}>
              {ruleOptions(k, Number(initial[k])).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={f[k] === String(v)}
                  onClick={() => setF((x) => ({ ...x, [k]: String(v) }))}
                  className={`u-focus inline-flex h-[44px] items-center rounded-sch-control border px-3 text-[0.8125rem] font-medium tabular-nums transition-colors lg:h-[2.125rem] ${
                    f[k] === String(v) ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface text-foreground hover:bg-subtle"
                  }`}
                >
                  {ruleLabel(k, v)}
                </button>
              ))}
            </div>
            <label className="flex max-w-[16rem] flex-col gap-1">
              <span className="text-xs text-muted">Otro valor</span>
              <AffixInput id={`rule-${k}`} inputMode="numeric" value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} aria-invalid={Boolean(show(k))} suffix={LIMITS[k].unit} />
            </label>
            <p className="rounded-sch-control bg-subtle px-3.5 py-2.5 text-[0.8125rem] text-foreground">
              <span className="font-medium">Ejemplo: </span>
              {examples[k]}
            </p>
          </EditorSection>
        ))}
        <EditorSection id="rules-summary" title="Resumen" description={`Así reserva un cliente en ${site.name} con lo que ves en pantalla; se aplica al guardar.`}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.8438rem]">
            <li>{notice === null ? "Anticipación mínima por revisar." : notice === 0 ? "Puede reservar sin anticipación mínima." : `Debe reservar con al menos ${ruleLabel("min_notice_min", notice)} de anticipación.`}</li>
            <li>{horizon === null ? "Horizonte por revisar." : `Puede reservar hasta ${ruleLabel("booking_horizon_days", horizon)} hacia adelante (hoy: hasta el ${until}).`}</li>
            <li>{slot === null ? "Intervalo por revisar." : `Ve horarios de inicio cada ${slot} min, dentro del horario de la sede y de cada profesional.`}</li>
          </ul>
          <p className="text-xs text-muted">No hay reglas de cancelación ni de confirmación en la agenda: solo estas tres.</p>
        </EditorSection>
        <div className="hidden items-center justify-end gap-2 pt-4 lg:flex">
          <span aria-live="polite" className="mr-auto text-[0.7812rem] text-muted">
            {dirty ? changesLabel(changes) : <SaveNote state={state === "saved" ? "saved" : "idle"} />}
          </span>
          {dirty ? (
            <Button onClick={reset} disabled={state === "saving"}>
              Descartar
            </Button>
          ) : null}
          <Button variant="primary" onClick={save} disabled={!dirty} loading={state === "saving"} loadingLabel="Guardando…">
            Guardar reglas
          </Button>
        </div>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Las reglas tienen cambios sin guardar. Si sales ahora, se pierden." /> : null}
    </>
  );
}

function clock(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
