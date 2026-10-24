"use client";

import { useState } from "react";
import type { ReviewLinkResult } from "@/lib/schedulingActions";

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

/**
 * «Reseña» section of the appointment card (card language 5a), desktop and phone. Two steps on
 * purpose (see above): «Crear enlace de reseña», then «Copiar enlace» / «Abrir en WhatsApp»
 * (green). The chip appears only when the client already answered — whether the link was sent
 * is not recorded anywhere, so the card does not claim it.
 */
export function ReviewSection({ load, siteName, phone, clientName }: { load: ReviewLinkLoader; siteName: string; phone: string | null; clientName: string }) {
  const { s, create, copy } = useReviewLink(load);
  const wa = s.state === "ready" ? whatsappHref(phone, reviewShareText(siteName, s.url)) : null;
  const first = clientName.replace(/^\s*[[(][^\])]*[\])]\s*/, "").split(/\s+/)[0] || "el cliente";
  return (
    <section aria-labelledby="appt-sec-review" className="c5-sec gap-2.5">
      <div className="flex items-center gap-2">
        <h3 id="appt-sec-review" className="c5-cap flex-1">
          Reseña
        </h3>
        {s.state === "ready" && s.answered ? <span className="c5-chip c5-ok">Respondida</span> : null}
      </div>
      {s.state === "error" ? (
        <p role="alert" className="c5-small text-[var(--c5-red-fg)]">
          {s.error}
        </p>
      ) : (
        <p className="c5-small">
          {s.state === "ready" && s.answered
            ? "El cliente ya respondió esta reseña. Se publica solo después de que la apruebes."
            : `Envíale a ${first} el enlace para que deje su opinión. Se publica solo después de que la apruebes.`}
        </p>
      )}
      {s.state === "ready" ? (
        <>
          <input readOnly value={s.url} aria-label="Enlace de reseña" onFocus={(e) => e.currentTarget.select()} className="u-focus c5-field h-[36px] truncate text-[12px]" />
          <div className="flex gap-2">
            <button type="button" className="u-focus c5-btn" data-size="sm" style={{ flex: "1 1 0" }} onClick={copy}>
              {s.copied ? "Enlace copiado ✓" : "Copiar enlace"}
            </button>
            {wa ? (
              <a href={wa} target="_blank" rel="noopener noreferrer" data-kind="ok" data-size="sm" style={{ flex: "1 1 0" }} className="u-focus c5-btn">
                <ChatGlyph />
                Abrir en WhatsApp
              </a>
            ) : null}
          </div>
          <span aria-live="polite" className="sr-only">
            {s.copied ? "Enlace copiado" : ""}
          </span>
        </>
      ) : (
        <div>
          <button type="button" className="u-focus c5-btn" data-size="sm" aria-busy={s.state === "loading" || undefined} onClick={() => s.state !== "loading" && create()}>
            {s.state === "loading" ? "Creando enlace…" : s.state === "error" ? "Reintentar" : "Crear enlace de reseña"}
          </button>
        </div>
      )}
    </section>
  );
}

function ChatGlyph() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 20l1.3-3.9A8 8 0 1112 20a8 8 0 01-4-1z" />
    </svg>
  );
}
