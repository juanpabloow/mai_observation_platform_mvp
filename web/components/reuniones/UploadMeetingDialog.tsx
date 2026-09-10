"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CONTROL_CLS, TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";

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
  { key: "upload", label: "Subida del archivo", hint: "El audio se guarda en almacenamiento privado" },
  { key: "transcribe", label: "Transcripción", hint: "Convierte el audio en texto con timestamps" },
  { key: "diarize", label: "Separación de participantes", hint: "Detecta quién habla en cada momento" },
  { key: "analyze", label: "Análisis: resumen y tareas", hint: "Todavía no disponible" },
] as const;

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
              {/* Deshabilitado, no decorativo: un botón que abre un selector
                  para luego no subir nada es peor que uno que se declara
                  inactivo. */}
              <button type="button" disabled className={`${CONTROL_CLS} mt-1.5 h-8 text-[0.8125rem]`}>
                Seleccionar archivo
              </button>
            </div>

            {/* NADA de fichero en vuelo, nombre, contacto ni cita.
                Aquí había una subida ficticia al 62 % de `renovacion-delta.wav`
                con un contacto y una cita inventados: era la maqueta del diseño
                y se veía como una subida de verdad en curso. La subida desde el
                navegador no está implementada, así que el diálogo dice qué hace
                el procesamiento y por dónde entra hoy el audio, y no finge un
                estado que nadie provocó. */}
            <div className="flex flex-col gap-2.5">
              <span className="text-[0.75rem] text-muted">Fases del procesamiento</span>
              <ol className="flex flex-col gap-2.5">
                {PHASES.map((p) => {
                  // Ninguna está en curso: no hay subida. El anillo giratorio
                  // sobre una fase parada era parte de la ficción.
                  const running = false;
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
              {/* La regla 13 del diseño: esto es una ventana, nunca un «panel». */}
              La subida desde el navegador todavía no está disponible. Hoy el audio entra por la
              API de Reuniones y lo procesa el worker; cuando termine, la reunión aparece en este
              listado con su transcripción y sus hablantes.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
            <button type="button" onClick={dismiss} className={`${CONTROL_CLS} h-9`}>
              Cancelar
            </button>
            <span className="ml-auto flex items-center gap-2.5">
              <span id={`${titleId}-hint`} className="text-[0.71875rem] text-muted">
                Subida desde el navegador no disponible todavía
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
