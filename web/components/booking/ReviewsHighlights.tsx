"use client";

import { ratingText, reviewCountText } from "@/lib/publicReviews";
import { RatingBars, ReviewArticle, splitReviews, Stars } from "./ReviewsDialog";
import { SERIF, type PublicReview, type RatingSummary } from "./ui";

/**
 * «Lo que dicen» — a few of the BUSINESS's reviews in view on step 1, so a visitor who is
 * still deciding sees them without opening anything. Phone: a horizontal strip of quotes
 * after the services, before "Ubicación y horario" (the services stay first: that is what
 * people come for). Laptop: a compact card in the side column, under "Tu selección" — the
 * average and the bars, no quotes (the dialog has them).
 *
 * The reviews are the site's, in page order (arrangePublicReviews): only ones with a
 * comment are quoted; «Ver las N» opens the full business reviews.
 * Nothing renders without a rating; the strip needs at least one comment.
 */
export function ReviewsHighlights({
  rating,
  reviews,
  onOpen,
  variant,
}: {
  rating: RatingSummary | null;
  reviews: PublicReview[];
  onOpen: (trigger: HTMLElement) => void;
  variant: "strip" | "card";
}) {
  if (!rating) return null;
  const all = `Ver las ${rating.count}`;

  if (variant === "strip") {
    const { featured } = splitReviews(reviews);
    if (featured.length === 0) return null;
    return (
      <section aria-labelledby="pb-said-strip" className="flex flex-col gap-2.5 lg:hidden">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="pb-said-strip" className={`${SERIF} m-0 text-[23px] leading-tight`}>
            Lo que dicen
          </h2>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={(e) => onOpen(e.currentTarget)}
            className="inline-flex min-h-11 items-center rounded-[12px] px-2 text-[14px] text-pb-ink underline underline-offset-[3px]"
          >
            {all}
            <span className="sr-only"> reseñas de este negocio</span>
          </button>
        </div>
        <ul className="-mx-4 my-0 flex list-none snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {featured.slice(0, 4).map((rv, i) => (
            <li key={`${rv.submitted_at}-${i}`} className="flex w-[272px] flex-none snap-start [&>article]:flex-1">
              <ReviewArticle review={rv} index={i} clamp />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section aria-labelledby="pb-said-card" className="flex flex-col gap-3 rounded-[16px] border border-pb-line bg-white p-5">
      <h2 id="pb-said-card" className={`${SERIF} m-0 text-[23px]`}>
        Lo que dicen
      </h2>
      <div className="flex items-center gap-3">
        <span className={`${SERIF} text-[40px] leading-none [font-variant-numeric:tabular-nums]`}>{ratingText(rating.average)}</span>
        <span className="flex flex-col gap-0.5">
          <Stars rating={Math.round(rating.average)} size={14} />
          <span className="text-[13px] text-pb-muted">{reviewCountText(rating.count)}</span>
        </span>
      </div>
      <RatingBars rating={rating} />
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={(e) => onOpen(e.currentTarget)}
        className="pb-press inline-flex min-h-11 items-center justify-center rounded-[12px] border border-pb-line3 bg-white px-4 text-[14.5px] text-pb-ink"
      >
        {all} reseñas
      </button>
    </section>
  );
}
