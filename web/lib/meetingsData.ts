/**
 * Reuniones — FIXTURES, not a repository.
 *
 * The module's screens ship before its storage. Everything here is the content
 * of the approved design sheet (Reuniones.html), typed so the components consume
 * the same shapes a real repository will later return. Nothing is invented: the
 * meetings, timestamps, quotes and percentages are the ones the spec shows.
 *
 * The read functions are async ON PURPOSE. When the tables land, the bodies get
 * replaced by queries and NO caller changes — which is the whole point of
 * putting the seam here instead of inlining literals into the pages.
 *
 * There is no tenant/client scoping in the arguments yet because there is no
 * storage to scope; the pages still resolve the client through the normal module
 * gate, so the surface cannot be reached without access. When the queries land,
 * `tenantId`/`clientId` become required parameters here too.
 */

import type { FindingKind, MeetingSummary } from "./meetingsSummary";

/** Where the recording came from. Shown as the row's second line. */
export type MeetingSource =
  | { kind: "file"; filename: string; size: string }
  | { kind: "meet" }
  | { kind: "inbox"; thread: string }
  | { kind: "room" }
  | { kind: "cancelled"; by: string };

/**
 * The lifecycle. Ordered by how far the meeting got, and deliberately explicit
 * about WHICH stage is running: "processing" as one bucket is what made the
 * spec's listing unable to say whether a row was still uploading or already
 * writing the summary.
 */
export type MeetingStatus =
  | { kind: "uploading"; percent: number }
  | { kind: "transcribing"; percent: number }
  | { kind: "diarizing"; percent: number }
  | { kind: "analyzing"; percent: number }
  | { kind: "done" }
  | { kind: "done-no-speakers" }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

export interface Participant {
  /** Initials shown in the avatar; the accessible name is `name`. */
  initials: string;
  name: string;
  /** Role + company, as the Inspector shows it. Null when unidentified. */
  role: string | null;
  /** Share of speaking time, 0–100. Null while diarization has not finished. */
  share: number | null;
}

export interface MeetingListItem {
  id: string;
  title: string;
  source: MeetingSource;
  /** Human date, already formatted — the fixtures are a spec, not a clock. */
  when: string;
  /** mm:ss or h:mm:ss. Null until the duration is known. */
  duration: string | null;
  participants: Participant[];
  /** Participants beyond the ones rendered as avatars. */
  extraParticipants: number;
  status: MeetingStatus;
  tasks: number | null;
  reports: number | null;
  updated: string;
}

export interface TranscriptSegment {
  /** Seconds from the start — what the player seeks to. */
  at: number;
  /** mm:ss label, as the spec prints it. */
  stamp: string;
  speaker: string;
  initials: string;
  text: string;
  /** Marks the segment Copilot or an evidence card jumped to. */
  cited?: boolean;
  /** The speaker was never matched to a contact. */
  unidentified?: boolean;
}

/** One block of a generated report document. */
export interface ReportSection {
  heading: string;
  body?: string;
  /** A numbered list, each line optionally citing a moment of the audio. */
  steps?: { text: string; stamp?: string; at?: number }[];
}

export interface MeetingReport {
  id: string;
  name: string;
  meta: string;
  citations: number | null;
  state: "edited" | "generated" | "generating" | "failed";
  /**
   * The document body, as DATA. It used to be JSX hard-coded into the Reportes
   * pane, which meant every meeting's report rendered the kickoff's text —
   * a bug the moment there was more than one meeting with a detail screen.
   * Absent while generating or when generation failed.
   */
  doc?: { title: string; subtitle: string; sections: ReportSection[] };
}

export interface EvidenceItem {
  initials: string;
  speaker: string;
  role: string;
  /**
   * The SAME taxonomy the summary's finding groups use (lib/meetingsSummary.ts).
   * It was a private four-value union here, which meant a support call's
   * "problema" or a sales call's "objeción" had nowhere to go in the evidence
   * tab even though the summary could name them.
   */
  kind: FindingKind;
  stamp: string;
  at: number;
  quote: string;
  /** Where this quote is already used, or null when nothing cites it yet. */
  usedIn: string | null;
  /** The quote produced a CRM task. */
  producedTask?: boolean;
  /** Theme heading this quote is grouped under. */
  theme: string;
}

export interface MeetingDetail extends MeetingListItem {
  /** Total seconds of audio — the player's aria-valuemax. */
  durationSeconds: number;
  language: string;
  confidence: string;
  segments: number;
  fileSize: string;
  tags: string[];
  transcript: TranscriptSegment[];
  /**
   * The Resumen view's whole content, as an ADAPTIVE model — see
   * lib/meetingsSummary.ts. This replaced four fixed fields
   * (executiveSummary / themes / decisions / risks / taskList): those forced the
   * screen to have the shape of a project kickoff, so an interview rendered two
   * empty headings and a support call had nowhere to put its diagnosis.
   */
  summary: MeetingSummary;
  /**
   * TRUE for the layout-validation scenarios at the bottom of this file, whose
   * content is invented to exercise a composition. Never true for content that
   * came from the approved design sheet, and it must stay false for anything
   * the real repository ever returns.
   */
  isTestFixture?: boolean;
  /** Named `reportList` because `reports` on the list item is the COUNT — one
   *  field cannot be both a number and an array. */
  reportList: MeetingReport[];
  evidence: EvidenceItem[];
}

/* ── People ─────────────────────────────────────────────────────────────── */

const MV: Participant = { initials: "MV", name: "María Vanegas", role: "Head of Ops · Gallery", share: 38 };
const JC: Participant = { initials: "JC", name: "Julián Cifuentes", role: "CTO · Northwind", share: 31 };
const LR: Participant = { initials: "LR", name: "Laura Rivas", role: "PM · Gallery", share: 22 };
const P4: Participant = { initials: "P4", name: "Participante 4", role: null, share: 9 };
const DS: Participant = { initials: "DS", name: "Diana Salas", role: null, share: null };
const AP: Participant = { initials: "AP", name: "Andrés Peña", role: null, share: null };

