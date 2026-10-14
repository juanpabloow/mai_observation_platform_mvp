import { z } from "zod";
import { checkRateLimit, clientIp } from "@/lib/schedulingApi";
import { publicError, publicInvalid, publicJson, publicNotFound, publicRateLimited } from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { authorDisplay, checkReviewComment, reviewCommentMessage, reviewLinkState } from "@/lib/publicReviews";
import { reviewLinkSecret, verifyReviewToken } from "@/lib/reviewLink";
import { getReviewForLink, submitReview } from "@worker/db/repositories/scheduling/reviews.js";
import { logger } from "@worker/logger.js";

/**
 * POST /api/resena/{token} — the customer's review of a COMPLETED appointment. PUBLIC
 * (no session, no cookies); the signed token in the path is the only credential.
 *
 * Order, each step before the next costs anything:
 *   1. per-process burst limiter;
 *   2. kill switch PUBLIC_BOOKING_DISABLED and a configured link secret;
 *   3. token signature (HMAC) — a forged or edited link is the generic 404;
 *   4. the public gate (active site, non-default client, scheduling enabled) via
 *      getReviewForLink — same 404;
 *   5. strict body: rating 1–5, optional plain-text comment, consent = true;
 *   6. ONE atomic submit (requested → pending): a double click or a replayed link
 *      changes nothing and gets 409.
 * The review is NOT published here — it waits for the business's approval. The author is
 * derived from the contact's name ("Andrés G."), never typed and never a phone/e-mail.
 * Logs carry no name, comment or token.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(2000).nullish(),
    publish_consent: z.literal(true),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const ip = clientIp(req);
  if (!checkRateLimit(`review-write:${ip}`, 10, 60_000)) return publicRateLimited(60);

  if (readPublicBookingPolicy().disabled) return publicNotFound();
  const secret = reviewLinkSecret();
  if (!secret) return publicError(503, "unavailable", "Las reseñas no están disponibles en este momento. Inténtalo más tarde.");

  const { token } = await params;
  const reviewId = verifyReviewToken(token, secret);
  if (!reviewId) return publicNotFound();
  const review = await getReviewForLink(reviewId);
  if (!review) return publicNotFound();
  const state = reviewLinkState(review);
  if (state === "answered") return publicError(409, "already_submitted", "Ya recibimos tu reseña. ¡Gracias!");
  if (state === "expired") return publicError(410, "expired", "Este enlace ya no está disponible.");

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return publicInvalid();
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return publicInvalid(
      field === "rating"
        ? "Elige de 1 a 5 estrellas."
        : field === "publish_consent"
          ? "Debes aceptar que publiquemos tu reseña."
          : "Revisa tu reseña e inténtalo de nuevo.",
    );
  }
  const comment = checkReviewComment(parsed.data.comment);
  if (!comment.ok) return publicInvalid(reviewCommentMessage(comment) ?? undefined);

  const saved = await submitReview({
    reviewId,
    rating: parsed.data.rating,
    comment: comment.value,
    authorDisplay: authorDisplay(review.contact_name),
  });
  if (!saved) return publicError(409, "already_submitted", "Ya recibimos tu reseña. ¡Gracias!");
  logger.info({ rating: parsed.data.rating, withComment: comment.value !== null }, "public review: submitted");
  return publicJson({ ok: true }, 201);
}
