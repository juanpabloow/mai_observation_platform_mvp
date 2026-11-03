"use client";

import { useEffect, useRef, useState } from "react";
import { FEATURED_REVIEWS, ratingText, relativeWhen, reviewCountText } from "@/lib/publicReviews";
import { IconClose, IconStar, SERIF, type PublicReview, type RatingSummary } from "./ui";

/**
 * Reviews WITHOUT leaving the booking: a bottom sheet on the phone, a centred dialog on
 * desktop (native <dialog> + showModal: focus trapped, page inert, Escape and a tap
 * outside close it). Nothing here changes the visitor's selection.
 *
 * It always says WHAT the reviews are about — the whole business, one artist or one
 * service — because those are different numbers and must never be read as each other.
 *
 * The list arrives in page order (arrangePublicReviews, web/lib/publicReviews.ts): the
 * featured reviews with a comment first, then the other commented ones behind «Ver más»,
 * then the star-only ones in compact rows. The bars show every approved review's stars.
 * Where a review came from is not shown to the public (product, 3 Nov 2026); it stays in
 * the platform's review screens.
 */

export interface ReviewsTarget {
  /** "de <negocio>" / "de <artista>" / "de <servicio>". */
  title: string;
  /** One line on what is counted ("Todas las reseñas de la sede"). */
  scope: string;
  rating: RatingSummary;
  reviews: PublicReview[];
}

/** The page-ordered list split as the page shows it. */
export function splitReviews(reviews: readonly PublicReview[]) {
  const commented = reviews.filter((r) => r.comment?.trim());
  return {
    featured: commented.slice(0, FEATURED_REVIEWS),
    more: commented.slice(FEATURED_REVIEWS),
    starOnly: reviews.filter((r) => !r.comment?.trim()),
  };
}

export function ReviewsDialog({ target, onClose, returnFocusTo }: { target: ReviewsTarget | null; onClose: () => void; returnFocusTo: HTMLElement | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [showMore, setShowMore] = useState<ReviewsTarget | null>(null);
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

  const parts = target ? splitReviews(target.reviews) : null;
  const expanded = Boolean(target && showMore === target);

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
      {target && parts ? (
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
              <span className="text-[12.5px] leading-[1.4] text-pb-muted">{target.scope}</span>
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
            <RatingBars rating={target.rating} />
            {parts.featured.length > 0 ? (
              <>
                <h3 className="m-0 mt-2 text-[12.5px] font-normal uppercase tracking-[0.08em] text-pb-muted">Con comentario</h3>
                {[...parts.featured, ...(expanded ? parts.more : [])].map((rv, i) => (
                  <ReviewArticle key={`${rv.submitted_at}-${i}`} review={rv} index={i} />
                ))}
                {parts.more.length > 0 && !expanded ? (
                  <button
                    type="button"
                    onClick={() => setShowMore(target)}
                    className="pb-press inline-flex min-h-11 items-center justify-center rounded-[12px] border border-pb-line3 bg-white px-4 text-[14.5px] text-pb-ink"
                  >
                    Ver {parts.more.length} más con comentario
                  </button>
                ) : null}
              </>
            ) : null}
            {parts.starOnly.length > 0 ? (
              <>
                <h3 className="m-0 mt-2 text-[12.5px] font-normal uppercase tracking-[0.08em] text-pb-muted">Solo calificación</h3>
                <ul className="m-0 flex list-none flex-col p-0">
                  {parts.starOnly.map((rv, i) => (
                    <li key={`${rv.submitted_at}-${i}`} className="flex items-center gap-2.5 border-t border-pb-hair py-2">
                      <Initials name={rv.author} />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-[590]">{rv.author}</span>
                      <span className="flex-none text-[12.5px] text-pb-muted">{relativeWhen(rv.submitted_at)}</span>
                      <Stars rating={rv.rating} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {target.reviews.length === 0 ? <p className="m-0 text-[14px] leading-[1.5] text-pb-muted">Las reseñas con comentario aparecerán aquí.</p> : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** One review with its comment: author, service · when, stars, text. */
export function ReviewArticle({ review: rv, index = 0, clamp = false }: { review: PublicReview; index?: number; clamp?: boolean }) {
  return (
    <article style={{ ["--i" as string]: index }} className="pb-rise flex flex-col gap-1.5 rounded-[16px] border border-pb-line bg-white p-3.5">
      <div className="flex items-center gap-2.5">
        <Initials name={rv.author} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-[590]">{rv.author}</span>
          <span className="text-[12.5px] leading-[1.35] text-pb-muted [overflow-wrap:anywhere]">{[rv.service, relativeWhen(rv.submitted_at)].filter(Boolean).join(" · ")}</span>
        </span>
        <Stars rating={rv.rating} />
      </div>
      {rv.comment ? (
        <p className={`m-0 whitespace-pre-line text-[14.5px] leading-[1.5] text-pb-body ${clamp ? "line-clamp-3" : ""}`}>{rv.comment}</p>
      ) : null}
    </article>
  );
}

/** "★★★★☆" with its accessible sentence. */
export function Stars({ rating, size = 13 }: { rating: number; size?: number }) {
  return (
    <span role="img" aria-label={`${rating} de 5 estrellas`} className="flex flex-none gap-px">
      {[1, 2, 3, 4, 5].map((k) => (
        <IconStar key={k} size={size} off={k > rating} />
      ))}
    </span>
  );
}

function Initials({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex size-8 flex-none items-center justify-center rounded-full bg-pb-sf2 text-[12px] font-semibold">
      {name
        .split(/\s+/)
        .map((w) => w.charAt(0))
        .join("")
        .slice(0, 2)}
    </span>
  );
}

/** How many reviews have each number of stars — every approved one, not only those shown. */
export function RatingBars({ rating }: { rating: RatingSummary }) {
  const dist = rating.dist;
  if (!dist || dist.length !== 5) return null;
  const max = Math.max(1, ...dist);
  return (
    <dl
      aria-label="Cuántas reseñas tiene cada calificación"
      className="m-0 grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 rounded-[12px] bg-pb-sf2 px-3.5 py-2.5 text-[12.5px] text-pb-tx2"
    >
      {dist.map((n, i) => (
        <div key={i} className="contents">
          <dt className="[font-variant-numeric:tabular-nums]">{5 - i} ★</dt>
          <dd className="m-0 h-1.5 overflow-hidden rounded-[3px] bg-pb-line" aria-hidden>
            <span className="block h-full rounded-[3px] bg-pb-ink" style={{ width: `${(n / max) * 100}%` }} />
          </dd>
          <dd className="m-0 min-w-5 text-right text-pb-muted [font-variant-numeric:tabular-nums]">
            <span className="sr-only">{5 - i === 1 ? "1 estrella" : `${5 - i} estrellas`}: </span>
            {n}
          </dd>
        </div>
      ))}
    </dl>
  );
}