/* ── The kickoff, the one meeting the spec details end to end ───────────── */

const KICKOFF_TRANSCRIPT: TranscriptSegment[] = [
  {
    at: 702,
    stamp: "11:42",
    speaker: "María Vanegas",
    initials: "MV",
    text: "Entonces el objetivo de hoy es cerrar el alcance de la fase uno. Queremos que la integración de contactos quede lista antes del arranque comercial de octubre, aunque el resto se mueva.",
  },
  {
    at: 718,
    stamp: "11:58",
    speaker: "Julián Cifuentes",
    initials: "JC",
    text: "De nuestro lado la parte técnica no es el problema. El riesgo está en el presupuesto: la partida de este trimestre ya está comprometida y el comité solo se reúne el primer martes de cada mes.",
  },
  {
    at: 724,
    stamp: "12:04",
    speaker: "Julián Cifuentes",
    initials: "JC",
    cited: true,
    text: "Si logramos que la fase uno entre como gasto operativo y no como proyecto nuevo, lo podemos aprobar sin comité. Eso nos ahorraría unas tres semanas, pero necesito el desglose por escrito antes del viernes.",
  },
  {
    at: 751,
    stamp: "12:31",
    speaker: "Laura Rivas",
    initials: "LR",
    text: "Yo puedo tener el desglose el jueves si nos confirman hoy qué campos entran en el mapeo. Sin esa lista no puedo estimar horas de desarrollo.",
  },
  {
    at: 767,
    stamp: "12:47",
    speaker: "María Vanegas",
    initials: "MV",
    text: "Hoy mismo te la mando. Son los diez campos del núcleo más teléfono normalizado; lo demás lo dejamos como campos configurables por cliente.",
  },
  {
    at: 785,
    stamp: "13:05",
    speaker: "Participante 4",
    initials: "P4",
    unidentified: true,
    text: "Una cosa: si el presupuesto entra como operativo, legal va a pedir que el contrato mencione el alcance exacto. No es bloqueante pero suma unos días.",
  },
  {
    at: 802,
    stamp: "13:22",
    speaker: "Julián Cifuentes",
    initials: "JC",
    text: "De acuerdo. Entonces quedamos así: alcance de fase uno cerrado a integración de contactos, desglose el jueves, y yo llevo la aprobación interna sin pasar por comité.",
  },
  {
    at: 820,
    stamp: "13:40",
    speaker: "Laura Rivas",
    initials: "LR",
    text: "Perfecto. Dejo agendada la revisión del desglose para el viernes a las nueve y les comparto el documento la noche anterior.",
  },
];

