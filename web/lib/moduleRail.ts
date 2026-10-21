/**
 * MODULE RAIL — whether the in-page side menu of the module screens (the category /
 * state filters of a list, the section index of an editor) is folded away on desktop.
 *
 * Same mechanics as the sidebar's collapsed rail (lib/sidebarCollapsed.ts): a plain
 * cookie the root layout reads during SSR, so the server HTML and the first client
 * render agree and the toggle never causes a hydration mismatch or a late jump. One
 * preference for every module: folding it on Servicios folds it on Productos too.
 *
 * PURE on purpose (no React, no next/headers) so the layout, the provider and the tests
 * share one definition.
 */

export const MODULE_RAIL_COOKIE = "module-rail";

/** `0` = folded; anything else (absent, unknown, tampered) = the open default. */
export function parseModuleRailOpen(value: string | undefined | null): boolean {
  return value !== "0";
}

/** The `document.cookie` assignment — one year, path=/ so every route sees it. */
export function moduleRailCookie(open: boolean): string {
  return `${MODULE_RAIL_COOKIE}=${open ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
}
