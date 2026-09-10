"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Chip, EmptyState, GHOST_ACTION_CLS, PRIMARY_SM_CLS } from "@/components/ui/primitives";
import { AudioPlayer, type AudioState, type SpeakerTurn } from "@/components/reuniones/AudioPlayer";
import { Avatar, ProgressBar, ShareMeter, StampLink, statusFace } from "@/components/reuniones/MeetingBits";
import type { EvidenceItem, MeetingDetail } from "@/lib/meetingsData";
import { groupTranscript, targetScrollTop } from "@/lib/transcriptBlocks";
import {
  composeSummary,
  FINDING_KIND,
  LEAD_LIMIT,
  pendingStepCount,
  SOURCE_LABEL,
  type Finding,
  type FindingKind,
  type FindingSource,
  type Highlight,
  type HighlightTarget,
  type NextStep,
} from "@/lib/meetingsSummary";

/**
 * The meeting workspace: header, the four views, the two optional panels and the
 * docked player.
 *
 * WHY ONE CLIENT COMPONENT. The tab, the two panels and the playhead are ONE
 * piece of state — clicking an evidence chip has to switch to the transcript AND
 * move the audio AND highlight a segment. Splitting that across a server page
 * with three islands would mean lifting the same state into a context anyway,
 * for no rendering benefit: the content is already in memory (it arrives as a
 * prop) so nothing here needs the server.
 *
 * LAYOUT CONTRACT (the spec's rules 6–8):
 *   - Inspector and Copilot open from clearly LABELLED toggles, never from a
 *     permanent side rail or decorative tabs;
 *   - with both closed the transcript goes into FOCUS MODE — a 1100px reading
 *     column, centred;
 *   - only the transcript scrolls; the header, the tab bar, both panels and the
 *     player stay put;
 *   - the player is docked at the BOTTOM of the transcript, and the scroller
 *     carries bottom padding so the last line is never hidden behind it.
 */

type Tab = "resumen" | "transcript" | "reportes" | "evidencia";

const TABS: { key: Tab; label: string }[] = [
  { key: "resumen", label: "Resumen" },
  { key: "transcript", label: "Transcript" },
  { key: "reportes", label: "Reportes" },
  { key: "evidencia", label: "Evidencia" },
];

/**
 * Tones for the SHARED finding taxonomy (lib/meetingsSummary.ts), used by both
 * the evidence tab and the summary's groups so a "Riesgo" looks the same in
 * both places.
 *
 * `risk` and `problem` are the only reds — they are the only kinds that mean
 * something is wrong. `dependency` and `objection` are amber (a pending
 * condition), and everything else is neutral: a decision or an idea is not a
 * status and should not be dressed as one. The design sheet spent violet on
 * "Dependencia", which is outside the product's palette entirely.
 */
const KIND_TONE: Record<FindingKind, "neutral" | "brand" | "warn" | "muted"> = {
  decision: "neutral",
  agreement: "muted",
  conclusion: "muted",
  risk: "brand",
  problem: "brand",
  dependency: "warn",
  objection: "warn",
  need: "neutral",
  question: "neutral",
  idea: "neutral",
  feedback: "neutral",
  recommendation: "neutral",
};