const KICKOFF: MeetingDetail = {
  id: "kickoff-northwind",
  title: "Kickoff — Integración Gallery × Northwind",
  source: { kind: "file", filename: "kickoff-northwind.m4a", size: "42,1 MB" },
  when: "2 sep 2026, 10:00",
  duration: "48:22",
  durationSeconds: 2902,
  participants: [MV, JC, LR, P4],
  extraParticipants: 0,
  status: { kind: "done" },
  tasks: 6,
  reports: 3,
  updated: "hace 2 h",
  language: "Español (CO)",
  confidence: "94,2 %",
  segments: 312,
  fileSize: "42,1 MB",
  tags: ["kickoff", "integración"],
  transcript: KICKOFF_TRANSCRIPT,
  summary: {
    executive:
      "La reunión cerró el alcance de la fase uno en la integración de contactos, con octubre como fecha objetivo. El freno no es técnico sino presupuestal: la partida del trimestre está comprometida y el comité solo sesiona una vez al mes, así que Northwind intentará aprobarlo como gasto operativo. Quedan tres compromisos con dueño y fecha.",
    /* PROYECTO → Resultado · Estado general · Bloqueador · Próximo paso.
       RESULTADO y ESTADO GENERAL son cosas distintas y mezclarlas se contradecía:
       "Estado: Alcance cerrado" en verde junto a un bloqueador crítico afirmaba
       que todo iba bien y que algo estaba roto a la vez. Lo que se cerró es el
       RESULTADO; el estado de una reunión con un riesgo crítico abierto es
       "En riesgo". */
    highlights: [
      { label: "Resultado", value: "Alcance de fase uno cerrado", tone: "success" },
      { label: "Estado general", value: "En riesgo", tone: "warn", target: { kind: "finding", id: "k-risk-1" } },
      { label: "Bloqueador", value: "Aprobación de presupuesto", target: { kind: "finding", id: "k-risk-1" } },
      { label: "Próximo paso", value: "Desglose el jueves", target: { kind: "step", id: "k-step-2" } },
    ],
    themes: [
      { label: "Alcance de fase uno", range: "11:42–12:00", at: 702 },
      { label: "Presupuesto y comité", range: "11:58–13:20", at: 718 },
      { label: "Mapeo de campos", range: "12:31–13:04", at: 751 },
      { label: "Revisión legal", range: "13:05–13:21", at: 785 },
    ],
    /* RANKED, not grouped. Index 0 is what a person needs to know first —
       here the scope decision, because it is what the meeting was for. The
       risk sits in this same list and the view routes it to the attention
       card by KIND, so nobody has to maintain two lists. */
    findings: [
      {
        id: "k-dec-1",
        kind: "decision",
        title: "La fase uno se limita a la integración de contactos",
        detail: "El resto del alcance se posterga para no mover la fecha de octubre.",
        by: "María Vanegas",
        initials: "MV",
        stamp: "11:42",
        at: 702,
        sources: ["transcript", "appointment"],
        actions: [{ label: "Ver en el transcript", primary: true }],
      },
      {
        id: "k-dec-2",
        kind: "decision",
        title: "Se aprobará como gasto operativo, no como proyecto nuevo",
        detail: "Evita el comité mensual de presupuesto y ahorra alrededor de tres semanas.",
        by: "Julián Cifuentes",
        initials: "JC",
        stamp: "12:04",
        at: 724,
        sources: ["transcript", "email"],
        actions: [{ label: "Ver en el transcript", primary: true }],
      },
      {
        id: "k-risk-1",
        kind: "risk",
        level: "critical",
        title: "Si la aprobación pasa a comité, octubre se cae",
        detail: "El comité sesiona el primer martes del mes. Es el único punto que mueve el cronograma completo.",
        by: "Julián Cifuentes",
        initials: "JC",
        stamp: "11:58",
        at: 718,
        sources: ["transcript"],
      },
      {
        id: "k-dec-3",
        kind: "decision",
        title: "El mapeo arranca con los diez campos del núcleo",
        detail: "Lo específico de cada cliente va a campos configurables.",
        by: "María Vanegas",
        initials: "MV",
        stamp: "12:47",
        at: 767,
        sources: ["transcript"],
        actions: [{ label: "Ver en el transcript", primary: true }],
      },
      {
        // NOT invented to fill space: Laura's close at 13:40 is already in the
        // transcript and the summary simply never picked it up.
        id: "k-agr-1",
        kind: "agreement",
        title: "La revisión del desglose queda agendada para el viernes a las nueve",
        detail: "Laura comparte el documento la noche anterior.",
        by: "Laura Rivas",
        initials: "LR",
        stamp: "13:40",
        at: 820,
        sources: ["transcript", "appointment"],
        actions: [{ label: "Ver en el transcript", primary: true }],
      },
      {
        id: "k-dep-1",
        kind: "dependency",
        level: "warning",
        title: "Legal pedirá el alcance exacto en el contrato",
        detail: "No es bloqueante, pero suma días al cronograma.",
        by: "Participante 4",
        initials: "P4",
        stamp: "13:05",
        at: 785,
        // El hablante no está identificado, así que la atribución es débil.
        confidence: 62,
        sources: ["transcript"],
      },
    ],
    nextSteps: [
      {
        id: "k-step-1",
        text: "Enviar la lista de los diez campos del mapeo",
        owner: "María Vanegas",
        ownerInitials: "MV",
        // "Hoy" is NOT late — it is soon. Only a passed date goes red.
        due: { label: "hoy", state: "soon" },
        evidence: { initials: "MV", stamp: "12:47", at: 767 },
        state: "todo",
      },
      {
        id: "k-step-2",
        text: "Entregar el desglose de horas de desarrollo",
        owner: "Laura Rivas",
        ownerInitials: "LR",
        due: { label: "jue 4 sep", state: "scheduled" },
        evidence: { initials: "LR", stamp: "12:31", at: 751 },
        state: "created",
      },
      {
        id: "k-step-3",
        text: "Llevar la aprobación interna sin comité",
        owner: "Julián Cifuentes",
        ownerInitials: "JC",
        due: { label: "vie 5 sep", state: "scheduled" },
        evidence: { initials: "JC", stamp: "13:22", at: 802 },
        state: "todo",
      },
      {
        id: "k-step-4",
        text: "Revisar con legal la redacción del alcance",
        owner: null,
        ownerInitials: null,
        due: null,
        evidence: { initials: "P4", stamp: "13:05", at: 785 },
        state: "blocked",
      },
    ],
    caveat: "No mostramos indicador de sentimiento: no hay evidencia suficiente en el audio para sustentarlo.",
  },
  reportList: [
    {
      id: "resumen-ejecutivo",
      name: "Resumen ejecutivo",
      meta: "Editado por María Vanegas · hace 1 h",
      citations: 6,
      state: "edited",
      doc: {
        title: "Kickoff Gallery × Northwind",
        subtitle: "2 de septiembre de 2026 · 48 minutos · 4 participantes",
        sections: [
          {
            heading: "Contexto",
            body:
              "La reunión buscaba cerrar el alcance de la fase uno de la integración entre Gallery y Northwind antes del arranque comercial de octubre. Participaron operaciones y producto por Gallery, y el equipo técnico y financiero por Northwind.",
          },
          {
            heading: "Qué se decidió",
            body:
              "La fase uno queda limitada a la integración de contactos. Northwind intentará aprobar el gasto como operativo para evitar el comité mensual de presupuesto, lo que ahorraría alrededor de tres semanas.",
          },
          {
            heading: "Compromisos",
            steps: [
              { text: "María envía hoy la lista de los diez campos del núcleo del mapeo", stamp: "MV 12:47", at: 767 },
              { text: "Laura entrega el desglose de horas el jueves", stamp: "LR 12:31", at: 751 },
              { text: "Julián lleva la aprobación interna antes del viernes", stamp: "JC 13:22", at: 802 },
            ],
          },
          {
            heading: "Riesgo principal",
            body:
              "Si la aprobación termina pasando por comité, la fecha de octubre no se sostiene. Es el único punto que puede mover el cronograma completo.",
          },
        ],
      },
    },
    { id: "acta-formal", name: "Acta formal", meta: "Generado 2 sep, 11:02", citations: 11, state: "generated" },
    { id: "tareas", name: "Tareas y compromisos", meta: "Generando… queda ~20 s", citations: null, state: "generating" },
    { id: "seguimiento", name: "Seguimiento comercial", meta: "Falló al generar · el transcript sigue disponible", citations: null, state: "failed" },
  ],
  evidence: [
    {
      initials: "JC",
      speaker: "Julián Cifuentes",
      role: "CTO · Northwind",
      kind: "decision",
      stamp: "12:04",
      at: 724,
      quote:
        "Si logramos que la fase uno entre como gasto operativo y no como proyecto nuevo, lo podemos aprobar sin comité. Eso nos ahorraría unas tres semanas, pero necesito el desglose por escrito antes del viernes.",
      usedIn: "Resumen ejecutivo · Acta formal",
      theme: "Presupuesto y comité",
    },
    {
      initials: "JC",
      speaker: "Julián Cifuentes",
      role: "CTO · Northwind",
      kind: "risk",
      stamp: "11:58",
      at: 718,
      quote:
        "El riesgo está en el presupuesto: la partida de este trimestre ya está comprometida y el comité solo se reúne el primer martes de cada mes.",
      usedIn: "Resumen ejecutivo",
      theme: "Presupuesto y comité",
    },
    {
      initials: "LR",
      speaker: "Laura Rivas",
      role: "PM · Gallery",
      kind: "agreement",
      stamp: "12:31",
      at: 751,
      quote:
        "Yo puedo tener el desglose el jueves si nos confirman hoy qué campos entran en el mapeo. Sin esa lista no puedo estimar horas de desarrollo.",
      usedIn: null,
      producedTask: true,
      theme: "Mapeo de campos",
    },
    {
      initials: "MV",
      speaker: "María Vanegas",
      role: "Head of Ops · Gallery",
      kind: "decision",
      stamp: "12:47",
      at: 767,
      quote: "Son los diez campos del núcleo más teléfono normalizado; lo demás lo dejamos como campos configurables por cliente.",
      usedIn: "Acta formal",
      theme: "Mapeo de campos",
    },
    {
      initials: "P4",
      speaker: "Participante 4",
      role: "Sin identificar",
      kind: "dependency",
      stamp: "13:05",
      at: 785,
      quote: "Si el presupuesto entra como operativo, legal va a pedir que el contrato mencione el alcance exacto. No es bloqueante pero suma unos días.",
      usedIn: null,
      theme: "Revisión legal",
    },
  ],
};

