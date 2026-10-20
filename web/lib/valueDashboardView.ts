import {
  addBuckets,
  addDays,
  automatedTotal,
  bucketState,
  channelTotal,
  computeEstimate,
  deltaOf,
  missingPrices,
  pendingProposal,
  RESERVED_OUTCOMES,
  type AssumptionVersion,
  type Bucket,
  type Channel,
  type Delta,
  type Estimate,
  type EvidenceWorkflow,
  type Lens,
  type Outcome,
  type ValueDashboardData,
} from "@worker/analytics/valueDashboardModel.js";

/**
 * VALUE DASHBOARD — the presentation model. Pure (no React, no DB): every text, state and
 * number the screen shows is derived HERE from the server payload, so the copy rules of the
 * spec are testable in one place (test/unit/valueDashboardView.test.ts):
 *   - unknown is «Valor desconocido» / «—» with its reason, never $0 or 0;
 *   - $0 with a saved price is a real $0 (free services), not "missing price";
 *   - money is «valor», never ahorro / cobrado / facturado; a conversation is never «resuelta»;
 *   - an estimate always says it is one, and only exists with confirmed assumptions.
 */

/* ------------------------------------------------------------------ format -- */

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function parts(day: string): { y: number; m: number; d: number } {
  return { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)), d: Number(day.slice(8, 10)) };
}

export function fmtDay(day: string, withYear = false): string {
  const p = parts(day);
  return `${p.d} ${MONTHS[p.m - 1]}${withYear ? ` ${p.y}` : ""}`;
}

