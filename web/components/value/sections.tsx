"use client";

import s from "./valueDashboard.module.css";
import { Chip, cx, KindTag, Meter, NoteList, TipBox, tipAttr, V } from "./bits";
import { buttonClass, segmentClass, segmentShell } from "@/components/ui/controls";
import {
  channelRows,
  CHANNEL_LABEL,
  cohortValue,
  evidenceCopy,
  fmtCOP,
  fmtDay,
  fmtHours,
  fmtN,
  fmtSeconds,
  ORIGIN_LABEL,
  outOfHoursView,
  qualityRows,
  reservationNotes,
  type EstimateView,
  type LensKey,
  type ModeKey,
} from "@/lib/valueDashboardView";
import type { ValueDashboardData } from "@worker/analytics/valueDashboardModel.js";

type Common = { data: ValueDashboardData; loading: boolean; vk: string };

const segTone = (channel: string, key: string): string =>
  key === "completed" || key === "pending" ? s[`c-${channel}-${key}`] : s[`c-${key}`];

/* ------------------------------------------------------- reservas y valor -- */

export function ReservationsCard({
  data,
  loading,
  vk,
  lens,
  mode,
  onLens,
  onMode,
  style,
}: Common & { lens: LensKey; mode: ModeKey; onLens: (l: LensKey) => void; onMode: (m: ModeKey) => void; style?: React.CSSProperties }) {
  const rows = channelRows(data, lens, mode);
  const notes = reservationNotes(data, lens, mode);
  const k = `${vk}-${lens}-${mode}`;
  return (
    <section aria-labelledby="vd-res" className={cx(s.card, s.gA, s.enter)} style={style}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 240px" }}>
          <h2 id="vd-res" className={s.h2}>
            Reservas y valor
          </h2>
          <p className={s.sub}>
            {lens === "creadas"
              ? "Citas creadas en el periodo, sin importar cuándo se atienden."
              : "Citas con fecha de atención en el periodo, sin importar cuándo se crearon."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Seg label="Qué fechas usar" value={lens} onChange={onLens} options={[["creadas", "Creadas"], ["atendidas", "Atendidas"]]} />
          <Seg label="Medida" value={mode} onChange={onMode} options={[["count", "Reservas"], ["value", "Valor"]]} />
        </div>
      </div>
      <TipBox style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {rows.map((r) => {
          const value = (
            <>
              <V loading={loading} k={k} w="7ch" style={{ fontSize: 15, fontWeight: 600 }}>
                {r.value}
              </V>
              <V loading={loading} k={k} w="11ch" className={s.tertiary} style={{ fontSize: 12, marginTop: 2 }}>
                {r.sub}
              </V>
            </>
          );
          return (
            <div key={r.channel} className={s.chRow}>
              <div className={s.chHead}>
                <span className={cx(s.chDot, s[`t-${r.channel}`])} aria-hidden />
                <span style={{ whiteSpace: "nowrap" }}>{r.name}</span>
                {r.isRef ? <span className={s.refTag}>Referencia</span> : null}
                <span className={s.chHeadMobileVal}>{value}</span>
              </div>
              <div role="img" aria-label={loading ? `${r.name}: cargando` : r.aria} className={s.stack}>
                <div className={s.stackInner} style={{ width: `${loading ? 0 : Math.max(r.sum > 0 ? 3 : 0, r.widthPct)}%` }}>
                  {r.segments.map((sg) =>
                    sg.n > 0 ? (
                      <span
                        key={sg.key}
                        {...tipAttr(sg.tip, loading)}
                        className={cx(s.seg, segTone(r.channel, sg.key))}
                        style={{ flexGrow: sg.n, flexShrink: 1, flexBasis: 0 }}
                      />
                    ) : null,
                  )}
                </div>
              </div>
              <div className={s.chVal}>{value}</div>
            </div>
          );
        })}
      </TipBox>
      <div className={s.legend}>
        <LegendItem cls={s.swCompleted} label="Completadas" />
        <LegendItem cls={s.swPending} label="Pendientes" />
        <LegendItem cls={s["c-no_show"]} label="No asistió" />
        {mode === "count" ? <LegendItem cls={s["c-cancelled"]} label="Canceladas" /> : null}
      </div>
      {loading ? null : <NoteList notes={notes} />}
    </section>
  );
}

function LegendItem({ cls, label }: { cls: string; label: string }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className={cx(s.sw, cls)} aria-hidden />
      {label}
    </span>
  );
}

