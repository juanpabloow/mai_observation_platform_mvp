/**
 * The public booking link of a site, as shown in Configuración de agenda → "Enlace de
 * reservas". Pure so it is unit-testable; the card (components/scheduling/
 * BookingLinkCard.tsx) prefixes the browser's CURRENT origin — never a hard-coded host.
 */

export type BookingLinkStatus = "available" | "site_inactive" | "scheduling_disabled";

/** Mirrors the public gate: the page answers only while the client's scheduling module
 * is on AND the site is active. */
export function bookingLinkStatus(input: { siteActive: boolean; schedulingEnabled: boolean }): BookingLinkStatus {
  if (!input.schedulingEnabled) return "scheduling_disabled";
  if (!input.siteActive) return "site_inactive";
  return "available";
}

export function bookingPath(slug: string): string {
  return `/book/${encodeURIComponent(slug)}`;
}

export function bookingUrl(origin: string | null, slug: string): string {
  const path = bookingPath(slug);
  return origin ? `${origin.replace(/\/+$/, "")}${path}` : path;
}