/** "19 sep – 18 oct 2026", "12 – 18 oct 2026", "20 dic 2025 – 18 ene 2026". */
export function fmtRange(from: string, to: string, withYear = true): string {
  const a = parts(from);
  const b = parts(to);
  const y = withYear ? ` ${b.y}` : "";
  if (from === to) return `${b.d} ${MONTHS[b.m - 1]}${y}`;
  if (a.y !== b.y) return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.m === b.m) return `${a.d} – ${b.d} ${MONTHS[b.m - 1]}${y}`;
  return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]}${y}`;
}

export const fmtN = (n: number): string => Math.round(n).toLocaleString("de-DE");
export const fmtCOP = (n: number): string => `${n < 0 ? "-" : ""}$${Math.round(Math.abs(n)).toLocaleString("de-DE")}`;
export const fmtHours = (minutes: number): string =>
  `${(minutes / 60).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
export const fmtPct = (p: number): string => `${Math.round(p * 100)}%`;
export function fmtSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} min ${r} s` : `${m} min`;
}
const plural = (n: number, one: string, many: string): string => `${fmtN(n)} ${n === 1 ? one : many}`;

export function fmtDateTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const time = new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return `${fmtDay(date, true)}, ${time}`;
}

export function updatedLabel(iso: string, tz: string, now = new Date()): string {
  const fmt = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("es-CO", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return fmt(new Date(iso)) === fmt(now) ? `Actualizado hoy, ${time}` : `Actualizado el ${fmtDateTime(iso, tz)}`;
}

/* ------------------------------------------------------------------- chips -- */

export type Tone = "ok" | "warn" | "info" | "est";

/* ---------------------------------------------------------------- channels -- */

export const CHANNEL_LABEL: Record<Channel, string> = { n8n: "Bot de WhatsApp", public: "Página de reservas", team: "Equipo" };
export const OUTCOME_LABEL: Record<Outcome, string> = {
  completed: "Completadas",
  pending: "Pendientes",
  no_show: "No asistió",
  cancelled: "Canceladas",
};

/* ------------------------------------------------------------------- texts -- */

export type MetricId = "res" | "val" | "comp" | "time";

export const METRIC_TEXT: Record<MetricId, { label: string; cuenta: string; excluye: string; tipo: string }> = {
  res: {
    label: "Reservas creadas por automatización",
    cuenta: "Citas creadas en el periodo por el bot de WhatsApp o la página de reservas, con cualquier resultado posterior.",
    excluye: "Citas creadas por el equipo y reprogramaciones de citas ya existentes.",
    tipo: "Medido desde el registro de citas.",
  },
  val: {
    label: "Valor de reservas creadas",
    cuenta: "Precio guardado en cada cita creada por automatización en el periodo. Incluye pendientes y no asistidas.",
    excluye: "Canceladas y citas sin precio guardado. No es dinero cobrado: no hay registro de pagos.",
    tipo: "Medido con el precio guardado en la cita.",
  },
  comp: {
    label: "Valor de servicios completados",
    cuenta: "Precio guardado en las citas creadas por automatización, con fecha de atención en el periodo y marcadas como completadas.",
    excluye: "Canceladas, no asistidas, pendientes y citas sin precio guardado. No equivale a dinero cobrado.",
    tipo: "Medido con el precio guardado en la cita.",
  },
  time: {
    label: "Tiempo liberado estimado",
    cuenta: "Minutos que el equipo habría dedicado a reservas de la página y, con conversaciones verificadas, a conversaciones atendidas solo por el bot, según supuestos confirmados por el negocio.",
    excluye: "Conversaciones con intervención del equipo, gestiones del bot y ejecuciones técnicas. No es una reducción de nómina.",
    tipo: "Calculado con supuestos del negocio.",
  },
};

/* ------------------------------------------------------------------ deltas -- */

export function deltaText(d: Delta): { text: string; tone: "up" | "down" | "flat" | "muted" } {
  if (d.kind === "unavailable") return { text: d.reason, tone: "muted" };
  if (d.kind === "no_prev_activity") return { text: `Sin actividad en el periodo anterior (${d.prevLabel})`, tone: "muted" };
  if (d.pct === 0) return { text: `= 0% vs ${d.prevLabel}`, tone: "flat" };
  return d.pct > 0 ? { text: `▲ ${d.pct}% vs ${d.prevLabel}`, tone: "up" } : { text: `▼ ${Math.abs(d.pct)}% vs ${d.prevLabel}`, tone: "down" };
}

const exact = (b: Bucket) => ({ value: b.value, exact: b.count === b.withPrice });

/* ---------------------------------------------------------------- estimate -- */

export interface EstimateView {
  estimate: Estimate;
  prev: Estimate | null;
  pending: AssumptionVersion | null;
  latestConfirmed: AssumptionVersion | null;
}

export function estimateView(data: ValueDashboardData): EstimateView {
  const enabled = data.evidence.enabled;
  const versions = data.assumptions.versions;
  const estimate = computeEstimate(data.units, versions, enabled);
  const prev = estimate.state === "confirmed" ? computeEstimate(data.prevUnits, versions, enabled) : null;
  const latestConfirmed =
    versions.filter((v) => v.status === "confirmed").sort((a, b) => ((a.confirmedAt ?? "") < (b.confirmedAt ?? "") ? 1 : -1))[0] ?? null;
  return { estimate, prev, pending: pendingProposal(versions), latestConfirmed };
}

/* -------------------------------------------------------------------- KPIs -- */

export interface KpiView {
  id: MetricId;
  label: string;
  value: string;
  /** A sentence instead of a number (unknown / not configured): rendered smaller. */
  small: boolean;
  delta: { text: string; tone: "up" | "down" | "flat" | "muted" };
  note: string;
  kind: "measured" | "estimate";
}

export function prevLabel(data: ValueDashboardData): string {
  return fmtRange(data.period.prevFromDay, data.period.prevToDay, false);
}

export function kpis(data: ValueDashboardData, ev: EstimateView): KpiView[] {
  const pl = prevLabel(data);
  // The full reason is said once, in the period line; each card only says there is none.
  const cmp = data.comparison.available ? data.comparison : { available: false, reason: "Sin comparación disponible" };
  const created = automatedTotal(data.created);
  const createdPrev = automatedTotal(data.prevCreated);
  const reserved = automatedTotal(data.created, RESERVED_OUTCOMES);
  const reservedPrev = automatedTotal(data.prevCreated, RESERVED_OUTCOMES);
  const completed = automatedTotal(data.dated, ["completed"]);
  const completedPrev = automatedTotal(data.prevDated, ["completed"]);
  const bot = channelTotal(data.created.n8n).count;
  const page = channelTotal(data.created.public).count;

  const res: KpiView = {
    id: "res",
    ...pick("res"),
    value: fmtN(created.count),
    small: false,
    delta: deltaText(deltaOf({ value: created.count, exact: true }, { value: createdPrev.count, exact: true }, pl, cmp)),
    note: created.count === 0 ? "Sin reservas automatizadas en el periodo" : `${fmtN(bot)} bot · ${fmtN(page)} página`,
    kind: "measured",
  };

  const rs = bucketState(reserved);
  const val: KpiView = {
    id: "val",
    ...pick("val"),
    value: rs === "unknown" ? "Valor desconocido" : fmtCOP(reserved.value ?? 0),
    small: rs === "unknown",
    delta: deltaText(rs === "zero" && reservedPrev.count === 0 ? deltaOf({ value: 0, exact: true }, { value: 0, exact: true }, pl, cmp) : deltaOf(exact(reserved), exact(reservedPrev), pl, cmp)),
    note:
      rs === "zero"
        ? "Sin reservas automatizadas vigentes en el periodo"
        : rs === "unknown"
          ? `Ninguna de las ${fmtN(reserved.count)} citas tiene precio guardado`
          : rs === "partial"
            ? `${plural(missingPrices(reserved), "cita sin precio", "citas sin precio")} fuera del cálculo`
            : "Precio guardado en la cita, no dinero cobrado",
    kind: "measured",
  };

  const cs = bucketState(completed);
  const comp: KpiView = {
    id: "comp",
    ...pick("comp"),
    value: cs === "unknown" ? "Valor desconocido" : fmtCOP(completed.value ?? 0),
    small: cs === "unknown",
    delta: deltaText(cs === "zero" && completedPrev.count === 0 ? deltaOf({ value: 0, exact: true }, { value: 0, exact: true }, pl, cmp) : deltaOf(exact(completed), exact(completedPrev), pl, cmp)),
    note:
      cs === "zero"
        ? "Ningún servicio automatizado completado en el periodo"
        : cs === "unknown"
          ? `${plural(completed.count, "completado", "completados")}, ninguno con precio guardado`
          : cs === "partial"
            ? `${plural(completed.count, "completado", "completados")} · ${fmtN(missingPrices(completed))} sin precio`
            : plural(completed.count, "servicio completado", "servicios completados"),
    kind: "measured",
  };

  const e = ev.estimate;
  const ok = e.state === "confirmed";
  let timeDelta: KpiView["delta"];
  if (!ok) timeDelta = { text: "No mostramos un tiempo liberado sin supuestos confirmados", tone: "muted" };
  else if (e.publicOnly) timeDelta = { text: "Sin comparación: cobertura parcial", tone: "muted" };
  else if (!ev.prev || ev.prev.state !== "confirmed" || ev.prev.coveredDays < ev.prev.totalDays || e.coveredDays < e.totalDays)
    timeDelta = { text: "Sin comparación: los supuestos no cubren ambos periodos", tone: "muted" };
  else timeDelta = deltaText(deltaOf({ value: e.minutes, exact: true }, { value: ev.prev.minutes, exact: true }, pl, cmp));
  const time: KpiView = {
    id: "time",
    ...pick("time"),
    value: ok ? fmtHours(e.minutes ?? 0) : e.state === "proposed" ? "Pendiente de confirmar" : e.state === "not_in_effect" ? "Aún no aplica" : "Configura tu estimación",
    small: !ok,
    delta: timeDelta,
    note: ok
      ? e.publicOnly
        ? "Estimación parcial: solo página de reservas"
        : `≈ ${fmtCOP(e.value ?? 0)} en tiempo del equipo`
      : e.state === "proposed"
        ? "Supuestos propuestos, sin confirmar"
        : e.state === "not_in_effect"
          ? `Los supuestos aplican desde el ${fmtDay(e.version!.effectiveFrom, true)}`
          : "Sin supuestos confirmados",
    kind: "estimate",
  };
  return [res, val, comp, time];
}

function pick(id: MetricId) {
  return { label: METRIC_TEXT[id].label };
}

/* ------------------------------------------------- reservations by channel -- */

export type LensKey = "creadas" | "atendidas";
export type ModeKey = "count" | "value";

/** What a hover / tap on a bar reveals: exact values, never estimates of their own. */
export interface Tip {
  title: string;
  lines: string[];
}

export interface Segment {
  key: Outcome;
  n: number;
  tip: Tip;
}

/** The money line of a bucket, keeping unknown ≠ $0 and saying what is missing. */
function bucketValueLine(b: Bucket): string {
  const st = bucketState(b);
  if (st === "zero") return "$0";
  if (st === "unknown") return "Valor desconocido: sin precio guardado";
  if (st === "partial") return `${fmtCOP(b.value ?? 0)} · ${plural(missingPrices(b), "cita sin precio", "citas sin precio")}`;
  return fmtCOP(b.value ?? 0);
}
const pctOf = (n: number, total: number): string => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%");
export interface ChannelRow {
  channel: Channel;
  name: string;
  isRef: boolean;
  segments: Segment[];
  sum: number;
  /** 0–100, relative to the largest row (stable base: 0 when there is nothing). */
  widthPct: number;
  value: string;
  sub: string;
  unknown: boolean;
  aria: string;
}

export function channelRows(data: ValueDashboardData, lens: LensKey, mode: ModeKey): ChannelRow[] {
  const L: Lens = lens === "creadas" ? data.created : data.dated;
  const raw = (["n8n", "public", "team"] as Channel[]).map((c) => {
    const cb = L[c];
    const outcomes: Outcome[] = mode === "value" ? ["completed", "pending", "no_show"] : ["completed", "pending", "no_show", "cancelled"];
    const raw = outcomes.map((o) => ({ key: o, n: mode === "value" ? cb[o].value ?? 0 : cb[o].count }));
    const sum = raw.reduce((s, x) => s + x.n, 0);
    const segments: Segment[] = raw.map((x) => {
      const b = cb[x.key];
      const title = `${CHANNEL_LABEL[c]} · ${OUTCOME_LABEL[x.key]}`;
      const lines =
        mode === "value"
          ? [`${bucketValueLine(b)} · ${pctOf(x.n, sum)} del valor del canal`, plural(b.count, "cita", "citas")]
          : [
              `${plural(b.count, "cita", "citas")} · ${pctOf(x.n, sum)} del canal`,
              x.key === "cancelled" ? `${bucketValueLine(b)} · no suma al valor` : bucketValueLine(b),
            ];
      return { ...x, tip: { title, lines } };
    });
    const live = addBuckets(...RESERVED_OUTCOMES.map((o) => cb[o]));
    return { c, cb, segments, sum, live };
  });
  const max = Math.max(0, ...raw.map((r) => r.sum));
  return raw.map(({ c, cb, segments, sum, live }) => {
    const unknown = mode === "value" && bucketState(live) === "unknown";
    const fmt = (n: number) => (mode === "value" ? fmtCOP(n) : fmtN(n));
    return {
      channel: c,
      name: CHANNEL_LABEL[c],
      isRef: c === "team",
      segments,
      sum,
      widthPct: max > 0 ? (sum / max) * 100 : 0,
      value: unknown ? "Valor desconocido" : fmt(sum),
      sub:
        mode === "value"
          ? live.count === 0
            ? "Sin citas vigentes"
            : `${fmtN(live.withPrice)} de ${fmtN(live.count)} citas con precio`
          : lens === "creadas"
            ? plural(cb.cancelled.count, "cancelada", "canceladas")
            : plural(cb.completed.count, "completada", "completadas"),
      unknown,
      aria: `${CHANNEL_LABEL[c]}: ${segments.map((s) => `${OUTCOME_LABEL[s.key]} ${fmt(s.n)}`).join(", ")}${unknown ? ". Valor desconocido: ninguna cita con precio" : ""}`,
    };
  });
}

export interface Note {
  mark: "i" | "!" | "−";
  warn?: boolean;
  text: string;
}

export function reservationNotes(data: ValueDashboardData, lens: LensKey, mode: ModeKey): Note[] {
  const L = lens === "creadas" ? data.created : data.dated;
  const live = automatedTotal(L, RESERVED_OUTCOMES);
  const cancelled = automatedTotal(L, ["cancelled"]);
  const notes: Note[] = [];
  if (mode === "value") {
    notes.push({
      mark: "−",
      text:
        cancelled.count === 0
          ? "Las citas canceladas no suman al valor. No asistidas se muestran aparte de completadas."
          : `${plural(cancelled.count, "cita cancelada", "citas canceladas")}${cancelled.withPrice > 0 ? ` (${fmtCOP(cancelled.value ?? 0)})` : ""} no ${cancelled.count === 1 ? "suma" : "suman"} al valor. No asistidas se muestran aparte de completadas.`,
    });
  } else {
    notes.push({ mark: "i", text: "Canceladas y no asistidas se muestran por separado: no cuentan como servicios completados." });
  }
  const st = bucketState(live);
  if (st === "unknown") {
    notes.push({
      mark: "!",
      warn: true,
      text: "Ninguna cita automatizada vigente tiene precio guardado: el valor es desconocido, no $0. Usamos el precio guardado en cada cita al crearla; editar hoy el precio de un servicio no cambia las citas anteriores.",
    });
  } else if (st === "partial") {
    notes.push({
      mark: "!",
      warn: true,
      text: `${plural(missingPrices(live), "cita automatizada no tiene", "citas automatizadas no tienen")} precio guardado y ${missingPrices(live) === 1 ? "queda" : "quedan"} fuera del valor. Usamos el precio guardado en cada cita: editar hoy un servicio no cambia las citas anteriores.`,
    });
  }
  if (live.withPrice > 0 && hasFreeGroup(L)) {
    notes.push({ mark: "i", text: "Hay citas con precio guardado de $0 (servicios gratuitos): cuentan con su precio, no como precio faltante." });
  }
  notes.push({ mark: "i", text: "El equipo aparece solo como referencia: no suma a los totales de automatización." });
  return notes;
}

/** Is there a group whose saved prices are all $0? The aggregate cannot count $0 prices
 *  mixed among paid ones, so this only says free appointments EXIST — never how many. */
function hasFreeGroup(L: Lens): boolean {
  for (const c of ["n8n", "public"] as Channel[]) for (const o of RESERVED_OUTCOMES) if (L[c][o].withPrice > 0 && L[c][o].value === 0) return true;
  return false;
}

/* ------------------------------------------------------------ out of hours -- */

export function outOfHoursView(data: ValueDashboardData) {
  const o = data.outOfHours;
  const fuera = o.antes_de_abrir + o.despues_de_cerrar + o.dia_sin_atencion + o.en_pausa;
  const classifiable = fuera + o.dentro;
  const totalBot = classifiable + o.sin_horario;
  const rows = [
    { label: "Antes de abrir", n: o.antes_de_abrir },
    { label: "Después de cerrar", n: o.despues_de_cerrar },
    { label: "Días sin atención", n: o.dia_sin_atencion },
    ...(o.en_pausa > 0 ? [{ label: "En pausas del horario", n: o.en_pausa }] : []),
  ];
  const max = Math.max(0, ...rows.map((r) => r.n));
  const state: "no_bot" | "no_hours" | "zero" | "some" =
    totalBot === 0 ? "no_bot" : classifiable === 0 ? "no_hours" : fuera === 0 ? "zero" : "some";
  const siteLabel = data.sites.length === 1 ? data.sites[0].name : "tus sedes";
  return {
    state,
    total: state === "no_hours" ? "—" : fmtN(fuera),
    pct:
      state === "no_bot"
        ? "Sin reservas del bot en el periodo"
        : state === "no_hours"
          ? "Sin horario semanal configurado"
          : state === "zero"
            ? "Ninguna reserva del bot fuera del horario semanal configurado"
            : `${Math.round((fuera / classifiable) * 100)}% de las reservas del bot`,
    rows: rows.map((r) => ({ ...r, widthPct: max > 0 ? (r.n / max) * 100 : 0 })),
    unclassified: o.sin_horario,
    subtitle: `Reservas del bot creadas fuera del horario semanal configurado de ${siteLabel}.`,
  };
}

/* --------------------------------------------------------------- evidence -- */

const ESTADO: Record<EvidenceWorkflow["estado"], { label: string; tone: Tone }> = {
  no_conversacional: { label: "No conversacional", tone: "info" },
  sin_ejecuciones_para_contrastar: { label: "Sin ejecuciones", tone: "warn" },
  sin_mapeos_configurados: { label: "Sin mapeos", tone: "warn" },
  mapeos_sin_turnos: { label: "Mapeos sin turnos", tone: "warn" },
  muestra_insuficiente: { label: "Muestra insuficiente", tone: "warn" },
  por_debajo_del_umbral: { label: "Por debajo del umbral", tone: "warn" },
  contraste_suficiente: { label: "Contraste suficiente", tone: "ok" },
};

const pctOrUnknown = (p: number | null) => (p === null ? "desconocida" : fmtPct(p));

export function workflowEvidenceRow(w: EvidenceWorkflow, minimo: number, umbral: number) {
  const e = ESTADO[w.estado];
  let why: string;
  switch (w.estado) {
    case "no_conversacional":
      why = "Sin mapeos de conversación ni mensajes reportados en el periodo. No bloquea las métricas.";
      break;
    case "sin_ejecuciones_para_contrastar":
      why = `Reportó ${plural(w.mensajesReportados, "mensaje", "mensajes")}, pero no hay ejecuciones ingeridas con que contrastarlos.`;
      break;
    case "sin_mapeos_configurados":
      why = `Faltan los mapeos conversation_id y user_message${w.rolesConfigurados && w.rolesConfigurados.length ? ` (tiene: ${w.rolesConfigurados.join(", ")})` : ""}. Nunca habrá turnos que contrastar.`;
      break;
    case "mapeos_sin_turnos":
      why = `Tiene los mapeos, pero no se reconstruyó ningún turno de sus ${plural(w.ejecuciones, "ejecución", "ejecuciones")} del periodo.`;
      break;
    case "muestra_insuficiente":
      why = `${plural(w.turnos, "turno", "turnos")} en el periodo; se necesitan al menos ${minimo} para juzgar.`;
      break;
    default:
      why = `Conversación registrada ${pctOrUnknown(w.pConversacion)} · mensaje del cliente ${pctOrUnknown(w.pMensajeCliente)} · respuesta del bot ${pctOrUnknown(w.pRespuestaBot)} (mínimo ${fmtPct(umbral)}, ${plural(w.turnos, "turno", "turnos")}).`;
  }
  return { name: w.name ?? w.id, status: e.label, tone: e.tone, why };
}

export function evidenceCopy(data: ValueDashboardData): { title: string; text: string; agencyHint: string | null } {
  const r = data.evidence.reason;
  if (r === "no_conversational")
    return {
      title: "Sin automatizaciones conversacionales",
      text: "Ningún workflow de este negocio registra conversaciones en la plataforma, así que no hay atención que medir.",
      agencyHint: "Si un workflow atiende clientes, configura sus mapeos de conversación o haz que reporte sus mensajes.",
    };
  if (r === "contrast_insufficient")
    return {
      title: "Sin evidencia suficiente",
      text: "Todavía no podemos confirmar que el registro de mensajes esté completo. No mostramos cifras de conversaciones ni tiempos de respuesta, ni siquiera ceros, hasta tener evidencia.",
      agencyHint: "El contraste automático entre ejecuciones y mensajes no alcanza el mínimo. Revisa el motivo de cada workflow.",
    };
  if (r === "no_review")
    return {
      title: "Sin evidencia suficiente",
      text: "El contraste automático del registro de mensajes es suficiente, pero falta su revisión manual. Hasta entonces no mostramos cifras de conversaciones.",
      agencyHint: "Falta registrar la revisión manual de una muestra de ejecuciones (§7 de la especificación).",
    };
  if (r === "review_rejected")
    return {
      title: "Sin evidencia suficiente",
      text: "La última revisión manual del registro de mensajes no se aprobó. No mostramos cifras de conversaciones hasta corregirlo.",
      agencyHint: "Corrige el workflow y registra una nueva revisión.",
    };
  return {
    title: "Sin evidencia suficiente",
    text: "La revisión manual del registro de mensajes no cubre todos los workflows conversacionales actuales. No mostramos cifras de conversaciones hasta revisarlos.",
    agencyHint: "Registra una revisión que incluya los workflows nuevos.",
  };
}

/* ---------------------------------------------------------------- quality -- */

export interface QualityRow {
  label: string;
  status: string;
  tone: Tone;
  text: string;
}

export function qualityRows(data: ValueDashboardData): QualityRow[] {
  const live = automatedTotal(data.created, RESERVED_OUTCOMES);
  const ps = bucketState(live);
  const ev = data.evidence;
  const t = data.cohort.tracking;
  const errWf = data.health.workflows.filter((w) => w.errors > 0);
  return [
    {
      label: "Reservas",
      status: data.coverage ? `Desde ${fmtDay(data.coverage.since, true)}` : "Medido",
      tone: data.coverage ? "warn" : "info",
      text: data.coverage
        ? `La agenda registra citas desde el ${fmtDay(data.coverage.since, true)}: el periodo cubre ${data.coverage.coveredDays} de ${data.period.days} días.`
        : "Contamos cada cita creada por el bot, por la página de reservas o por el equipo, desde el registro de citas.",
    },
    {
      label: "Conversaciones",
      status: ev.enabled ? "Con evidencia" : ev.reason === "no_conversational" ? "No aplica" : "Sin evidencia",
      tone: ev.enabled ? "ok" : ev.reason === "no_conversational" ? "info" : "warn",
      text: ev.enabled
        ? `Contraste automático suficiente y revisión manual aprobada el ${fmtDay(ev.review!.reviewedAt.slice(0, 10), true)}.`
        : evidenceCopy(data).text,
    },
    {
      label: "Precios",
      status: ps === "zero" ? "Sin citas" : ps === "unknown" ? "Sin precios" : ps === "partial" ? `${fmtN(missingPrices(live))} sin precio` : "Completos",
      tone: ps === "partial" || ps === "unknown" ? "warn" : ps === "zero" ? "info" : "ok",
      text:
        ps === "unknown"
          ? "Las citas se guardaron sin precio, así que su valor es desconocido. Las citas nuevas toman el precio del servicio."
          : ps === "partial"
            ? `${plural(missingPrices(live), "cita se guardó", "citas se guardaron")} sin precio y no suman al valor.`
            : ps === "zero"
              ? "No hubo citas automatizadas vigentes en el periodo."
              : "Todas las citas automatizadas vigentes tienen precio guardado (un precio de $0 cuenta como guardado).",
    },
    {
      label: "Origen de clientes",
      status: !t ? "Sin seguimiento" : t.partial ? `Desde ${fmtDay(localDayOf(t.startedAt!, data.tz), true)}` : "Todo el periodo",
      tone: !t ? "info" : t.partial ? "warn" : "ok",
      text: !t
        ? "El seguimiento del origen de clientes no está activo para este negocio."
        : t.partial
          ? `El seguimiento empezó el ${fmtDay(localDayOf(t.startedAt!, data.tz), true)}, a mitad del periodo: la cohorte de clientes nuevos es parcial.`
          : "El seguimiento del origen cubre todo el periodo.",
    },
    {
      label: "Automatizaciones",
      status: errWf.length === 0 ? "Sin errores" : `${errWf.length} con errores`,
      tone: errWf.length === 0 ? "ok" : "warn",
      text:
        errWf.length === 0
          ? "Ninguna ejecución con error en el periodo."
          : `${errWf.map((w) => w.name ?? w.id).slice(0, 3).join(", ")} ${errWf.length === 1 ? "tuvo" : "tuvieron"} ejecuciones con error. No cambia tus reservas ni la estimación.`,
    },
  ];
}

export function qualitySummary(data: ValueDashboardData): { label: string; tone: Tone } {
  const ps = bucketState(automatedTotal(data.created, RESERVED_OUTCOMES));
  if (ps === "unknown") return { label: "Faltan precios", tone: "warn" };
  if (ps === "partial" || data.coverage || data.cohort.tracking?.partial) return { label: "Datos parciales", tone: "warn" };
  if (!data.evidence.enabled && data.evidence.reason !== "no_conversational") return { label: "Conversaciones sin evidencia", tone: "warn" };
  return { label: "Datos completos", tone: "ok" };
}

export function localDayOf(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/* ------------------------------------------------------------------ cohort -- */

export const ORIGIN_LABEL: Record<string, string> = {
  meta_ad: "Anuncio de Meta",
  meta_post: "Publicación de Meta",
  organic_whatsapp: "WhatsApp directo",
  booking_page: "Página de reservas",
  booked_by_contact: "Reservado por otro cliente",
  import: "Importado",
  manual: "Creado por el equipo",
  unknown: "Origen desconocido",
  sin_origen: "Sin origen registrado",
};

export function cohortValue(r: { completadas: number; completadasSinPrecio: number; valor: number | null }): { text: string; sub: string } {
  if (r.completadas === 0) return { text: "$0", sub: "Sin servicios completados" };
  if (r.valor === null) return { text: "Valor desconocido", sub: `${plural(r.completadas, "completado", "completados")}, ninguno con precio` };
  if (r.completadasSinPrecio > 0) return { text: fmtCOP(r.valor), sub: `${plural(r.completadas, "completado", "completados")} · ${fmtN(r.completadasSinPrecio)} sin precio` };
  return { text: fmtCOP(r.valor), sub: plural(r.completadas, "completado", "completados") };
}

/* ----------------------------------------------------------- detail panel -- */

export interface DetailRow {
  label: string;
  val: string;
  widthPct: number | null;
  tone?: Channel | Outcome | "time";
  sub?: string;
}

export function detailGroups(data: ValueDashboardData, metric: MetricId, ev: EstimateView): Array<{ title: string; rows: DetailRow[] }> {
  const cr = data.created;
  const at = data.dated;
  const pct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
  if (metric === "res") {
    const tot = automatedTotal(cr).count;
    const ch = (c: Channel) => channelTotal(cr[c]).count;
    const out = (o: Outcome) => cr.n8n[o].count + cr.public[o].count;
    return [
      { title: "POR CANAL", rows: (["n8n", "public"] as Channel[]).map((c) => ({ label: CHANNEL_LABEL[c], val: fmtN(ch(c)), widthPct: pct(ch(c), tot), tone: c })) },
      { title: "POR RESULTADO", rows: (["completed", "pending", "no_show", "cancelled"] as Outcome[]).map((o) => ({ label: OUTCOME_LABEL[o], val: fmtN(out(o)), widthPct: pct(out(o), tot), tone: o })) },
    ];
  }
  if (metric === "val") {
    const live = automatedTotal(cr, RESERVED_OUTCOMES);
    const cancelled = automatedTotal(cr, ["cancelled"]);
    const chLive = (c: Channel) => channelTotal(cr[c], RESERVED_OUTCOMES);
    if (bucketState(live) === "unknown") {
      return [
        {
          title: "SIN PRECIO GUARDADO",
          rows: [
            ...(["n8n", "public"] as Channel[]).map((c) => ({ label: CHANNEL_LABEL[c], val: plural(chLive(c).count, "cita", "citas"), widthPct: null, sub: "Valor desconocido" })),
            { label: "Cómo se calcula", val: "", widthPct: null, sub: "Se usa el precio guardado en la cita al crearla. Editar hoy un servicio no cambia las citas anteriores." },
          ],
        },
      ];
    }
    return [
      {
        title: "POR CANAL",
        rows: (["n8n", "public"] as Channel[]).map((c) => {
          const b = chLive(c);
          return { label: CHANNEL_LABEL[c], val: bucketState(b) === "unknown" ? "Valor desconocido" : fmtCOP(b.value ?? 0), widthPct: pct(b.value ?? 0, live.value ?? 0), tone: c };
        }),
      },
      {
        title: "FUERA DEL CÁLCULO",
        rows: [
          { label: "Canceladas", val: cancelled.withPrice > 0 ? fmtCOP(cancelled.value ?? 0) : "—", widthPct: null, sub: plural(cancelled.count, "cita", "citas") },
          {
            label: "Citas sin precio",
            val: fmtN(missingPrices(live)),
            widthPct: null,
            sub: "Usamos el precio guardado en cada cita: editar hoy un servicio no cambia las citas anteriores.",
          },
        ],
      },
    ];
  }
  if (metric === "comp") {
    const comp = automatedTotal(at, ["completed"]);
    if (bucketState(comp) === "unknown") {
      return [
        {
          title: "SIN PRECIO GUARDADO",
          rows: [
            { label: "Completadas del bot", val: fmtN(at.n8n.completed.count), widthPct: null, sub: "Valor desconocido" },
            { label: "Completadas de la página", val: fmtN(at.public.completed.count), widthPct: null, sub: "Valor desconocido" },
            { label: "Cómo se calcula", val: "", widthPct: null, sub: "Se usa el precio guardado en la cita. Editar hoy un servicio no cambia las citas anteriores." },
          ],
        },
      ];
    }
    return [
      {
        title: "POR CANAL DE ORIGEN",
        rows: (["n8n", "public"] as Channel[]).map((c) => {
          const b = at[c].completed;
          return {
            label: CHANNEL_LABEL[c],
            val: bucketState(b) === "unknown" ? "Valor desconocido" : fmtCOP(b.value ?? 0),
            widthPct: pct(b.value ?? 0, comp.value ?? 0),
            tone: c,
            sub: plural(b.count, "completada", "completadas"),
          };
        }),
      },
      {
        title: "NO CUENTAN COMO COMPLETADAS",
        rows: [
          { label: "No asistió", val: fmtN(at.n8n.no_show.count + at.public.no_show.count), widthPct: null },
          { label: "Canceladas", val: fmtN(at.n8n.cancelled.count + at.public.cancelled.count), widthPct: null },
          { label: "Pendientes de marcar", val: fmtN(at.n8n.pending.count + at.public.pending.count), widthPct: null },
          { label: "Completadas sin precio", val: fmtN(missingPrices(comp)), widthPct: null },
        ],
      },
    ];
  }
  const e = ev.estimate;
  if (e.state !== "confirmed") {
    return [{ title: "SIN CALCULAR", rows: [{ label: e.state === "proposed" ? "Supuestos propuestos, sin confirmar" : "Faltan supuestos confirmados", val: "—", widthPct: null }] }];
  }
  const parts: Array<[string, number]> = [
    ...(e.u1 ? ([["Conversaciones solo con el bot, sin reserva", e.u1.minutes]] as Array<[string, number]>) : []),
    ...(e.u2 ? ([["Conversaciones con reserva del bot, sin intervención", e.u2.minutes]] as Array<[string, number]>) : []),
    ["Reservas en la página", e.u3!.minutes],
  ];
  const pm = Math.max(0, ...parts.map((p) => p[1]));
  return [
    { title: "COMPONENTES", rows: parts.map(([label, m]) => ({ label, val: `${fmtN(m)} min`, widthPct: pm > 0 ? (m / pm) * 100 : 0, tone: "time" as const })) },
    {
      title: "EXCLUIDO",
      rows: e.publicOnly
        ? [{ label: "Conversaciones del bot", val: "—", widthPct: null, sub: "Sin evidencia suficiente del registro de mensajes. Se sumarán cuando la haya." }]
        : [{ label: "Conversaciones con intervención del equipo", val: fmtN(data.conversations?.classes.conIntervencionHumana ?? 0), widthPct: null, sub: "No se estiman en esta versión." }],
    },
  ];
}

/** «Por día» bars for the open metric. null = no value for that day (not 0). Each bar
 *  carries the exact numbers of its day for the hover / tap tooltip. */
export function dailyBars(
  data: ValueDashboardData,
  metric: MetricId,
  ev: EstimateView,
): Array<{ day: string; v: number | null; tip: Tip }> {
  if (metric === "time") {
    const units = new Map(data.units.map((u) => [u.day, u]));
    return ev.estimate.perDayMinutes.map((d) => {
      const u = units.get(d.day);
      const lines =
        d.minutes === null
          ? ["Sin supuestos vigentes ese día: no se estima"]
          : [
              `${fmtN(d.minutes)} min estimados`,
              ...(u && u.u1 !== null ? [plural(u.u1, "conversación solo con el bot", "conversaciones solo con el bot")] : []),
              ...(u && u.u2 !== null ? [plural(u.u2, "conversación con reserva del bot", "conversaciones con reserva del bot")] : []),
              plural(u?.u3 ?? 0, "reserva en la página", "reservas en la página"),
            ];
      return { day: d.day, v: d.minutes, tip: { title: fmtDay(d.day, true), lines } };
    });
  }
  return data.daily.map((d) => {
    const title = fmtDay(d.day, true);
    if (metric === "res") {
      return {
        day: d.day,
        v: d.created,
        tip: { title, lines: [plural(d.created, "reserva automatizada", "reservas automatizadas"), ...(d.reserved.count > 0
            ? [bucketState(d.reserved) === "unknown" ? "Valor vigente desconocido: sin precio guardado" : `Valor vigente: ${bucketValueLine(d.reserved)}`]
            : [])] },
      };
    }
    const b = metric === "val" ? d.reserved : d.completed;
    const unknown = b.count > 0 && b.withPrice === 0;
    return {
      day: d.day,
      v: unknown ? null : b.value ?? 0,
      tip: {
        title,
        lines: [bucketValueLine(b), plural(b.count, metric === "val" ? "cita vigente" : "servicio completado", metric === "val" ? "citas vigentes" : "servicios completados")],
      },
    };
  });
}

export function comparisonLine(data: ValueDashboardData): string {
  const range = fmtRange(data.period.fromDay, data.period.toDay);
  if (data.comparison.available) return `${range} · comparado con ${prevLabel(data)}`;
  const why = data.comparison.reason?.replace(/^Sin comparación:\s*/, "");
  return why ? `${range} · sin comparación: ${why}` : `${range} · sin comparación disponible`;
}

export function customCompareNote(from: string, to: string): string | null {
  if (!from || !to || from > to) return null;
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return `Se compara con los ${days} días anteriores: ${fmtRange(addDays(from, -days), addDays(from, -1), false)}.`;
}