/* ── Discovery: the meeting the spec uses for the "still processing" state ─ */

const DISCOVERY: MeetingDetail = {
  id: "discovery-sural",
  title: "Discovery — Grupo Sural",
  source: { kind: "meet" },
  when: "2 sep 2026, 08:30",
  duration: "31:07",
  durationSeconds: 1867,
  participants: [DS, AP],
  extraParticipants: 0,
  status: { kind: "analyzing", percent: 34 },
  tasks: null,
  reports: null,
  updated: "hace 4 min",
  language: "Español (CO)",
  confidence: "—",
  segments: 0,
  fileSize: "—",
  tags: [],
  transcript: [
    {
      at: 134,
      stamp: "02:14",
      speaker: "Diana Salas",
      initials: "DS",
      text: "Hoy manejamos todo en planillas y por WhatsApp. Lo que más nos duele es que nadie sabe en qué quedó cada conversación.",
    },
    {
      at: 168,
      stamp: "02:48",
      speaker: "Andrés Peña",
      initials: "AP",
      text: "Entiendo. ¿Cuántas personas están respondiendo esos mensajes hoy y en qué horario?",
    },
    {
      at: 185,
      stamp: "03:05",
      speaker: "Diana Salas",
      initials: "DS",
      text: "Somos tres, de siete de la mañana a seis de la tarde, y los fines de semana queda una sola persona de turno.",
    },
    {
      at: 221,
      stamp: "03:41",
      speaker: "Andrés Peña",
      initials: "AP",
      text: "Perfecto. Eso ya nos dice que el problema no es de volumen sino de trazabilidad entre turnos.",
    },
  ],
  // Still analyzing: EVERY summary list is empty, and the view renders none of
  // those sections rather than four empty headings.
  summary: { executive: "", highlights: [], themes: [], findings: [], nextSteps: [] },
  reportList: [],
  evidence: [],
};

/* ═══════════════════════════════════════════════════════════════════════════
   ESCENARIOS DE VALIDACIÓN — no son contenido de producto.

   Cada uno existe para probar una FORMA distinta de la vista Resumen (2/3/4
   destacados, 100 % / 50-50 / 62-38, con y sin próximos pasos, sin hallazgos).
   Su contenido está inventado para ese fin: no proviene de ninguna reunión real
   ni del pliego de diseño, a diferencia de KICKOFF y DISCOVERY, que sí
   reproducen literalmente el contenido aprobado en Reuniones.html.

   Cuando llegue el almacenamiento, ESTE BLOQUE se borra entero — las dos
   fixtures de arriba pueden migrar a un seed de demo, estas no deben.

   Marcados con `isTestFixture: true` para que nada los confunda con datos
   reales si alguien los proyecta en una demo.
   ═══════════════════════════════════════════════════════════════════════════ */

/** 2 · VENTA — Necesidad · Objeción · Próximo paso. Cuatro datos destacados,
 *  grupos de objeciones + necesidades, y seguimiento sin tareas de CRM. */
