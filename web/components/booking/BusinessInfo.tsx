"use client";

import { whatsappLink } from "@/lib/bookingPage";
import { BTN_SECONDARY, IconHours, IconPin, IconWhatsApp, SERIF } from "./ui";

/**
 * Where and when: the site's address, its weekly hours and "Cómo llegar", plus the
 * business's WhatsApp — all from the SITE's configuration (address, opening_hours,
 * public_maps_url, public_whatsapp); nothing here is a second copy. Every line that has
 * no data is simply omitted, and the block disappears when there is nothing to say.
 *
 * Laptop (non-compact): the title, then address and hours side by side, then the two
 * actions at full width (two equal columns). Phone: stacked, the actions full width one
 * under the other.
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
  compact = false,
  title = "Ubicación y horario",
}: {
  siteName: string;
  address: string | null;
  hours: Array<{ days: string; hours: string }>;
  directionsUrl: string | null;
  whatsapp: string | null;
  whatsappText: string;
  compact?: boolean;
  title?: string;
}) {
  const wa = whatsappLink(whatsapp, whatsappText);
  const wide = !compact;
  if (!address && hours.length === 0 && !directionsUrl && !wa) return null;
  return (
    <section
      aria-label={title}
      className={`flex flex-col gap-3 rounded-[16px] border border-pb-line bg-white ${compact ? "p-3.5" : "p-4"} ${wide ? "lg:flex-row lg:flex-wrap lg:items-start lg:gap-x-6 lg:px-5" : ""}`}
    >
      <h2 className={`${SERIF} m-0 text-[21px] leading-tight ${wide ? "lg:basis-full" : ""}`}>{title}</h2>
      {address ? (
        <p className={`m-0 flex items-start gap-2.5 text-[14.5px] leading-[1.45] text-pb-body ${wide ? "lg:min-w-0 lg:basis-[calc(50%-12px)]" : ""}`}>
          <IconPin />
          <span>
            <span className="sr-only">Dirección: </span>
            {address}
            {compact ? null : <span className="block text-[13px] text-pb-muted">{siteName}</span>}
          </span>
        </p>
      ) : null}
      {hours.length > 0 ? (
        <div className={`flex items-start gap-2.5 text-[14.5px] leading-[1.45] text-pb-body ${wide ? "lg:min-w-0 lg:flex-1" : ""}`}>
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
        <div className={wide ? `mt-1 grid gap-2 lg:basis-full ${directionsUrl && wa ? "sm:grid-cols-2" : ""}` : "flex flex-wrap gap-2"}>
          {directionsUrl ? (
            <a href={directionsUrl} rel="noopener noreferrer" className={BTN_SECONDARY}>
              Cómo llegar
            </a>
          ) : null}
          {wa ? (
            <a href={wa} rel="noopener noreferrer" className={`${BTN_SECONDARY} gap-2`}>
              <IconWhatsApp />
              Escríbenos por WhatsApp
            </a>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
