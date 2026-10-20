/**
 * SIDEBAR COLLAPSED — whether the desktop rail is the narrow icon strip. A personal,
 * interface-only preference with the same mechanics as the sidebar theme, the text size
 * and the top bar: a plain cookie that the root layout reads DURING SSR, so the server
 * HTML and the browser's first render agree.
 *
 * It used to live only in localStorage, which the server cannot read: SSR always drew
 * the rail expanded, `SidebarProvider` applied the stored value in an effect after
 * mount, and because the rail streams in its own <Suspense> boundary that hydrates
 * LATER, React hydrated it with `collapsed = true` against expanded HTML — a hydration
 * mismatch on every full load for anyone who had collapsed the rail (and a rebuilt
 * subtree). The cookie removes the mismatch at its cause. The old localStorage key is
 * still read ONCE, after the rail has hydrated, to carry existing preferences over.
 *
 * PURE on purpose (no React, no next/headers): the layout, the provider and the tests
 * share one definition of the name, the values and the lifetime.
 */

export const SIDEBAR_COLLAPSED_COOKIE = 'sidebar-collapsed';
/** The pre-cookie storage key (read once to migrate, then kept in sync). */
export const LEGACY_SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';

/** `1` = collapsed; anything else (absent, unknown, tampered) = the expanded default. */
export function parseSidebarCollapsed(value: string | undefined | null): boolean {
  return value === '1';
}

/** The `document.cookie` assignment — one year, path=/ so every route sees it. */
export function sidebarCollapsedCookie(collapsed: boolean): string {
  return `${SIDEBAR_COLLAPSED_COOKIE}=${collapsed ? '1' : '0'}; path=/; max-age=31536000; samesite=lax`;
}

/** Whether a `document.cookie` string already carries the preference (so a legacy
 *  localStorage value must not override an explicit cookie choice). */
export function hasSidebarCollapsedCookie(cookieHeader: string): boolean {
  return cookieHeader.split(';').some((part) => part.trim().startsWith(`${SIDEBAR_COLLAPSED_COOKIE}=`));
}