const COMERCIAL: MeetingDetail = {
  isTestFixture: true,
  id: "comercial-delta",
  title: "Llamada comercial — Delta Foods (renovación)",
  source: { kind: "file", filename: "comercial-delta.m4a", size: "31,8 MB" },
  when: "3 sep 2026, 15:00",
  duration: "26:41",
  durationSeconds: 1601,
  participants: [
    { initials: "AP", name: "Andrés Peña", role: "Account Executive · Gallery", share: 44 },
    { initials: "CR", name: "Carolina Restrepo", role: "Directora de Compras · Delta Foods", share: 56 },
  ],
  extraParticipants: 0,
  status: { kind: "done" },
  tasks: 2,
  reports: 1,
  updated: "hace 30 min",
  language: "Español (CO)",
  confidence: "92,8 %",
  segments: 184,
  fileSize: "31,8 MB",
  tags: ["renovación", "pricing"],
  transcript: [
    {
      at: 212,
      stamp: "03:32",
      speaker: "Carolina Restrepo",
      initials: "CR",
      text: "Lo que necesitamos es que el equipo de bodega deje de pasar los pedidos a mano. Hoy se nos van dos horas diarias en eso y se cometen errores.",
    },
    {
      at: 478,
      stamp: "07:58",
      speaker: "Carolina Restrepo",
      initials: "CR",
      text: "El precio que me pasaste está un 30 % por encima de lo que pagamos hoy. Con ese número no lo puedo defender internamente.",
    },
    {
      at: 690,
      stamp: "11:30",
      speaker: "Andrés Peña",
      initials: "AP",
      text: "Entiendo. Puedo armar una comparación de costo por pedido procesado, que es donde se ve el ahorro real, y la revisamos la semana entrante.",
    },
    {
      at: 902,
      stamp: "15:02",
      speaker: "Carolina Restrepo",
      initials: "CR",
      text: "También me preocupa el tiempo de implementación. Si arranca en noviembre nos pega con el cierre de año.",
    },
    {
      at: 1154,
      stamp: "19:14",
      speaker: "Carolina Restrepo",
      initials: "CR",
      text: "Y algo del año pasado: el onboarding se nos hizo lento. Tres semanas para dejar operativo al equipo de bodega es mucho.",
    },
  ],
  summary: {
    executive:
      "Delta Foods quiere eliminar la captura manual de pedidos en bodega, que hoy les cuesta dos horas diarias y errores. El precio propuesto está un 30 % sobre lo que pagan y Carolina no puede defenderlo internamente con ese número. Acordaron revisar una comparación de costo por pedido procesado la semana entrante.",
    // VENTA → cuatro datos. Prueba el layout de 4 columnas.
    highlights: [
      { label: "Necesidad", value: "Eliminar captura manual en bodega", target: { kind: "transcript", at: 212 } },
      { label: "Objeción", value: "Precio 30 % sobre el actual", tone: "warn", target: { kind: "finding", id: "c-obj-1" } },
      { label: "Próximo paso", value: "Comparación de costo por pedido", target: { kind: "step", id: "c-step-1" } },
      { label: "Responsable", value: "Andrés Peña" },
    ],
    themes: [
      { label: "Dolor operativo en bodega", range: "03:32–06:10", at: 212 },
      { label: "Precio y defensa interna", range: "07:58–11:29", at: 478 },
      { label: "Tiempos de implementación", range: "15:02–18:40", at: 902 },
    ],
    findings: [
      {
        id: "c-need-1",
        kind: "need",
        title: "Quieren eliminar la captura manual de pedidos en bodega",
        detail: "Ellos mismos cuantifican el costo: dos horas diarias del equipo y errores de digitación.",
        by: "Carolina Restrepo",
        initials: "CR",
        stamp: "03:32",
        at: 212,
        sources: ["transcript"],
        actions: [{ label: "Ver en el transcript", primary: true }],
      },
      {
        id: "c-obj-1",
        kind: "objection",
        level: "warning",
        title: "El precio está un 30 % sobre el contrato actual",
        detail: "Sin un argumento de ahorro no pasa la aprobación interna de Delta Foods.",
        by: "Carolina Restrepo",
        initials: "CR",
        stamp: "07:58",
        at: 478,
        sources: ["transcript", "document"],
        actions: [{ label: "Ver en el transcript", primary: true }, { label: "Abrir la cuenta" }],
      },
      {
        id: "c-obj-2",
        kind: "objection",
        level: "warning",
        title: "Un arranque en noviembre choca con su cierre de año",
        by: "Carolina Restrepo",
        initials: "CR",
        stamp: "15:02",
        at: 902,
        sources: ["transcript"],
      },
      {
        id: "c-obj-3",
        kind: "objection",
        title: "El onboarding anterior tomó tres semanas",
        detail: "No quiere repetir ese costo de tiempo de su equipo.",
        by: "Carolina Restrepo",
        initials: "CR",
        stamp: "19:14",
        at: 1154,
        sources: ["transcript"],
      },
      {
        id: "c-agr-1",
        kind: "agreement",
        title: "Se revisará el costo por pedido procesado antes de volver al precio",
        by: "Andrés Peña",
        initials: "AP",
        stamp: "11:30",
        at: 690,
        sources: ["transcript", "task"],
      },
      {
        id: "c-q-1",
        kind: "question",
        title: "¿Un arranque en enero es viable para implementación?",
        detail: "Nadie del equipo de implementación estaba en la llamada para confirmarlo.",
        by: "Carolina Restrepo",
        initials: "CR",
        stamp: "15:02",
        at: 902,
        sources: ["transcript"],
      },
    ],
    absences: ["No se tomó una decisión de compra en esta llamada."],
    nextSteps: [
      {
        id: "c-step-1",
        text: "Armar la comparación de costo por pedido procesado",
        owner: "Andrés Peña",
        ownerInitials: "AP",
        // VENCIDA de verdad: la fecha ya pasó. Este es el único rojo permitido.
        due: { label: "1 sep", state: "overdue" },
        evidence: { initials: "AP", stamp: "11:30", at: 690 },
        state: "todo",
      },
      {
        id: "c-step-2",
        text: "Confirmar con implementación si un arranque en enero es viable",
        owner: null,
        ownerInitials: null,
        due: null,
        evidence: { initials: "CR", stamp: "15:02", at: 902 },
        state: "todo",
      },
    ],
  },
  reportList: [
    {
      id: "seguimiento-comercial",
      name: "Seguimiento comercial",
      meta: "Generado 3 sep, 15:34",
      citations: 4,
      state: "generated",
      doc: {
        title: "Seguimiento — Delta Foods",
        subtitle: "3 de septiembre de 2026 · 27 minutos · 2 participantes",
        sections: [
          {
            heading: "Necesidad declarada",
            body:
              "Delta Foods busca eliminar la captura manual de pedidos en bodega. El costo que ellos mismos cuantifican es de dos horas diarias del equipo, más errores de digitación.",
          },
          {
            heading: "Objeciones a resolver",
            steps: [
              { text: "Precio 30 % sobre el contrato actual, sin argumento de ahorro", stamp: "CR 07:58", at: 478 },
              { text: "Un arranque en noviembre choca con el cierre de año", stamp: "CR 15:02", at: 902 },
            ],
          },
          {
            heading: "Siguiente movimiento",
            body:
              "Presentar costo por pedido procesado en lugar de precio de licencia. Es el único terreno donde la conversación de precio tiene un contraargumento con los datos que ellos dieron.",
          },
        ],
      },
    },
  ],
  evidence: [
    {
      initials: "CR",
      speaker: "Carolina Restrepo",
      role: "Directora de Compras · Delta Foods",
      kind: "objection",
      stamp: "07:58",
      at: 478,
      quote: "El precio que me pasaste está un 30 % por encima de lo que pagamos hoy. Con ese número no lo puedo defender internamente.",
      usedIn: "Seguimiento comercial",
      theme: "Precio y defensa interna",
    },
  ],
};

