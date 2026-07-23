import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, isGoogleConfigured } from "@/lib/auth";
import { getServerSession } from "@/lib/session";
import { ConnectGoogle } from "@/components/ConnectGoogle";

/**
 * Per-USER sign-in settings — deliberately session-gated only (unlike the
 * tenant-admin pages under /settings), because every member must be able to
 * manage how they sign in. This page hosts the explicit "Connect Google"
 * action of the recovery flow: reset password → log in → link Google here.
 */
export default async function SecuritySettingsPage() {
  const session = await getServerSession();
  if (!session?.user) redirect("/login?redirect=/settings/security");

  const accounts = await auth.api.listUserAccounts({ headers: await headers() });
  const googleLinked = accounts.some((account) => account.providerId === "google");

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="space-y-1">
        <Link href="/" className="text-sm text-neutral-500 transition-colors hover:text-foreground">
          &larr; Overview
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Sign-in &amp; security</h1>
        <p className="text-sm text-neutral-500">Manage how you sign in to your account.</p>
      </div>

      <Suspense fallback={null}>
        <ConnectGoogle
          googleEnabled={isGoogleConfigured}
          googleLinked={googleLinked}
          email={session.user.email}
        />
      </Suspense>
    </main>
  );
}