export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  full,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  full?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx(segmentShell("sm"), full && s.segFull)}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={segmentClass(value === v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- fuera de horario -- */

export function OutOfHoursCard({ data, loading, vk, style }: Common & { style?: React.CSSProperties }) {
  const v = outOfHoursView(data);
  return (
    <section aria-labelledby="vd-out" className={cx(s.card, s.gB, s.enter)} style={{ gap: 14, ...style }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="vd-out" className={s.h2}>
          Actividad fuera de horario
        </h2>
        <p className={s.sub}>{v.subtitle}</p>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <V loading={loading} k={vk} w="2ch" className={s.big}>
          {v.total}
        </V>
        <V loading={loading} k={vk} w="16ch" className={s.secondary} style={{ fontSize: 14 }}>
          {v.pct}
        </V>
      </div>
      {v.state === "no_hours" && !loading ? null : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {v.rows.map((r) => (
            <div key={r.label} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 44px", gap: "4px 10px", alignItems: "center" }}>
              <span className={s.secondary} style={{ fontSize: 13.5 }}>
                {r.label}
              </span>
              <V loading={loading} k={vk} w="2ch" style={{ fontSize: 14, fontWeight: 600, textAlign: "right", justifySelf: "end" }}>
                {fmtN(r.n)}
              </V>
              <span style={{ gridColumn: "1 / -1" }}>
                <Meter pct={r.widthPct} tone={s["t-out"]} loading={loading} />
              </span>
            </div>
          ))}
        </div>
      )}
      {v.unclassified > 0 && !loading ? (
        <p className={s.note} style={{ margin: 0 }}>
          {fmtN(v.unclassified)} {v.unclassified === 1 ? "reserva" : "reservas"} del bot en sedes sin horario semanal configurado: no se pueden clasificar y no
          suman aquí.
        </p>
      ) : null}
      <p className={s.note} style={{ margin: "auto 0 0", lineHeight: 1.5, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
        Usa el horario semanal configurado: no contempla festivos ni excepciones. No significa que estas reservas se habrían perdido sin la automatización.
      </p>
    </section>
  );
}

/* --------------------------------------------------- atención automatizada -- */

export function AttentionCard({
  data,
  loading,
  vk,
  onOpenQuality,
  style,
}: Common & { onOpenQuality: () => void; style?: React.CSSProperties }) {
  const c = data.conversations;
  const enabled = data.evidence.enabled && c !== null;
  const copy = evidenceCopy(data);
  return (
    <section aria-labelledby="vd-att" className={cx(s.card, s.gC, s.enter)} style={style}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="vd-att" className={s.h2}>
          Atención automatizada
        </h2>
        <p className={s.sub}>
          {enabled ? (
            <V loading={loading} k={vk} w="24ch">
              {fmtN(totalConv(c))} conversaciones con mensajes del cliente en el periodo.
            </V>
          ) : (
            "Conversaciones del bot, solo con evidencia de que el registro de mensajes está completo."
          )}
        </p>
      </div>
      {!enabled ? (
        <div role="status" className={s.evidenceBox}>
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <circle cx="8" cy="8" r="6.2" />
              <path d="M8 4.8v3.8M8 11v.2" />
            </svg>
            {copy.title}
          </span>
          <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5, maxWidth: 520 }}>
            {copy.text}
          </span>
          {data.viewer === "agency" && copy.agencyHint ? (
            <span className={s.secondary} style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 520 }}>
              {copy.agencyHint}
            </span>
          ) : null}
          <span className={s.note}>Las reservas no dependen de esto y aparecen arriba.</span>
          {data.viewer === "agency" ? (
            <button type="button" onClick={onOpenQuality} className={buttonClass({ variant: "secondary", size: "sm" })} style={{ marginTop: 4 }}>
              Ver estado por workflow
            </button>
          ) : null}
        </div>
      ) : (
        <ConversationFacts data={data} loading={loading} vk={vk} />
      )}
    </section>
  );
}

