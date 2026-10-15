import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { getPublicBrandLogo, listPublicCategories, listPublicServicesForSite } from "@worker/db/repositories/scheduling/publicCatalog.js";
import { publicServiceRatings, publicServiceReviews, publicSiteRating, publicSiteReviews } from "@worker/db/repositories/scheduling/reviews.js";
import { listPublicPromotions } from "@worker/db/repositories/scheduling/promotions.js";
import { projectPublicCategory, projectPublicPromotion, projectPublicReview, projectPublicService, projectPublicSite } from "@/lib/publicBookingApi";
import { publicClientConfig, readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { BookingFlow } from "@/components/booking/BookingFlow";

/**
 * PUBLIC booking page /book/{siteSlug}. No auth, no cookies. Resolves the site through
 * the central public gate (active site + non-default client + `scheduling` module
 * enabled) — an unknown slug, inactive site, default client, disabled module or the
 * PUBLIC_BOOKING_DISABLED kill switch all render the same 404. The catalogue is
 * pre-loaded here through the SAME minimal projection the public API returns, so the
 * first paint already lists services (no spinner on a slow in-app browser).
 *
 * The browser receives ONLY public values: the site's name/address/timezone/closed
 * weekdays/booking horizon, the services, the business logo URL and — from the policy —
 * the Turnstile SITE key and the privacy-policy URL. Never a tenant/client id, never a secret.
 *
 * Design: "Gallery Reserva v3" (white ground, near-black ink, Newsreader titles — the
 * font comes from ./layout.tsx). The look is scoped to `.pb3` (globals.css) so no other
 * module changes, and the page is light by design — there is no theme switch here.
 *
 * robots: noindex. These pages are reached from links the business shares (Instagram,
 * WhatsApp, its website); indexing them would only publish slugs — including ones
 * later deactivated — and invite crawling of the availability endpoints. Link previews
 * (Open Graph) still work.
 */
export const dynamic = "force-dynamic";

// Zoom is never blocked: no maximum-scale / user-scalable here. `resizes-content` lets
// Android Chrome shrink the layout above the keyboard, so the bottom bar stays on top of
// it (iOS ignores it; the flow follows visualViewport there).
export const viewport: Viewport = { width: "device-width", initialScale: 1, interactiveWidget: "resizes-content", themeColor: "#ffffff" };

const ROBOTS: Metadata["robots"] = { index: false, follow: false };

async function resolve(slug: string) {
  if (readPublicBookingPolicy().disabled) return null;
  return getPublicBookingSiteBySlug(slug);
}

export async function generateMetadata({ params }: { params: Promise<{ siteSlug: string }> }): Promise<Metadata> {
  const { siteSlug } = await params;
  const site = await resolve(siteSlug);
  if (!site) {
    // Same metadata for every unavailable reason — nothing to enumerate.
    return { title: "Reserva no disponible", robots: ROBOTS };
  }
  const title = `Reserva en ${site.name}`;
  const description = `Elige servicio, artista y horario, y confirma tu cita en ${site.name} en menos de un minuto. Sin crear cuenta.`;
  return {
    title,
    description,
    robots: ROBOTS,
    openGraph: { title, description, type: "website", locale: "es_CO", siteName: site.name },
    twitter: { card: "summary", title, description },
  };
}

export default async function PublicBookingPage({ params }: { params: Promise<{ siteSlug: string }> }) {
  const { siteSlug } = await params;
  const site = await resolve(siteSlug);
  if (!site) notFound();

  const [serviceRows, logoUrl, ratings, serviceReviews, categoryRows, siteRating, siteReviews, promotionRows] = await Promise.all([
    listPublicServicesForSite(site.tenant_id, site.id),
    getPublicBrandLogo(site.tenant_id, site.client_id),
    publicServiceRatings(site.tenant_id, site.id),
    publicServiceReviews(site.tenant_id, site.id),
    listPublicCategories(site.tenant_id, site.client_id),
    publicSiteRating(site.tenant_id, site.id),
    publicSiteReviews(site.tenant_id, site.id),
    listPublicPromotions(site.tenant_id, site.id, new Date()),
  ]);
  const services = serviceRows.map((s) => projectPublicService(s, ratings, serviceReviews));
  const publicSite = projectPublicSite(site);
  const config = publicClientConfig(readPublicBookingPolicy());

  return (
    <div lang="es" className="flex min-h-full flex-none flex-col">
      <BookingFlow
        slug={siteSlug}
        site={publicSite}
        logoUrl={logoUrl}
        initialServices={services}
        initialCategories={categoryRows.map(projectPublicCategory)}
        siteRating={siteRating}
        siteReviews={siteReviews.map(projectPublicReview)}
        promotions={promotionRows.map(projectPublicPromotion)}
        turnstileSiteKey={config.turnstileSiteKey}
        turnstileMisconfigured={config.turnstileMisconfigured}
        privacyPolicyUrl={config.privacyPolicyUrl}
      />
    </div>
  );
}
