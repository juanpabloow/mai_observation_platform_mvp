/**
 * TOP BAR — a personal, interface-only preference: show or hide the desktop header bar
 * (sidebar toggle · client / workflow breadcrumb). Same mechanics as the sidebar theme and
 * the text size: a plain cookie, read by the root layout DURING SSR and stamped on <html>
 * as `data-topbar`, so the first painted frame is already right (no flash, no table).
 *
 * DEFAULT by role when the person never chose: the agency (owner/admin) keeps the bar —
 * it carries the client switcher they use — and everyone else starts without it.
 *
 * It only hides the bar from xl up (where the rail is always visible): below that the bar
 * holds the button that opens the menu, so it always stays. With the bar hidden, the
 * rail's collapse control moves into the rail (`.u-rail-toggle`).
 *
 * PURE on purpose (no React, no next/headers): the layout and the menu share it.
 */

export const TOPBAR_COOKIE = 'topbar';
export const TOPBAR_PREFS = ['shown', 'hidden'] as const;
export type TopbarPref = (typeof TOPBAR_PREFS)[number];

export const TOPBAR_LABELS: Record<TopbarPref, string> = { shown: 'Show', hidden: 'Hide' };

/** A known stored choice, or null when the person never chose. */
export function parseTopbarPref(value: string | undefined | null): TopbarPref | null {
  return (TOPBAR_PREFS as readonly string[]).includes(value ?? '') ? (value as TopbarPref) : null;
}

/** The choice if there is one, else the role default: shown for owner/admin, hidden otherwise. */
export function resolveTopbarPref(stored: TopbarPref | null, role: 'owner' | 'admin' | 'member' | null): TopbarPref {
  if (stored) return stored;
  return role === 'owner' || role === 'admin' ? 'shown' : 'hidden';
}

/** The `document.cookie` assignment — one year, path=/ so every route sees it. */
export function topbarCookie(pref: TopbarPref): string {
  return `${TOPBAR_COOKIE}=${pref}; path=/; max-age=31536000; samesite=lax`;
}
