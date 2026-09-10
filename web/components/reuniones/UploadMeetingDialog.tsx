"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CONTROL_CLS, TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";
import { ProgressBar } from "@/components/reuniones/MeetingBits";
import type { MediaLimits } from "@worker/meetings/mediaLimits.js";
import {
  IDLE,
  UploadError,
  acceptAttribute,
  describeLimits,
  newAttemptId,
  reusedMessage,
  titleFromFilename,
  uploadMeeting,
  type UploadState,
} from "@/lib/meetingsUpload";

/**
 * "Subir reunión" — a real centred MODAL, not a side panel.
 *
 * The spec was explicit about two things the sheet got wrong: it must be
 * centred over the untouched list (so an operator can still see what they
 * already have), and its reassurance copy must say WINDOW, not panel — "puedes
 * cerrar este panel" described a drawer that does not exist.
 *
 * DIALOG BEHAVIOUR is the point of this being a component and not markup:
 *   - `<dialog>` with `showModal()`, so the browser owns the top layer, the
 *     inert background and the Escape key rather than a hand-rolled trap;
 *   - focus moves to the close button on open and RETURNS to the trigger on
 *     close (a modal that drops focus to <body> loses a keyboard user);
 *   - a click on the backdrop closes, which `<dialog>` does not do by itself.
 *
 * THE PHASES LIST is not a progress bar. It names the four stages so a person
 * knows what "processing" will actually do, and only the running one carries the
 * accent; the rest are plainly pending. Upload progress is ACCENT (bytes moving)
 * and never the amber the analysis stages use.
 *
 * ── La subida es real ──────────────────────────────────────────────────────
 *
 * Todo el estado sale de `lib/meetingsUpload`, que ejecuta el flujo contra la
 * API que ya existía: crear la reunión → firmar el PUT → enviar a R2 con
 * progreso → confirmar → sondear el pipeline. Este componente no sabe de
 * checksums ni de firmas; pinta `UploadState` y ya.
 *
 * El progreso tiene DOS tramos que la gente confunde si no se nombran: primero
 * se calcula el SHA-256 del fichero (obligatorio, `upload-complete` lo exige) y
 * después se envían los bytes. Con un fichero grande el primero tarda, y una
 * barra que va al 100 % y vuelve al 0 % parece un error. Así que cada tramo
 * dice qué está haciendo.
 *
 * La fase de ANÁLISIS sigue diciendo que no está disponible, porque no lo está:
 * no hay etapa ni almacenamiento, igual que en las tres pestañas del detalle.
 */

const PHASE_ORDER = ["upload", "transcribe", "diarize", "analyze"] as const;
type PhaseKey = (typeof PHASE_ORDER)[number];

/** Qué fase está en curso, derivada del estado real. `null` = ninguna. */
function activePhase(state: UploadState): PhaseKey | null {
  switch (state.stage) {
    case "hashing":
    case "creating":
    case "signing":
    case "uploading":
    case "confirming":
      return "upload";
    case "processing":
      if (state.pipelineStage === "transcribe") return "transcribe";
      if (state.pipelineStage === "diarize") return "diarize";
      // `normalize` es parte de «preparar el audio», que para quien mira es la
      // misma fase que la subida: el fichero todavía no es texto.
      return "upload";
    default:
      return null;
  }
}

/** Las fases ya recorridas, para marcarlas hechas y no dejarlas grises. */
function donePhases(state: UploadState): Set<PhaseKey> {
  const done = new Set<PhaseKey>();
  if (state.stage === "processing" || state.stage === "ready") done.add("upload");
  if (state.stage === "processing" && (state.pipelineStage === "diarize")) done.add("transcribe");
  if (state.stage === "ready") {
    done.add("transcribe");
    done.add("diarize");
  }
  return done;
}

/** La línea de estado de la fase de subida, que es la que tiene dos tramos. */
function uploadHint(state: UploadState): string {
  switch (state.stage) {
    case "hashing":
      return `Verificando el fichero · ${state.percent ?? 0} %`;
    case "creating":
      return "Creando la reunión…";
    case "signing":
      return "Pidiendo permiso de subida…";
    case "uploading":
      return `Enviando a almacenamiento privado · ${state.percent ?? 0} %`;
    case "confirming":
      return "Confirmando la subida…";
    case "processing":
      return state.pipelineStage === "normalize" ? "Preparando el audio…" : "Audio guardado";
    case "ready":
      return "Audio guardado";
    default:
      return "El audio se guarda en almacenamiento privado";
  }
}

