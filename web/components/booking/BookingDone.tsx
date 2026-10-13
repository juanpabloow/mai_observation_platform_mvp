"use client";

import { bookingIcsDataUrl } from "@/lib/bookingIcs";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate, timezoneLabel } from "@/lib/siteCalendar";
import { IconCheck, SERIF, type PublicConfirmation } from "./ui";

/**
 * "Tu cita está reservada" — built ONLY from the server's confirmation (the engine's
 * snapshot): the professional actually assigned, the time in the site's zone, the price
 * that was recorded and the public reference (a random UUID, never a row id). It
 * promises nothing the platform does not do (no "we sent you a WhatsApp").
 */
export function BookingDone({ confirmation: c, firstName }: { confirmation: PublicConfirmation; firstName: string | null }) {
  const ics = bookingIcsDataUrl({
    reference: c.reference,
    service: c.service,
    site: c.site,
    address: c.address,
    staffName: c.staff_name,
    startAt: c.start_at,
    endAt: c.service_end_at,
  });
  const rows = [
    { k: "Servicio", v: `${c.service} · ${c.duration_min} min` },
    { k: "Artista", v: c.staff_name ?? "Asignado por la sede" },
    {
      k: "Fecha y hora",
      v: `${longDate(c.start_at, c.timezone)} · ${fmtTime(c.start_at, c.timezone, "24")}–${fmtTime(c.service_end_at, c.timezone, "24")}`,
      sub: `Hora de ${timezoneLabel(c.timezone).replace(/GMT-(\d)/, "GMT−$1")}`,
    },
    { k: "Sede", v: c.address ? `${c.site} · ${c.address}` : c.site },
    { k: "Referencia", v: c.reference, mono: true },
  ];
  return (
    <div className="flex flex-col gap-[18px] pt-5">
      <span aria-hidden className="flex size-16 items-center justify-center rounded-full bg-pb-sage">
        <IconCheck size={28} stroke="#2F5A38" width={1.8} />
      </span>
      <div role="status" className="flex flex-col gap-1.5">
        <h1 id="pb-done-title" tabIndex={-1} className={`${SERIF} m-0 text-[34px] leading-[1.08]`}>
          Tu cita está reservada
        </h1>
        <p className="m-0 text-[15.5px] leading-[1.5] text-pb-muted">
          {firstName ? `Te esperamos, ${firstName}. ` : ""}Guarda estos datos o toma una captura de pantalla.
        </p>
      </div>
      <section aria-label="Datos de la cita" className="rounded-[16px] border border-pb-line bg-white px-4 py-1">
        {rows.map((r) => (
          <div key={r.k} className="flex flex-col gap-0.5 border-b border-pb-hair py-2.5">
            <span className="text-[12.5px] text-pb-muted">{r.k}</span>
            <span className={`text-[15px] leading-[1.35] [overflow-wrap:anywhere] [font-variant-numeric:tabular-nums] ${r.mono ? "font-mono text-[13px]" : ""}`}>{r.v}</span>
            {r.sub ? <span className="text-[13px] text-pb-muted">{r.sub}</span> : null}
          </div>
        ))}
        <div className="flex min-h-[52px] items-center justify-between">
          <span className="text-[15px] font-[590]">Precio</span>
          <span className="text-[17px] font-semibold [font-variant-numeric:tabular-nums]">
            {priceLabelCOP(c.price) ? `${priceLabelCOP(c.price)} COP` : "Precio a consultar"}
          </span>
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <a href={ics} download="cita.ics" className="inline-flex min-h-11 items-center rounded-[12px] border border-pb-line3 bg-white px-4 text-[15px] text-pb-ink">
          Añadir a mi calendario
        </a>
        <p className="m-0 text-[14px] leading-[1.5] text-pb-muted">¿Necesitas cambiarla? Escríbele a {c.site}.</p>
      </div>
    </div>
  );
}
