"use client";

import { useEffect, useRef, useState } from "react";
import { REVIEW_COMMENT_MAX } from "@/lib/publicReviews";
import { CTA_BASE, ctaTone, IconCheck, SERIF, Spinner } from "./ui";

/**
 * The customer's review form (/resena/{token}): 1–5 stars, an optional comment and the
 * publication consent. ONE submit; the server makes it atomic, so a double tap or a retry
 * after a lost response can never create two reviews (a second one answers 409, which
 * this form shows as the same "thanks").
 *
 * The stars are a native radio group (arrow keys, one tab stop, a name per option) drawn
 * as 44px targets. Nothing is published from here — the business approves it first.
 */

const LABELS = ["Muy mala", "Mala", "Regular", "Buena", "Excelente"] as const;

type Sent = "idle" | "sending" | "done";

export function ReviewForm({ token, siteName, staffName, author }: { token: string; siteName: string; staffName: string | null; author: string }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<Sent>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const errRef = useRef<HTMLParagraphElement>(null);
  // A server refusal is announced (role=alert) AND focused, once it is on screen.
  useEffect(() => {
    if (error) errRef.current?.focus();
  }, [error]);

  const ratingErr = tried && rating === 0 ? "Elige de 1 a 5 estrellas." : null;
  const consentErr = tried && !consent ? "Debes aceptar que publiquemos tu reseña." : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state !== "idle") return;
    setTried(true);
    setError(null);
    if (rating === 0 || !consent) return;
    setState("sending");
    try {
      const res = await fetch(`/api/resena/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || null, publish_consent: true }),
      });
      if (res.ok || res.status === 409) {
        setState("done");
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "No pudimos enviar tu reseña. Inténtalo de nuevo.");
    } catch {
      setError("Sin conexión. Revisa tu internet e inténtalo de nuevo.");
    }
    setState("idle");
  };

  if (state === "done") {
    return (
      <div role="status" className="flex flex-col items-start gap-2 rounded-[16px] border border-pb-line bg-white p-5">
        <span aria-hidden className="flex size-11 items-center justify-center rounded-full bg-pb-ink">
          <IconCheck />
        </span>
        <h2 className={`${SERIF} m-0 text-[26px] leading-tight`}>¡Gracias por tu reseña!</h2>
        <p className="m-0 text-[15px] leading-[1.5] text-pb-muted">{siteName} la revisará antes de publicarla.</p>
      </div>
    );
  }

  const sending = state === "sending";
  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <fieldset className="m-0 flex flex-col gap-2 rounded-[16px] border border-pb-line bg-white p-4">
        <legend className="float-left mb-1 p-0 text-[15px] font-[590]">
          {staffName ? `Califica tu cita con ${staffName}` : "Califica tu cita"}
        </legend>
        <div className="clear-both flex items-center gap-1">
          {LABELS.map((label, i) => {
            const value = i + 1;
            const on = value <= rating;
            return (
              <label key={value} className="relative flex size-11 cursor-pointer items-center justify-center">
                <input
                  type="radio"
                  name="rating"
                  value={value}
                  checked={rating === value}
                  onChange={() => setRating(value)}
                  aria-label={`${value} de 5: ${label}`}
                  aria-describedby={ratingErr ? "rv-rating-err" : undefined}
                  className="peer absolute inset-0 m-0 size-11 cursor-pointer opacity-0"
                />
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 16 16"
                  aria-hidden
                  className="rounded-[8px] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pb-focus"
                >
                  <path
                    d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z"
                    fill={on ? "#E8A317" : "none"}
                    stroke={on ? "#E8A317" : "#9aa0a8"}
                    strokeWidth="1"
                    strokeLinejoin="round"
                  />
                </svg>
              </label>
            );
          })}
          <span aria-hidden className="ml-2 text-[14px] text-pb-muted">
            {rating ? LABELS[rating - 1] : ""}
          </span>
        </div>
        {ratingErr ? (
          <span id="rv-rating-err" className="text-[13.5px] leading-[1.4] text-pb-err">
            {ratingErr}
          </span>
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="rv-comment" className="text-[14px] font-[590]">
          Cuéntanos más <span className="font-normal text-pb-muted">(opcional)</span>
        </label>
        <textarea
          id="rv-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={REVIEW_COMMENT_MAX}
          rows={4}
          aria-describedby="rv-comment-hint"
          className="min-h-[112px] w-full resize-y rounded-[12px] border border-pb-line2 bg-white px-3.5 py-3 text-[16px] leading-[1.45] text-pb-ink"
        />
        <span id="rv-comment-hint" className="flex justify-between gap-3 text-[12.5px] text-pb-muted">
          <span>Sin enlaces, correos ni teléfonos: el texto es público.</span>
          <span className="[font-variant-numeric:tabular-nums]">
            {comment.length}/{REVIEW_COMMENT_MAX}
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-2 rounded-[12px] border border-pb-line bg-white py-3 pl-1.5 pr-3.5">
        <label className="flex cursor-pointer items-start gap-0.5">
          <span className="relative -mt-2.5 flex size-11 flex-none items-center justify-center">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              aria-invalid={Boolean(consentErr)}
              aria-describedby={consentErr ? "rv-consent-err" : undefined}
              className="peer absolute inset-0 m-0 size-11 cursor-pointer opacity-0"
            />
            <span
              aria-hidden
              className={`flex size-6 items-center justify-center rounded-[7px] border-[1.5px] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pb-focus ${
                consent ? "border-pb-ink bg-pb-ink" : consentErr ? "border-pb-err-bd bg-white" : "border-pb-faint bg-white"
              }`}
            >
              {consent ? <IconCheck size={14} width={2.2} /> : null}
            </span>
          </span>
          <span className="text-[14px] leading-[1.5] text-pb-tx2">
            Acepto que {siteName} publique mi reseña en su página de reservas como <span className="font-[590] text-pb-ink">«{author}»</span>, después de revisarla.
          </span>
        </label>
        {consentErr ? (
          <span id="rv-consent-err" className="pl-[46px] text-[13.5px] leading-[1.4] text-pb-err">
            {consentErr}
          </span>
        ) : null}
      </div>

      {error ? (
        <p ref={errRef} tabIndex={-1} role="alert" className="m-0 rounded-[12px] bg-pb-err-bg px-3 py-2.5 text-[14px] text-pb-err-fg">
          {error}
        </p>
      ) : null}

      <button type="submit" aria-disabled={sending} className={`${CTA_BASE} ${ctaTone(sending ? "sending" : "on")} w-full`}>
        {sending ? (
          <>
            <Spinner /> Enviando…
          </>
        ) : (
          "Enviar reseña"
        )}
      </button>
    </form>
  );
}
