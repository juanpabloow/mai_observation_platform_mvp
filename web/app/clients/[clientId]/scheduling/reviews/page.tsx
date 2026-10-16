import { connection } from "next/server";
import { notFound } from "next/navigation";
import { canManageClient } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listReviewsForModeration } from "@worker/db/repositories/scheduling/reviews.js";
import { ReviewsModeration, type ModerationItem } from "@/components/scheduling/reviews/ReviewsModeration";
import { listExternalReviewsForClient } from "@worker/db/repositories/scheduling/externalReviews.js";
import { ExternalReviewsPanel } from "@/components/scheduling/reviews/ExternalReviewsPanel";

/**
 * REVIEWS — what customers said after a completed appointment, and what the booking page
 * may show. Nothing reaches /book/{slug} until it is approved here.
 *
 * Gating, like the sibling Staff and Configuración pages: requireClientModulePage (URL
 * client validated against the session's tenant + scope, non-default, scheduling ON) and
 * canManageClient (the client's owner or the agency) — anyone else gets the 404.
 */
export default async function ClientReviewsPage({ params }: { params: Promise<{ clientId: string }> }) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  if (!canManageClient(scope, clientId)) notFound();

  const [rows, external] = await Promise.all([listReviewsForModeration(scope.tenantId, client.id), listExternalReviewsForClient(scope.tenantId, client.id)]);
  const items: ModerationItem[] = rows.map((r) => ({
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
    <ReviewsModeration
      clientId={client.id}
      items={items}
      footer={
        <ExternalReviewsPanel
          clientId={client.id}
          items={external.map((x) => ({
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
      }
    />
  );
}
