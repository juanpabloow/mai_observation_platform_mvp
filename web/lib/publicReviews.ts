import { checkPublicBio, publicProfileMessage, type PublicTextResult } from "./staffPublicProfile";

/**
 * REVIEWS — pure helpers shared by the review page, the booking page and the tests.
 * The decisions (product, 13 Oct 2026): a review comes ONLY from a completed appointment's
 * link, it is published only after the business approves it, and it shows the author as
 * first name + initial ("Andrés G.") — never a phone or an e-mail.
 */

export const REVIEW_COMMENT_MAX = 600;

/** "Andrés Gómez Ruiz" → "Andrés G."; "andrés" → "Andrés"; nothing usable → "Cliente". */
export function authorDisplay(fullName: string | null | undefined): string {
  const words = (fullName ?? "")
    .replace(/[^\p{L}\p{M}\s'-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "Cliente";
  const cap = (w: string) => w.charAt(0).toLocaleUpperCase("es") + w.slice(1).toLocaleLowerCase("es");
  const first = cap(words[0]).slice(0, 24);
  return words.length > 1 ? `${first} ${words[1].charAt(0).toLocaleUpperCase("es")}.` : first;
}

/** Same content rules as a public presentation: plain text, no links, e-mails or phones. */
export function checkReviewComment(raw: string | null | undefined): PublicTextResult {
  return checkPublicBio(raw);
}

/**
 * Where a review link stands — ONE rule for the page and the submit API:
 * answered (already submitted, whatever the business decided) → expired (past its date,
 * or the appointment is no longer completed) → open.
 */
export function reviewLinkState(
  review: { status: string; expires_at: Date | string; appointment_status: string },
  now: Date = new Date(),
): "open" | "answered" | "expired" {
  if (review.status !== "requested") return "answered";
  if (new Date(review.expires_at).getTime() <= now.getTime() || review.appointment_status !== "completed") return "expired";
  return "open";
}

/** Spanish copy for a refused comment (the same rules as a public presentation). */
export function reviewCommentMessage(result: PublicTextResult): string | null {
  return result.ok ? null : publicProfileMessage(result.error, "Comentario", result.max);
}

/** "4,9" — one decimal, Spanish comma. */
export function ratingText(average: number): string {
  return average.toFixed(1).replace(".", ",");
}

export function reviewCountText(count: number): string {
  return count === 1 ? "1 reseña" : `${count} reseñas`;
}

/** "hace 5 días", "hace 3 semanas", "hace 2 meses" — coarse on purpose. */
export function relativeWhen(iso: string, now: Date = new Date()): string {
  const days = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return "hoy";
  if (days === 1) return "ayer";
  if (days < 7) return `hace ${days} días`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? "hace 1 semana" : `hace ${w} semanas`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30);
    return m === 1 ? "hace 1 mes" : `hace ${m} meses`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? "hace 1 año" : `hace ${y} años`;
}
