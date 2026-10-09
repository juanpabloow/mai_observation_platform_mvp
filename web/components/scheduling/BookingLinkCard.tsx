"use client";

import { useEffect, useState } from "react";
import { bookingLinkStatus, bookingPath, bookingUrl, type BookingLinkStatus } from "@/lib/bookingLink";

/**
 * "Enlace de reservas" — the public booking URL of ONE site, in that site's detail in
 * Configuración de agenda. The URL is built from the CURRENT origin in the browser
 * (never a hard-coded localhost or Railway domain), so the same build shows the right
 * link on every environment. Before hydration only the path is known, which is what
 * the preview line shows.
 *
 * The status mirrors the public gate (getPublicBookingSiteBySlug): the page answers
 * only while the site is active AND the client's scheduling module is enabled.
 * The slug is never changed here — it is edited (deliberately) in "URL pública".
 */

const STATUS_COPY: Record<BookingLinkStatus, { label: string; hint: string; dot: string }> = {
  available: {
    label: "Disponible",
    hint: "Cualquier persona con el enlace puede reservar, sin crear cuenta.",
    dot: "bg-success",
  },
  site_inactive: {
    label: "Sede inactiva",
    hint: "El enlace muestra «no disponible» hasta que reactives la sede.",
    dot: "bg-faintest",
  },
  scheduling_disabled: {
    label: "Agenda desactivada",
    hint: "El módulo de agenda de este cliente está apagado; el enlace no acepta reservas.",
    dot: "bg-warn-rule",
  },
};

export function BookingLinkCard({
  slug,
  siteActive,
  schedulingEnabled,
  serviceCount,
}: {
  slug: string;
  siteActive: boolean;
  schedulingEnabled: boolean;
  /** Services enabled at this site — 0 means the page would list nothing. */
  serviceCount: number;
}) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  useEffect(() => setOrigin(window.location.origin), []);

  const path = bookingPath(slug);
  const url = bookingUrl(origin, slug);
  const status = bookingLinkStatus({ siteActive, schedulingEnabled });
  const copy = STATUS_COPY[status];

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 1600);
  };

  return (
    <section aria-labelledby={`booking-link-${slug}`} className="border-t border-line px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`booking-link-${slug}`} className="text-sm font-semibold text-foreground">
          Enlace de reservas
        </h4>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">
          <span aria-hidden className={`size-1.5 rounded-full ${copy.dot}`} />
          {copy.label}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">{copy.hint}</p>

      <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code
          className="u-mono min-w-0 flex-1 select-all truncate rounded-lg border border-line bg-subtle/50 px-3 py-2.5 text-xs text-foreground lg:py-2"
          title={url}
        >
          {url}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copyLink}
            className="inline-flex h-[44px] flex-1 items-center justify-center rounded-lg border border-line-strong px-3 text-xs font-medium text-foreground transition hover:bg-subtle sm:flex-none lg:h-[34px]"
          >
            {copied === "ok" ? "Copiado ✓" : copied === "failed" ? "Selecciona y copia" : "Copiar enlace"}
          </button>
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-[44px] flex-1 items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 sm:flex-none lg:h-[34px]"
          >
            Abrir página
          </a>
        </div>
      </div>
      <p className="mt-2 text-[0.6875rem] text-faint">
        Ruta: <span className="u-mono">{path}</span> · Si cambias la URL pública, el enlace anterior deja de funcionar.
      </p>
      {status === "available" && serviceCount === 0 ? (
        <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-[0.6875rem] text-warn">
          Esta sede aún no tiene servicios activos: la página no tendrá nada para reservar.
        </p>
      ) : null}
    </section>
  );
}
