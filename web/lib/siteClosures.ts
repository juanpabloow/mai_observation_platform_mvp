import { dateLabel, localDay, localIsoWithOffset, timeLabel } from "./localTime";
import { PUBLIC_REASON_LABEL, type PublicAbsenceReason } from "./publicAbsenceReason";

/**
 * Upcoming WHOLE-SITE closures for the machine API (GET /api/scheduling/v1/sites), so an
 * assistant can answer "¿abren el lunes festivo?" from the agenda instead of a prompt that
 * someone has to edit every time the business closes. Input is the site-wide blocks the
 * explain loader already reads (one-off exceptions + recurring series blocks, PUBLIC reason
 * only — the internal `reason` text never reaches this file). Pure, no I/O.
 */

export interface SiteClosureSpan {
  from: Date;
  until: Date;
  public_reason: PublicAbsenceReason | null;
}

export interface SiteClosure {
  from_local: string;
  until_local: string;
  /** Site-local date the closure starts on ("YYYY-MM-DD"). */
  day: string;
  /** True when it covers whole local days (midnight to midnight). */
  all_day: boolean;
  public_reason: PublicAbsenceReason | null;
  public_reason_label: string | null;
  /** One sentence the assistant can say as is, e.g. "La sede está cerrada el lunes, 10 de noviembre." */
  customer_message: string;
}

/** Days ahead the endpoint looks for closures. */
export const SITE_CLOSURE_WINDOW_DAYS = 14;

const isLocalMidnight = (d: Date, tz: string) => localIsoWithOffset(d, tz).slice(11, 16) === "00:00";

function sentence(c: SiteClosureSpan, tz: string, locale: string, allDay: boolean): string {
  // Only a block marked «Cierre de la sede» says "cerrada"; any other site-wide block
  // (no public reason, or «No disponible») stays neutral, like /staff/status does.
  const is = c.public_reason === "site_closed" ? "está cerrada" : "no atiende";
  if (allDay) {
    // The last closed day is the one before `until` (midnight that ends the closure).
    const lastDay = new Date(c.until.getTime() - 1);
    const first = dateLabel(c.from, tz, locale);
    const last = dateLabel(lastDay, tz, locale);
    return localDay(c.from, tz) === localDay(lastDay, tz)
      ? `La sede ${is} el ${first}.`
      : `La sede ${is} del ${first} al ${last}.`;
  }
  const sameDay = localDay(c.from, tz) === localDay(new Date(c.until.getTime() - 1), tz);
  return sameDay
    ? `La sede ${is} el ${dateLabel(c.from, tz, locale)} de ${timeLabel(c.from, tz, locale)} a ${timeLabel(c.until, tz, locale)}.`
    : `La sede ${is} desde el ${dateLabel(c.from, tz, locale)}, ${timeLabel(c.from, tz, locale)}, hasta el ${dateLabel(c.until, tz, locale)}, ${timeLabel(c.until, tz, locale)}.`;
}

/** Site-wide closures that end after `now`, earliest first, with local labels. */
export function projectSiteClosures(spans: SiteClosureSpan[], tz: string, now: Date, locale: string): SiteClosure[] {
  return spans
    .filter((c) => c.until.getTime() > now.getTime() && c.until.getTime() > c.from.getTime())
    .sort((a, b) => a.from.getTime() - b.from.getTime())
    .map((c) => {
      const allDay = isLocalMidnight(c.from, tz) && isLocalMidnight(c.until, tz);
      return {
        from_local: localIsoWithOffset(c.from, tz),
        until_local: localIsoWithOffset(c.until, tz),
        day: localDay(c.from, tz),
        all_day: allDay,
        public_reason: c.public_reason,
        public_reason_label: c.public_reason ? PUBLIC_REASON_LABEL[c.public_reason] : null,
        customer_message: sentence(c, tz, locale, allDay),
      };
    });
}
