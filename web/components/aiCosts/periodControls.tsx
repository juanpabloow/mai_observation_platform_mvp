"use client";

import { useState } from "react";
import Link from "next/link";
import a from "./aiCosts.module.css";
import { cx } from "@/components/value/bits";
import { FIELD } from "@/components/ui/controls";
import { fmtRange } from "@/lib/valueDashboardView";
import { resolvePeriod, type Period, type PeriodKey } from "@worker/analytics/valueDashboardModel.js";
import { resolveBaseline, type Baseline, type BaselineKey } from "@worker/analytics/aiCostPeriods.js";

/**
 * COSTOS DE IA — the pieces both screens (costs and executions) share: the period + comparison
 * control whose choices apply at once (no «Aplicar»), its query string, and the toggle between
 * the two screens, which keeps the chosen dates.
 */

export type Sel = { key: PeriodKey; from: string; to: string };
export type BaseSel = { key: BaselineKey; from: string; to: string };
type Draft = { p: Sel; b: BaseSel };

export function Seg<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className={a.seg}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className="u-focus">
          {l}
        </button>
      ))}
    </div>
  );
}

export function periodQuery(p: Sel, b: BaseSel): URLSearchParams {
  const qs = new URLSearchParams({ periodo: p.key });
  if (p.key === "custom") {
    qs.set("desde", p.from);
    qs.set("hasta", p.to);
  }
  if (b.key !== "anterior") qs.set("comparar", b.key);
  if (b.key === "custom") {
    qs.set("cdesde", b.from);
    qs.set("chasta", b.to);
  }
  return qs;
}

export const selOf = (p: Period): Sel => ({ key: p.key, from: p.fromDay, to: p.toDay });
export const baseSelOf = (b: Baseline): BaseSel => ({ key: b.key, from: b.fromDay, to: b.toDay });

/** What a draft would load, with the same rules the server applies. */
function previewOf(d: Draft, tz: string) {
  const pr = resolvePeriod(d.p.key === "custom" ? { key: "custom", from: d.p.from, to: d.p.to } : { key: d.p.key }, new Date(), tz);
  if (!pr.ok) return { error: pr.error } as const;
  const br = resolveBaseline(pr.period, d.b.key === "custom" ? { key: "custom", from: d.b.from, to: d.b.to } : { key: d.b.key }, tz);
  if (!br.ok) return { error: br.error } as const;
  return { period: pr.period, baseline: br.baseline } as const;
}

const BASE_SHORT: Record<BaselineKey, string> = { anterior: "vs anterior", mes: "vs mes anterior", custom: "" };
export const baseLabelOf = (b: Baseline) => BASE_SHORT[b.key] || `vs ${fmtRange(b.fromDay, b.toDay, false)}`;

/** The date pill. Lives inside the header's actions box (the popover is positioned there). */
export function RangeControl({
  period: p,
  baseline: b,
  sel,
  base,
  tz,
  today,
  loading,
  open,
  onToggle,
  onLoad,
}: {
  period: Period;
  baseline: Baseline;
  sel: Sel;
  base: BaseSel;
  tz: string;
  today: string;
  loading: boolean;
  open: boolean;
  onToggle: () => void;
  onLoad: (p: Sel, b: BaseSel) => void;
}) {
  return (
    <>
      <button type="button" className={cx(a.pill, "u-focus")} aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
          <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
        </svg>
        <span className={a.num}>{fmtRange(p.fromDay, p.toDay, false)}</span>
        <span className={a.muted}>{baseLabelOf(b)}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open ? <RangePopover period={p} baseline={b} sel={sel} base={base} tz={tz} today={today} loading={loading} onLoad={onLoad} /> : null}
    </>
  );
}

