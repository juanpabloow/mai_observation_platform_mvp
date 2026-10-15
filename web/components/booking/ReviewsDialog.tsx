"use client";

import { useEffect, useRef } from "react";
import { ratingText, relativeWhen, reviewCountText } from "@/lib/publicReviews";
import { IconClose, IconStar, SERIF, type PublicReview, type RatingSummary } from "./ui";

/**
 * Recent reviews WITHOUT leaving the booking: a bottom sheet on the phone, a centred
 * dialog on desktop (native <dialog> + showModal: focus trapped, page inert, Escape and a
 * tap outside close it). Nothing here changes the visitor's selection.
 *
 * It always says WHAT the reviews are about — the whole business, one artist or one
 * service — because those are different numbers and must never be read as each other.
 * Every review shown comes from a completed appointment and was approved by the business.
 */

export interface ReviewsTarget {
  /** "de <negocio>" / "de <artista>" / "de <servicio>". */
  title: string;
  /** One line on what is counted ("Todas las citas de la sede"). */
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
                {target.scope} De clientes con una cita completada; publicadas por el negocio.
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
                      <span className="truncate text-[12.5px] text-pb-muted">
                        {rv.service} · {relativeWhen(rv.submitted_at)}
                      </span>
                    </span>
                    <span aria-label={`${rv.rating} de 5 estrellas`} className="flex flex-none gap-px">
                      {Array.from({ length: rv.rating }, (_, k) => (
                        <IconStar key={k} />
                      ))}
                    </span>
                  </div>
                  {rv.comment ? <p className="m-0 whitespace-pre-line text-[14.5px] leading-[1.5] text-pb-body">{rv.comment}</p> : null}
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}
