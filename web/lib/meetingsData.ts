/**
 * Reuniones — el contrato de la pantalla, ya contra la base de datos.
 *
 * ── Qué cambió ──────────────────────────────────────────────────────────────
 *
 * Este fichero eran FIXTURES: el contenido de la hoja de diseño, tipado para que
 * los componentes consumieran las formas que un repositorio devolvería después.
 * Se decía a sí mismo que «cuando lleguen las tablas, los cuerpos se reemplazan
 * por consultas y ningún llamador cambia». Han llegado, y es lo que ha pasado:
 * los TIPOS de abajo son exactamente los de antes; lo que se fue son los datos
 * inventados.
 *
 * Los fixtures no se conservan aquí en desuso. Una pantalla que mezcla seis
 * reuniones de mentira con la real es peor que una pantalla vacía, y un fichero
 * de mil líneas de datos que ya no se leen es una trampa para el siguiente que
 * lo abra. Siguen en la rama de diseño, que es donde son útiles.
 *
 * ── El ámbito ya no es opcional ─────────────────────────────────────────────
 *
 * `listMeetings` y `getMeeting` exigen `tenantId` y `clientId`. Las páginas ya
 * los tienen del gate del módulo, y el filtro se aplica además en el WHERE del
 * repositorio: el aislamiento entre clientes no puede depender de que quien
 * llama se acuerde de pasarlo.
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
  /**
   * El identificador ESTABLE del segmento dentro de su versión de transcript — el
   * `index` del artefacto, no una posición del array. Es lo que apunta una cita, así
   * que sobrevive a cualquier agrupación de presentación (ver transcriptBlocks.ts).
   */
  index: number;
  /** Seconds from the start — what the player seeks to. */
  at: number;
  /** Fin del segmento. Hace falta para medir la PAUSA entre dos consecutivos, que es
   *  una de las razones por las que un bloque de intervención se corta. */
  endsAt: number;
  /** mm:ss label, as the spec prints it. */
  stamp: string;
  /**
   * La etiqueta de diarización cruda (`SPEAKER_00`…), no el nombre mostrado. Se agrupa
   * por ESTO: dos hablantes sin resolver comparten el nombre «Sin asignar», y agrupar
   * por nombre los juntaría en una intervención que nunca existió.
   */
  speakerLabel: string | null;
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
   * Metadatos del resumen: de qué versión de transcripción salió y si esa versión
   * sigue siendo la activa. `null` cuando la reunión aún no tiene resumen.
   */
  analysis: {
    readonly id: string;
    readonly outdated: boolean;
    readonly model: string;
    readonly createdAt: string;
    /**
     * Coste ESTIMADO, nunca el importe facturado. Los tokens de entrada
     * cacheados se cuentan a tarifa completa, así que sobreestima antes que
     * quedarse corto. `null` = tarifa desconocida, no cero.
     */
    readonly costUsd: number | null;
  } | null;
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

/** Sort keys the listing offers. Mirrors the toolbar's own list. */
export type MeetingSort = "recent" | "oldest" | "longest";

/** mm:ss / h:mm:ss → seconds, for sorting by length. Null durations sort last. */
function durationSeconds(d: string | null): number {
  if (!d) return -1;
  const parts = d.split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}


/* ── Las lecturas ─────────────────────────────────────────────────────────── */

/**
 * El ámbito resuelto por el gate del módulo. Se pide como objeto para que
 * añadir una dimensión más adelante no cambie el orden de dos uuids que se
 * pueden confundir entre sí.
 */
export interface MeetingsScope {
  readonly tenantId: string;
  readonly clientId: string;
}

/**
 * El listado, ya filtrado y ordenado.
 *
 * El filtro por faceta y la búsqueda se aplican EN MEMORIA sobre las filas de
 * este cliente, no en SQL. Es deliberado para el volumen de hoy: la faceta se
 * deriva del estado compuesto (`statusOf`), que es una decisión de producto con
 * pruebas, y duplicarla en SQL significaría mantener el mismo criterio en dos
 * lenguajes y descubrir la divergencia cuando una fila aparezca en la faceta
 * equivocada. Cuando el volumen lo pida, lo que hay que mover a SQL es la
 * paginación, y entonces la faceta tiene que bajar con ella.
 */