/** 3 · ENTREVISTA — sin decisiones ni tareas formales. Prueba una reunión que
 *  produce conclusiones y una pregunta abierta, y NADA más. */
const ENTREVISTA: MeetingDetail = {
  isTestFixture: true,
  id: "entrevista-backend",
  title: "Entrevista técnica — Ingeniería de plataforma",
  source: { kind: "meet" },
  when: "3 sep 2026, 09:00",
  duration: "52:18",
  durationSeconds: 3138,
  participants: [
    { initials: "LR", name: "Laura Rivas", role: "PM · Gallery", share: 34 },
    { initials: "SM", name: "Sebastián Moreno", role: "Candidato", share: 66 },
  ],
  extraParticipants: 0,
  status: { kind: "done" },
  tasks: null,
  reports: 1,
  updated: "hace 5 h",
  language: "Español (CO)",
  confidence: "95,1 %",
  segments: 341,
  fileSize: "—",
  tags: ["hiring"],
  transcript: [
    {
      at: 420,
      stamp: "07:00",
      speaker: "Sebastián Moreno",
      initials: "SM",
      text: "En el último equipo llevé la migración de un monolito a colas. Lo que más me costó no fue el código sino convencer al equipo de que valía la pena medir antes de optimizar.",
    },
    {
      at: 1580,
      stamp: "26:20",
      speaker: "Sebastián Moreno",
      initials: "SM",
      text: "No he trabajado con Postgres a esa escala, mi experiencia fuerte es con MySQL. Pero el modelo de bloqueos lo entiendo y no me asusta aprenderlo.",
    },
    {
      at: 2640,
      stamp: "44:00",
      speaker: "Laura Rivas",
      initials: "LR",
      text: "Perfecto. Queda pendiente coordinar la sesión de diseño de sistemas con el equipo de plataforma antes de decidir.",
    },
  ],
  summary: {
    executive:
      "Sebastián tiene experiencia liderando una migración a colas y una lectura clara de que el trabajo difícil fue de convencimiento, no técnico. Su experiencia de base de datos es en MySQL, no en Postgres a esta escala. Queda una sesión de diseño de sistemas pendiente antes de cualquier decisión.",
    // ENTREVISTA → sólo DOS datos relevantes. Prueba el layout de 2 columnas.
    highlights: [
      { label: "Rol", value: "Ingeniería de plataforma" },
      { label: "Siguiente etapa", value: "Sesión de diseño de sistemas", tone: "info", target: { kind: "transcript", at: 2640 } },
    ],
    themes: [
      { label: "Migración a colas", range: "07:00–14:30", at: 420 },
      { label: "Experiencia con bases de datos", range: "26:20–33:10", at: 1580 },
    ],
    findings: [
      {
        id: "e-con-1",
        kind: "conclusion",
        title: "Sabe conducir un cambio técnico con resistencia del equipo",
        detail: "Identifica el problema social antes del técnico: lo difícil no fue el código sino convencer de medir antes de optimizar.",
        by: "Sebastián Moreno",
        initials: "SM",
        stamp: "07:00",
        at: 420,
        sources: ["transcript"],
      },
      {
        id: "e-con-2",
        kind: "conclusion",
        title: "Su experiencia de base de datos es MySQL, no Postgres a esta escala",
        detail: "Lo declara sin rodeos, lo que hace su autoevaluación creíble.",
        by: "Sebastián Moreno",
        initials: "SM",
        stamp: "26:20",
        at: 1580,
        sources: ["transcript"],
      },
      {
        id: "e-q-1",
        kind: "question",
        title: "¿La brecha de Postgres es asumible para este puesto?",
        detail: "O el equipo necesita a alguien con esa experiencia ya hecha.",
        by: "Laura Rivas",
        initials: "LR",
        stamp: "44:00",
        at: 2640,
        sources: ["transcript"],
      },
    ],
    absences: ["No se tomó una decisión de contratación en esta sesión."],
    // Una entrevista no produce tareas de CRM. La sección no se renderiza.
    nextSteps: [],
  },
  reportList: [
    {
      id: "acta-entrevista",
      name: "Acta de entrevista",
      meta: "Generado 3 sep, 10:05",
      citations: 3,
      state: "generated",
      doc: {
        title: "Entrevista técnica — Ingeniería de plataforma",
        subtitle: "3 de septiembre de 2026 · 52 minutos · 2 participantes",
        sections: [
          {
            heading: "Señales principales",
            body:
              "Lidera cambios técnicos atendiendo primero la resistencia del equipo. Declara sus brechas sin adornarlas, lo que hace su autoevaluación creíble.",
          },
          { heading: "Brecha declarada", body: "Postgres a la escala del puesto. Su experiencia profunda es en MySQL." },
          {
            heading: "Antes de decidir",
            steps: [{ text: "Sesión de diseño de sistemas con el equipo de plataforma", stamp: "LR 44:00", at: 2640 }],
          },
        ],
      },
    },
  ],
  evidence: [],
};

/** 4 · SOPORTE — Problema · Diagnóstico · Resolución. Prueba un grupo único a
 *  ancho completo y un highlight en verde de "resuelto". */