export function MeetingWorkspace({
  meeting,
  backHref,
  /** Derived by the page from the meeting's own state — see the detail route. */
  audioState = "ready",
  /**
   * La ruta de sesión que firma el GET del audio, o `null` si no hay nada que
   * reproducir. No es la URL firmada: se pide al reproducir, para que la
   * caducidad cuente desde entonces y no desde que se pintó la página.
   */
  audioSrc = null,
}: {
  meeting: MeetingDetail;
  /** Absolute href back to the listing, built by the server page. */
  backHref: string;
  audioState?: AudioState;
  audioSrc?: string | null;
}) {
  const face = statusFace(meeting.status);
  const analysisReady = meeting.status.kind === "done" || meeting.status.kind === "done-no-speakers";

  // La pestaña inicial. Antes: Resumen en cuanto la reunión estaba lista. Pero
  // sin etapa de análisis ese Resumen está vacío, y abrir en una pestaña vacía
  // esconde lo único que sí hay. Se abre en Resumen sólo si tiene contenido.
  const hasTranscript = meeting.transcript.length > 0;
  const hasSummary =
    meeting.summary.executive.trim() !== "" ||
    meeting.summary.findings.length > 0 ||
    meeting.summary.nextSteps.length > 0 ||
    meeting.summary.highlights.length > 0;
  const [tab, setTab] = useState<Tab>(analysisReady && hasSummary ? "resumen" : "transcript");
  const [inspector, setInspector] = useState(false);
  const [copilot, setCopilot] = useState(false);
  const [at, setAt] = useState(0);
  /** The segment a jump landed on — highlighted for orientation, not as a warning. */
  const [focusedAt, setFocusedAt] = useState<number | null>(null);

  const speakers: SpeakerTurn[] = useMemo(() => {
    const total = meeting.durationSeconds || 1;
    return meeting.transcript.map((s, i) => ({
      from: s.at / total,
      to: (meeting.transcript[i + 1]?.at ?? total) / total,
      name: s.speaker,
    }));
  }, [meeting.transcript, meeting.durationSeconds]);

  /** Jump to a moment: move the audio, show the transcript, mark the segment. */
  const jumpTo = (seconds: number) => {
    setAt(seconds);
    setFocusedAt(seconds);
    setTab("transcript");
  };

  const focusMode = !inspector && !copilot;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--content-pad)]">
      {/* ── HEADER CARD: identity, state and the meeting-level actions. Fixed
             height and fixed slots across every tab, so nothing shifts when the
             view changes. ── */}
      <section className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow-card)]">
        <Link href={backHref} aria-label="Volver a Reuniones" className="u-focus inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground">
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9.6 3.6 5.2 8l4.4 4.4" />
          </svg>
        </Link>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="truncate text-[1.0625rem] font-semibold tracking-[-0.02em]">{meeting.title}</h1>
          <p className="flex flex-wrap items-center gap-2 text-[0.75rem] text-muted">
            <span>{meeting.when}</span>
            <span aria-hidden className="text-faintest">·</span>
            <span className="u-mono">{meeting.duration}</span>
            <span aria-hidden className="text-faintest">·</span>
            <span>{meeting.participants.length} participantes</span>
            <Chip tone={face.tone}>{face.label}</Chip>
            {meeting.isTestFixture ? (
              <Chip tone="muted" title="Contenido inventado para validar el layout. No es una reunión real.">
                Fixture de prueba
              </Chip>
            ) : null}
          </p>
        </div>
        {/* The header player: play · plain progress · time · speed. Same
            component, `variant="bar"` — a 160-bar waveform in a header is
            decoration, and this screen is about text. */}
        {tab !== "transcript" ? (
          <div className="order-3 w-full min-w-0 border-t border-line-row pt-2 lg:order-none lg:ml-auto lg:w-[19rem] lg:border-0 lg:pt-0">
            <AudioPlayer
              meetingId={meeting.id}
              durationSeconds={meeting.durationSeconds}
              startAt={at}
              state={audioState}
              src={audioSrc}
              speakers={speakers}
              density="compact"
              variant="bar"
            />
          </div>
        ) : null}

        <span className={`flex shrink-0 items-center gap-1.5 ${tab !== "transcript" ? "" : "ml-auto"}`}>
          <button type="button" className={GHOST_ACTION_CLS}>
            Exportar
          </button>
          <button type="button" className={GHOST_ACTION_CLS}>
            Compartir
          </button>
          <button
            type="button"
            aria-label="Más acciones de la reunión"
            className="u-focus inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
              <circle cx="3" cy="8" r="1.3" />
              <circle cx="8" cy="8" r="1.3" />
              <circle cx="13" cy="8" r="1.3" />
            </svg>
          </button>
        </span>
      </section>

      {/* ── THE WORK AREA: [Inspector] [view + player] [Copilot] ── */}
      <div className="flex min-h-0 flex-1 gap-[var(--content-pad)]">
        {inspector ? <InspectorPanel meeting={meeting} onClose={() => setInspector(false)} /> : null}

        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]">
          {/* Tab bar — one fixed-height band. The panel toggles live at its right
              end, labelled, with aria-pressed carrying the state. */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line-row px-2.5 py-2">
            <div role="tablist" aria-label="Vistas de la reunión" className="flex min-w-0 flex-wrap items-center gap-1">
              {TABS.map((t) => {
                const locked = !analysisReady && t.key !== "transcript";
                const selected = tab === t.key;
                const count =
                  t.key === "reportes" ? meeting.reportList.length || null : t.key === "evidencia" ? meeting.evidence.length || null : null;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-disabled={locked || undefined}
                    disabled={locked}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setTab(t.key)}
                    title={locked ? "Se habilita cuando el análisis termine" : undefined}
                    className={`u-focus inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors ${
                      selected
                        ? "bg-ink font-semibold text-ink-fg"
                        : locked
                          ? "cursor-not-allowed text-faint"
                          : "text-muted hover:bg-subtle hover:text-foreground"
                    }`}
                  >
                    {t.label}
                    {/* Locked tabs say WHY in words, never by colour alone. */}
                    {locked ? <span className="text-[0.65625rem] text-warn">· en proceso</span> : null}
                    {count !== null && !locked ? (
                      <span className={`u-mono text-[0.65625rem] ${selected ? "opacity-70" : "text-faint"}`}>{count}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <PanelToggle name="Inspector" open={inspector} onToggle={() => setInspector((v) => !v)} />
              <PanelToggle name="Copilot" open={copilot} onToggle={() => setCopilot((v) => !v)} />
            </span>
          </div>

          {/* While the analysis runs, ONE banner carries the whole story: the
              stage, the percentage, its bar and the phase checklist. The sheet
              told it three times (banner + checklist + a sentence in the tab
              bar), which is how a reader stops believing any of them. */}
          {!analysisReady && face.progress ? (
            <div className="m-2.5 flex shrink-0 flex-col gap-2 rounded-xl border border-warn/30 bg-warn-soft px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-warn/30 border-t-warn" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[0.8125rem] font-semibold text-warn">
                    {face.label} · {face.progress.value} %
                  </span>
                  <span className="text-[0.75rem] text-warn/90">
                    {hasTranscript
                      ? "La transcripción ya está disponible: puedes leerla, buscarla y citarla mientras el resto avanza."
                      : "El transcript aparecerá aquí en cuanto la etapa termine."}
                  </span>
                  <ProgressBar
                    kind={face.progress.kind}
                    value={face.progress.value}
                    label="Progreso del procesamiento"
                    className="mt-0.5 max-w-[20rem]"
                  />
                </div>
                <Chip tone="success">Te avisaremos al terminar</Chip>
              </div>
              {/* La lista se DERIVA del estado. Estaba escrita para un solo
                  escenario —«el análisis corre, todo lo anterior está hecho»— y
                  con vistos verdes fijos: una reunión recién subida mostraba
                  «Transcripción completa» y «0 participantes separados» en verde
                  sin tener ni una frase. Ahora cada línea dice lo que hay. */}
              <ol className="flex flex-wrap items-center gap-4 border-t border-warn/20 pt-2">
                <PhaseItem
                  state={
                    hasTranscript ? "done" : meeting.status.kind === "transcribing" ? "running" : "pending"
                  }
                >
                  {hasTranscript ? "Transcripción completa" : "Transcripción"}
                </PhaseItem>
                <PhaseItem
                  state={
                    meeting.participants.length > 0
                      ? "done"
                      : meeting.status.kind === "diarizing"
                        ? "running"
                        : "pending"
                  }
                >
                  {meeting.participants.length > 0
                    ? `${meeting.participants.length} participantes separados`
                    : "Separación de participantes"}
                </PhaseItem>
                {/* El análisis no tiene etapa ni almacenamiento: nunca «corre». */}
                <PhaseItem state="unavailable">Análisis: todavía no disponible</PhaseItem>
              </ol>
            </div>
          ) : null}

          {/* THE CONTENT REGION. Two kinds of view live here and they need
              different geometry:

              READING views (transcript, resumen, evidencia) scroll in ONE
              scroller, and the transcript alone takes the spec's focus measure —
              a 1100px column, centred — because it is the only one that is
              continuous prose. Applying that measure to every tab is what left
              Reportes with 250px of dead canvas on each side.

              Reportes is a WORKSPACE: a list beside a document, both stretching
              to the bottom, each scrolling on its own. It manages its own height
              and must not inherit a reading column. */}
          {tab === "reportes" ? (
            <Reports meeting={meeting} onSeek={jumpTo} />
          ) : (
            <div
              // RESUMEN is a board of BOXES, so its scroller shows the canvas and
              // the panels read as objects on it. The other tabs are ONE surface
              // (a document, a list) and stay white.
              className={`min-h-0 flex-1 overflow-y-auto ${tab === "resumen" ? "bg-background" : ""}`}
            >
              {/* ONE container contract for every reading view: centred, capped,
                  and with the SAME lateral padding. Resumen used to inherit a
                  bare `px-4`, so its content sat almost against the card's left
                  edge while the transcript beside it had 32px — which is what
                  made the screen look unbalanced. The transcript keeps a
                  narrower measure (the spec's focus column) because it is
                  continuous prose; the others get the wider one. */}
              {/* ONE container contract. The transcript keeps a narrow reading
                  measure (continuous prose); the panel-based views take the full
                  width with a modest gutter, so a panel spans the card instead of
                  floating in the middle of it. */}
              <div
                className={
                  tab === "transcript"
                    ? `mx-auto w-full px-6 sm:px-8 ${focusMode ? "max-w-[68.75rem]" : "max-w-none"}`
                    : tab === "resumen"
                      ? "w-full px-3 sm:px-4"
                      : "mx-auto w-full max-w-[78rem] px-6 sm:px-8"
                }
              >
                {tab === "transcript" ? (
                  <Transcript meeting={meeting} focusedAt={focusedAt} onSeek={jumpTo} />
                ) : tab === "resumen" ? (
                  <Summary meeting={meeting} onSeek={jumpTo} />
                ) : (
                  <Evidence meeting={meeting} onSeek={jumpTo} />
                )}
              </div>
            </div>
          )}

          {/* THE WAVEFORM DOCK LIVES ONLY IN TRANSCRIPT. It is 70px of the
              loudest object on the screen, and it earns that only where the
              shape of the audio is what you navigate by — beside the text it
              indexes. On Resumen, Reportes and Evidencia the same audio is
              reachable from the compact bar in the header, and the space goes
              to the content instead. */}
          {tab === "transcript" ? (
            <AudioPlayer
              meetingId={meeting.id}
              durationSeconds={meeting.durationSeconds}
              startAt={at}
              state={audioState}
              src={audioSrc}
              speakers={speakers}
            />
          ) : null}
        </section>

        {copilot ? <CopilotPanel meeting={meeting} onClose={() => setCopilot(false)} onSeek={jumpTo} /> : null}
      </div>
    </div>
  );
}

/**
 * Una línea de la lista de fases, con su estado REAL.
 *
 * Sustituye a `PhaseDone`, que sólo sabía pintar el visto verde: con un único
 * estado posible, la lista afirmaba que todo lo anterior a la etapa en curso
 * estaba hecho, y eso sólo era cierto en el escenario para el que se dibujó.
 * «pendiente» y «no disponible» se distinguen a propósito: lo primero llegará,
 * lo segundo no existe todavía.
 */
function PhaseItem({
  state,
  children,
}: {
  state: "done" | "running" | "pending" | "unavailable";
  children: React.ReactNode;
}) {
  const tone =
    state === "done"
      ? "text-foreground"
      : state === "running"
        ? "text-warn"
        : "text-warn/70";
  return (
    <li className={`flex items-center gap-2 text-[0.78125rem] ${tone}`}>
      {state === "done" ? (
        <span aria-hidden className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-success text-white">
          <svg viewBox="0 0 16 16" className="size-2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3.4 8.4l3 3 6.2-6.6" />
          </svg>
        </span>
      ) : state === "running" ? (
        <span aria-hidden className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-warn/30 border-t-warn" />
      ) : (
        <span aria-hidden className="size-3.5 shrink-0 rounded-full border-2 border-warn/25" />
      )}
      {children}
    </li>
  );
}

/**
 * The panel toggle. ONE component for both panels and both states, so Inspector
 * and Copilot cannot drift into four different-looking buttons the way they did
 * across the design sheet's frames.
 *
 * ICON-ONLY, because the tab bar is the view's densest row and two labelled
 * toggles took 300px of it — enough to force the bar to wrap the moment a panel
 * narrows the column. The state is carried by `aria-pressed`, by the accessible
 * name ("Inspector · abierto") and by FILL vs OUTLINE — three signals, none of
 * them colour alone.
 */
function PanelToggle({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  const label = `${name} · ${open ? "abierto" : "cerrado"}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={label}
      title={label}
      className={`u-focus inline-flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
        open ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface text-muted hover:border-faint hover:text-foreground"
      }`}
    >
      {name === "Inspector" ? (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
          <rect x="2.6" y="3.2" width="10.8" height="9.6" />
          <path d="M6.4 3.2v9.6" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2.4l1.3 3.1 3.1 1.3-3.1 1.3L8 11.2 6.7 8.1 3.6 6.8l3.1-1.3z" />
        </svg>
      )}
    </button>
  );
}

/* ── The four views ───────────────────────────────────────────────────────── */

/**
 * El ancestro que de verdad hace scroll. `scrollIntoView` ya lo encuentra solo, pero
 * para MEDIR si algo está visible hay que saber contra qué caja comparar, y la del
 * contenedor de contenido no sirve: es más alta que la ventana.
 *
 * Devuelve null si no hay ninguno, y entonces el que scrollea es el documento.
 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

export function Transcript({
  meeting,
  focusedAt,
  onSeek,
}: {
  meeting: MeetingDetail;
  focusedAt: number | null;
  onSeek: (s: number) => void;
}) {
  // BLOQUES DE INTERVENCIÓN con PÁRRAFOS dentro. Ver transcriptBlocks.ts: el bloque
  // trae la cabecera, el párrafo trae texto corrido y los segmentos van EN LÍNEA.
  const blocks = useMemo(() => groupTranscript(meeting.transcript), [meeting.transcript]);
  const content = useRef<HTMLDivElement | null>(null);

  /*
    EL SALTO DEJA LA CABECERA VISIBLE. Antes nadie desplazaba nada: `jumpTo` cambiaba
    de pestaña y marcaba el segmento, y el lector tenía que buscarlo — y cuando caía
    arriba, el borde del scroller le cortaba la cabecera por la mitad (justo lo que se
    veía en la captura).

    Se desplaza el BLOQUE, no el segmento: lo que hay que poder leer es de quién es la
    intervención y desde cuándo. `scroll-mt-6` en el <article> le da el aire que
    `block: "start"` no da por sí solo, y `scrollIntoView` respeta ese margen.
  */
  useEffect(() => {
    if (focusedAt === null) return;
    const root = content.current;
    if (!root) return;
    const block = root.querySelector<HTMLElement>(`[data-block-focused="true"]`);
    const segment = root.querySelector<HTMLElement>(`[data-segment-focused="true"]`);
    if (!block) return;

    const viewport = scrollParentOf(root);
    if (!viewport || !segment) {
      // Sin contenedor propio scrollea el documento, y sin segmento sólo hay cabecera
      // que mostrar: en los dos casos basta lo que el navegador ya sabe hacer.
      block.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }

    // UN solo desplazamiento, a una posición calculada. Ver targetScrollTop: desplazar
    // a la cabecera y corregir después dependía de un requestAnimationFrame que en una
    // pestaña que no se pinta no llega nunca.
    const viewRect = viewport.getBoundingClientRect();
    const origin = viewRect.top - viewport.scrollTop;
    const segRect = segment.getBoundingClientRect();
    viewport.scrollTo({
      top: targetScrollTop({
        viewHeight: viewport.clientHeight,
        maxScroll: viewport.scrollHeight - viewport.clientHeight,
        blockTop: block.getBoundingClientRect().top - origin,
        segmentTop: segRect.top - origin,
        segmentBottom: segRect.bottom - origin,
        marginTop: parseFloat(getComputedStyle(block).scrollMarginTop) || 0,
      }),
      behavior: "smooth",
    });
  }, [focusedAt]);

  return (
    // gap-7 entre intervenciones: la separación tiene que leerse como un cambio de
    // turno, no como un renglón más. Antes era gap-1.5, del tiempo en que cada
    // segmento era una fila.
    <div ref={content} className="flex flex-col gap-7 py-4 pb-10">
      {blocks.map((block) => {
        const jumpedInside = block.segments.some((s) => focusedAt === s.at);
        const citedInside = block.segments.some((s) => s.cited);
        return (
          <article
            key={block.key}
            data-block-focused={jumpedInside ? "true" : undefined}
            className={`group scroll-mt-6 rounded-xl transition-colors ${
              // A jumped-to block is a REFERENCE, so it tints accent-blue, not the
              // amber the sheet used — amber here read as "something is wrong".
              jumpedInside
                ? "bg-accent/8 px-3.5 py-3 ring-1 ring-accent/25"
                : citedInside
                  ? "bg-subtle px-3.5 py-3"
                  : "px-3.5 py-0"
            }`}
          >
            {/* UNA cabecera por intervención, y nunca repetida por longitud: un
                párrafo nuevo no es una intervención nueva. */}
            <header className="mb-1.5 flex items-center gap-2.5">
              <Avatar person={{ initials: block.initials, name: block.speaker }} size={28} />
              <h3 className="flex flex-wrap items-center gap-2">
                <span className="text-[0.8125rem] font-semibold">{block.speaker}</span>
                <StampLink at={block.at} onSeek={onSeek}>{block.stamp}</StampLink>
                {block.unidentified ? (
                  <button type="button" className="u-focus rounded text-[0.6875rem] text-accent underline decoration-accent/40">
                    Identificar
                  </button>
                ) : null}
                {jumpedInside ? <Chip tone="muted">Desde la evidencia</Chip> : citedInside ? <Chip tone="muted">Citado por Copilot</Chip> : null}
              </h3>
              <button
                type="button"
                onClick={() => onSeek(block.at)}
                aria-label={`Escuchar desde ${block.stamp}`}
                className="u-focus ml-auto shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
                  <path d="M4 2.6l8 5.4-8 5.4z" />
                </svg>
              </button>
            </header>

            {/* LOS PÁRRAFOS. `pl-[2.375rem]` los alinea con el nombre, bajo el avatar.
                `60ch` MEDIDO, no elegido de memoria: en el navegador este cuerpo da
                6.82 px por carácter real y 8.67 px por «0», así que 60ch ≈ 520 px ≈ 76
                caracteres por línea — dentro del 65–80 que se pide. 72ch parecía
                correcto y medía ~91 en pantalla ancha, porque `ch` es el ancho del
                cero, más grande que la media de las minúsculas. Interlineado 1.6. */}
            <div className="flex flex-col gap-3 pl-[2.375rem]">
              {block.paragraphs.map((paragraph) => (
                <p
                  key={paragraph.key}
                  className="max-w-[60ch] text-[0.875rem] leading-[1.6] text-foreground/90"
                >
                  {/*
                    Cada segmento sigue siendo un elemento propio —con su índice y su
                    tiempo— pero EN LÍNEA: el texto fluye y se ajusta al ancho en vez
                    de romperse una vez por segmento de Whisper.

                    Es un <span> CON SEMÁNTICA DE BOTÓN, y las dos mitades de esa frase
                    son deliberadas.

                    Semántica de botón porque clicar un segmento salta a SU tiempo: con
                    un span mudo esa acción sólo existiría para el ratón, y quien navega
                    con teclado llegaría al principio de la intervención y a ningún
                    punto dentro de ella. `role="button"` + `tabIndex` + Enter/Espacio es
                    lo que hace que la acción exista de verdad.

                    Y un span, no un <button>, porque un botón NO fluye en línea de
                    forma fiable: medido en el navegador, `<button class="inline">`
                    computaba `inline-block` —gana el valor del agente de usuario— y el
                    párrafo se desarmaba, con cada segmento envuelto a una palabra por
                    línea. Un span es inline por naturaleza y no depende de ganar una
                    batalla de cascada.
                  */}
                  {paragraph.segments.map((segment, position) => {
                    const jumped = focusedAt === segment.at;
                    return (
                      <Fragment key={segment.index}>
                      <span
                        role="button"
                        tabIndex={0}
                        data-segment-index={segment.index}
                        data-segment-at={segment.at}
                        data-segment-focused={jumped ? "true" : undefined}
                        aria-label={`Escuchar desde ${segment.stamp}`}
                        title={`Escuchar desde ${segment.stamp}`}
                        onClick={() => onSeek(segment.at)}
                        onKeyDown={(event) => {
                          // Lo que `role="button"` promete y un span no trae puesto.
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault(); // el Espacio, si no, desplaza la página
                          onSeek(segment.at);
                        }}
                        className={`u-focus cursor-pointer rounded transition-colors hover:text-foreground ${
                          // El segmento exacto al que se saltó, resaltado DENTRO del
                          // párrafo: se ve el punto sin perder el contexto.
                          jumped ? "bg-accent/20 text-foreground" : ""
                        }`}
                      >
                        {segment.text}
                      </span>
                      {/* El espacio va FUERA: dentro, el fondo del resaltado se
                          extendería hasta la palabra siguiente. Y tiene que estar: dos
                          elementos adyacentes en JSX no dejan hueco y el texto saldría
                          pegado. */}
                      {position < paragraph.segments.length - 1 ? " " : ""}
                      </Fragment>
                    );
                  })}
                </p>
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   RESUMEN — the adaptive view.

   Every section below is CONDITIONAL and every layout decision is derived from
   the data, so the same component serves a project kickoff, a sales call, an
   interview, a support call and a meeting that produced almost nothing. There
   is no branch anywhere on a meeting's name or subject.
   ═══════════════════════════════════════════════════════════════════════════ */


/**
 * Icons per finding kind — the non-colour half of "what kind of thing is this".
 *
 * NORMALISED on purpose: one 16×16 box, one 1.5 stroke, round caps, and every
 * path kept inside 2–14 so nothing touches the edge and gets clipped at
 * `size-3.5`. They used to be drawn ad hoc, so the triangle bled past the box
 * while the checkmark floated in the middle of it and the row of headings
 * looked like four different icon sets.
 */
function FindingIcon({ kind }: { kind: FindingKind }) {
  const p = (d: string) => (
    <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d.split("|").map((seg) => (
        <path key={seg} d={seg} />
      ))}
    </svg>
  );
  switch (kind) {
    case "risk":
      // Triángulo de advertencia, base en y=13, vértice en y=3.
      return p("M8 3 2.4 13h11.2L8 3Z|M8 7.2v2.4|M8 11.4h.01");
    case "dependency":
      // Dos eslabones.
      return p("M6.6 9.4 9.4 6.6|M9.1 4.9 10 4a2.4 2.4 0 0 1 3.4 3.4l-.9.9|M6.9 11.1l-.9.9A2.4 2.4 0 0 1 2.6 8.6l.9-.9");
    case "problem":
      return p("M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z|M6.2 6.2l3.6 3.6|M9.8 6.2l-3.6 3.6");
    case "question":
      return p("M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z|M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6v.9|M8 11.2h.01");
    case "objection":
      // Bocadillo con signo: una objeción es algo que alguien dijo.
      return p("M13.4 9.2A1.6 1.6 0 0 1 11.8 10.8H5.6L3 13.2V4.4a1.6 1.6 0 0 1 1.6-1.6h7.2a1.6 1.6 0 0 1 1.6 1.6v4.8Z|M8.2 5.2v2.1|M8.2 8.9h.01");
    case "idea":
      return p("M8 2.6a3.6 3.6 0 0 0-2.1 6.6v1.3h4.2V9.2A3.6 3.6 0 0 0 8 2.6Z|M6.7 12.8h2.6");
    case "feedback":
      return p("M8 2.8l1.6 3.2 3.6.5-2.6 2.5.6 3.5L8 10.8l-3.2 1.7.6-3.5L2.8 6.5l3.6-.5L8 2.8Z");
    case "recommendation":
      return p("M3.2 8.4l3 3 6.6-6.8");
    case "agreement":
      // Dos manos / acuerdo mutuo: un acuerdo no es una decisión unilateral.
      return p("M2.6 8.6l2.6-2.6 2.8 2.8|M13.4 7.4l-2.6 2.6L8 7.2|M5.2 6h5.6");
    case "conclusion":
      return p("M4 2.8h8v10.4l-4-2.4-4 2.4V2.8Z");
    case "decision":
    default:
      return p("M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z|M5.7 8.1l1.7 1.7 3-3.4");
  }
}

/**
 * THE panel — the unit the Resumen view is built from.
 *
 * Every block on this screen is one of these: executive summary, themes, the
 * narrative, attention, at-a-glance and next steps. They used to be a mix —
 * two sections floating loose on the surface and four in bordered cards — which
 * read as if the loose ones were still loading. One shape, one padding.
 *
 * They sit on the CANVAS (the scroller goes grey for this tab), which is what
 * makes them read as boxes rather than as regions of one page. They span the
 * full width — the gutter is 12–16px, not a reading measure — so the grey shows
 * BETWEEN boxes, never as a wide margin down either side.
 */
function Panel({
  title,
  count,
  actions,
  children,
  className = "",
  bleed = false,
}: {
  title?: string;
  count?: number;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Children run edge to edge (a list with its own dividers). */
  bleed?: boolean;
}) {
  return (
    <section className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)] ${className}`}>
      {title ? (
        <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5">
          <h2 className="min-w-0 truncate text-[0.8125rem] font-semibold">{title}</h2>
          {count !== undefined ? <span className="shrink-0 text-[0.6875rem] text-faint u-mono">{count}</span> : null}
          {actions ? <span className="ml-auto flex shrink-0 items-center gap-2">{actions}</span> : null}
        </div>
      ) : null}
      <div className={bleed ? "min-w-0" : "min-w-0 px-4 pb-4"}>{children}</div>
    </section>
  );
}

/** Corroboration chip: where a finding is backed up. */
function SourceChip({ source }: { source: FindingSource }) {
  const icon =
    source === "email"
      ? "M2.6 4.6h10.8v6.8H2.6V4.6Z|M2.6 4.6 8 8.6l5.4-4"
      : source === "task"
        ? "M3.4 8.2l2.4 2.4 6.8-6.8|M3.4 12.6h9.2"
        : source === "contact"
          ? "M8 3.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z|M3.6 13a4.4 4.4 0 0 1 8.8 0"
          : source === "appointment"
            ? "M3 4.4h10v8.4H3V4.4Z|M3 7.2h10|M5.8 2.8v1.6|M10.2 2.8v1.6"
            : source === "document"
              ? "M4.2 2.8h5l2.6 2.6v7.8H4.2V2.8Z|M6.2 8h3.6|M6.2 10.4h3.6"
              : "M2.8 8h1.4|M5.6 5.4v5.2|M8 3.6v8.8|M10.4 6v4|M13.2 8h.01";
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-soft bg-subtle px-1.5 py-0.5 text-[0.65625rem] text-muted">
      <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icon.split("|").map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
      {SOURCE_LABEL[source]}
    </span>
  );
}

