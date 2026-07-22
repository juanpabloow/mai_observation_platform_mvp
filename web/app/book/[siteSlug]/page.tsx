import { notFound } from "next/navigation";
import { getActiveSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { BookingFlow } from "@/components/booking/BookingFlow";

/**
 * PUBLIC booking page /book/{siteSlug}. No auth. Resolves the site by its
 * globally-unique slug (active only) server-side; the BookingFlow client drives
 * the steps and calls the public /api/booking/{slug}/* endpoints, which use the
 * SAME availability + booking engine as the internal agenda and n8n API.
 */
export const dynamic = "force-dynamic";

export default async function PublicBookingPage({ params }: { params: Promise<{ siteSlug: string }> }) {
  const { siteSlug } = await params;
  const site = await getActiveSiteBySlug(siteSlug);
  if (!site) notFound();

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{site.name}</h1>
        {site.address ? <p className="text-sm text-muted">{site.address}</p> : null}
        <p className="text-xs text-faint">Times shown in {site.timezone}</p>
      </header>
      <BookingFlow slug={siteSlug} timezone={site.timezone} />
    </main>
  );
}