function totalConv(c: ValueDashboardData["conversations"]): number {
  if (!c) return 0;
  const k = c.classes;
  return k.conIntervencionHumana + k.u2CitaBot + k.enCurso + k.u1RespondidaPorBot + k.conTurnosSinRespuesta;
}

function ConversationFacts({ data, loading, vk }: Common) {
  const { classes: k, turns: t } = data.conversations!;
  const a = k.u2CitaBot;
  const b = k.u1RespondidaPorBot + k.enCurso + k.conTurnosSinRespuesta;
  const cI = k.conIntervencionHumanaYCitaBot;
  const d = k.conIntervencionHumana - cI;
  const sinInt = a + b;
  const conInt = cI + d;
  const tot = sinInt + conInt;
  const pct = (n: number) => (tot > 0 ? ` · ${Math.round((n / tot) * 100)}%` : "");
  const tipSin = {
    title: "Sin intervención humana",
    lines: [`${fmtN(sinInt)} conversaciones${pct(sinInt)}`, `${fmtN(a)} con reserva del bot · ${fmtN(k.u1RespondidaPorBot)} respondidas por el bot`, `${fmtN(k.enCurso)} en curso · ${fmtN(k.conTurnosSinRespuesta)} con turnos sin respuesta o tardíos`],
  };
  const tipCon = {
    title: "Con intervención del equipo",
    lines: [`${fmtN(conInt)} conversaciones${pct(conInt)}`, `${fmtN(cI)} también con reserva del bot`],
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <TipBox style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className={s.overline}>INTERVENCIÓN</span>
        <div role="img" aria-label={`${fmtN(sinInt)} sin intervención humana, ${fmtN(conInt)} con intervención del equipo`} className={s.stack}>
          <div className={s.stackInner} style={{ width: loading || tot === 0 ? "0%" : "100%" }}>
            {sinInt > 0 ? <span {...tipAttr(tipSin, loading)} className={cx(s.seg, s["t-n8n"])} style={{ flexGrow: sinInt, flexBasis: 0 }} /> : null}
            {conInt > 0 ? <span {...tipAttr(tipCon, loading)} className={cx(s.seg, s["c-team-pending"])} style={{ flexGrow: conInt, flexBasis: 0 }} /> : null}
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px 16px", fontSize: 13.5 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={cx(s.sw, s["t-n8n"])} style={{ width: 10 }} aria-hidden />
            <span style={{ flex: 1 }}>Sin intervención humana</span>
            <V loading={loading} k={vk} w="5ch" style={{ fontWeight: 600 }}>
              {fmtN(sinInt)}
              {pct(sinInt)}
            </V>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={cx(s.sw, s["c-team-pending"])} style={{ width: 10 }} aria-hidden />
            <span style={{ flex: 1 }}>Con intervención del equipo</span>
            <V loading={loading} k={vk} w="5ch" style={{ fontWeight: 600 }}>
              {fmtN(conInt)}
              {pct(conInt)}
            </V>
          </span>
        </div>
      </TipBox>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span className={s.overline}>RESULTADO × INTERVENCIÓN</span>
        <div role="table" aria-label="Conversaciones por resultado e intervención" className={s.matrix}>
          <div role="row" style={{ display: "contents" }}>
            <span role="columnheader" className={s.mHead} />
            <span role="columnheader" className={cx(s.mHead, s.mHeadL)}>
              Con reserva del bot
            </span>
            <span role="columnheader" className={cx(s.mHead, s.mHeadL)}>
              Sin reserva
            </span>
          </div>
          <div role="row" style={{ display: "contents" }}>
            <span role="rowheader" className={s.mRow}>
              Sin intervención
            </span>
            <span role="cell" className={cx(s.mCell, s.mCellHi)}>
              <V loading={loading} k={vk} w="3ch">
                {fmtN(a)}
              </V>
            </span>
            <span role="cell" className={s.mCell}>
              <V loading={loading} k={vk} w="3ch">
                {fmtN(b)}
              </V>
            </span>
          </div>
          <div role="row" style={{ display: "contents" }}>
            <span role="rowheader" className={s.mRow}>
              Con intervención
            </span>
            <span role="cell" className={cx(s.mCell, s.mCellHi)}>
              <V loading={loading} k={vk} w="3ch">
                {fmtN(cI)}
              </V>
            </span>
            <span role="cell" className={s.mCell}>
              <V loading={loading} k={vk} w="3ch">
                {fmtN(d)}
              </V>
            </span>
          </div>
        </div>
        <span className={s.note} style={{ lineHeight: 1.5 }}>
          De las {fmtN(b)} sin reserva ni intervención: {fmtN(k.u1RespondidaPorBot)} respondidas por el bot en todos sus turnos, {fmtN(k.enCurso)} en curso y{" "}
          {fmtN(k.conTurnosSinRespuesta)} con turnos sin respuesta o tardíos. «Con reserva» y «con intervención» se cruzan en lugar de sumarse.
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
        <span className={s.overline}>PRIMERA RESPUESTA DEL BOT</span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <V loading={loading} k={vk} w="4ch" className={s.mid}>
            {t.medianaBotS === null ? "—" : fmtSeconds(t.medianaBotS)}
          </V>
          <V loading={loading} k={vk} w="20ch" className={s.secondary} style={{ fontSize: 13.5 }}>
            {t.medianaBotS === null
              ? "Sin turnos respondidos por el bot en el periodo"
              : `mediana · 9 de cada 10 en menos de ${fmtSeconds(t.p90BotS ?? t.medianaBotS)}`}
          </V>
        </div>
        <div className={s.facts}>
          {(
            [
              [t.respuestaTardia, "respuestas tardías (más de 30 min)"],
              [t.sinRespuestaObservable, "turnos sin respuesta registrada"],
              [t.enCurso, "turnos todavía en curso, sin medir"],
            ] as Array<[number, string]>
          ).map(([n, label]) => (
            <div key={label} className={s.fact}>
              <V loading={loading} k={vk} w="2ch" style={{ fontSize: 16, fontWeight: 600 }}>
                {fmtN(n)}
              </V>
              <span className={s.secondary} style={{ fontSize: 12.5, lineHeight: 1.35 }}>
                {label}
              </span>
            </div>
          ))}
        </div>
        <span className={s.note}>
          Base: {fmtN(t.turnos)} turnos del cliente en el periodo; {fmtN(t.respondidosPorPersona)} los respondió primero una persona.
        </span>
      </div>
      <span className={s.note} style={{ lineHeight: 1.5 }}>
        «Respondida por el bot» no significa «resuelta»: solo indica que el bot respondió y no hubo intervención humana.
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- estimación -- */

export function EstimateCard({
  data,
  loading,
  vk,
  ev,
  onOpen,
  style,
}: Common & { ev: EstimateView; onOpen: () => void; style?: React.CSSProperties }) {
  const e = ev.estimate;
  const ok = e.state === "confirmed";
  const owner = data.canConfirm;
  const status =
    ok && ev.latestConfirmed
      ? { tone: "ok" as const, text: `Confirmado · desde ${fmtDay(ev.latestConfirmed.effectiveFrom, true)}` }
      : e.state === "not_in_effect"
        ? { tone: "info" as const, text: `Confirmado · aplica desde ${fmtDay(e.version!.effectiveFrom, true)}` }
        : e.state === "proposed"
          ? { tone: "warn" as const, text: "Propuesto · sin confirmar" }
          : { tone: "info" as const, text: "Sin configurar" };
  const btnLabel = ok
    ? "Revisar supuestos"
    : e.state === "proposed"
      ? owner
        ? "Revisar y confirmar"
        : "Revisar propuesta"
      : owner
        ? "Configurar supuestos"
        : data.canPropose
          ? "Proponer supuestos"
          : "Ver supuestos";
  const rows: Array<[string, number]> = [];
  if (ok) {
    if (e.u1) rows.push([`${fmtN(e.u1.units)} conversaciones solo con el bot, sin reserva${e.u1.perUnit !== null ? ` × ${e.u1.perUnit} min` : ""}`, e.u1.minutes]);
    if (e.u2) rows.push([`${fmtN(e.u2.units)} conversaciones con reserva del bot, sin intervención${e.u2.perUnit !== null ? ` × ${e.u2.perUnit} min` : ""}`, e.u2.minutes]);
    if (e.u3) rows.push([`${fmtN(e.u3.units)} reservas en la página${e.u3.perUnit !== null ? ` × ${e.u3.perUnit} min` : ""}`, e.u3.minutes]);
  }
  return (
    <section aria-labelledby="vd-est" className={cx(s.card, s.cardEst, s.gD, s.enter)} style={{ gap: 14, ...style }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 200 }}>
          <span style={{ alignSelf: "flex-start" }}>
            <KindTag kind="estimate" />
          </span>
          <h2 id="vd-est" className={s.h2}>
            Capacidad liberada para tu equipo
          </h2>
        </div>
        <Chip tone={status.tone}>{status.text}</Chip>
      </div>
      {ok && e.publicOnly ? (
        <span className={s.partialChip}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
            <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4z" fill="currentColor" />
            <circle cx="8" cy="8" r="6.2" />
          </svg>
          Estimación parcial: solo página de reservas
        </span>
      ) : null}
      {ev.pending && ok ? <span className={s.note}>Hay una nueva propuesta pendiente de confirmar; mientras tanto se usan los supuestos confirmados.</span> : null}
      {ok ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <V loading={loading} k={vk} w="5ch" className={s.big}>
              {fmtHours(e.minutes ?? 0)}
            </V>
            <V loading={loading} k={vk} w="14ch" className={s.secondary} style={{ fontSize: 14 }}>
              ≈ {fmtCOP(e.value ?? 0)} en tiempo del equipo
            </V>
          </div>
          <div className={s.estRows}>
            {rows.map(([label, m]) => (
              <div key={label} className={s.estRow}>
                <V loading={loading} k={vk} w="24ch" className={s.secondary} style={{ lineHeight: 1.4 }}>
                  {label}
                </V>
                <V loading={loading} k={vk} w="6ch" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {fmtN(m)} min
                </V>
              </div>
            ))}
            {e.publicOnly ? (
              <div className={s.estRow}>
                <span className={s.secondary}>Conversaciones del bot · sin evidencia suficiente, no incluidas</span>
                <span style={{ fontWeight: 600 }}>—</span>
              </div>
            ) : null}
            <div className={s.estRow} style={{ borderBottom: 0 }}>
              <span className={s.secondary}>Costo por hora del equipo</span>
              <span style={{ fontWeight: 600 }}>{e.version ? fmtCOP(e.version.costoHora) : "Según el supuesto de cada día"}</span>
            </div>
          </div>
          {e.coveredDays < e.totalDays && e.firstCoveredDay ? (
            <span className={s.note}>
              Los supuestos aplican desde el {fmtDay(e.firstCoveredDay, true)}: antes no se estima tiempo ({e.coveredDays} de {e.totalDays} días).
            </span>
          ) : null}
          <span className={s.note} style={{ lineHeight: 1.5 }}>
            {e.publicOnly
              ? "Solo incluye reservas hechas en la página. Las conversaciones se sumarán cuando haya evidencia de que el registro de mensajes está completo. No es una reducción de nómina."
              : `Cada conversación cuenta una sola vez: si terminó en reserva usa solo los minutos de reserva. Excluye ${fmtN(data.conversations?.classes.conIntervencionHumana ?? 0)} conversaciones con intervención. No es una reducción de nómina.`}
          </span>
        </div>
      ) : (
        <div className={s.estEmpty}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>
            {e.state === "proposed" ? "Supuestos pendientes de confirmar" : e.state === "not_in_effect" ? "Los supuestos aún no aplican" : "Configura tu estimación"}
          </span>
          <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            {e.state === "proposed"
              ? owner
                ? "Tu agencia propuso supuestos. Revísalos y confírmalos para ver el tiempo liberado; hasta entonces no mostramos un ahorro."
                : "Hay supuestos propuestos, pero el negocio aún no los confirmó. No mostramos un tiempo liberado hasta entonces."
              : e.state === "not_in_effect"
                ? `Los supuestos confirmados aplican desde el ${fmtDay(e.version!.effectiveFrom, true)}, después de este periodo.`
                : owner
                  ? "Define cuántos minutos le toma a tu equipo atender una conversación o agendar una cita. Sin supuestos confirmados no mostramos un tiempo liberado."
                  : "Propón cuántos minutos le toma al equipo atender una conversación o agendar una cita. Solo el dueño del negocio puede confirmarlos."}
          </span>
        </div>
      )}
      <button type="button" onClick={onOpen} className={buttonClass({ variant: ok ? "secondary" : "primary" })} style={{ alignSelf: "flex-start" }}>
        {btnLabel}
      </button>
    </section>
  );
}

