"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CONTROL_CLS, TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";
import { ProgressBar } from "@/components/reuniones/MeetingBits";

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
 */

const PHASES = [
  { key: "upload", label: "Subida del archivo", hint: "En curso · 62 % · queda ~1 min" },
  { key: "transcribe", label: "Transcripción", hint: "Convierte el audio en texto con timestamps" },
  { key: "diarize", label: "Separación de participantes", hint: "Detecta quién habla en cada momento" },
  { key: "analyze", label: "Análisis: resumen y tareas", hint: "Cada conclusión queda ligada a su cita" },
] as const;

/** The demo file the design sheet shows mid-upload. */
const UPLOAD_PERCENT = 62;

export function UploadMeetingButton() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // showModal()/close() rather than an `open` attribute: only the former puts the
  // dialog in the top layer, makes the rest of the page inert and wires Escape.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      closeRef.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  const dismiss = () => {
    setOpen(false);
    // Return focus to what opened it.
    triggerRef.current?.focus();
  };

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
        // Escape fires `cancel`; route it through dismiss so focus returns too.
        onCancel={(e) => {
          e.preventDefault();
          dismiss();
        }}
        onClose={() => setOpen(false)}
        // A backdrop click is a click on the <dialog> itself (its children sit in
        // the inner box), which is how this distinguishes the two.
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

          {/* Only the BODY scrolls; the header and the footer stay put, so the
              actions never scroll out of reach on a short viewport. */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
            <div
              role="group"
              aria-label="Zona para arrastrar el archivo"
              className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-subtle px-4 py-5 text-center"
            >
              <span aria-hidden className="mb-1 inline-flex size-9 items-center justify-center rounded-lg bg-chip text-muted">
                <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 10.6V3.2M8 3.2L5.4 5.8M8 3.2l2.6 2.6M2.8 11.4v1.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.4" />
                </svg>
              </span>
              <p className="text-[0.8125rem] text-foreground">Arrastra el audio o video aquí</p>
              <p className="text-[0.71875rem] text-muted">MP3, M4A, WAV, MP4 · hasta 4 GB</p>
              <button type="button" className={`${CONTROL_CLS} mt-1.5 h-8 text-[0.8125rem]`}>
                Seleccionar archivo
              </button>
            </div>

            {/* The file in flight. Accent bar = bytes moving. */}
            <div className="flex flex-col gap-2 rounded-xl border border-line px-3 py-3">
              <div className="flex items-center gap-2.5">
                <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-chip text-muted">
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M2 8h1.6M5.2 5v6M8 3v10M10.8 6v4M13.6 8H14" />
                  </svg>
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[0.8125rem] font-medium">renovacion-delta.wav</span>
                  <span className="text-[0.71875rem] text-muted u-mono">121 MB · WAV 48 kHz · 1,2 MB/s</span>
                </span>
                <span className="shrink-0 text-[0.75rem] text-muted u-mono">{UPLOAD_PERCENT} %</span>
                <button
                  type="button"
                  aria-label="Quitar el archivo"
                  className="u-focus shrink-0 rounded p-0.5 text-faint transition-colors hover:text-foreground"
                >
                  <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
              <ProgressBar kind="upload" value={UPLOAD_PERCENT} label="Progreso de la subida" />
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[0.75rem] text-muted">Nombre de la reunión</span>
              <input
                defaultValue="Renovación anual — Delta Foods"
                className="u-focus rounded-xl border border-line-strong bg-surface px-3 py-2 text-[0.8125rem] text-foreground outline-none"
              />
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-[0.75rem] text-muted">Asociaciones</legend>
              <div className="flex flex-wrap gap-1.5">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft bg-subtle py-1 pl-1 pr-2 text-[0.78125rem]">
                  <span aria-hidden className="inline-flex size-5 items-center justify-center rounded-full bg-gradient-to-br from-[#2E9C7F] to-[#1F7A4D] text-[0.5rem] font-semibold text-white u-mono">
                    JC
                  </span>
                  Julián Cifuentes
                  <button type="button" aria-label="Quitar a Julián Cifuentes" className="u-focus rounded text-faint hover:text-foreground">
                    <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </span>
                <button
                  type="button"
                  className="u-focus inline-flex items-center gap-1 rounded-lg border border-dashed border-line-strong px-2.5 py-1 text-[0.78125rem] text-muted transition-colors hover:border-faint hover:text-foreground"
                >
                  + Contacto
                </button>
              </div>
              <button type="button" className="u-focus flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-left transition-colors hover:border-faint">
                <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <rect x="2" y="3" width="12" height="9" />
                  <path d="M5 12v2" />
                </svg>
                <span className="flex-1 text-[0.78125rem]">Conversación de Inbox</span>
                <span className="text-[0.75rem] text-muted">Ninguna ▾</span>
              </button>
              <button type="button" className="u-focus flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-left transition-colors hover:border-faint">
                <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <rect x="2.5" y="3.5" width="11" height="10" />
                  <path d="M2.5 6.6h11" />
                </svg>
                <span className="flex-1 text-[0.78125rem]">Cita de Agenda</span>
                <span className="text-[0.75rem] text-foreground">1 sep, 09:45 ▾</span>
              </button>
            </fieldset>

            <div className="flex flex-col gap-2.5">
              <span className="text-[0.75rem] text-muted">Fases del procesamiento</span>
              <ol className="flex flex-col gap-2.5">
                {PHASES.map((p, i) => {
                  const running = i === 0;
                  return (
                    <li key={p.key} className="flex items-start gap-2.5">
                      <span
                        aria-hidden
                        className={`mt-0.5 size-4 shrink-0 rounded-full border-2 ${
                          running ? "animate-spin border-line border-t-accent" : "border-line"
                        }`}
                      />
                      <span className="flex flex-col gap-px">
                        <span className={`text-[0.8125rem] ${running ? "font-medium text-foreground" : "text-muted"}`}>{p.label}</span>
                        <span className={`text-[0.71875rem] ${running ? "text-accent" : "text-faint"}`}>{p.hint}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>

            <p className="flex items-start gap-2 rounded-xl bg-subtle px-3 py-2.5 text-[0.75rem] leading-relaxed text-muted">
              <svg viewBox="0 0 16 16" className="mt-0.5 size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
                <circle cx="8" cy="8" r="5.8" />
                <path d="M8 5.4h.01M8 7.6v3" />
              </svg>
              {/* The spec's rule 13: this is a window, never a "panel". */}
              Puedes cerrar esta ventana y seguir trabajando. El procesamiento continúa y te avisamos cuando la reunión esté lista.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
            <button type="button" onClick={dismiss} className={`${CONTROL_CLS} h-9`}>
              Cancelar
            </button>
            <span className="ml-auto flex items-center gap-2.5">
              <span id={`${titleId}-hint`} className="text-[0.71875rem] text-muted">
                Se habilita cuando termine la subida ({UPLOAD_PERCENT} %)
              </span>
              <button type="button" disabled aria-describedby={`${titleId}-hint`} className={`${TOOLBAR_PRIMARY_CLS} h-9`}>
                Procesar reunión
              </button>
            </span>
          </div>
        </div>
      </dialog>
    </>
  );
}
