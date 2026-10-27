import { Suspense } from "react";
import { connection } from "next/server";
import { headers } from "next/headers";
import Link from "next/link";
import { auth, isGoogleConfigured } from "@/lib/auth";
import { requireSession } from "@/lib/requireAuth";
import { getServerSession } from "@/lib/session";
import { countryOptions, nationalOf } from "@/lib/phone";
import { PageShell } from "@/components/ui/PageShell";
import { ConnectGoogle } from "@/components/ConnectGoogle";
import { AccountProfileForm } from "@/components/session/AccountProfileForm";
import { getUserAvatarMeta, getUserProfile } from "@worker/db/repositories/userProfiles.js";
import { listActiveSessionsForUser } from "@worker/db/repositories/authSessions.js";

/**
 * Per-USER account + security — session-gated only (unlike the tenant-admin pages under
 * /settings), because every member must manage their own profile and sign-in: the personal
 * profile (name, phone, photo), Google sign-in (the explicit link of the recovery flow:
 * reset password → log in → connect Google here) and the way into Sesiones.
 */
export default async function SecuritySettingsPage() {
  await connection();
  const { userId, email } = await requireSession();
  const session = await getServerSession();
  const [accounts, profile, avatar, sessions] = await Promise.all([
    auth.api.listUserAccounts({ headers: await headers() }),
    getUserProfile(userId),
    getUserAvatarMeta(userId),
    listActiveSessionsForUser(userId),
  ]);
  const googleLinked = accounts.some((account) => account.providerId === "google");
  const others = sessions.filter((s) => s.id !== session?.session.id).length;

  return (
    <PageShell surface="canvas" as="main">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <header className="flex flex-col gap-1 px-1 pt-2">
          <h1 className="u-page-title">Cuenta y seguridad</h1>
          <p className="m-0 text-sm text-muted">Tus datos personales y cómo entras. Tu rol y tus negocios los gestiona tu administrador.</p>
        </header>

        <section aria-labelledby="sec-profile" className="flex flex-col gap-4 rounded-sch-card border border-line bg-surface p-5">
          <h2 id="sec-profile" className="m-0 text-[15px] font-semibold">
            Tu perfil
          </h2>
          <AccountProfileForm
            email={email}
            countries={countryOptions()}
            initial={{
              userId,
              name: session?.user.name ?? "",
              country: profile?.phone_country ?? "CO",
              national: nationalOf(profile?.phone_e164),
              uploaded: avatar?.sha256 ?? null,
              providerImage: session?.user.image ?? null,
            }}
          />
        </section>

        <Link
          href="/settings/security/sessions"
          className="u-focus flex min-h-[60px] items-center justify-between gap-4 rounded-sch-card border border-line bg-surface px-5 py-3 transition-colors hover:bg-subtle"
        >
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px] font-semibold text-foreground">Sesiones</span>
            <span className="text-sm text-muted">
              {others === 0 ? "Solo estás conectado en este equipo." : `Este equipo y ${others} ${others === 1 ? "sesión más" : "sesiones más"}.`}
            </span>
          </span>
          <span aria-hidden className="text-lg text-faint">
            ›
          </span>
        </Link>

        <Suspense fallback={null}>
          <ConnectGoogle googleEnabled={isGoogleConfigured} googleLinked={googleLinked} email={email} />
        </Suspense>
      </div>
    </PageShell>
  );
}
