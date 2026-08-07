/**
 * TEXT SIZE — a personal, interface-only preference that scales the app's type and
 * spacing together.
 *
 * The app shipped with a hard `html { font-size: 90% }`: it reproduced the density
 * of viewing the UI at 90% browser zoom, which suited dense operative tables and
 * made everything else read a notch small. That is a TASTE, not a fact, so it stops
 * being a constant and becomes a choice — with the old value still available as
 * Compact for anyone who wants the density back.
 *
 * Because Tailwind's type AND spacing scales are rem-based, one root declaration
 * rescales the whole UI coherently. The shell geometry (rail width, bar heights) is
 * deliberately in fixed px and does NOT ride this, so chrome stays put while content
 * grows — see the note in globals.css.
 *
 * Same mechanics as the sidebar theme (lib/sidebarTheme.ts): a plain cookie, read by
 * the root layout DURING SSR and stamped on <html> as `data-text-scale`, so the first
 * painted frame is already at the chosen size with no flash. It is not tenant or
 * client state, so it needs no table and no round-trip.
 *
 * PURE on purpose (no React, no next/headers): the server layout and the client
 * toggle import the same parser and cookie name, and it is unit-testable.
 */

export const TEXT_SCALE_COOKIE = 'text-scale';
export const TEXT_SCALES = ['compact', 'default', 'large'] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

/** DEFAULT is the 100% root. Compact is the old hardcoded 90%. */
export const DEFAULT_TEXT_SCALE: TextScale = 'default';

export const TEXT_SCALE_LABELS: Record<TextScale, string> = {
  compact: 'Compact',
  default: 'Default',
  large: 'Large',
};

/** Narrow an arbitrary cookie value to a known scale, else the default. */
export function parseTextScale(value: string | undefined | null): TextScale {
  return (TEXT_SCALES as readonly string[]).includes(value ?? '')
    ? (value as TextScale)
    : DEFAULT_TEXT_SCALE;
}

/** The `document.cookie` assignment that persists the preference — one definition,
 *  shared with the server reader. One year, path=/ so every route sees it. */
export function textScaleCookie(scale: TextScale): string {
  return `${TEXT_SCALE_COOKIE}=${scale}; path=/; max-age=31536000; samesite=lax`;
}
