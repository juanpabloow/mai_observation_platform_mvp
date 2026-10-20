import { notFound, redirect } from "next/navigation";
import { resolveValueAccess } from "@/lib/valueDashboard";

/**
 * Access GATE for the value dashboard, in the LAYOUT on purpose: `loading.tsx` wraps the PAGE
 * in a Suspense boundary, so a notFound() thrown by the page arrives after the response has
 * started streaming and the status stays 200 (the body is the not-found UI, no data). Deciding
 * here — before that boundary — makes a refused request a real 404 (401 → /login). The page
 * re-checks on its own; so do the period API and the assumption actions.
 */
export default async function ValueDashboardLayout({
  params,
  children,
}: {
  params: Promise<{ clientId: string }>;
  children: React.ReactNode;
}) {
  const { clientId } = await params;
  const access = await resolveValueAccess(clientId);
  if (!access.ok) {
    if (access.status === 401) redirect("/login");
    notFound();
  }
  return children;
}