const PHASES: Record<PhaseKey, { label: string; idle: string }> = {
  upload: { label: "Subida del archivo", idle: "El audio se guarda en almacenamiento privado" },
  transcribe: { label: "Transcripción", idle: "Convierte el audio en texto con timestamps" },
  diarize: { label: "Separación de participantes", idle: "Detecta quién habla en cada momento" },
  // No está disponible y se dice, igual que en las tres pestañas del detalle.
  analyze: { label: "Análisis: resumen y tareas", idle: "Todavía no disponible" },
};

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Del 1 al 10, que es el `diarization_max_speakers` del worker. Ofrecer más sería
 * ofrecer algo que el worker recortaría, y la base guardaría entonces una intención
 * distinta de la que corrió.
 */
const SPEAKER_COUNT_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export function UploadMeetingButton({
  clientId,
  limits,
  /** `/clients/{id}/reuniones`, para abrir la reunión al terminar. */
  basePath,
}: {
  clientId: string;
  limits: MediaLimits;
  basePath: string;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<UploadState>(IDLE);
  /**
   * `null` es AUTOMÁTICO, y es el valor por defecto. No es 1: «no lo sé» y «habla
   * una sola persona» son respuestas distintas, y sólo la segunda es una afirmación.
   */
  const [speakerCount, setSpeakerCount] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * EL INTENTO. Se acuña al ABRIR el diálogo y al pulsar «subir otra», y va dentro de
   * la clave de idempotencia. Es lo que separa las dos cosas que antes chocaban:
   * reintentar (mismo intento → misma reunión) y pedir otra reunión con el mismo audio
   * (intento nuevo → reunión nueva). Un ref y no estado: cambiarlo no debe repintar,
   * y `start` necesita leer el valor vigente, no el de la última renderización.
   */
  const attemptRef = useRef<string>(newAttemptId());
  const titleId = useId();
  const router = useRouter();

  const busy = ["hashing", "creating", "signing", "uploading", "confirming", "processing"].includes(
    state.stage,
  );

  // showModal()/close() rather than an `open` attribute: only the former puts the
  // dialog in the top layer, makes the rest of the page inert and wires Escape.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      // Cada apertura es una acción explícita del usuario: intento nuevo.
      attemptRef.current = newAttemptId();
      el.showModal();
      closeRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const dismiss = useCallback(() => {
    // Cerrar aborta el SONDEO, no el procesamiento: el worker sigue con lo suyo
    // y la reunión aparecerá en el listado. Lo que se corta si la subida está a
    // medias es el PUT, que sí es de este navegador.
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    triggerRef.current?.focus();
    // Si hubo reunión, el listado tiene una fila nueva que refrescar.
    if (state.meetingId !== null) router.refresh();
  }, [router, state.meetingId]);

  const reset = () => {
    // «Subir otra» es tan explícito como abrir el diálogo, así que también acuña.
    attemptRef.current = newAttemptId();
    setFile(null);
    setTitle("");
    setState(IDLE);
    if (inputRef.current) inputRef.current.value = "";
  };

  const pick = (chosen: File | null) => {
    if (!chosen) return;
    setFile(chosen);
    setTitle((current) => (current.trim() === "" ? titleFromFilename(chosen.name) : current));
    setState(IDLE);
  };

  const start = async () => {
    if (!file) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await uploadMeeting({
        file,
        clientId,
        limits,
        title: title.trim() === "" ? titleFromFilename(file.name) : title.trim(),
        attemptId: attemptRef.current,
        speakerCount,
        onState: setState,
        signal: controller.signal,
      });
      router.refresh();
    } catch (error) {
      // `uploadMeeting` ya dejó el estado en "error" con su mensaje; aquí sólo
      // se evita que la promesa rechazada suba sin manejar.
      if (!(error instanceof UploadError)) throw error;
    } finally {
      abortRef.current = null;
    }
  };

  const openMeeting = () => {
    if (state.meetingId === null) return;
    const href = `${basePath}/${state.meetingId}`;
    setOpen(false);
    router.push(href);
  };

  const active = activePhase(state);
  const done = donePhases(state);
  const accept = acceptAttribute(limits);

  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)} className={TOOLBAR_PRIMARY_CLS}>
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M8 3.2v9.6M3.2 8h9.6" />
        </svg>
        Subir reunión
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        onCancel={(e) => {
          e.preventDefault();
          dismiss();
        }}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) dismiss();
        }}
        className="m-auto w-[min(41rem,calc(100vw-2rem))] max-h-[min(46rem,calc(100vh-4rem))] rounded-2xl border border-line bg-surface p-0 text-foreground shadow-[var(--shadow-float)] backdrop:bg-[rgba(16,20,28,0.45)]"
      >
        <div className="flex max-h-[inherit] flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <h2 id={titleId} className="text-[0.9375rem] font-semibold tracking-[-0.01em]">
              Subir reunión
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={dismiss}
              aria-label="Cerrar esta ventana"
              className="u-focus ml-auto inline-flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-subtle hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            {/* El input real, oculto: la zona de arrastre y el botón lo abren. */}
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />

            {file === null ? (
              <div
                role="group"
                aria-label="Zona para arrastrar el archivo"
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pick(e.dataTransfer.files?.[0] ?? null);
                }}
                className={`flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-4 py-5 text-center transition-colors ${
                  dragging ? "border-accent bg-chip" : "border-line-strong bg-subtle"
                }`}
              >
                <span aria-hidden className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-chip text-muted">
                  <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 10.6V3.2M8 3.2L5.4 5.8M8 3.2l2.6 2.6M2.8 11.4v1.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.4" />
                  </svg>
                </span>
                <p className="text-[0.8125rem] text-foreground">Arrastra el audio o video aquí</p>
                {/* Los formatos y el tope salen de los límites EFECTIVOS del
                    servidor, no de un texto fijo: decía «hasta 4 GB» cuando el
                    máximo real son 2 GiB, y omitía FLAC, OGG y WEBM. */}
                <p className="text-[0.71875rem] text-muted">{describeLimits(limits)}</p>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className={`${CONTROL_CLS} mt-1.5 h-8 text-[0.8125rem]`}
                >
                  Seleccionar archivo
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-line px-3 py-3">
                <div className="flex items-center gap-2.5">
                  <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-chip text-muted">
                    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2 8h1.6M5.2 5v6M8 3v10M10.8 6v4M13.6 8H14" />
                    </svg>
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate text-[0.8125rem] font-medium">{file.name}</span>
                    <span className="text-[0.71875rem] text-muted u-mono">
                      {bytesLabel(file.size)}
                      {file.type ? ` · ${file.type}` : ""}
                    </span>
                  </span>
                  {state.stage === "hashing" || state.stage === "uploading" ? (
                    <span className="shrink-0 text-[0.75rem] text-muted u-mono">{state.percent ?? 0} %</span>
                  ) : null}
                  {!busy ? (
                    <button
                      type="button"
                      onClick={reset}
                      aria-label="Quitar el archivo"
                      className="u-focus shrink-0 rounded p-0.5 text-faint transition-colors hover:text-foreground"
                    >
                      <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                {state.stage === "hashing" || state.stage === "uploading" ? (
                  <ProgressBar
                    kind="upload"
                    value={state.percent ?? 0}
                    label={state.stage === "hashing" ? "Verificación del fichero" : "Progreso de la subida"}
                  />
                ) : null}
              </div>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] text-muted">Nombre de la reunión</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy}
                placeholder={file ? titleFromFilename(file.name) : "Se toma del nombre del fichero"}
                maxLength={500}
                className="u-focus rounded-xl border border-line-strong bg-surface px-3 py-2 text-[0.8125rem] text-foreground outline-none disabled:text-muted"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] text-muted">¿Cuántas personas hablan?</span>
              <select
                value={speakerCount === null ? "auto" : String(speakerCount)}
                onChange={(e) =>
                  setSpeakerCount(e.target.value === "auto" ? null : Number(e.target.value))
                }
                disabled={busy}
                className="u-focus rounded-xl border border-line-strong bg-surface px-3 py-2 text-[0.8125rem] text-foreground outline-none disabled:text-muted"
              >
                <option value="auto">Automático</option>
                {SPEAKER_COUNT_CHOICES.map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? "1 persona" : `${n} personas`}
                  </option>
                ))}
              </select>
              <span className="text-[0.6875rem] text-muted">
                Déjalo en automático si no estás seguro. Decirlo ayuda cuando alguien
                habla muy poco y el detector no llega a separarlo.
              </span>
            </label>

            <div className="flex flex-col gap-2.5">
              <span className="text-[0.75rem] text-muted">Fases del procesamiento</span>
              <ol className="flex flex-col gap-2.5">
                {PHASE_ORDER.map((key) => {
                  const running = active === key;
                  const complete = done.has(key);
                  const hint =
                    key === "upload" && (running || complete) ? uploadHint(state) : PHASES[key].idle;
                  return (
                    <li key={key} className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 rounded-full border-2 ${
                          running
                            ? "animate-spin border-line border-t-accent"
                            : complete
                              ? "border-accent bg-accent"
                              : "border-line"
                        }`}
                      />
                      <span className="flex flex-col gap-px">
                        <span
                          className={`text-[0.8125rem] ${
                            running || complete ? "font-medium text-foreground" : "text-muted"
                          }`}
                        >
                          {PHASES[key].label}
                        </span>
                        <span className={`text-[0.71875rem] ${running ? "text-accent" : "text-faint"}`}>
                          {hint}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            {state.stage === "error" ? (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-warn-rule bg-warn-soft px-3 py-2.5 text-[0.75rem] leading-relaxed text-foreground"
              >
                <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                  <path d="M8 2.6l5.4 9.4H2.6L8 2.6zM8 6.4v2.8M8 10.8h.01" />
                </svg>
                <span className="flex flex-col gap-1">
                  <span>{state.message}</span>
                  {state.code ? (
                    <span className="text-[0.6875rem] text-muted u-mono">código: {state.code}</span>
                  ) : null}
                </span>
              </p>
            ) : state.reused && state.stage !== "idle" ? (
              <p className="flex items-start gap-2 rounded-xl bg-subtle px-3 py-2.5 text-[0.75rem] leading-relaxed text-muted">
                <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                  <circle cx="8" cy="8" r="5.8" />
                  <path d="M8 5.4h.01M8 7.6v3" />
                </svg>
                {reusedMessage(state.reusedMediaState)}
              </p>
            ) : (
              <p className="flex items-start gap-2 rounded-xl bg-subtle px-3 py-2.5 text-[0.75rem] leading-relaxed text-muted">
                <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                  <circle cx="8" cy="8" r="5.8" />
                  <path d="M8 5.4h.01M8 7.6v3" />
                </svg>
                {/* La regla 13 del diseño: esto es una ventana, nunca un «panel». */}
                Puedes cerrar esta ventana y seguir trabajando. El procesamiento continúa y la reunión
                aparecerá en el listado con su transcripción y sus hablantes.
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
            <button type="button" onClick={dismiss} className={`${CONTROL_CLS} h-9`}>
              {busy ? "Cerrar" : "Cancelar"}
            </button>
            <span className="ml-auto flex items-center gap-2.5">
              <span id={`${titleId}-hint`} className="text-[0.71875rem] text-muted">
                {state.stage === "ready"
                  ? "Transcripción lista"
                  : state.stage === "error" && state.retryable
                    ? "Puedes reintentar con el mismo fichero"
                    : busy
                      ? "No cierres la pestaña hasta que termine la subida"
                      : file === null
                        ? "Elige un archivo para empezar"
                        : ""}
              </span>
              {state.stage === "ready" ? (
                <button type="button" onClick={openMeeting} className={`${TOOLBAR_PRIMARY_CLS} h-9`}>
                  Abrir la transcripción
                </button>
              ) : state.stage === "error" ? (
                <button
                  type="button"
                  onClick={start}
                  disabled={!state.retryable || file === null}
                  aria-describedby={`${titleId}-hint`}
                  className={`${TOOLBAR_PRIMARY_CLS} h-9`}
                >
                  Reintentar
                </button>
              ) : (
                <button
                  type="button"
                  onClick={start}
                  disabled={file === null || busy}
                  aria-describedby={`${titleId}-hint`}
                  className={`${TOOLBAR_PRIMARY_CLS} h-9`}
                >
                  {busy ? "Procesando…" : "Procesar reunión"}
                </button>
              )}
            </span>
          </div>
        </div>
      </dialog>
    </>
  );
}
