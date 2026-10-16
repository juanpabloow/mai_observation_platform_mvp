"use client";

import { useEffect, useRef } from "react";
import { originalDate, ratingText, relativeWhen, reviewCountText, reviewOrigin } from "@/lib/publicReviews";
import { IconClose, IconStar, SERIF, type PublicReview, type RatingSummary } from "./ui";

/**
 * Recent reviews WITHOUT leaving the booking: a bottom sheet on the phone, a centred
 * dialog on desktop (native <dialog> + showModal: focus trapped, page inert, Escape and a
 * tap outside close it). Nothing here changes the visitor's selection.
 *
 * It always says WHAT the reviews are about — the whole business, one artist or one
 * service — because those are different numbers and must never be read as each other.
 *
 * And WHERE they come from: a review collected here came from a completed appointment; an
 * imported one is labelled "Reseña importada de Fresha" with its original date (and a link
 * to Fresha when there is a safe one), and is never described as an M_AI appointment.
 * When an average mixes both, the scope line says how many were imported.
 */

export interface ReviewsTarget {
  /** "de <negocio>" / "de <artista>" / "de <servicio>". */
  title: string;
  /** One line on what is counted ("Todas las reseñas de la sede"). */
  scope: string;
  rating: RatingSummary;
  reviews: PublicReview[];
}

export function ReviewsDialog({ target, onClose, returnFocusTo }: { target: ReviewsTarget | null; onClose: () => void; returnFocusTo: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const open = Boolean(target);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      trigger.current = returnFocusTo;
      d.showModal();
      closeBtn.current?.focus();
    } else if (!open && d.open) {
      d.close();
      const t = trigger.current;
      trigger.current = null;
      t?.focus();
    }
  }, [open, returnFocusTo]);

  return (
    <dialog
      ref={ref}
      className="pb-dialog pb-sheet"
      aria-labelledby="pb-reviews-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {target ? (
        <>
          <div className="flex flex-none items-start gap-3 px-4 pb-2 pt-4">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 id="pb-reviews-title" className={`${SERIF} m-0 text-[25px] leading-[1.15] [overflow-wrap:anywhere]`}>
                Reseñas {target.title}
              </h2>
              <span className="flex items-center gap-1.5 text-[15px]">
                <IconStar size={16} />
                <span className="font-semibold [font-variant-numeric:tabular-nums]">{ratingText(target.rating.average)}</span>
                <span className="text-pb-muted">· {reviewCountText(target.rating.count)}</span>
              </span>
              <span className="text-[12.5px] leading-[1.4] text-pb-muted">
                {target.scope} {reviewOrigin(target.rating)}
                {target.reviews.length > 0 && target.reviews.length < target.rating.count ? ` Las ${target.reviews.length} más recientes.` : ""}
              </span>
            </div>
            <button
              ref={closeBtn}
              type="button"
              aria-label="Cerrar reseñas"
              onClick={onClose}
              className="pb-press flex size-11 flex-none items-center justify-center rounded-full border border-pb-line2 bg-white p-0 text-pb-ink"
            >
              <IconClose />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-2">
            {target.reviews.length === 0 ? (
              <p className="m-0 text-[14px] leading-[1.5] text-pb-muted">Las reseñas con comentario aparecerán aquí.</p>
            ) : (
              target.reviews.map((rv, i) => (
                <article
                  key={`${rv.submitted_at}-${i}`}
                  style={{ ["--i" as string]: i }}
                  className="pb-rise flex flex-col gap-1.5 rounded-[16px] border border-pb-line bg-white p-3.5"
                >
                  <div className="flex items-center gap-2.5">
                    <span aria-hidden className="flex size-8 flex-none items-center justify-center rounded-full bg-pb-sf2 text-[12px] font-semibold">
                      {rv.author
                        .split(/\s+/)
                        .map((w) => w.charAt(0))
                        .join("")
                        .slice(0, 2)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[14px] font-[590]">{rv.author}</span>
                      <span className="text-[12.5px] leading-[1.35] text-pb-muted [overflow-wrap:anywhere]">
                        {[rv.service, rv.source === "fresha" ? originalDate(rv.submitted_at) : relativeWhen(rv.submitted_at)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span aria-label={`${rv.rating} de 5 estrellas`} className="flex flex-none gap-px">
                      {Array.from({ length: rv.rating }, (_, k) => (
                        <IconStar key={k} />
                      ))}
                    </span>
                  </div>
                  {rv.comment ? <p className="m-0 whitespace-pre-line text-[14.5px] leading-[1.5] text-pb-body">{rv.comment}</p> : null}
                  {rv.source === "fresha" ? <ImportedBadge url={rv.source_url ?? null} /> : null}
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** The provenance line of an imported review (and its public Fresha link, if any). */
export function ImportedBadge({ url }: { url: string | null }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-pb-muted">
      <span className="rounded-full bg-pb-sf2 px-2 py-0.5 text-pb-tx2">Reseña importada de Fresha</span>
      {url ? (
        <a href={url} rel="noopener noreferrer nofollow" className="inline-flex min-h-11 items-center text-pb-ink underline underline-offset-[3px]">
          Ver en Fresha
          <span className="sr-only"> (sitio externo)</span>
        </a>
      ) : null}
    </span>
  );
}