const SOPORTE: MeetingDetail = {
  isTestFixture: true,
  id: "soporte-4471",
  title: "Soporte — ticket 4471, pedidos duplicados",
  source: { kind: "inbox", thread: "escalado desde WhatsApp" },
  when: "2 sep 2026, 17:20",
  duration: "18:05",
  durationSeconds: 1085,
  participants: [
    { initials: "DS", name: "Diana Salas", role: "Soporte N2 · Gallery", share: 48 },
    { initials: "JC", name: "Julián Cifuentes", role: "CTO · Northwind", share: 52 },
  ],
  extraParticipants: 0,
  status: { kind: "done" },
  tasks: 1,
  reports: null,
  updated: "ayer",
  language: "Español (CO)",
  confidence: "93,4 %",
  segments: 122,
  fileSize: "—",
  tags: ["incidente"],
  transcript: [
    {
      at: 96,
      stamp: "01:36",
      speaker: "Julián Cifuentes",
      initials: "JC",
      text: "Desde el lunes nos están entrando pedidos duplicados. El mismo pedido aparece dos veces con distinto número.",
    },
    {
      at: 402,
      stamp: "06:42",
      speaker: "Diana Salas",
      initials: "DS",
      text: "Ya lo vi: el webhook de la tienda está reintentando cuando nuestra respuesta tarda más de cinco segundos, y no estamos deduplicando por idempotency key.",
    },
    {
      at: 780,
      stamp: "13:00",
      speaker: "Diana Salas",
      initials: "DS",
      text: "Activamos la deduplicación por clave y limpiamos los 14 duplicados de esta semana. Ya no deberían entrar más.",
    },
  ],
  summary: {
    executive:
      "Northwind reporta pedidos duplicados desde el lunes. La causa es el reintento del webhook de la tienda cuando la respuesta tarda más de cinco segundos, sin deduplicación por idempotency key. Se activó la deduplicación y se limpiaron los 14 duplicados de la semana.",
    // SOPORTE → Problema · Diagnóstico · Resolución. Tres datos.
    highlights: [
      { label: "Problema", value: "Pedidos duplicados desde el lunes", tone: "warn", target: { kind: "finding", id: "s-prob-1" } },
      { label: "Diagnóstico", value: "Reintento de webhook sin idempotency key", target: { kind: "transcript", at: 402 } },
      { label: "Resolución", value: "Deduplicación activada", tone: "success", target: { kind: "transcript", at: 780 } },
    ],
    themes: [
      { label: "Síntoma reportado", range: "01:36–04:20", at: 96 },
      { label: "Causa raíz", range: "06:42–10:15", at: 402 },
    ],
    findings: [
      {
        id: "s-prob-1",
        kind: "problem",
        level: "critical",
        title: "El webhook reintenta y el receptor no deduplica",
        detail: "La tienda reintenta cuando la respuesta tarda más de cinco segundos, y sin idempotency key el mismo pedido entra dos veces.",
        by: "Diana Salas",
        initials: "DS",
        stamp: "06:42",
        at: 402,
        sources: ["transcript", "email"],
        actions: [{ label: "Ver en el transcript", primary: true }, { label: "Abrir el ticket" }],
      },
      {
        id: "s-prob-2",
        kind: "problem",
        level: "warning",
        title: "14 pedidos duplicados llegaron a producción esta semana",
        detail: "Se detectaron por el reporte del cliente, no por una alerta propia.",
        by: "Diana Salas",
        initials: "DS",
        stamp: "13:00",
        at: 780,
        sources: ["transcript"],
      },
      {
        id: "s-rec-1",
        kind: "recommendation",
        title: "Bajar el timeout de respuesta a 3 s",
        detail: "Para que el reintento del webhook no se dispare por latencia normal.",
        by: "Diana Salas",
        initials: "DS",
        stamp: "13:00",
        at: 780,
        sources: ["transcript", "task"],
      },
      {
        id: "s-rec-2",
        kind: "recommendation",
        title: "Alertar cuando un idempotency key llegue más de una vez",
        detail: "Detectarlo sin esperar el reporte del cliente.",
        by: "Diana Salas",
        initials: "DS",
        stamp: "13:00",
        at: 780,
        sources: ["transcript"],
      },
    ],
    nextSteps: [
      {
        id: "s-step-1",
        text: "Bajar el timeout de respuesta del webhook a 3 s y alertar sobre reintentos",
        owner: "Diana Salas",
        ownerInitials: "DS",
        due: { label: "lun 8 sep", state: "scheduled" },
        evidence: { initials: "DS", stamp: "06:42", at: 402 },
        state: "created",
      },
    ],
  },
  reportList: [],
  evidence: [],
};

/** 5 · SIN HALLAZGOS SUFICIENTES — el análisis corrió y no encontró nada
 *  afirmable. Prueba el estado vacío de la vista completa. También sirve de
 *  prueba de TEXTO LARGO: título y nombre deliberadamente extensos. */
const INFORMAL: MeetingDetail = {
  isTestFixture: true,
  id: "informal-cafe",
  title: "Conversación informal de equipo — seguimiento de la semana y temas varios sin agenda previa",
  source: { kind: "room" },
  when: "1 sep 2026, 12:15",
  duration: "07:42",
  durationSeconds: 462,
  participants: [
    { initials: "MV", name: "María Fernanda Vanegas Restrepo", role: "Head of Ops · Gallery", share: 51 },
    { initials: "LR", name: "Laura Rivas", role: "PM · Gallery", share: 49 },
  ],
  extraParticipants: 0,
  status: { kind: "done" },
  tasks: null,
  reports: null,
  updated: "ayer",
  language: "Español (CO)",
  confidence: "88,2 %",
  segments: 46,
  fileSize: "—",
  tags: [],
  transcript: [
    {
      at: 42,
      stamp: "00:42",
      speaker: "María Fernanda Vanegas Restrepo",
      initials: "MV",
      text: "¿Alcanzaste a ver lo del reporte de la semana pasada? Nada urgente, era más por curiosidad.",
    },
    {
      at: 130,
      stamp: "02:10",
      speaker: "Laura Rivas",
      initials: "LR",
      text: "Lo vi de reojo. Lo miro bien cuando cierre lo de esta semana.",
    },
  ],
  // Nada afirmable: TODOS los campos vacíos. La vista muestra un solo estado.
  summary: { executive: "", highlights: [], themes: [], findings: [], nextSteps: [] },
  reportList: [],
  evidence: [],
};

