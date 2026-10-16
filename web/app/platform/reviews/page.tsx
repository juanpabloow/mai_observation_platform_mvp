import { connection } from "next/server";
import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platformAdmin";
import { PlatformReviews } from "@/components/platform/PlatformReviews";

/**
 * /platform/reviews — EXTERNAL (Fresha) review import and provenance review, for M_AI
 * PLATFORM administrators only (web/lib/platformAdmin.ts — an explicit server allow-list,
 * empty by default). Anyone else, including every tenant owner/admin and every business
 * role, gets the same 404 as a page that does not exist. Each action re-checks on its own.
 */
export const dynamic = "force-dynamic";

export default async function PlatformReviewsPage() {
  await connection();
  if (!(await requirePlatformAdmin())) notFound();
  return <PlatformReviews />;
}
