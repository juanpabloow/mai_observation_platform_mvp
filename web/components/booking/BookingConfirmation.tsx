"use client";

import { bookingIcsDataUrl } from "@/lib/bookingIcs";
import { fmtTime, longDate, timezoneLabel, type HourFormat } from "@/lib/siteCalendar";
import { priceText } from "./ServiceList";
import { BookingSummary } from "./BookingSummary";

/**
 * The success state, inside the booking card. Shows ONLY what the confirmation
 * projection returned — the public reference (a random UUID, never a row id), site,
 * service, the professional the engine assigned, and the time in the site's zone.
 * "Añadir a mi calendario" is a same-tab .ics download built from those fields.
 * It promises nothing the platform does not do (no "we sent you a WhatsApp").
 */

export interface PublicConfirmation {
  reference: string;
  site: string;
  address: string | null;
  service: string;
  staff_name: string | null;
  start_at: string;
  service_end_at: string;
  duration_min: number;
  price: string | null;
  timezone: string;
}

export function BookingConfirmation({
  confirmation: c,
  firstName,
  format,
  onAnother,
}: {
  confirmation: PublicConfirmation;
  firstName: string | null;
  format: HourFormat;
  onAnother: () => void;
}) {
  const ics = bookingIcsDataUrl({
    reference: c.reference,
    service: c.service,
    site: c.site,
    address: c.address,
    staffName: c.staff_name,
    startAt: c.start_at,
    endAt: c.service_end_at,
  });
  return (
    <section role="status" aria-labelledby="booking-done-title" className="mx-auto flex w-full max-w-xl flex-col items-center gap-3.5 py-6 text-center">
      <span aria-hidden className="flex size-14 items-center justify-center rounded-full bg-success/12 text-2xl text-success">
        ✓
      </span>
      <h2 id="booking-done-title" tabIndex={-1} className="text-[22px] font-semibold tracking-tight outline-none">
        {firstName ? `¡Listo, ${firstName}! ` : ""}Tu cita está confirmada
      </h2>
      <p className="max-w-[420px] text-sm leading-relaxed text-muted">
        Guarda tu referencia. Si necesitas cambiar o cancelar la cita, comunícate con {c.site}.
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-1.5">
        <a
          href={ics}
          download="cita.ics"
          className="u-focus inline-flex h-[44px] items-center whitespace-nowrap rounded-[10px] border border-ink bg-ink px-[18px] text-sm font-medium text-ink-fg transition-colors hover:bg-ink-hover"
        >
          Añadir a mi calendario
        </a>
        <button
          type="button"
          onClick={onAnother}
          className="u-focus inline-flex h-[44px] items-center whitespace-nowrap rounded-[10px] border border-line-strong bg-surface px-[18px] text-sm text-foreground transition-colors hover:bg-subtle"
        >
          Reservar otra cita
        </button>
      </div>
      <div className="mt-3 w-full max-w-md text-left">
        <BookingSummary
          title="Tu reserva"
          note={null}
          rows={[
            { label: "Referencia", value: c.reference, mono: true },
            { label: "Sede", value: c.address ? `${c.site} · ${c.address}` : c.site },
            { label: "Servicio", value: c.service },
            { label: "Profesional", value: c.staff_name ?? "Asignado por la sede" },
            { label: "Fecha", value: longDate(c.start_at, c.timezone) },
            { label: "Hora", value: `${fmtTime(c.start_at, c.timezone, format)} – ${fmtTime(c.service_end_at, c.timezone, format)}`, mono: true },
            { label: "Precio", value: priceText(c.price) },
            { label: "Zona horaria", value: timezoneLabel(c.timezone) },
          ]}
        />
      </div>
    </section>
  );
}
