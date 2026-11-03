import { notFound, redirect } from "next/navigation";
import { resolveAiCostsAccess } from "@/lib/aiCosts";

/**
 * Access GATE for a business's Costos de IA, in the LAYOUT (same reason as the value
 * dashboard's): a refused request is a real 404 (401 → /login) before anything streams. Rule:
 * the agency, or whoever may see this business's value dashboard (`analytics.view`). The page,
 * the period API and the report re-check on their own.
 */
export default async function ClientAiCostsLayout({
  params,
  children,
}: {
  params: Promise<{ clientId: string }>;
  children: React.ReactNode;
}) {
  const { clientId } = await params;
  const access = await resolveAiCostsAccess(clientId);
  if (!access.ok) {
    if (access.status === 401) redirect("/login");
    notFound();
  }
  return children;
}