/**
 * ONE narrative finding in the lead column: rank number, kind, headline,
 * context, corroboration, attribution and its contextual actions.
 *
 * The RANK NUMBER is load-bearing, not decoration: it is what tells a reader
 * that this list is ordered by importance rather than by category, which is the
 * whole point of the editorial layout.
 */
function LeadFinding({ finding: f, rank, onSeek }: { finding: Finding; rank: number; onSeek: (s: number) => void }) {
  const sources: FindingSource[] = f.sources?.length ? f.sources : ["transcript"];
  return (
    <article id={`finding-${f.id}`} className="flex scroll-mt-6 gap-3 py-4 first:pt-0 last:pb-0">
      <span
        aria-hidden
        className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-line-soft bg-subtle text-[0.65625rem] font-semibold text-muted u-mono"
      >
        {rank}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em]">{f.title}</h3>
          <span className="shrink-0 text-[0.6875rem] text-faint">{FINDING_KIND[f.kind].singular}</span>
        </div>
        {f.detail ? <p className="text-[0.875rem] leading-[1.65] text-foreground/85">{f.detail}</p> : null}

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
          {sources.map((src) => (
            <SourceChip key={src} source={src} />
          ))}
          {/* Confidence, only when the analysis is unsure enough to matter. */}
          {f.confidence !== undefined ? (
            <span className="inline-flex items-center gap-1.5 text-[0.65625rem] text-muted" title="Confianza del análisis en esta atribución">
              <span aria-hidden className="relative block h-1 w-10 overflow-hidden rounded-full bg-chip">
                <span className="absolute inset-y-0 left-0 rounded-full bg-faint" style={{ width: `${f.confidence}%` }} />
              </span>
              <span className="u-mono">{f.confidence}%</span>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onSeek(f.at)}
            className="u-focus inline-flex items-center gap-1.5 rounded text-[0.6875rem] text-muted transition-colors hover:text-foreground"
          >
            <Avatar person={{ initials: f.initials, name: f.by }} size={15} />
            <span className="truncate">{f.by}</span>
            <span className="u-mono">{f.stamp}</span>
          </button>

          {f.actions?.length ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {f.actions.map((a, i) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={i === 0 ? () => onSeek(f.at) : undefined}
                  className={
                    a.primary || i === 0
                      ? "u-focus rounded-lg border border-line-strong px-2.5 py-1 text-[0.71875rem] text-foreground transition-colors hover:border-faint"
                      : "u-focus rounded px-1 text-[0.71875rem] text-muted transition-colors hover:text-foreground"
                  }
                >
                  {a.label}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   RESUMEN — editorial layout.

     ┌──────────────────────────────┬────────────────────┐
     │ Lo más importante            │ Requiere atención  │
     │  ranked narrative findings   ├────────────────────┤
     │                              │ En una mirada      │
     └──────────────────────────────┴────────────────────┘
     ┌───────────────────────────────────────────────────┐
     │ Próximos pasos (full width)                       │
     └───────────────────────────────────────────────────┘

   The left column is NOT named after a category: it holds whatever the most
   relevant items were, each carrying its own kind label. The right column
   holds ONLY exceptions, and disappears when there are none — in which case
   the narrative takes the full width instead of leaving a hole.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Chip tone per highlight tone. Red is only ever `danger`. */
const HIGHLIGHT_TONE: Record<NonNullable<Highlight["tone"]>, "neutral" | "muted" | "warn" | "brand" | "success"> = {
  neutral: "muted",
  info: "neutral",
  warn: "warn",
  danger: "brand",
  success: "success",
};

/**
 * El estado vacío de una fase que todavía no existe.
 *
 * Tres pestañas —Resumen, Reportes y Evidencia— dependen del análisis, y el
 * análisis no tiene etapa ni almacenamiento: `analysis_state` es `pending` para
 * toda reunión. La alternativa era dejar los fixtures del diseño, y eso habría
 * puesto seis reuniones inventadas y las citas de un kickoff que no existió al
 * lado de una transcripción real. Un hueco honesto se lee como un hueco; un
 * dato inventado se lee como un dato.
 *
 * Se dice QUÉ falta y QUÉ sí hay, porque «vacío» sin más deja al usuario sin
 * saber si la reunión se procesó mal o si la función no ha llegado.
 */
function PhasePending({
  title,
  body,
  onGoToTranscript,
}: {
  title: string;
  body: string;
  onGoToTranscript?: () => void;
}) {
  return (
    <div className="flex min-h-[18rem] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span
        aria-hidden
        className="inline-flex size-10 items-center justify-center rounded-full border border-line bg-subtle text-muted"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none">
          <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.6" />
          <path d="M12 8v4l2.5 1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-[34rem] text-[0.8125rem] leading-relaxed text-muted">{body}</p>
      {onGoToTranscript ? (
        <button
          type="button"
          onClick={onGoToTranscript}
          className="u-focus mt-1 rounded-lg border border-line px-3 py-1.5 text-[0.8125rem] font-medium text-foreground hover:bg-subtle"
        >
          Ver la transcripción
        </button>
      ) : null}
    </div>
  );
}

/**
 * El estado VACÍO y el resumen, separados en dos componentes.
 *
 * Estaban en una sola función: un `return <PhasePending/>` temprano y, DESPUÉS, un
 * `useState`. Eso rompe las reglas de los hooks —eslint lo marcaba como error— y no es
 * teórico: en cuanto una reunión pase de «sin análisis» a «con análisis» sin
 * desmontarse, React encuentra un hook que antes no existía y el orden se descoloca.
 *
 * El arreglo es estructural y no mueve nada de conducta: `Summary` decide, `SummaryBody`
 * tiene los hooks. El texto del estado vacío, la condición que lo dispara (contenido, no
 * estado) y todo lo demás quedan idénticos.
 */
function Summary({ meeting, onSeek }: { meeting: MeetingDetail; onSeek: (s: number) => void }) {
  const s = meeting.summary;
  // Ni narrativa, ni hallazgos, ni siguientes pasos: no hay análisis. Se
  // comprueba el CONTENIDO y no un estado, porque una reunión puede tener el
  // análisis "ready" y no haber encontrado nada que decir.
  const nothing =
    s.executive.trim() === "" &&
    s.highlights.length === 0 &&
    s.themes.length === 0 &&
    s.findings.length === 0 &&
    s.nextSteps.length === 0;
  if (nothing) {
    return (
      <PhasePending
        title="Todavía no hay resumen"
        body={
          "El análisis de la reunión —resumen ejecutivo, temas, decisiones y siguientes pasos— " +
          "es una fase posterior del módulo y aún no está disponible. La transcripción y los " +
          "hablantes de esta reunión sí están completos y se pueden leer."
        }
      />
    );
  }
  return <SummaryBody meeting={meeting} onSeek={onSeek} />;
}

function SummaryBody({ meeting, onSeek }: { meeting: MeetingDetail; onSeek: (s: number) => void }) {
  const s = meeting.summary;
  const c = composeSummary(s);
  const [showAllLead, setShowAllLead] = useState(false);
  const shownLead = showAllLead ? c.lead : c.lead.slice(0, LEAD_LIMIT);
  const pending = pendingStepCount(s.nextSteps);

  const jumpToTarget = (t: HighlightTarget) => {
    if (t.kind === "transcript") return onSeek(t.at);
    const el = document.getElementById(t.kind === "finding" ? `finding-${t.id}` : `step-${t.id}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.classList.add("u-flash");
    window.setTimeout(() => el?.classList.remove("u-flash"), 1400);
  };

  if (c.isEmpty) {
    return (
      <div className="py-6">
        <EmptyState
          title="Esta reunión no produjo un resumen confiable."
          hint="El transcript está completo y se puede leer, buscar y citar. No afirmamos conclusiones que no estén dichas en el audio."
        />
      </div>
    );
  }

  // No exceptions and nothing to glance at → the narrative gets everything.
  const hasSide = c.attention.length > 0 || c.glance.length > 0;

  return (
    <div className="flex flex-col gap-4 py-4 pb-8">
      {s.executive ? (
        <Panel title="Resumen ejecutivo">
          <p className="text-[0.9375rem] leading-[1.7] text-balance text-foreground/90">{s.executive}</p>
        </Panel>
      ) : null}

      {s.themes.length > 0 ? (
        <Panel title="Temas principales" count={s.themes.length}>
          <ul className="flex flex-wrap gap-1.5">
            {s.themes.map((t) => (
              <li key={t.label}>
                <button
                  type="button"
                  onClick={() => onSeek(t.at)}
                  title={`Ir a "${t.label}" en el transcript`}
                  className="u-focus inline-flex max-w-full items-center gap-2 rounded-lg border border-line-soft bg-subtle px-2.5 py-1 text-[0.78125rem] transition-colors hover:border-line-strong hover:bg-surface"
                >
                  <span className="min-w-0 truncate">{t.label}</span>
                  <span className="shrink-0 text-[0.6875rem] text-muted u-mono">{t.range}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* ── THE TWO COLUMNS ── */}
      {/* TWO COLUMNS at their NATURAL heights.
          Stretching the shorter column to close the gap was tried and dropped:
          it only moved the emptiness inside a box, where it read as a panel that
          failed to load. Columns ending a little apart is normal on a board;
          what was wrong here was the CONTENT — three narrative items against two
          tall side cards — not the grid. */}
      <div className={hasSide ? "grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" : ""}>
        {shownLead.length > 0 || s.absences?.length ? (
          <Panel title="Lo más importante de la reunión" count={c.lead.length || undefined}>
            <div className="flex flex-col divide-y divide-line-soft">
              {shownLead.map((f, i) => (
                <LeadFinding key={f.id} finding={f} rank={i + 1} onSeek={onSeek} />
              ))}
            </div>
            {c.lead.length > LEAD_LIMIT ? (
              <button
                type="button"
                onClick={() => setShowAllLead((v) => !v)}
                aria-expanded={showAllLead}
                className="u-focus mt-3 w-fit rounded text-[0.78125rem] text-accent hover:underline"
              >
                {showAllLead ? "Ver menos" : `Ver todos (${c.lead.length})`}
              </button>
            ) : null}
            {s.absences?.length ? (
              <ul className="mt-3 flex flex-col gap-1 border-t border-line-soft pt-2.5">
                {s.absences.map((a) => (
                  <li key={a} className="text-[0.75rem] text-faint">
                    {a}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
        ) : null}

        {hasSide ? (
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-2">
            {c.attention.length > 0 ? (
              <Panel title="Requiere atención" count={c.attention.length} bleed>
                <ul className="flex flex-col">
                  {c.attention.map((a) => (
                    <li key={a.id} className="border-t border-line-soft first:border-t-0">
                      <button
                        type="button"
                        onClick={() => jumpToTarget(a.target)}
                        className="u-focus group flex w-full items-start gap-2 px-4 py-2.5 text-left transition-colors hover:bg-subtle"
                      >
                        <span
                          aria-hidden
                          className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                            a.tone === "danger" ? "bg-brand" : a.tone === "warn" ? "bg-warn" : "bg-faint"
                          }`}
                        />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-[0.8125rem] font-medium leading-snug">{a.title}</span>
                          <span className="text-[0.71875rem] leading-snug text-muted">{a.note}</span>
                        </span>
                        <svg
                          viewBox="0 0 16 16"
                          className="mt-1 size-2.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <path d="M6 3.5 10.5 8 6 12.5" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {c.glance.length > 0 ? (
              <Panel title="En una mirada" bleed>
                <dl className="flex flex-col">
                  {c.glance.map((h) => {
                    const linked = Boolean(h.target);
                    const value = h.tone ? (
                      <Chip tone={HIGHLIGHT_TONE[h.tone]}>{h.value}</Chip>
                    ) : (
                      <span
                        className={`text-[0.8125rem] font-medium leading-snug ${
                          linked ? "underline decoration-line-strong decoration-1 underline-offset-2 group-hover:decoration-foreground" : ""
                        }`}
                      >
                        {h.value}
                      </span>
                    );
                    const row = (
                      <>
                        <dt className="u-th shrink-0 pt-0.5">{h.label}</dt>
                        <dd className="ml-auto flex min-w-0 justify-end text-right">{value}</dd>
                      </>
                    );
                    return linked ? (
                      <button
                        key={h.label}
                        type="button"
                        onClick={() => jumpToTarget(h.target!)}
                        className="u-focus group flex items-start gap-3 border-t border-line-soft px-4 py-2.5 text-left first:border-t-0 hover:bg-subtle"
                      >
                        {row}
                      </button>
                    ) : (
                      <div key={h.label} className="flex items-start gap-3 border-t border-line-soft px-4 py-2.5 first:border-t-0">
                        {row}
                      </div>
                    );
                  })}
                </dl>
              </Panel>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* ── FULL-WIDTH TABLE ── */}
      {s.nextSteps.length > 0 ? <NextSteps steps={s.nextSteps} pending={pending} onSeek={onSeek} /> : null}
    </div>
  );
}
/**
 * Próximos pasos (was "Tareas y compromisos", which asserted that every meeting
 * produces tasks — an interview produces a decision about a candidate, not a
 * ticket). Full width, below the two columns: it is the operational table, and
 * a table squeezed into a 60 % column is where the dates start wrapping.
 *
 * Holds tasks with an owner and a date, commitments with neither, and things
 * already created in the CRM, without pretending they are the same.
 */
function NextSteps({ steps, pending, onSeek }: { steps: NextStep[]; pending: number; onSeek: (s: number) => void }) {
  const COLS = "20px minmax(200px,1fr) 156px 116px 96px 132px";
  const dueClass = (d: NextStep["due"]) =>
    !d || d.state === "none"
      ? "text-faint"
      : d.state === "overdue"
        ? "font-medium text-brand"
        : d.state === "soon"
          ? "text-warn"
          : "text-muted";

  return (
    <Panel
      title="Próximos pasos"
      count={steps.length}
      actions={
        // The CTA states the REAL number it would create — not a constant.
        pending > 0 ? (
          <button type="button" className={PRIMARY_SM_CLS} title="Pide confirmación antes de crear las tareas">
            Crear tareas pendientes ({pending})
          </button>
        ) : null
      }
    >
      <div role="table" aria-label="Próximos pasos de la reunión" className="overflow-x-auto">
        <div className="min-w-[820px]">
          <div
            role="row"
            className="grid h-8 items-center gap-2.5 border-b border-line-row px-1 text-[0.6875rem] font-semibold text-muted"
            style={{ gridTemplateColumns: COLS }}
          >
            <span role="columnheader">
              <span className="sr-only">Seleccionar</span>
            </span>
            <span role="columnheader">Acción</span>
            <span role="columnheader">Responsable</span>
            <span role="columnheader">Fecha</span>
            <span role="columnheader">Evidencia</span>
            <span role="columnheader">Estado</span>
          </div>
          {steps.map((t) => (
            <div
              role="row"
              key={t.id}
              id={`step-${t.id}`}
              className="grid min-h-12 scroll-mt-6 items-center gap-2.5 border-b border-line-soft px-1 last:border-b-0"
              style={{ gridTemplateColumns: COLS }}
            >
              <span role="cell">
                <input type="checkbox" aria-label={`Seleccionar: ${t.text}`} className="u-focus size-3.5 rounded border-line-strong" />
              </span>
              <span role="cell" className="text-[0.8125rem]">
                {t.text}
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-1.5 text-[0.78125rem] text-muted">
                {t.ownerInitials ? (
                  <Avatar person={{ initials: t.ownerInitials, name: t.owner ?? "" }} size={18} />
                ) : (
                  <span aria-hidden className="text-faint">
                    —
                  </span>
                )}
                <span className="truncate">{t.owner ?? "Sin responsable"}</span>
              </span>
              <span role="cell" className={`text-[0.78125rem] ${dueClass(t.due)}`}>
                {/* "Vencida" is stated, never implied by colour alone. */}
                {t.due ? (
                  <>
                    {t.due.label}
                    {t.due.state === "overdue" ? <span className="ml-1 text-[0.65625rem] uppercase">vencida</span> : null}
                  </>
                ) : (
                  "Sin fecha"
                )}
              </span>
              <span role="cell">
                <button
                  type="button"
                  onClick={() => onSeek(t.evidence.at)}
                  title={`Ir al minuto ${t.evidence.stamp} del transcript`}
                  className="u-focus rounded-md border border-line-soft px-1.5 py-0.5 text-[0.65625rem] text-muted u-mono transition-colors hover:border-faint hover:text-foreground"
                >
                  {t.evidence.initials} {t.evidence.stamp}
                </button>
              </span>
              <span role="cell" className="flex items-center gap-1.5">
                {t.state === "created" ? (
                  <>
                    <Chip tone="success">Creada</Chip>
                    <button type="button" className="u-focus rounded text-[0.6875rem] text-accent underline decoration-accent/40">
                      Ver tarea
                    </button>
                  </>
                ) : t.state === "blocked" ? (
                  <Chip tone="muted" title="Tu rol no permite crear tareas en el CRM">
                    Sin permiso
                  </Chip>
                ) : (
                  <button
                    type="button"
                    className="u-focus rounded-md border border-line-strong px-2 py-0.5 text-[0.6875rem] transition-colors hover:border-faint"
                  >
                    Crear tarea
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/**
 * Reportes: the catalogue on the left, the editable document on the right, and
 * the save actions always visible at the bottom.
 *
 * ONE SURFACE, SPLIT BY A HAIRLINE — not two cards inside a card. The list and
 * the document used to each carry their own rounded border inside the view's
 * border, which is three nested frames around one piece of content and reads as
 * clutter at any density. Now the view is a single plane divided by a vertical
 * rule, and the rows are full-bleed with their own dividers, the way the
 * Contacts table treats a list.
 *
 * The row's numbers live in its META LINE ("… · hace 1 h · 6 citas") rather than
 * in a right-aligned column of their own: a two-column row for one small count
 * spent horizontal space and put the number far from the name it describes.
 */
/** The catalogue's section headings: the list's own column labels. */
function SectionHead({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <h3 className="u-th flex items-center gap-1.5 border-b border-line-row px-4 py-2">
      {children}
      {count !== undefined ? <span className="text-faint u-mono">{count}</span> : null}
    </h3>
  );
}

function Reports({ meeting, onSeek }: { meeting: MeetingDetail; onSeek: (s: number) => void }) {
  const [selected, setSelected] = useState(meeting.reportList[0]?.id ?? null);
  if (meeting.reportList.length === 0) {
    return (
      <PhasePending
        title="Todavía no hay informes"
        body={
          "Los informes se generan a partir del análisis de la reunión, que es una fase " +
          "posterior del módulo. Cuando exista, los documentos generados aparecerán aquí con " +
          "sus citas al audio."
        }
      />
    );
  }
  const doc = meeting.reportList.find((r) => r.id === selected) ?? null;

  const stateChip = (state: MeetingDetail["reportList"][number]["state"]) =>
    state === "edited" ? (
      <Chip tone="muted">Editado</Chip>
    ) : state === "generated" ? (
      <Chip tone="success">Generado</Chip>
    ) : state === "generating" ? (
      <Chip tone="warn">Generando</Chip>
    ) : (
      <Chip tone="brand">Falló</Chip>
    );

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── THE CATALOGUE ── */}
      <div className="flex w-[20.5rem] shrink-0 flex-col overflow-y-auto border-r border-line">
        <SectionHead count={meeting.reportList.length}>Generados</SectionHead>
        <ul>
          {meeting.reportList.map((r) => {
            const active = selected === r.id;
            return (
              <li key={r.id} className="relative border-b border-line-soft">
                <div
                  className={`flex items-start gap-2 px-4 py-2.5 transition-colors ${active ? "bg-chip" : "hover:bg-subtle"}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => setSelected(r.id)}
                      aria-current={active ? "true" : undefined}
                      className="u-focus truncate text-left text-[0.8125rem] font-medium text-foreground after:absolute after:inset-0 after:content-['']"
                    >
                      {r.name}
                    </button>
                    {/* Meta and counts on ONE line — the count describes the
                        report, so it belongs beside its own words. */}
                    <span className="truncate text-[0.71875rem] text-muted">
                      {r.meta}
                      {r.citations !== null ? (
                        <>
                          <span aria-hidden className="text-faintest">
                            {" · "}
                          </span>
                          <span className="u-mono">{r.citations} citas</span>
                        </>
                      ) : null}
                    </span>
                    {r.state === "failed" ? (
                      <button
                        type="button"
                        className="u-focus relative z-10 w-fit rounded text-[0.71875rem] text-brand underline decoration-brand/40 hover:decoration-brand"
                      >
                        Reintentar
                      </button>
                    ) : null}
                  </span>
                  <span className="relative z-10 flex shrink-0 items-center gap-1.5">
                    {stateChip(r.state)}
                    <button
                      type="button"
                      aria-label={`Más acciones para ${r.name}`}
                      className="u-focus inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
                    >
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
                        <circle cx="3" cy="8" r="1.3" />
                        <circle cx="8" cy="8" r="1.3" />
                        <circle cx="13" cy="8" r="1.3" />
                      </svg>
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        {/* "Disponibles para generar", not "No generados": the section is an
            OFFER, and naming it by what is missing reads as a list of failures. */}
        <SectionHead>Disponibles para generar</SectionHead>
        <ul>
          {["Decisiones", "Riesgos y bloqueos", "Minuta"].map((name) => (
            <li key={name} className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">{name}</span>
              {/* A LINK, not an outlined button: these are secondary offers, and
                  three outlined buttons in a column read as the screen's main
                  actions when the real primary is "Generar reporte" above. */}
              <button type="button" className="u-focus shrink-0 rounded text-[0.78125rem] text-accent hover:underline">
                Generar
              </button>
            </li>
          ))}
          <li className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[0.8125rem] text-foreground">Prompt personalizado</span>
              <span className="truncate text-[0.71875rem] text-muted">Escribe qué quieres extraer de la reunión</span>
            </span>
            <button
              type="button"
              className="u-focus shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-[0.78125rem] text-muted transition-colors hover:border-faint hover:text-foreground"
            >
              Escribir
            </button>
          </li>
        </ul>
      </div>

      {/* ── THE DOCUMENT ── */}
      {doc ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-row px-5 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[0.875rem] font-semibold">{doc.name}</span>
              <span className="truncate text-[0.71875rem] text-muted">{doc.meta}</span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {["Regenerar", "Copiar", "Exportar"].map((a) => (
                <button
                  key={a}
                  type="button"
                  className="u-focus rounded-lg border border-line-strong px-2.5 py-1.5 text-[0.78125rem] text-muted transition-colors hover:border-faint hover:text-foreground"
                >
                  {a}
                </button>
              ))}
              <button
                type="button"
                aria-label="Más acciones del reporte"
                className="u-focus inline-flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
                  <circle cx="3" cy="8" r="1.3" />
                  <circle cx="8" cy="8" r="1.3" />
                  <circle cx="13" cy="8" r="1.3" />
                </svg>
              </button>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {doc.state === "failed" ? (
              <div className="p-6">
                <EmptyState title="No pudimos generar este reporte." hint="El transcript sigue disponible: puedes leerlo, buscarlo y citarlo." />
              </div>
            ) : doc.state === "generating" || !doc.doc ? (
              <div className="p-6">
                <EmptyState title="Generando el reporte…" hint={doc.meta} />
              </div>
            ) : (
              /* LEFT-ALIGNED, with a measure. Centring the article in a pane this
                 wide left two big symmetric gutters and made the document float;
                 a document reads from a left edge.

                 RENDERED FROM DATA. This used to be the kickoff's text written
                 straight into the JSX, so every meeting's report showed that one
                 meeting's content. */
              <article className="flex max-w-[58rem] flex-col gap-5 px-9 py-7">
                <header className="flex flex-col gap-1.5 border-b border-line-soft pb-4">
                  <h3 className="text-[1.375rem] font-semibold tracking-[-0.02em]">{doc.doc.title}</h3>
                  <p className="text-[0.8125rem] text-muted">{doc.doc.subtitle}</p>
                </header>
                {doc.doc.sections.map((sec) => (
                  <section key={sec.heading} className="flex flex-col gap-1.5">
                    <h4 className="text-[0.875rem] font-semibold">{sec.heading}</h4>
                    {sec.body ? <p className="text-[0.9375rem] leading-[1.8] text-foreground/90">{sec.body}</p> : null}
                    {sec.steps ? (
                      <ol className="flex flex-col gap-2 text-[0.9375rem] leading-[1.8] text-foreground/90">
                        {sec.steps.map((st, i) => (
                          <li key={st.text} className="flex gap-3">
                            <span aria-hidden className="shrink-0 text-muted u-mono">
                              {i + 1}.
                            </span>
                            <span>
                              {st.text}
                              {st.stamp && st.at !== undefined ? (
                                <>
                                  {" "}
                                  <StampLink at={st.at} onSeek={onSeek} boxed>
                                    {st.stamp}
                                  </StampLink>
                                </>
                              ) : null}
                              .
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </section>
                ))}
              </article>
            )}
          </div>

          {/* Save actions stay VISIBLE — the spec's rule 2. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-row px-5 py-2.5">
            <span className="text-[0.78125rem] text-muted">
              Este reporte se apoya en <span className="font-medium text-foreground u-mono">{doc.citations ?? 0}</span> citas del transcript
            </span>
            <button type="button" className="u-focus rounded text-[0.78125rem] text-accent underline decoration-accent/40 hover:decoration-accent">
              Ver evidencia
            </button>
            <span className="ml-auto flex items-center gap-2">
              <span className="text-[0.78125rem] text-warn">2 cambios sin guardar</span>
              <button
                type="button"
                className="u-focus rounded-lg border border-line-strong px-3 py-1.5 text-[0.78125rem] text-muted transition-colors hover:border-faint hover:text-foreground"
              >
                Descartar
              </button>
              <button type="button" className={PRIMARY_SM_CLS}>
                Guardar
              </button>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Evidencia: a FLAT surface with dividers, grouped by theme. No nested cards —
 * the spec is explicit that this is the Contacts-table treatment, not a wall of
 * boxes.
 */
function Evidence({ meeting, onSeek }: { meeting: MeetingDetail; onSeek: (s: number) => void }) {
  const [kind, setKind] = useState<"all" | EvidenceItem["kind"]>("all");
  if (meeting.evidence.length === 0) {
    return (
      <PhasePending
        title="Todavía no hay evidencia citada"
        body={
          "La evidencia son las frases del audio que el análisis selecciona y agrupa por tema. " +
          "Depende de la misma fase que el resumen. Mientras tanto, la transcripción completa " +
          "está disponible y cada segmento se puede escuchar desde su marca de tiempo."
        }
      />
    );
  }
  const items = meeting.evidence.filter((e) => kind === "all" || e.kind === kind);
  const counts = (k: EvidenceItem["kind"]) => meeting.evidence.filter((e) => e.kind === k).length;

  // Group by theme, preserving the order the quotes arrive in.
  const groups: { theme: string; items: EvidenceItem[] }[] = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.theme === it.theme) last.items.push(it);
    else groups.push({ theme: it.theme, items: [it] });
  }

  // The filter pills are DERIVED from the kinds this meeting actually produced,
  // in the order they first appear. Fixed pills meant a support call showed
  // "Compromisos 0" and had nowhere to put its "Problema".
  const presentKinds = [...new Set(meeting.evidence.map((e) => e.kind))];
  // "No agregues filtros cuando haya pocos elementos": one kind, or a handful of
  // quotes, is faster to read than to filter.
  const showFilters = presentKinds.length > 1 && meeting.evidence.length > 3;

  return (
    <div className="flex flex-col py-3 pb-6">
      {showFilters ? (
        <div role="group" aria-label="Filtros de evidencia" className="mb-1 flex flex-wrap items-center gap-1.5 pb-2">
          {[{ key: "all" as const, label: "Todas", n: meeting.evidence.length }, ...presentKinds.map((k) => ({ key: k, label: FINDING_KIND[k].label, n: counts(k) }))].map(
            (f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setKind(f.key)}
                aria-pressed={kind === f.key}
                className={`u-focus inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[0.78125rem] transition-colors ${
                  kind === f.key ? "bg-ink font-semibold text-ink-fg" : "text-muted hover:bg-subtle hover:text-foreground"
                }`}
              >
                {f.label}
                <span className={`u-mono text-[0.65625rem] ${kind === f.key ? "opacity-70" : "text-faint"}`}>{f.n}</span>
              </button>
            ),
          )}
        </div>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title={meeting.evidence.length === 0 ? "Todavía no hay citas registradas." : "Ninguna cita de este tipo."}
          hint={
            meeting.evidence.length === 0
              ? "La evidencia se llena cuando el análisis liga una conclusión a un momento del audio."
              : "Cambia el filtro para ver el resto de la evidencia."
          }
        />
      ) : (
        groups.map((g) => (
          <section key={g.theme}>
            <h3 className="u-th border-y border-line-row bg-subtle px-3.5 py-1.5">
              {g.theme} · {g.items.length} {g.items.length === 1 ? "cita" : "citas"}
            </h3>
            <ul>
              {g.items.map((e) => (
                <li key={e.at} className="flex gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0">
                  <Avatar person={{ initials: e.initials, name: e.speaker }} size={26} />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <h4 className="flex flex-wrap items-center gap-2">
                      <span className="text-[0.8125rem] font-semibold">{e.speaker}</span>
                      <span className="text-[0.71875rem] text-muted">{e.role}</span>
                      <span className="inline-flex items-center gap-1.5">
                        <span className={e.kind === "risk" || e.kind === "problem" ? "text-brand" : e.kind === "dependency" || e.kind === "objection" ? "text-warn" : "text-muted"}>
                          <FindingIcon kind={e.kind} />
                        </span>
                        <Chip tone={KIND_TONE[e.kind]}>{FINDING_KIND[e.kind].singular}</Chip>
                      </span>
                      <span className="ml-auto text-[0.6875rem] text-muted u-mono">{e.stamp}</span>
                    </h4>
                    <blockquote className="max-w-[92ch] text-[0.84375rem] leading-relaxed text-foreground/90">«{e.quote}»</blockquote>
                    {/* Actions and provenance stay in ONE group, left-aligned. In
                        the sheet the "Usada en…" note was pushed 1200px away by
                        margin-left:auto, so nothing tied it to its own row. */}
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => onSeek(e.at)}
                        className="u-focus rounded text-[0.71875rem] text-accent underline decoration-accent/40"
                      >
                        Abrir en el transcript
                      </button>
                      <button
                        type="button"
                        onClick={() => onSeek(e.at)}
                        className="u-focus inline-flex items-center gap-1.5 rounded text-[0.71875rem] text-muted hover:text-foreground"
                      >
                        <svg viewBox="0 0 16 16" className="size-2.5" fill="currentColor" aria-hidden>
                          <path d="M4 2.6l8 5.4-8 5.4z" />
                        </svg>
                        Escuchar desde {e.stamp}
                      </button>
                      {e.producedTask ? (
                        <span className="inline-flex items-center gap-1.5 text-[0.71875rem] text-success">
                          <span aria-hidden className="size-1.5 rounded-full bg-success" />
                          Generó una tarea en el CRM
                        </span>
                      ) : (
                        <span className="text-[0.71875rem] text-faint">{e.usedIn ? `Usada en ${e.usedIn}` : "Todavía no se usa en ningún reporte"}</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/* ── The two optional panels ──────────────────────────────────────────────── */

function InspectorPanel({ meeting, onClose }: { meeting: MeetingDetail; onClose: () => void }) {
  return (
    <aside
      aria-label="Inspector de la reunión"
      className="flex w-[16.5rem] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line-row px-3 py-2.5">
        <h2 className="text-[0.8125rem] font-semibold">Inspector</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar el Inspector"
          className="u-focus ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        <section className="flex flex-col gap-2.5">
          <h3 className="u-th">Participantes</h3>
          {meeting.participants.map((p) => (
            <div key={p.initials} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Avatar person={p} size={24} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 truncate text-[0.78125rem] font-medium">{p.name}</span>
                    {p.share !== null ? <span className="shrink-0 text-[0.6875rem] text-muted u-mono">{p.share} %</span> : null}
                  </span>
                  <span className="truncate text-[0.6875rem] text-faint">{p.role ?? "Sin identificar · asociar contacto"}</span>
                </span>
              </div>
              {p.share !== null ? <ShareMeter value={p.share} name={p.name} /> : null}
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <h3 className="u-th">Procesamiento</h3>
          {/* What the analysis deliberately DID NOT assert. This used to be a
              full block in the summary body, sitting under Decisiones as if it
              were a finding — it is metadata about the analysis, so it belongs
              beside the rest of it. */}
          {meeting.summary.caveat ? (
            <p className="flex items-start gap-1.5 rounded-lg bg-subtle px-2 py-1.5 text-[0.6875rem] leading-relaxed text-muted">
              <svg viewBox="0 0 16 16" className="mt-px size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <path d="M8 2.6a5.4 5.4 0 1 1 0 10.8 5.4 5.4 0 0 1 0-10.8Z" />
                <path d="M8 5.6h.01M8 7.6v3" />
              </svg>
              {meeting.summary.caveat}
            </p>
          ) : null}
          <dl className="flex flex-col gap-1.5 text-[0.75rem]">
            {[
              ["Idioma", meeting.language],
              ["Confianza media", meeting.confidence],
              ["Segmentos", String(meeting.segments)],
              ["Archivo", meeting.fileSize],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-2">
                <dt className="text-muted">{k}</dt>
                <dd className="ml-auto text-foreground u-mono">{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {meeting.tags.length > 0 ? (
          <section className="flex flex-col gap-2 border-t border-line-soft pt-3">
            <h3 className="u-th">Etiquetas</h3>
            <ul className="flex flex-wrap gap-1.5">
              {meeting.tags.map((t) => (
                <li key={t}>
                  <Chip tone="neutral">{t}</Chip>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  aria-label="Añadir etiqueta"
                  className="u-focus inline-flex items-center rounded-full border border-dashed border-line-strong px-2 py-[0.1rem] text-[0.6875rem] text-muted hover:border-faint"
                >
                  +
                </button>
              </li>
            </ul>
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function CopilotPanel({
  meeting,
  onClose,
  onSeek,
}: {
  meeting: MeetingDetail;
  onClose: () => void;
  onSeek: (s: number) => void;
}) {
  const cited = meeting.evidence.slice(0, 2);
  return (
    <aside
      aria-label="Copilot de la reunión"
      className="flex w-[20rem] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line-row px-3 py-2.5">
        <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 2.4l1.3 3.1 3.1 1.3-3.1 1.3L8 11.2 6.7 8.1 3.6 6.8l3.1-1.3z" />
        </svg>
        <h2 className="text-[0.8125rem] font-semibold">Copilot</h2>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" className="u-focus rounded text-[0.6875rem] text-muted hover:text-foreground">
            Nuevo hilo
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar Copilot"
            className="u-focus inline-flex size-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <p className="self-end rounded-2xl rounded-br-md bg-chip px-3 py-2 text-[0.78125rem]">
          ¿Qué acordaron sobre el presupuesto y quién queda responsable?
        </p>
        <div className="flex flex-col gap-2">
          <p className="text-[0.8125rem] leading-relaxed">
            Acordaron intentar que la fase uno se apruebe como gasto operativo para evitar el comité de presupuesto, que solo sesiona el primer
            martes del mes.
          </p>
          <ul className="flex flex-col gap-1 text-[0.78125rem] text-foreground/90">
            <li className="flex gap-2">
              <span aria-hidden className="text-faint">—</span> Julián lleva la aprobación interna sin pasar por comité.
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-faint">—</span> Laura entrega el desglose de horas el jueves.
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-faint">—</span> María envía hoy la lista de campos del mapeo.
            </li>
          </ul>
        </div>

        <h3 className="u-th">Evidencia · {cited.length} citas</h3>
        {cited.map((e) => (
          <div key={e.at} className="flex flex-col gap-1.5 rounded-xl border border-line-soft bg-subtle px-2.5 py-2">
            <span className="flex items-center gap-1.5">
              <Avatar person={{ initials: e.initials, name: e.speaker }} size={18} />
              <span className="min-w-0 truncate text-[0.71875rem] font-medium">{e.speaker}</span>
              <span className="ml-auto text-[0.65625rem] text-muted u-mono">{e.stamp}</span>
            </span>
            <blockquote className="text-[0.75rem] leading-relaxed text-foreground/90">«{e.quote.slice(0, 120)}…»</blockquote>
            <span className="flex items-center gap-2.5">
              <button type="button" onClick={() => onSeek(e.at)} className="u-focus rounded text-[0.6875rem] text-accent underline decoration-accent/40">
                Ir al transcript
              </button>
              <button type="button" onClick={() => onSeek(e.at)} className="u-focus inline-flex items-center gap-1 rounded text-[0.6875rem] text-muted hover:text-foreground">
                <svg viewBox="0 0 16 16" className="size-2" fill="currentColor" aria-hidden>
                  <path d="M4 2.6l8 5.4-8 5.4z" />
                </svg>
                Escuchar
              </button>
            </span>
          </div>
        ))}

        {/* The refusal is the feature: it says what it could NOT find, in amber
            (a caution), never as a confident answer. */}
        <p className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-soft px-2.5 py-2 text-[0.75rem] leading-relaxed text-warn">
          <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
            <circle cx="8" cy="8" r="5.8" />
            <path d="M8 5.2v3.4M8 11h.01" />
          </svg>
          No encontré en la reunión un monto ni una fecha de aprobación. No lo afirmo porque no está dicho en el audio.
        </p>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-t border-line-row px-3 py-2.5">
        <form
          onSubmit={(e) => e.preventDefault()}
          className="u-focus flex items-center gap-2 rounded-xl border border-line-strong px-2.5 py-1.5"
        >
          <input
            placeholder="Pregúntale a esta reunión…"
            aria-label="Pregúntale a esta reunión"
            className="min-w-0 flex-1 bg-transparent text-[0.78125rem] outline-none placeholder:text-faint"
          />
          <button
            type="submit"
            aria-label="Enviar la pregunta"
            className="u-focus inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink text-ink-fg hover:bg-ink-hover"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M8 12.6V3.4M4.4 7l3.6-3.6L11.6 7" />
            </svg>
          </button>
        </form>
        <p className="text-[0.6875rem] text-faint">Responde solo con lo dicho en esta reunión y cita el minuto.</p>
      </div>
    </aside>
  );
}