export async function listMeetings(
  scope: MeetingsScope,
  options?: {
    facet?: MeetingFacet;
    search?: string;
    sort?: MeetingSort;
  },
): Promise<MeetingListItem[]> {
  const { listMeetingsForUi } = await import("@worker/meetings/uiRead.js");
  const { toListItem } = await import("./meetingsMap");

  const facet = options?.facet ?? "all";
  const sort = options?.sort ?? "recent";
  const search = options?.search?.trim().toLowerCase();

  const now = new Date();
  const rows = (await listMeetingsForUi(scope)).map((row) => toListItem(row, now));

  const filtered = rows.filter((meeting) => {
    if (facet !== "all" && facetOf(meeting.status) !== facet) return false;
    if (!search) return true;
    const haystack = [meeting.title, meeting.when].join(" ").toLowerCase();
    return haystack.includes(search);
  });

  // El repositorio ya devuelve por recencia (started_at, y created_at cuando no
  // hay), así que "recent" es el orden que llega.
  if (sort === "oldest") return [...filtered].reverse();
  if (sort === "longest") {
    return [...filtered].sort((a, b) => durationSeconds(b.duration) - durationSeconds(a.duration));
  }
  return filtered;
}

/** Las cifras de la cabecera, contadas sobre las filas reales de este cliente. */
export interface MeetingsHeadline {
  readonly total: number;
  readonly done: number;
  readonly processing: number;
  readonly attention: number;
  /**
   * Audio con transcripción lista, ya con unidad.
   *
   * Lleva la unidad dentro a propósito. Con «h» fija en la plantilla, dos
   * minutos de audio se imprimían como «0,0 h transcritas», que se lee como un
   * contador roto en vez de como un dato pequeño. La cifra elige su unidad.
   */
  readonly transcribedLabel: string;
  /** null mientras no exista almacenamiento de tareas: no se cuenta lo que no hay. */
  readonly openTasks: number | null;
}

export function headlineOf(meetings: readonly MeetingListItem[]): MeetingsHeadline {
  const facetCount = (facet: Exclude<MeetingFacet, "all">) =>
    meetings.filter((meeting) => facetOf(meeting.status) === facet).length;
  const seconds = meetings
    .filter((meeting) => meeting.status.kind === "done" || meeting.status.kind === "done-no-speakers")
    .reduce((total, meeting) => total + Math.max(0, durationSeconds(meeting.duration)), 0);
  return {
    total: meetings.length,
    done: facetCount("done"),
    processing: facetCount("processing"),
    attention: facetCount("attention"),
    transcribedLabel: transcribedLabelOf(seconds),
    openTasks: null,
  };
}

/** Segundos → «45 s», «12 min», «1,4 h». La unidad la elige la magnitud. */
export function transcribedLabelOf(seconds: number): string {
  if (seconds <= 0) return "0 min";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1).replace(".", ",")} h`;
}

/**
 * Una reunión con su transcripción y sus hablantes.
 *
 * `null` cuando no existe O no es de este cliente: la página lo traduce a un
 * 404 indistinguible, que es el criterio del módulo.
 */
export async function getMeeting(
  scope: MeetingsScope,
  meetingId: string,
): Promise<MeetingDetail | null> {
  const { getMeetingForUi } = await import("@worker/meetings/uiRead.js");
  const { toDetail } = await import("./meetingsMap");

  const detail = await getMeetingForUi(scope, meetingId);
  if (detail === null) return null;

  // El resumen se lee aparte: es opcional, y una reunión sin él tiene que
  // pintarse igual de bien que antes de que esto existiera.
  const { getAnalysis } = await import("@worker/meetings/analysis/service.js");
  const analysis = await getAnalysis(scope, meetingId).catch(() => null);
  return toDetail(detail, new Date(), analysis);
}

/**
 * ¿Se puede reproducir el audio de esta reunión?
 *
 * Lo decide la existencia de un `normalized` vivo, no el estado del pipeline:
 * una reunión con la transcripción lista cuya retención ya borró el audio no
 * tiene nada que reproducir, y una que acaba de normalizar sí aunque no haya
 * texto todavía.
 */
export async function getMeetingAudioAvailability(
  scope: MeetingsScope,
  meetingId: string,
): Promise<boolean> {
  const { hasPlayableAudio } = await import("@worker/meetings/uiRead.js");
  return hasPlayableAudio(scope, meetingId);
}
