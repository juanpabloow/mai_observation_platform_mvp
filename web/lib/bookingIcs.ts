/**
 * An iCalendar (.ics) file for a CONFIRMED public booking, built in the browser from the
 * confirmation the API already returned — so "Agregar al calendario" needs no extra
 * endpoint and carries nothing beyond what the customer was shown (service, site,
 * address, professional, time, public reference). RFC 5545: CRLF lines, escaped text,
 * UTC timestamps.
 */

export interface IcsBooking {
  reference: string;
  service: string;
  site: string;
  address: string | null;
  staffName: string | null;
  startAt: string;
  endAt: string;
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
export function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** 20261014T140000Z */
export function icsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function buildBookingIcs(b: IcsBooking, now: Date = new Date()): string {
  const description = [`Referencia: ${b.reference}`, b.staffName ? `Profesional: ${b.staffName}` : null]
    .filter(Boolean)
    .join("\n");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//M_AI//Reservas//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(b.reference)}@reservas`,
    `DTSTAMP:${icsUtc(now.toISOString())}`,
    `DTSTART:${icsUtc(b.startAt)}`,
    `DTEND:${icsUtc(b.endAt)}`,
    `SUMMARY:${icsEscape(`${b.service} · ${b.site}`)}`,
    `LOCATION:${icsEscape(b.address ? `${b.site}, ${b.address}` : b.site)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function bookingIcsDataUrl(b: IcsBooking): string {
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(buildBookingIcs(b))}`;
}
