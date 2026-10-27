import Link from "next/link";
import { connection } from "next/server";
import { requireSession } from "@/lib/requireAuth";
import { PageShell } from "@/components/ui/PageShell";
import { SessionsPanel } from "@/components/session/SessionsPanel";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/** Seguridad → Sesiones (4g/4h). Session-gated: everyone manages their OWN sessions. */
export default async function SessionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await connection();
  await requireSession();
  const sp = await searchParams;
  const pending = first(sp.pending);
  return (
    <PageShell as="main" grow={false}>
      <div className="flex flex-col gap-[22px] px-5 py-5 sm:px-8 sm:py-7">
        <div className="flex flex-col gap-1">
          <Link href="/settings/security" className="u-focus -ml-2 flex h-11 w-fit items-center gap-1 rounded-sch-control px-2 text-sm text-muted hover:text-foreground">
            <span aria-hidden>‹</span> Cuenta y seguridad
          </Link>
          <h1 className="u-page-title">Sesiones</h1>
          <p className="m-0 text-[15px] text-muted">Dónde está abierta tu cuenta. Mostramos navegador y sistema solo cuando se registran; nunca ubicación.</p>
        </div>
        <SessionsPanel pending={pending && /^[\w-]{1,64}$/.test(pending) ? pending : null} reauthError={first(sp.error)} />
      </div>
    </PageShell>
  );
}