/* ── The rest of the listing ────────────────────────────────────────────── */

const OTHERS: MeetingListItem[] = [
  {
    id: "renovacion-delta",
    title: "Renovación anual — Delta Foods",
    source: { kind: "file", filename: "renovacion-delta.wav", size: "121 MB" },
    when: "1 sep, 09:45",
    duration: "54:03",
    participants: [JC, DS],
    extraParticipants: 2,
    status: { kind: "transcribing", percent: 72 },
    tasks: null,
    reports: null,
    updated: "hace 1 min",
  },
  {
    id: "comite-semanal",
    title: "Comité semanal de operaciones",
    source: { kind: "file", filename: "comite-sem-36.mp3", size: "68,9 MB" },
    when: "1 sep, 16:00",
    duration: "1:12:40",
    participants: [MV, LR],
    extraParticipants: 4,
    status: { kind: "done" },
    tasks: 11,
    reports: 2,
    updated: "ayer",
  },
  {
    id: "llamada-entrante-812",
    title: "Llamada entrante — número no registrado",
    source: { kind: "inbox", thread: "conversación de WhatsApp" },
    when: "1 sep, 11:20",
    duration: "09:14",
    participants: [AP],
    extraParticipants: 1,
    status: { kind: "done-no-speakers" },
    tasks: 2,
    reports: 1,
    updated: "ayer",
  },
  {
    id: "sesion-producto",
    title: "Sesión de producto — grabación de sala",
    source: { kind: "room" },
    when: "31 ago, 15:10",
    duration: null,
    participants: [],
    extraParticipants: 0,
    status: { kind: "failed", reason: "Audio corrupto a los 03:12" },
    tasks: null,
    reports: null,
    updated: "31 ago",
  },
  {
    id: "onboarding-andes",
    title: "Onboarding cliente — Ferretería Andes",
    source: { kind: "file", filename: "onboarding-andes.m4a", size: "28,4 MB" },
    when: "30 ago, 14:00",
    duration: "22:36",
    participants: [LR, AP],
    extraParticipants: 0,
    status: { kind: "diarizing", percent: 48 },
    tasks: null,
    reports: null,
    updated: "hace 8 min",
  },
  {
    id: "qbr-northwind",
    title: "Revisión trimestral — Northwind",
    source: { kind: "file", filename: "qbr-northwind-q3.mp4", size: "340 MB" },
    when: "29 ago, 11:00",
    duration: "1:04:19",
    participants: [MV, JC],
    extraParticipants: 3,
    status: { kind: "done" },
    tasks: 9,
    reports: 4,
    updated: "29 ago",
  },
  {
    id: "prueba-micro",
    title: "Prueba de micrófono",
    source: { kind: "cancelled", by: "vanegas.mora23" },
    when: "28 ago, 17:40",
    duration: "01:02",
    participants: [],
    extraParticipants: 0,
    status: { kind: "cancelled" },
    tasks: null,
    reports: null,
    updated: "28 ago",
  },
];

const ALL: MeetingListItem[] = [KICKOFF, DISCOVERY, COMERCIAL, ENTREVISTA, SOPORTE, INFORMAL, ...OTHERS];

/* ── The facets the listing offers ──────────────────────────────────────── */

export type MeetingFacet = "all" | "done" | "processing" | "attention";

/** Which facet a status belongs to. One place, so the pills and the rows agree. */
export function facetOf(status: MeetingStatus): Exclude<MeetingFacet, "all"> {
  switch (status.kind) {
    case "done":
      return "done";
    case "uploading":
    case "transcribing":
    case "diarizing":
    case "analyzing":
      return "processing";
    default:
      // failed / cancelled / done-no-speakers all need a human to look.
      return "attention";
  }
}

/** The spec's totals for the summary strip. They describe the whole book (128
 *  meetings), not the fixture page, so they are stated rather than counted. */
export const MEETINGS_SUMMARY = {
  total: 128,
  done: 121,
  processing: 3,
  attention: 1,
  hoursTranscribed: "96,4",
  openTasks: 17,
} as const;

/** Sort keys the listing offers. Mirrors the toolbar's own list. */
export type MeetingSort = "recent" | "oldest" | "longest";

/** mm:ss / h:mm:ss → seconds, for sorting by length. Null durations sort last. */
function durationSeconds(d: string | null): number {
  if (!d) return -1;
  const parts = d.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export async function listMeetings(options?: {
  facet?: MeetingFacet;
  search?: string;
  sort?: MeetingSort;
}): Promise<MeetingListItem[]> {
  const facet = options?.facet ?? "all";
  const sort = options?.sort ?? "recent";
  const search = options?.search?.trim().toLowerCase();
  const rows = ALL.filter((m) => {
    if (facet !== "all" && facetOf(m.status) !== facet) return false;
    if (!search) return true;
    const haystack = [m.title, m.when, ...m.participants.map((p) => p.name)].join(" ").toLowerCase();
    return haystack.includes(search);
  });
  // ALL is already in "most recent first" order (the fixtures are a spec, not a
  // clock, so there is no date to sort on — the declared order IS recency).
  if (sort === "oldest") return [...rows].reverse();
  if (sort === "longest") return [...rows].sort((a, b) => durationSeconds(b.duration) - durationSeconds(a.duration));
  return rows;
}

const DETAILS: MeetingDetail[] = [KICKOFF, DISCOVERY, COMERCIAL, ENTREVISTA, SOPORTE, INFORMAL];

export async function getMeeting(id: string): Promise<MeetingDetail | null> {
  return DETAILS.find((m) => m.id === id) ?? null;
}

/** Ids that have a detail fixture — the listing only links those rows. */
export const DETAILED_IDS: readonly string[] = DETAILS.map((m) => m.id);
