"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/**
 * Visiting /logout clears the session (via the auth route handler) and redirects
 * to /login. Kept client-side so the cookie clearing + redirect happen in one
 * step from the user's session.
 */
export default function LogoutPage() {
  const router = useRouter();

  useEffect(() => {
    authClient.signOut().finally(() => {
      router.push("/login");
      router.refresh();
    });
  }, [router]);

  return (
    <main className="mx-auto flex w-full flex-1 items-center justify-center px-6 py-16 text-sm text-neutral-500">
      Signing out…
    </main>
  );
}
