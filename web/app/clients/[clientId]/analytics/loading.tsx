import s from "@/components/value/valueDashboard.module.css";

/**
 * Route-level skeleton for the value dashboard: the same header rhythm, KPI row and grid as
 * the loaded page, so content replaces it without a jump. Static blocks — no shimmer loop,
 * and no number of any kind (never a $0 while data is unknown).
 */
export default function Loading() {
  const bar = (w: string, h = 12, soft = false) => <span className={`${s.skel} ${soft ? s.skelSoft : ""}`} style={{ width: w, height: h }} />;
  return (
    <div className={s.root} aria-busy="true" aria-label="Cargando datos">
      <header style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {bar("160px", 14)}
        {bar("min(420px, 80%)", 28)}
        {bar("min(520px, 90%)", 14, true)}
      </header>
      <div className={s.kpis}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={s.kpi} style={{ gap: 12, minHeight: 150 }}>
            {bar("60%")}
            {bar("45%", 26)}
            {bar("70%", 10, true)}
          </div>
        ))}
      </div>
      <div className={s.grid}>
        <div className={`${s.card} ${s.gA}`} style={{ minHeight: 300 }}>
          {bar("30%", 14)}
          {bar("90%", 26, true)}
          {bar("60%", 26, true)}
          {bar("75%", 26, true)}
        </div>
        <div className={`${s.card} ${s.gB}`} style={{ minHeight: 300 }}>
          {bar("50%", 14)}
          {bar("40%", 40, true)}
          {bar("80%", 14, true)}
        </div>
      </div>
      <span className={s.tertiary} style={{ fontSize: 13, textAlign: "center" }}>
        Cargando datos del periodo…
      </span>
    </div>
  );
}
