import { connection } from "next/server";
import { notFound } from "next/navigation";
import { canManageClient } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listReviewsForModeration } from "@worker/db/repositories/scheduling/reviews.js";
import { ReviewsModeration, type ModerationItem } from "@/components/scheduling/reviews/ReviewsModeration";

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

  const rows = await listReviewsForModeration(scope.tenantId, client.id);
  const items: ModerationItem[] = rows.map((r) => ({
    id: r.id,
    status: r.status === "approved" ? "approved" : r.status === "hidden" ? "hidden" : "pending",
    rating: r.rating,
    comment: r.comment,
    author: r.author_display,
    service: r.service_name,
    staff: r.staff_name,
    site: r.site_name,
    timezone: r.timezone,
    appointmentAt: new Date(r.start_at).toISOString(),
    submittedAt: new Date(r.submitted_at).toISOString(),
  }));
  return <ReviewsModeration clientId={client.id} items={items} />;
}
