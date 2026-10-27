import Link from "next/link";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAccessScope, hasFullAccess, memberLandingHref } from "@/lib/access";
import { getServerSession } from "@/lib/session";
import { memberLandingPath } from "@/lib/landing";
import { AGENCY_PERMISSIONS } from "@/lib/permissions/catalog";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { BusinessPicker } from "@/components/access/BusinessPicker";
import { LAST_BUSINESS_COOKIE } from "@/lib/accessCopy";
import { initialsOf } from "@/lib/personName";

/**
 * /negocios — 1d «¿A qué negocio entras?», the default stop after signing in. It ONLY shows
 * when it means something: the agency (owner/admin) with two or more businesses. Everyone
 * else passes straight through — a business member to the first page their role opens, the
 * agency with one business into it, with none to the Hub. The list is the agency's OWN
 * tenant's businesses (tenant-scoped read); each destination still runs its own gate.
 */
export default async function BusinessPickerPage() {
  await connection();
  const scope = await getAccessScope(); // redirects when signed out / no access
  if (!hasFullAccess(scope)) redirect(memberLandingHref(scope));
  const clients = (await listClientsForTenant(scope.tenantId)).filter((c) => !c.is_default);
  const landing = (id: string) => memberLandingPath(id, { permissions: AGENCY_PERMISSIONS, staffBound: false });
  if (clients.length === 0) redirect("/");
  if (clients.length === 1) redirect(landing(clients[0]!.id));

  const session = await getServerSession();
  const last = (await cookies()).get(LAST_BUSINESS_COOKIE)?.value ?? null;
  const email = session?.user?.email ?? "";
  const initials = initialsOf(session?.user?.name || email) || "·";

  return (
    <div className="u-access fixed inset-0 z-0 flex flex-col overflow-y-auto bg-white text-[#111]">
      <header className="flex items-center justify-between gap-4 px-5 py-5 lg:px-9 lg:py-7">
        <span className="text-[15px] font-semibold tracking-[.02em]">
          MONTSERRAT<span className="text-[#E5484D]">_</span>AI
        </span>
        <span className="flex min-w-0 items-center gap-2.5 text-[13px] text-[#3A3A3C]">
          <span aria-hidden className="flex size-7 flex-none items-center justify-center rounded-full bg-[#111] text-xs text-white">
            {initials}
          </span>
          <span className="hidden truncate sm:inline">{email} ·</span>
          <Link href="/logout" className="u-focus rounded text-[#2F6BE4] hover:text-[#1F4FB0]">
            Cerrar sesión
          </Link>
        </span>
      </header>
      <main className="flex flex-1 justify-center px-5 pb-10 pt-4 lg:pt-10">
        <div className="flex w-full max-w-[480px] flex-col gap-[18px]">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] lg:text-[28px]">¿A qué negocio entras?</h1>
            <p className="m-0 text-[15px] text-[#5E636B]">Tienes acceso a {clients.length}. Podrás cambiar de negocio en cualquier momento.</p>
          </div>
          <BusinessPicker
            items={clients.map((c) => ({ id: c.id, name: c.name, logoUrl: c.logo_url, href: landing(c.id), last: c.id === last }))}
          />
          <Link href="/" className="u-focus self-start rounded text-sm text-[#2F6BE4] hover:text-[#1F4FB0]">
            Ir al panel de la agencia
          </Link>
        </div>
      </main>
    </div>
  );
}
