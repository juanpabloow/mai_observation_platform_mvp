import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { getPublicBrandLogo, listPublicServicesForSite } from "@worker/db/repositories/scheduling/publicCatalog.js";
import { projectPublicService, projectPublicSite } from "@/lib/publicBookingApi";
import { publicClientConfig, readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { initialsOf } from "@/lib/staffTone";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { BookingThemeSwitch } from "@/components/booking/BookingThemeSwitch";

/**
 * PUBLIC booking page /book/{siteSlug}. No auth, no cookies. Resolves the site through
 * the central public gate (active site + non-default client + `scheduling` module
 * enabled) — an unknown slug, inactive site, default client, disabled module or the
 * PUBLIC_BOOKING_DISABLED kill switch all render the same 404. The catalogue is
 * pre-loaded here through the SAME minimal projection the public API returns, so the
 * first paint already lists services (no spinner on a slow in-app browser).
 *
 * The browser receives ONLY public values: the site's name/address/timezone/closed
 * weekdays, the services, and — from the policy — the Turnstile SITE key and the
 * privacy-policy URL. Never a tenant/client id, never a secret.
 *
 * robots: noindex. These pages are reached from links the business shares (Instagram,
 * WhatsApp, its website); indexing them would only publish slugs — including ones
 * later deactivated — and invite crawling of the availability endpoints. Link previews
 * (Open Graph) still work.
 */
export const dynamic = "force-dynamic";

// Zoom is never blocked: no maximum-scale / user-scalable here.
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

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
  const description = `Elige servicio, profesional y horario, y confirma tu cita en ${site.name} en menos de un minuto. Sin crear cuenta.`;
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

  const [serviceRows, logoUrl] = await Promise.all([
    listPublicServicesForSite(site.tenant_id, site.id),
    getPublicBrandLogo(site.tenant_id, site.client_id),
  ]);
  const services = serviceRows.map(projectPublicService);
  const publicSite = projectPublicSite(site);
  const config = publicClientConfig(readPublicBookingPolicy());

  return (
    <main lang="es" className="mx-auto flex w-full max-w-[1080px] flex-1 flex-col gap-3.5 sm:gap-5 sm:px-0 sm:py-6">
      {/* The business first: its logo (or a monogram), its name, one warm line. */}
      <header className="flex items-center gap-3.5 sm:px-1">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded logo (R2)
          <img src={logoUrl} alt="" className="size-12 shrink-0 rounded-xl border border-line bg-surface object-cover" />
        ) : (
          <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-ink text-base font-semibold text-ink-fg">
            {initialsOf(site.name)}
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">{site.name}</h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
            {site.address ? (
              <span className="inline-flex items-center gap-[5px]">
                <svg viewBox="0 0 16 16" className="size-[13px]" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8Z" />
                  <circle cx="8" cy="6" r="1.7" />
                </svg>
                {site.address}
              </span>
            ) : null}
            <span>Reserva en menos de un minuto · sin crear cuenta</span>
          </p>
        </div>
        <BookingThemeSwitch />
      </header>
      <BookingFlow
        slug={siteSlug}
        site={publicSite}
        initialServices={services}
        turnstileSiteKey={config.turnstileSiteKey}
        turnstileMisconfigured={config.turnstileMisconfigured}
        privacyPolicyUrl={config.privacyPolicyUrl}
      />
    </main>
  );
}
