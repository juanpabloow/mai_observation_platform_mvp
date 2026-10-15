"use client";

import { bookingIcsDataUrl } from "@/lib/bookingIcs";
import { whatsappLink } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { fmtTime, longDate, timezoneLabel } from "@/lib/siteCalendar";
import { BusinessInfo } from "./BusinessInfo";
import { SERIF, type PublicConfirmation, type PublicSiteView } from "./ui";

/**
 * "Tu cita está reservada" — built ONLY from the server's confirmation (the engine's
 * snapshot): the professional actually assigned, the time in the site's zone, the price
 * that was recorded and the public reference (a random UUID, never a row id). It
 * promises nothing the platform does not do (no "we sent you a WhatsApp"). It is only
 * ever rendered AFTER the server answered 200/201 — the check draws itself then.
 * The location block repeats the site's address, hours and "Cómo llegar".
 */
export function BookingDone({ confirmation: c, firstName, site }: { confirmation: PublicConfirmation; firstName: string | null; site: PublicSiteView }) {
  const wa = whatsappLink(site.whatsapp ?? null, `Hola ${c.site}, tengo una cita reservada (referencia ${c.reference.slice(0, 8)}).`);
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
      <span aria-hidden className="pb-pop flex size-16 items-center justify-center rounded-full bg-pb-sage">
        <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="#2F5A38" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path className="pb-check-draw" d="M3.5 8.5 6.5 11.5 12.5 4.5" />
        </svg>
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
        <p className="m-0 text-[14px] leading-[1.5] text-pb-muted">
          ¿Necesitas cambiarla?{" "}
          {wa ? (
            <a href={wa} rel="noopener noreferrer" className="text-pb-ink underline underline-offset-[3px]">
              Escríbele a {c.site} por WhatsApp
            </a>
          ) : (
            `Escríbele a ${c.site}.`
          )}
        </p>
      </div>
      <BusinessInfo
        title="Ubicación"
        siteName={c.site}
        address={c.address}
        hours={site.hours ?? []}
        directionsUrl={site.directions_url ?? null}
        whatsapp={null}
        whatsappText=""
        compact
      />
    </div>
  );
}
