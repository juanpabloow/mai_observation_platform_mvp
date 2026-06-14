"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Visiting /logout clears the session and sends the user to /login.
 *
 * Resilience (logout must NEVER hang): the redirect is DECOUPLED from the
 * sign-out call settling. We fire authClient.signOut() to invalidate the session
 * server-side + clear the cookie, but we navigate regardless via:
 *   - a 3s timeout (so a stalled sign-out can't trap the user on "Signing out…"),
 *   - and the sign-out's own completion (success OR failure), whichever is first.
 * We use a HARD navigation (window.location.replace) so any stale client session
 * cache is dropped and the React tree can't get wedged, guarded by `left` so we
 * navigate exactly once. Even if a failed sign-out left the cookie behind, the
 * data-layer auth gate still protects every route.
 */
export default function LogoutPage() {
  useEffect(() => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      window.location.replace("/login");
    };

    const timer = setTimeout(leave, 3000);

    authClient
      .signOut()
      .catch(() => {
        // A failed/rejected sign-out must not block the redirect.
      })
      .finally(() => {
        clearTimeout(timer);
        leave();
      });
  }, []);

  return (
    <main className="mx-auto flex w-full flex-1 items-center justify-center px-6 py-16 text-sm text-neutral-500">
      Signing out…
    </main>
  );
}
