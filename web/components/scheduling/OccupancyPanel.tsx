"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { priceLabelCOP } from "@/lib/money";
import { hoursLabel, type OccupancyGranularity, type OccupancyRow } from "@/lib/occupancyView";
import type { OccupancyView } from "@/lib/occupancyData";

const GRAN_PARAM: Record<OccupancyGranularity, string> = { day: "dia", week: "semana", month: "mes" };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

const INPUT = "h-[34px] rounded-lg border border-line-strong bg-surface px-2.5 text-xs text-foreground outline-none transition focus:border-foreground";
const SEG = "u-focus rounded-md px-3 py-1 text-xs transition";

function fmtDay(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MESES[m - 1]}`;
}
function periodLabel(v: OccupancyView): string {
  if (v.sites.length === 0) return "";
  if (v.granularity === "day") {
    const [y] = v.period.from.split("-");
    return `${fmtDay(v.period.from)} ${y}`;
  }
  if (v.granularity === "week") return `${fmtDay(v.period.from)} – ${fmtDay(v.period.to)}`;
  const [y, m] = v.period.from.split("-").map(Number);
  return `${MESES[m - 1]} ${y}`;
}
const pctLabel = (p: number | null): string => (p === null ? "—" : `${p}%`);
/** One accent-tinted colour for an occupancy %, for cells and the trend. */
const tint = (pct: number | null): string =>
  pct === null ? "transparent" : `color-mix(in srgb, var(--accent) ${Math.min(100, Math.max(6, pct))}%, transparent)`;

type SortKey = "name" | "available" | "reservada" | "atendida" | "noshow" | "free" | "collected" | "sales";

export function OccupancyPanel({ clientName, view }: { clientName: string; view: OccupancyView }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "reservada", dir: "desc" });

  const nav = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, val] of Object.entries(patch)) {
      if (val === null || val === "") p.delete(k);
      else p.set(k, val);
    }
    const qs = p.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const setGran = (g: OccupancyGranularity) => nav({ g: GRAN_PARAM[g], d: null });
  const step = (dir: -1 | 1) => nav({ d: shiftAnchor(view.granularity, view.period.anchor, dir) });

  const sortVal = (r: OccupancyRow): number | string => {
    switch (sort.key) {
      case "name": return r.name.toLocaleLowerCase("es");
      case "available": return r.availableMin;
      case "atendida": return r.atendidaPct ?? -1;
      case "noshow": return r.noShowMin;
      case "free": return r.freeMin;
      case "collected": return Number(r.collectedAmount ?? "0");
      case "sales": return r.salesPerAvailableHour ?? -1;
      default: return r.reservadaPct ?? -1; // reservada
    }
  };
  const rows = [...view.rows].sort((a, b) => {
    const av = sortVal(a), bv = sortVal(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : a.staffId < b.staffId ? -1 : 1;
    return sort.dir === "asc" ? cmp : -cmp;
  });

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="u-page-title truncate text-[19px] font-semibold tracking-[-0.025em] text-foreground">Ocupación</h1>
              <span className="truncate text-xs text-muted">{clientName}</span>
            </div>
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              Cuánto del tiempo disponible de cada profesional se vende. Reservada cuenta lo agendado; atendida, lo que de verdad asistió.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!view.isStaff && view.sites.length > 1 ? (
              <select aria-label="Sede" value={view.selectedSiteId ?? ""} onChange={(e) => nav({ site: e.target.value, staff: null })} className={`${INPUT} max-w-[12rem]`}>
                {view.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            ) : null}
            <div className="flex items-center gap-0.5 rounded-lg bg-chip p-0.5" role="group" aria-label="Periodo">
              {(["day", "week", "month"] as const).map((g) => (
                <button key={g} type="button" aria-pressed={view.granularity === g} onClick={() => setGran(g)}
                  className={`${SEG} ${view.granularity === g ? "bg-surface font-medium text-foreground shadow-sm" : "text-muted hover:text-foreground"}`}>
                  {g === "day" ? "Día" : g === "week" ? "Semana" : "Mes"}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Periodo anterior" onClick={() => step(-1)} className="u-focus grid size-[34px] place-items-center rounded-lg border border-line-strong text-muted transition hover:bg-subtle hover:text-foreground">‹</button>
              <span className="min-w-[8.5rem] text-center text-xs font-medium text-foreground">{periodLabel(view)}</span>
              <button type="button" aria-label="Periodo siguiente" onClick={() => step(1)} className="u-focus grid size-[34px] place-items-center rounded-lg border border-line-strong text-muted transition hover:bg-subtle hover:text-foreground">›</button>
              <button type="button" onClick={() => nav({ d: null })} className="u-focus ml-1 h-[34px] rounded-lg border border-line-strong px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground">Hoy</button>
            </div>
          </div>
        </div>
      </PageShell>

      {view.sites.length === 0 ? (
        <PageShell><p className="p-8 text-center text-sm text-muted">No hay sedes configuradas. Crea una sede y sus horarios para medir la ocupación.</p></PageShell>
      ) : view.rows.length === 0 ? (
        <PageShell><p className="p-8 text-center text-sm text-muted">No hay profesionales que tomen reservas en esta sede todavía.</p></PageShell>
      ) : (
        <>
          {/* Site-total — the one bold number: how full the team is this period. */}
          {view.siteTotal ? <SiteTotal row={view.siteTotal} canMoney={view.canMoney} /> : null}

          {/* Per-professional table (sortable; horizontal scroll at ~390px). */}
          <PageShell ariaLabel="Ocupación por profesional" className="overflow-auto">
            <table className="w-full min-w-[46rem] border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-surface text-muted shadow-[0_1px_0_var(--line)]">
                <tr>
                  <Th sort={sort} onSort={setSort} k="name" label="Profesional" className="pl-4" />
                  <Th sort={sort} onSort={setSort} k="available" label="Horas disp." num />
                  <Th sort={sort} onSort={setSort} k="reservada" label="Reservada" num />
                  <Th sort={sort} onSort={setSort} k="atendida" label="Atendida" num />
                  <Th sort={sort} onSort={setSort} k="noshow" label="No-shows" num />
                  <Th sort={sort} onSort={setSort} k="free" label="Libres 7d" num />
                  <th scope="col" className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium">Tendencia</th>
                  {view.canMoney ? <Th sort={sort} onSort={setSort} k="collected" label="Cobrado" num /> : null}
                  {view.canMoney ? <Th sort={sort} onSort={setSort} k="sales" label="Ventas/hora" num /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.staffId} className="border-t border-line-soft hover:bg-subtle/50">
                    <td className="max-w-[12rem] truncate px-2.5 py-2 pl-4 font-medium text-foreground">{r.name}</td>
                    <td className="u-tnum px-2.5 py-2 text-right text-muted">{r.availableMin > 0 ? hoursLabel(r.availableMin) : <span className="text-faint">sin horario</span>}</td>
                    <PctCell pct={r.reservadaPct} />
                    <PctCell pct={r.atendidaPct} muted />
                    <td className="u-tnum px-2.5 py-2 text-right text-muted">{r.noShowMin > 0 ? hoursLabel(r.noShowMin) : "—"}</td>
                    <td className="u-tnum px-2.5 py-2 text-right text-muted">{hoursLabel(r.freeMin)}</td>
                    <td className="px-2.5 py-2"><Sparkline trend={r.trend} /></td>
                    {view.canMoney ? <td className="u-tnum px-2.5 py-2 text-right text-foreground">{priceLabelCOP(r.collectedAmount ?? "0") ?? "$0"}</td> : null}
                    {view.canMoney ? <td className="u-tnum px-2.5 py-2 text-right text-muted">{r.salesPerAvailableHour != null ? `${priceLabelCOP(r.salesPerAvailableHour)}/h` : "—"}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-2 text-[0.625rem] text-faint">
              Reservada = agendado ÷ disponible. Atendida = asistido ÷ disponible. El tiempo fuera de horario no infla el porcentaje.
            </p>
          </PageShell>

          {/* Heatmap — when is the site (or a professional) busiest, this period. */}
          {view.heatmap ? (
            <PageShell ariaLabel="Mapa de ocupación por día y hora" className="overflow-auto">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 sm:px-5">
                <h2 className="text-xs font-semibold text-foreground">Ocupación por día y hora</h2>
                {!view.isStaff ? (
                  <select aria-label="Profesional del mapa" value={view.heatmapStaffId ?? ""} onChange={(e) => nav({ staff: e.target.value || null })} className={`${INPUT}`}>
                    <option value="">Toda la sede</option>
                    {view.rows.map((r) => <option key={r.staffId} value={r.staffId}>{r.name}</option>)}
                  </select>
                ) : null}
              </div>
              <Heatmap grid={view.heatmap.grid} />
              <p className="px-4 pb-3 text-[0.625rem] text-faint">Intensidad = porcentaje reservado de la capacidad de esa hora. Las horas sin capacidad quedan en blanco.</p>
            </PageShell>
          ) : null}
        </>
      )}
    </main>
  );
}

function SiteTotal({ row, canMoney }: { row: OccupancyRow; canMoney: boolean }) {
  return (
    <PageShell grow={false} clip={false}>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-4 sm:px-5">
        <div>
          <div className="text-[0.625rem] uppercase tracking-wide text-faint">Ocupación reservada · toda la sede</div>
          <div className="u-tnum text-[2rem] font-semibold leading-none text-foreground">{pctLabel(row.reservadaPct)}</div>
        </div>
        <Metric label="Atendida" value={pctLabel(row.atendidaPct)} />
        <Metric label="Horas disponibles" value={hoursLabel(row.availableMin)} />
        <Metric label="Horas libres (7d)" value={hoursLabel(row.freeMin)} />
        <Metric label="No-shows" value={row.noShowMin > 0 ? hoursLabel(row.noShowMin) : "—"} />
        {canMoney ? <Metric label="Cobrado" value={priceLabelCOP(row.collectedAmount ?? "0") ?? "$0"} /> : null}
        {canMoney ? <Metric label="Ventas / hora disp." value={row.salesPerAvailableHour != null ? `${priceLabelCOP(row.salesPerAvailableHour)}` : "—"} /> : null}
      </div>
    </PageShell>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.625rem] uppercase tracking-wide text-faint">{label}</div>
      <div className="u-tnum text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}

function PctCell({ pct, muted }: { pct: number | null; muted?: boolean }) {
  return (
    <td className="px-2.5 py-2 text-right">
      <span className={`u-tnum inline-flex items-center justify-end gap-1.5 ${muted ? "text-muted" : "font-medium text-foreground"}`}>
        {pct !== null ? <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: tint(pct) }} /> : null}
        {pctLabel(pct)}
      </span>
    </td>
  );
}

function Sparkline({ trend }: { trend: Array<number | null> }) {
  if (trend.length === 0) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex h-6 items-end gap-0.5" aria-hidden>
      {trend.map((p, i) => (
        <span key={i} title={p === null ? "sin datos" : `${p}%`} className="w-1.5 rounded-sm bg-chip" style={{ height: p === null ? 2 : `${Math.max(2, (p / 100) * 24)}px`, backgroundColor: p === null ? undefined : tint(Math.max(20, p)) }} />
      ))}
    </span>
  );
}

function Heatmap({ grid }: { grid: Array<Array<{ availableMin: number; bookedMin: number }>> }) {
  // Only render hours that any day has capacity in (keeps the grid tight), else fall back to 8–20.
  let min = 24, max = 0;
  for (const row of grid) for (let h = 0; h < 24; h++) if (row[h].availableMin > 0) { min = Math.min(min, h); max = Math.max(max, h); }
  if (min > max) { min = 8; max = 20; }
  const hours = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div className="p-3 sm:p-4">
      <table className="border-separate border-spacing-0.5 text-[0.5625rem]">
        <thead>
          <tr>
            <th className="w-9" />
            {hours.map((h) => <th key={h} className="w-5 pb-1 text-center font-normal text-faint">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, wd) => (
            <tr key={wd}>
              <td className="pr-1.5 text-right font-medium text-muted">{DIAS[wd]}</td>
              {hours.map((h) => {
                const cell = row[h];
                const pct = cell.availableMin > 0 ? Math.round((cell.bookedMin / cell.availableMin) * 100) : null;
                return (
                  <td key={h}>
                    <div
                      title={pct === null ? `${DIAS[wd]} ${h}:00 · sin horario` : `${DIAS[wd]} ${h}:00 · ${pct}% (${cell.bookedMin}/${cell.availableMin} min)`}
                      className={`size-5 rounded-[3px] ${pct === null ? "bg-subtle/40" : "border border-line/40"}`}
                      style={pct === null ? undefined : { backgroundColor: tint(pct) }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ sort, onSort, k, label, className = "", num }: { sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void; k: SortKey; label: string; className?: string; num?: boolean }) {
  const active = sort.key === k;
  const toggle = () => onSort(active ? { key: k, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: k, dir: k === "name" ? "asc" : "desc" });
  return (
    <th scope="col" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`whitespace-nowrap px-2.5 py-1.5 font-medium ${num ? "text-right" : "text-left"} ${className}`}>
      <button type="button" onClick={toggle} className={`u-focus inline-flex items-center gap-1 hover:text-foreground ${num ? "flex-row-reverse" : ""}`}>
        {label}
        <span aria-hidden className="text-[0.625rem] text-faint">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );
}

function shiftAnchor(g: OccupancyGranularity, anchor: string, dir: -1 | 1): string {
  // Mirror of occupancyView.shiftPeriod (kept local so the client bundle need not import the lib's
  // other exports); day ±1, week ±7, month ±1 calendar month.
  const [y, m, d] = anchor.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (g === "day" || g === "week") {
    const u = new Date(Date.UTC(y, m - 1, d + dir * (g === "day" ? 1 : 7), 12));
    return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
  }
  const first = new Date(Date.UTC(y, m - 1 + dir, 1, 12));
  const clamp = Math.min(d, new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate());
  return `${first.getUTCFullYear()}-${pad(first.getUTCMonth() + 1)}-${pad(clamp)}`;
}
