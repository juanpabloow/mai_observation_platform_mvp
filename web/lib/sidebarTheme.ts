/**
 * SIDEBAR APPEARANCE — a personal, interface-only preference that recolors ONLY
 * the navigation rail (Light or Black), independent of the app's light/dark theme.
 *
 * It is deliberately NOT tenant or client state: it says nothing about the
 * business, so it needs no table, no migration and no server round-trip. It lives
 * in a plain cookie, which the root layout reads DURING SSR and stamps onto <html>
 * as `data-sidebar-theme` — so the first painted frame already has the right rail
 * and there is no flash.
 *
 * PURE on purpose (no React, no next/headers): both the server layout and the
 * client toggle import the same parser and cookie name, and it is unit-testable.
 */

export const SIDEBAR_THEME_COOKIE = 'sidebar-theme';
export const SIDEBAR_THEMES = ['light', 'black'] as const;
export type SidebarTheme = (typeof SIDEBAR_THEMES)[number];
/** Light is the default: an unset, unknown or tampered cookie must never break the rail. */
// CRM Color Refactor: the design ships the DARK rail as the standard shell, so it is the
// default now. Users who explicitly pick "Light" still get it — their cookie overrides this.
export const DEFAULT_SIDEBAR_THEME: SidebarTheme = 'black';

/**
 * What each option is CALLED in the menu. Split from the stored value on purpose:
 * the dark rail was repainted deep navy, but its cookie value stays `black` so
 * preferences saved before the repaint keep resolving instead of silently
 * falling back to Light.
 */
export const SIDEBAR_THEME_LABELS: Record<SidebarTheme, string> = {
  light: 'Light',
  black: 'Navy',
};

/** Narrow an arbitrary cookie value to a known theme, else the default. */
export function parseSidebarTheme(value: string | undefined | null): SidebarTheme {
  return (SIDEBAR_THEMES as readonly string[]).includes(value ?? '')
    ? (value as SidebarTheme)
    : DEFAULT_SIDEBAR_THEME;
}

/**
 * The `document.cookie` assignment that persists the preference. Kept here (rather
 * than inline in the toggle) so the cookie's name, path and lifetime have exactly
 * one definition shared with the server reader. One year, path=/ so every route
 * sees it, SameSite=Lax so it survives normal navigation.
 */
export function sidebarThemeCookie(theme: SidebarTheme): string {
  return `${SIDEBAR_THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}