/* --------------------------------------------------------- clientes nuevos -- */

export function CohortCard({ data, loading, vk, style }: Common & { style?: React.CSSProperties }) {
  const t = data.cohort.tracking;
  const rows = data.cohort.rows;
  const total = rows.reduce((n, r) => n + r.clientesNuevos, 0);
  const max = Math.max(0, ...rows.map((r) => r.clientesNuevos));
  const startDay = t?.startedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: data.tz }).format(new Date(t.startedAt)) : null;
  return (
    <section aria-labelledby="vd-coh" className={cx(s.card, s.gF, s.enter)} style={{ gap: 14, ...style }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="vd-coh" className={s.h2}>
          Clientes nuevos por origen
        </h2>
        <p className={s.sub}>Clientes creados en el periodo y el valor de sus servicios completados en él.</p>
      </div>
      {!t ? (
        <div className={s.estEmpty}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>Sin seguimiento de origen</span>
          <span className={s.secondary} style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            El origen de los clientes no se está registrando para este negocio, así que no hay cohorte que mostrar.
          </span>
        </div>
      ) : startDay && startDay > data.period.toDay ? (
        <div className={s.estEmpty}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>El seguimiento empieza después de este periodo</span>
          <span className={s.secondary} style={{ fontSize: 13.5 }}>Seguimiento desde el {fmtDay(startDay, true)}.</span>
        </div>
      ) : (
        <>
          {t.partial && startDay ? (
            <span className={s.partialChip}>Seguimiento desde el {fmtDay(startDay, true)}: cohorte parcial</span>
          ) : null}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <V loading={loading} k={vk} w="2ch" className={s.big}>
              {fmtN(total)}
            </V>
            <span className={s.secondary} style={{ fontSize: 14 }}>
              {total === 1 ? "cliente nuevo" : "clientes nuevos"}
            </span>
          </div>
          {rows.length === 0 && !loading ? (
            <span className={s.note}>Ningún cliente nuevo en el periodo con seguimiento.</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((r) => {
                const cv = cohortValue(r);
                return (
                  <div key={r.origen} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "4px 12px", alignItems: "baseline" }}>
                    <span className={s.secondary} style={{ fontSize: 13.5 }}>
                      {ORIGIN_LABEL[r.origen] ?? r.origen} · <V loading={loading} k={vk} w="2ch">{fmtN(r.clientesNuevos)}</V>
                    </span>
                    <span style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                      <V loading={loading} k={vk} w="6ch" style={{ fontSize: 14, fontWeight: 600 }}>
                        {cv.text}
                      </V>
                      <V loading={loading} k={vk} w="10ch" className={s.tertiary} style={{ fontSize: 12 }}>
                        {cv.sub}
                      </V>
                    </span>
                    <span style={{ gridColumn: "1 / -1" }}>
                      <Meter pct={max > 0 ? (r.clientesNuevos / max) * 100 : 0} tone={s["t-public"]} loading={loading} height={6} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <p className={s.note} style={{ margin: 0, lineHeight: 1.5, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
            El origen es el primer contacto registrado del cliente. Valor = precio guardado en sus citas completadas; no es dinero cobrado.
          </p>
        </>
      )}
    </section>
  );
}

/* --------------------------------------------------------- gestiones del bot -- */

export function BotActionsCard({ data, loading, vk, style }: Common & { style?: React.CSSProperties }) {
  const a = data.botActions;
  const items: Array<[string, number]> = [
    ["Citas reprogramadas", a.rescheduled],
    ["Citas canceladas por el bot", a.cancelled],
    ["Citas confirmadas", a.confirmed],
  ];
  return (
    <section aria-labelledby="vd-bot" className={cx(s.card, s.gG, s.enter)} style={{ gap: 14, ...style }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 id="vd-bot" className={s.h2}>
          Gestiones del bot
        </h2>
        <p className={s.sub}>Cambios que el bot hizo sobre citas ya existentes.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {items.map(([label, n]) => (
          <div key={label} className={s.estRow}>
            <span className={s.secondary}>{label}</span>
            <V loading={loading} k={vk} w="2ch" style={{ fontWeight: 600 }}>
              {fmtN(n)}
            </V>
          </div>
        ))}
      </div>
      <p className={s.note} style={{ margin: "auto 0 0", lineHeight: 1.5 }}>
        Solo se cuentan: no suman tiempo liberado ni valor.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ salud -- */

export function HealthCard({ data, loading, vk, style }: Common & { style?: React.CSSProperties }) {
  const h = data.health;
  const bad = h.workflows.filter((w) => w.errors > 0);
  const rows = qualityRows(data).filter((r) => r.label !== "Automatizaciones");
  return (
    <section aria-labelledby="vd-hl" className={cx(s.card, s.cardSlim, s.gE, s.enter)} style={style}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 id="vd-hl" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
          Salud de las automatizaciones
        </h2>
        <span className={s.note}>Las ejecuciones técnicas no cuentan como tareas ni como ahorro.</span>
      </div>
      <div className={s.healthGrid}>
        <div className={s.inset} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className={s.secondary} style={{ fontSize: 12.5 }}>
            Ejecuciones con error
          </span>
          <V loading={loading} k={vk} w="2ch" style={{ fontSize: 18, fontWeight: 600 }}>
            {fmtN(h.errors)}
          </V>
          <V loading={loading} k={vk} w="14ch" className={s.tertiary} style={{ fontSize: 12.5 }}>
            {h.executions === 0 ? "Sin ejecuciones en el periodo" : `de ${fmtN(h.executions)} ejecuciones técnicas`}
          </V>
        </div>
        <div className={s.inset} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span className={s.secondary} style={{ fontSize: 12.5 }}>
            Necesitan atención
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 18, fontWeight: 600 }}>
            {loading ? null : <span className={cx(s.dot, bad.length ? s.dotWarn : s.dotOk)} aria-hidden />}
            <V loading={loading} k={vk} w="2ch">
              {fmtN(bad.length)}
            </V>
          </span>
          <V loading={loading} k={vk} w="14ch" className={s.tertiary} style={{ fontSize: 12.5 }}>
            {bad.length === 0 ? "Todo en orden" : bad.slice(0, 2).map((w) => `${w.name ?? w.id} · ${fmtN(w.errors)} con error`).join(" · ")}
          </V>
        </div>
        <div className={s.inset} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={s.secondary} style={{ fontSize: 12.5 }}>
            Instrumentación
          </span>
          {rows.map((r) => (
            <div key={r.label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{ flex: 1 }}>{r.label}</span>
              {loading ? <V loading k={vk} w="8ch">{""}</V> : <Chip tone={r.tone}>{r.status}</Chip>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export { CHANNEL_LABEL };