function RangePopover({
  period: p,
  baseline: b,
  sel,
  base,
  tz,
  today,
  loading,
  onLoad,
}: {
  period: Period;
  baseline: Baseline;
  sel: Sel;
  base: BaseSel;
  tz: string;
  today: string;
  loading: boolean;
  onLoad: (p: Sel, b: BaseSel) => void;
}) {
  // Mounted on open, so every opening starts from what is on screen.
  const [draft, setDraft] = useState<Draft>({ p: sel, b: base });
  const preview = previewOf(draft, tz);

  /** Every choice applies at once when it is valid. */
  function change(next: Draft) {
    setDraft(next);
    const pv = previewOf(next, tz);
    if ("error" in pv) return;
    const nextP: Sel = { key: next.p.key, from: pv.period.fromDay, to: pv.period.toDay };
    const nextB: BaseSel = { key: next.b.key, from: pv.baseline.fromDay, to: pv.baseline.toDay };
    if (periodQuery(nextP, nextB).toString() === periodQuery(sel, base).toString()) return;
    onLoad(nextP, nextB);
  }

  return (
    <div role="dialog" aria-label="Fechas" className={a.pop}>
      <span className={a.popLabel}>Periodo</span>
      <Seg
        label="Periodo"
        value={draft.p.key}
        onChange={(k) => change({ ...draft, p: { key: k, from: draft.p.from || p.fromDay, to: draft.p.to || p.toDay } })}
        options={[["7", "7 días"], ["30", "30 días"], ["custom", "Fechas"]]}
      />
      {draft.p.key === "custom" ? (
        <div className={a.dates}>
          <input type="date" aria-label="Periodo desde" className={cx(FIELD, "h-[40px]")} value={draft.p.from} max={today} onChange={(e) => change({ ...draft, p: { ...draft.p, from: e.target.value } })} />
          <input type="date" aria-label="Periodo hasta" className={cx(FIELD, "h-[40px]")} value={draft.p.to} max={today} onChange={(e) => change({ ...draft, p: { ...draft.p, to: e.target.value } })} />
        </div>
      ) : null}
      <span className={a.popLabel} style={{ marginTop: 4 }}>
        Comparar con
      </span>
      <Seg
        label="Comparar con"
        value={draft.b.key}
        onChange={(k) => change({ ...draft, b: { key: k, from: draft.b.from || b.fromDay, to: draft.b.to || b.toDay } })}
        options={[["anterior", "Anterior"], ["mes", "Mes anterior"], ["custom", "Fechas"]]}
      />
      {draft.b.key === "custom" ? (
        <div className={a.dates}>
          <input type="date" aria-label="Comparar desde" className={cx(FIELD, "h-[40px]")} value={draft.b.from} max={today} onChange={(e) => change({ ...draft, b: { ...draft.b, from: e.target.value } })} />
          <input type="date" aria-label="Comparar hasta" className={cx(FIELD, "h-[40px]")} value={draft.b.to} max={today} onChange={(e) => change({ ...draft, b: { ...draft.b, to: e.target.value } })} />
        </div>
      ) : null}
      <span aria-live="polite" className={"error" in preview ? a.popError : a.popRange}>
        {"error" in preview
          ? preview.error
          : `${fmtRange(preview.period.fromDay, preview.period.toDay)} vs ${fmtRange(preview.baseline.fromDay, preview.baseline.toDay)}${loading ? " · cargando…" : ""}`}
      </span>
    </div>
  );
}

export type CostsScreen = "costos" | "ejecuciones";

/**
 * «Costos de IA | Ejecuciones» — two screens, one place. A link per screen (it is navigation, and
 * the URL stays bookmarkable); the chosen dates go along.
 */
export function ScreenToggle({ current, qs }: { current: CostsScreen; qs: URLSearchParams }) {
  const href = (screen: CostsScreen) => {
    const q = new URLSearchParams(qs);
    q.delete("cliente");
    if (screen === "ejecuciones") q.set("vista", "ejecuciones");
    else q.delete("vista");
    return `?${q}`;
  };
  const items: Array<[CostsScreen, string]> = [
    ["costos", "Costos de IA"],
    ["ejecuciones", "Ejecuciones"],
  ];
  return (
    <nav aria-label="Pantalla" className={cx(a.seg, a.screens)}>
      {items.map(([k, label]) => (
        <Link key={k} href={href(k)} aria-current={current === k ? "page" : undefined} className="u-focus" scroll={false}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
