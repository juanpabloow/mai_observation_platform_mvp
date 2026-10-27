"use client";

import { useEffect } from "react";
import { authClient } from "@/lib/auth-client";
import { SESSION_CHANNEL } from "@/lib/accessCopy";
import { safeInternalPath } from "@/lib/safeRedirect";

/**
 * Visiting /logout clears the session and sends the user to /login (or to `?next=`, an
 * INTERNAL path only — «Usar otra cuenta» and the wrong-account invitation use it).
 *
 * Resilience (logout must NEVER hang): the redirect is DECOUPLED from the
 * sign-out call settling. We fire authClient.signOut() to invalidate the session
 * server-side + clear the cookie, but we navigate regardless via:
 *   - a 3s timeout (so a stalled sign-out can't trap the user on "Cerrando sesión…"),
 *   - and the sign-out's own completion (success OR failure), whichever is first.
 * We use a HARD navigation (window.location.replace) so any stale client session
 * cache is dropped and the React tree can't get wedged, guarded by `left` so we
 * navigate exactly once. Even if a failed sign-out left the cookie behind, the
 * data-layer auth gate still protects every route. Other tabs of this browser are told,
 * so they leave the app too instead of showing data until their next request.
 */
function nextTarget(): string {
  const raw = new URLSearchParams(window.location.search).get("next");
  if (raw && (raw === "/login" || raw.startsWith("/login?"))) return raw;
  return safeInternalPath(raw, "/login");
}

export default function LogoutPage() {
  useEffect(() => {
    let left = false;
    const target = nextTarget();
    const leave = () => {
      if (left) return;
      left = true;
      try {
        const ch = new BroadcastChannel(SESSION_CHANNEL);
        ch.postMessage({ type: "ended", reason: "signed-out" });
        ch.close();
      } catch {
        // No BroadcastChannel: the other tabs notice on their next check.
      }
      window.location.replace(target);
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
    <main role="status" className="mx-auto flex w-full flex-1 items-center justify-center px-6 py-16 text-sm text-muted">
      Cerrando sesión…
    </main>
  );
}
