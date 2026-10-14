"use client";

import { useState } from "react";
import type { ReviewLinkResult } from "@/lib/schedulingActions";
import { Button, CARD } from "../ui/system";

/**
 * "Enlace de reseña" — the review link of a COMPLETED appointment, shared by the desktop
 * panel and the phone sheet. Nothing is sent from here: the operator copies the link or
 * opens a WhatsApp chat with the text pre-filled (wa.me never sends by itself).
 *
 * Two clicks on purpose: "Crear enlace" asks the server (gateAppointment + idempotent
 * request), then "Copiar" writes to the clipboard inside its OWN click — Safari refuses
 * a clipboard write that follows an await.
 */

export type ReviewLinkLoader = () => Promise<ReviewLinkResult>;

type State =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; error: string }
  | { state: "ready"; url: string; answered: boolean; copied: boolean };

export function reviewShareText(siteName: string, url: string): string {
  return `¡Gracias por tu visita a ${siteName}! ¿Nos cuentas cómo te fue? Tu opinión nos ayuda: ${url}`;
}

export function useReviewLink(load: ReviewLinkLoader) {
  const [s, setS] = useState<State>({ state: "idle" });
  const create = async () => {
    setS({ state: "loading" });
    const r = await load();
    if (!r.ok) return setS({ state: "error", error: r.error });
    setS({ state: "ready", url: `${window.location.origin}${r.path}`, answered: r.answered, copied: false });
  };
  const copy = async () => {
    if (s.state !== "ready") return;
    try {
      await navigator.clipboard.writeText(s.url);
      setS({ ...s, copied: true });
    } catch {
      setS({ state: "error", error: "No se pudo copiar. Selecciona el enlace y cópialo a mano." });
    }
  };
  return { s, create, copy };
}

/** wa.me/{digits}?text=… — opens the chat with the message drafted; the operator sends it. */
export function whatsappHref(phone: string | null, text: string): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}

/** Desktop card (AppointmentPanel). */
export function ReviewLinkCard({ load, siteName, phone }: { load: ReviewLinkLoader; siteName: string; phone: string | null }) {
  const { s, create, copy } = useReviewLink(load);
  const wa = s.state === "ready" ? whatsappHref(phone, reviewShareText(siteName, s.url)) : null;
  return (
    <section aria-labelledby="appt-panel-review" className={`${CARD} p-4`}>
      <div className="flex items-center justify-between gap-2">
        <h3 id="appt-panel-review" className="text-[13px] font-semibold">
          Reseña
        </h3>
        {s.state === "idle" || s.state === "error" ? (
          <Button variant="tertiary" size="sm" onClick={create}>
            {s.state === "error" ? "Reintentar" : "Crear enlace"}
          </Button>
        ) : null}
      </div>
      {s.state === "idle" ? (
        <p className="mt-1 text-[13px] text-muted">Pídele al cliente su opinión. Se publica solo después de que la apruebes.</p>
      ) : s.state === "loading" ? (
        <div className="mt-3 h-10 animate-pulse rounded-sch-control bg-subtle" aria-busy="true" aria-label="Creando enlace" />
      ) : s.state === "error" ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {s.error}
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {s.answered ? <p className="text-[13px] text-muted">El cliente ya respondió esta reseña.</p> : null}
          <input
            readOnly
            value={s.url}
            aria-label="Enlace de reseña"
            onFocus={(e) => e.currentTarget.select()}
            className="u-mono h-[36px] w-full truncate rounded-sch-control border border-line bg-subtle px-2.5 text-xs"
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={copy}>
              {s.copied ? "Copiado" : "Copiar enlace"}
            </Button>
            {wa ? (
              <a href={wa} target="_blank" rel="noopener noreferrer" className="inline-flex h-[32px] items-center rounded-sch-control px-2.5 text-xs text-accent hover:underline">
                Abrir WhatsApp
              </a>
            ) : null}
          </div>
          <span aria-live="polite" className="sr-only">
            {s.copied ? "Enlace copiado" : ""}
          </span>
        </div>
      )}
    </section>
  );
}
