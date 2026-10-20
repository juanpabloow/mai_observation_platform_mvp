import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { buildValueDashboard, periodInputFrom, resolveValueAccess } from "@/lib/valueDashboard";
import { ValueDashboard } from "@/components/value/ValueDashboard";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * VALUE DASHBOARD — «El valor de tu automatización»: the client's Analytics
 * (/clients/[clientId]/analytics). The technical execution analytics of the workflows live
 * under Workflows (/workflows/<scope>/analytics). Access is validated on the server
 * (lib/valueDashboard.ts: agency or this client's owner; everyone else 404s). The first
 * period is rendered here; later period changes go through /api/analytics/{client}/value.
 * `?periodo=7|30|custom&desde&hasta` is bookmarkable; an invalid custom period falls back to
 * the error state with its reason rather than to a silent default.
 */
export default async function ValueDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId } = await params;
  const access = await resolveValueAccess(clientId);
  if (!access.ok) {
    if (access.status === 401) redirect("/login");
    notFound();
  }
  const sp = await searchParams;
  const input = periodInputFrom({ periodo: first(sp.periodo), desde: first(sp.desde), hasta: first(sp.hasta) });
  let result: Awaited<ReturnType<typeof buildValueDashboard>> | null = null;
  try {
    result = await buildValueDashboard(clientId, input);
  } catch {
    result = null; // a failed query is an ERROR state with «Reintentar», never "no data"
  }
  if (result && !result.ok && result.status === 404) notFound();
  return (
    <ValueDashboard
      clientId={clientId}
      initial={result?.ok ? result.data : null}
      initialError={result && !result.ok && result.status === 400 ? result.error : null}
    />
  );
}
