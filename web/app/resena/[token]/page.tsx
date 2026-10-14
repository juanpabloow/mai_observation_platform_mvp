import type { Metadata, Viewport } from "next";
import { getReviewForLink } from "@worker/db/repositories/scheduling/reviews.js";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { authorDisplay, reviewLinkState } from "@/lib/publicReviews";
import { reviewLinkSecret, verifyReviewToken } from "@/lib/reviewLink";
import { longDate } from "@/lib/siteCalendar";
import { ReviewForm } from "@/components/booking/ReviewForm";

/**
 * PUBLIC review page /resena/{token} — the link a business (agenda "Enlace de reseña")
 * or n8n sends after a COMPLETED appointment. No auth, no cookies; the signed token is
 * the only credential (web/lib/reviewLink.ts).
 *
 * A forged token, an unknown review, a disabled site/module/client and the kill switch
 * all render the SAME "not available" card. The page shows only what the customer
 * already knows: the business, the service, the professional and the day — never a
 * phone, an e-mail or an id. The author line is computed here exactly as the API will
 * store it ("Andrés G.").
 */
export const dynamic = "force-dynamic";

export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content", themeColor: "#f4f5f7" };

export const metadata: Metadata = { title: "Tu reseña", robots: { index: false, follow: false } };

const SHELL = "pb3 -m-[var(--content-pad)] flex min-h-[calc(100%_+_var(--content-pad)_*_2)] flex-none flex-col px-4 py-8 lg:py-14";

async function resolve(token: string) {
  if (readPublicBookingPolicy().disabled) return null;
  const secret = reviewLinkSecret();
  if (!secret) return null;
  const id = verifyReviewToken(token, secret);
  return id ? getReviewForLink(id) : null;
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main lang="es" className={SHELL}>
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2">
        <h1 className="m-0 font-pb-serif text-[32px] font-normal leading-[1.08]">{title}</h1>
        <p className="m-0 text-[15.5px] leading-[1.5] text-pb-muted">{body}</p>
      </div>
    </main>
  );
}

export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const review = await resolve(token);
  if (!review) return <Message title="Este enlace no está disponible" body="Revisa el enlace o comunícate directamente con el negocio." />;
  const state = reviewLinkState(review);
  if (state === "answered") {
    return <Message title="¡Gracias por tu reseña!" body={`Ya la recibimos. ${review.site_name} la revisará antes de publicarla.`} />;
  }
  if (state === "expired") {
    return <Message title="Este enlace venció" body={`Si quieres dejar tu opinión, pídele un enlace nuevo a ${review.site_name}.`} />;
  }

  return (
    <main lang="es" className={SHELL}>
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex min-h-11 items-center gap-2.5">
          {review.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded logo (R2)
            <img src={review.logo_url} alt="" className="size-11 flex-none rounded-full border border-pb-line object-cover" />
          ) : null}
          <div className="flex min-w-0 flex-col gap-px">
            <span className="truncate font-pb-serif text-[19px] font-normal leading-[1.1]">{review.site_name}</span>
            {review.site_address ? <span className="truncate text-[12.5px] text-pb-muted">{review.site_address}</span> : null}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 font-pb-serif text-[32px] font-normal leading-[1.08] tracking-[-0.01em]">¿Cómo te fue?</h1>
          <p className="m-0 text-[15px] leading-[1.45] text-pb-muted">
            {review.service_name}
            {review.staff_name ? ` con ${review.staff_name}` : ""} · {longDate(review.start_at.toISOString(), review.timezone)}
          </p>
        </div>
        <ReviewForm token={token} siteName={review.site_name} staffName={review.staff_name} author={authorDisplay(review.contact_name)} />
        <p className="m-0 text-center text-[12.5px] text-pb-muted">Impulsado por M_AI</p>
      </div>
    </main>
  );
}
