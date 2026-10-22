import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listReviewsForModeration } from "@worker/db/repositories/scheduling/reviews.js";
import { listExternalReviewsForClient } from "@worker/db/repositories/scheduling/externalReviews.js";
import { requirePlatformAdmin } from "@/lib/platformAdmin";
import { ReviewsScreen, type OwnReview } from "@/components/scheduling/reviews/ReviewsScreen";

/**
 * REVIEWS — what customers said after a completed appointment, and what the booking page
 * may show. Nothing reaches /book/{slug} until it is approved here.
 *
 * Gating, like the sibling Staff and Configuración pages: requireClientModulePage (URL
 * client validated against the session's tenant + scope, non-default, scheduling ON) and
 * canManageClient (the client's owner or the agency) — anyone else gets the 404.
 *
 * `canImport` is the PLATFORM administrator check (env allow-list, lib/platformAdmin) —
 * never a tenant or client role. It only decides whether the link to the existing
 * importer (/platform/reviews) is drawn; that page and its actions re-check it.
 */
export default async function ClientReviewsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling", "reviews.moderate");

  const [rows, external, platform] = await Promise.all([
    listReviewsForModeration(scope.tenantId, client.id),
    listExternalReviewsForClient(scope.tenantId, client.id),
    requirePlatformAdmin(),
  ]);
  const items: OwnReview[] = rows.map((r) => ({
    id: r.id,
    status: r.status === "approved" ? "approved" : r.status === "hidden" ? "hidden" : "pending",
    rating: r.rating,
    comment: r.comment,
    author: r.author_display,
    service: r.service_name ?? "",
    staff: r.staff_name,
    site: r.site_name,
    timezone: r.timezone,
    appointmentAt: new Date(r.start_at).toISOString(),
    submittedAt: new Date(r.submitted_at).toISOString(),
  }));
  return (
    <ReviewsScreen
      clientId={client.id}
      own={items}
      canImport={platform !== null}
      imported={external.map((x) => ({
        id: x.id,
        status: x.status,
        provenance: x.provenance_status,
        rating: x.rating,
        comment: x.comment,
        author: x.author_display,
        staff: x.staff_name,
        service: x.service_name,
        writtenAt: new Date(x.original_reviewed_at).toISOString(),
        site: x.site_name,
        openKinds: x.open_requests.map((q) => q.kind),
      }))}
    />
  );
}
