"use client";

import { mapEmbedUrl, whatsappLink } from "@/lib/bookingPage";
import { BTN_SECONDARY, BTN_WHATSAPP, IconHours, IconPin, IconWhatsApp, SERIF } from "./ui";

/**
 * Where and when: a map of the site, its address, its weekly hours and "Cómo llegar",
 * plus the business's WhatsApp — all from the SITE's configuration (address,
 * opening_hours, public_maps_url, public_whatsapp); nothing here is a second copy. Every
 * line that has no data is simply omitted, and the block disappears when there is
 * nothing to say. The same block closes step 1 and the confirmation.
 *
 * The map is Google Maps' public embed for the address (mapEmbedUrl); it is out of the
 * tab order because "Cómo llegar" is the accessible way to the same place.
 *
 * Laptop: the title, then the map on the left and the details and actions on the right.
 * Phone: stacked — map, details, then the actions full width one under the other.
 *
 * Links open in the same tab: Instagram's in-app browser hands wa.me and Maps links to
 * their apps, and a popup would be blocked there.
 */
export function BusinessInfo({
  siteName,
  address,
  hours,
  directionsUrl,
  whatsapp,
  whatsappText,
  title = "Ubicación y horario",
}: {
  siteName: string;
  address: string | null;
  hours: Array<{ days: string; hours: string }>;
  directionsUrl: string | null;
  whatsapp: string | null;
  whatsappText: string;
  title?: string;
}) {
  const wa = whatsappLink(whatsapp, whatsappText);
  const map = mapEmbedUrl(address);
  if (!address && hours.length === 0 && !directionsUrl && !wa) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-3 rounded-[16px] border border-pb-line bg-white p-4 lg:px-5">
      <h2 className={`${SERIF} m-0 text-[21px] leading-tight`}>{title}</h2>
      <div className={map ? "flex flex-col gap-3.5 lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start lg:gap-x-6" : "flex flex-col"}>
        {map ? (
          <div className="relative h-[168px] overflow-hidden rounded-[12px] border border-pb-line bg-pb-sf2 lg:h-[230px]">
            <iframe
              title={`Mapa de ${siteName}: ${address}`}
              src={map}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              tabIndex={-1}
              className="absolute inset-0 size-full border-0"
            />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-3">
          {address ? (
            <p className="m-0 flex items-start gap-2.5 text-[14.5px] leading-[1.45] text-pb-body">
              <IconPin />
              <span>
                <span className="sr-only">Dirección: </span>
                {address}
                <span className="block text-[13px] text-pb-muted">{siteName}</span>
              </span>
            </p>
          ) : null}
          {hours.length > 0 ? (
            <div className="flex items-start gap-2.5 text-[14.5px] leading-[1.45] text-pb-body">
              <IconHours />
              <dl aria-label="Horario" className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                {hours.map((h) => (
                  <div key={h.days} className="contents">
                    <dt className="text-pb-tx2">{h.days}</dt>
                    <dd className={`m-0 [font-variant-numeric:tabular-nums] ${h.hours === "Cerrado" ? "text-pb-muted" : ""}`}>{h.hours}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {directionsUrl || wa ? (
            <div className={`mt-1 grid gap-2 ${map ? "" : `lg:max-w-[560px] ${directionsUrl && wa ? "sm:grid-cols-2" : ""}`}`}>
              {directionsUrl ? (
                <a href={directionsUrl} rel="noopener noreferrer" className={BTN_SECONDARY}>
                  Cómo llegar
                </a>
              ) : null}
              {wa ? (
                <a href={wa} rel="noopener noreferrer" className={BTN_WHATSAPP}>
                  <IconWhatsApp />
                  Escríbenos por WhatsApp
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
