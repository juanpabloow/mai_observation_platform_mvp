"use client";

import type { RefObject } from "react";
import { COUNTRY_CODES, type ContactDraft, type ContactErrors } from "@/lib/publicBookingFlow";
import { IconCheck, IconWifi, LINK_BTN, SERIF } from "./ui";
import { TurnstileField, type TurnstileHandle } from "./TurnstileField";

/**
 * STEP 4 — Tus datos. The ONLY step with the full summary (service, artist, site, date,
 * time, duration, price), each block with "Editar". Name, mobile with its country
 * prefix, optional e-mail and the existing consent. Nothing is saved until "Confirmar
 * cita"; what the visitor typed survives going back, an error and a retry.
 */

export interface SummaryRow {
  k: string;
  v: string;
  sub?: string | null;
  /** The step that edits this block ("Editar"), or none. */
  edit?: { label: string; step: 1 | 2 | 3 } | null;
}

const INPUT =
  "h-12 w-full min-w-0 rounded-[12px] bg-white px-3.5 text-[16px] text-pb-ink placeholder:text-pb-faint";
const border = (err: boolean) => (err ? "border-[1.5px] border-pb-err-bd" : "border border-pb-line3");

function FieldError({ id, text }: { id: string; text: string }) {
  return (
    <span id={id} className="text-[13.5px] leading-[1.4] text-pb-err">
      {text}
    </span>
  );
}

export function DetailsStep({
  rows,
  priceLabel,
  priceSub,
  form,
  setField,
  touch,
  errors,
  show,
  errorCount,
  submitState,
  takenTime,
  onPickOtherTime,
  siteName,
  privacyPolicyUrl,
  turnstileSiteKey,
  turnstileMisconfigured,
  turnstileRef,
  onTurnstile,
  onSubmit,
  onFieldFocus,
  onEdit,
  priceChange = null,
  onAcceptPrice,
}: {
  rows: SummaryRow[];
  priceLabel: string;
  priceSub: string | null;
  form: ContactDraft;
  setField: <K extends keyof ContactDraft>(k: K, v: ContactDraft[K]) => void;
  touch: (k: keyof ContactErrors) => void;
  errors: ContactErrors;
  show: (k: keyof ContactErrors) => string;
  errorCount: number;
  submitState: "idle" | "sending" | "error" | "taken";
  takenTime: string | null;
  onPickOtherTime: () => void;
  siteName: string;
  privacyPolicyUrl: string | null;
  turnstileSiteKey: string | null;
  turnstileMisconfigured: boolean;
  turnstileRef: RefObject<TurnstileHandle | null>;
  onTurnstile: (token: string | null) => void;
  onSubmit: () => void;
  onFieldFocus: (el: HTMLElement) => void;
  onEdit: (step: 1 | 2 | 3) => void;
  /** The server refused because the price changed: what was shown and what it is now. */
  priceChange?: { previous: string; current: string; accepted: boolean } | null;
  onAcceptPrice?: () => void;
}) {
  const nameErr = show("name");
  const phoneErr = show("phone");
  const emailErr = show("email");
  const consentErr = show("consent");
  const focus = (e: React.FocusEvent<HTMLElement>) => onFieldFocus(e.currentTarget);
  void errors;

  return (
    <div className="flex flex-col gap-[18px]">
      {submitState === "error" ? (
        <div role="alert" className="flex items-start gap-2.5 rounded-[12px] border border-pb-err-bd2 bg-pb-err-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-err-fg">
          <IconWifi />
          <span>
            <strong className="font-[590]">No pudimos conectar.</strong> Tu cita aún no está reservada. Tus datos siguen aquí; vuelve a intentarlo.
          </span>
        </div>
      ) : null}
      {priceChange ? (
        <div role="alert" className="pb-rise flex flex-col gap-2.5 rounded-[12px] border border-pb-warn-bd bg-pb-warn-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-warn-fg">
          <span>
            <strong className="font-[590]">El precio cambió mientras reservabas.</strong> Antes:{" "}
            <span className="line-through [font-variant-numeric:tabular-nums]">{priceChange.previous}</span>. Ahora:{" "}
            <strong className="font-[590] [font-variant-numeric:tabular-nums]">{priceChange.current}</strong>. Tu cita aún no está reservada.
          </span>
          {priceChange.accepted ? (
            <span className="flex items-center gap-1.5 font-[590]">
              <span className="pb-pop flex">
                <IconCheck size={16} stroke="#5a4114" />
              </span>
              Aceptaste el nuevo precio. Ya puedes confirmar.
            </span>
          ) : (
            <button type="button" onClick={onAcceptPrice} className="pb-press inline-flex min-h-11 self-start items-center rounded-[12px] bg-pb-ink px-4 text-[15px] text-white">
              Acepto el nuevo precio
            </button>
          )}
        </div>
      ) : null}
      {submitState === "taken" ? (
        <div role="alert" className="flex flex-col gap-2.5 rounded-[12px] border border-pb-warn-bd bg-pb-warn-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-warn-fg">
          <span>
            <strong className="font-[590]">{takenTime ? `Las ${takenTime} ya no está disponible.` : "Esa hora ya no está disponible."}</strong> Alguien la reservó hace un momento. Elige otra hora; tus datos se conservan.
          </span>
          <button type="button" onClick={onPickOtherTime} className="inline-flex min-h-11 self-start items-center rounded-[12px] bg-pb-ink px-4 text-[15px] text-white">
            Elegir otra hora
          </button>
        </div>
      ) : null}

      <section aria-label="Resumen de tu cita" className="rounded-[16px] border border-pb-line bg-white py-1 pl-4 pr-1.5">
        {rows.map((r) => (
          <div key={r.k} className="flex min-h-[60px] items-center gap-3 border-b border-pb-hair">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-2">
              <span className="text-[12.5px] text-pb-muted">{r.k}</span>
              <span className="text-[15px] leading-[1.35] [overflow-wrap:anywhere] [font-variant-numeric:tabular-nums]">{r.v}</span>
              {r.sub ? <span className="text-[13px] text-pb-muted">{r.sub}</span> : null}
            </span>
            {r.edit ? (
              <button type="button" onClick={() => onEdit(r.edit!.step)} aria-label={r.edit.label} className={LINK_BTN}>
                Editar
              </button>
            ) : null}
          </div>
        ))}
        <div className="flex min-h-[52px] items-center justify-between gap-3 pr-2.5">
          <span className="flex flex-col">
            <span className="text-[15px] font-[590]">Precio</span>
            {priceSub ? <span className="text-[12.5px] text-pb-muted">{priceSub}</span> : null}
          </span>
          <span key={priceLabel} className="pb-fade text-[17px] font-semibold [font-variant-numeric:tabular-nums]">
            {priceLabel}
          </span>
        </div>
      </section>

      <form
        id="pb-booking-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="m-0 flex flex-col gap-4"
      >
        <h2 className={`${SERIF} m-0 text-[23px]`}>¿A nombre de quién?</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pb-name" className="text-[14px] font-[590]">
            Nombre
          </label>
          <input
            id="pb-name"
            name="name"
            type="text"
            autoComplete="name"
            autoCapitalize="words"
            enterKeyHint="next"
            maxLength={120}
            value={form.name}
            onChange={(e) => setField("name", e.target.value)}
            onBlur={() => touch("name")}
            onFocus={focus}
            aria-invalid={Boolean(nameErr)}
            aria-describedby={nameErr ? "pb-name-err" : undefined}
            className={`${INPUT} ${border(Boolean(nameErr))}`}
          />
          {nameErr ? <FieldError id="pb-name-err" text={nameErr} /> : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pb-phone" className="text-[14px] font-[590]">
            Celular
          </label>
          <div className="flex gap-2">
            <select
              aria-label="Prefijo de país"
              autoComplete="tel-country-code"
              value={form.cc}
              onChange={(e) => setField("cc", e.target.value)}
              onFocus={focus}
              className="h-12 flex-none rounded-[12px] border border-pb-line3 bg-white px-2.5 text-[16px] text-pb-ink"
            >
              {COUNTRY_CODES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              id="pb-phone"
              name="tel"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              enterKeyHint="next"
              maxLength={32}
              placeholder="300 123 4567"
              value={form.phone}
              onChange={(e) => setField("phone", e.target.value.replace(/[^\d +()-]/g, ""))}
              onBlur={() => touch("phone")}
              onFocus={focus}
              aria-invalid={Boolean(phoneErr)}
              aria-describedby={phoneErr ? "pb-phone-err" : "pb-phone-hint"}
              className={`${INPUT} flex-1 ${border(Boolean(phoneErr))}`}
            />
          </div>
          {phoneErr ? (
            <FieldError id="pb-phone-err" text={phoneErr} />
          ) : (
            <span id="pb-phone-hint" className="text-[13px] text-pb-muted">
              Te contactaremos aquí si hay algún cambio en tu cita.
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="pb-email" className="text-[14px] font-[590]">
            Email <span className="font-normal text-pb-muted">(opcional)</span>
          </label>
          <input
            id="pb-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            enterKeyHint="done"
            maxLength={254}
            placeholder="nombre@correo.com"
            value={form.email}
            onChange={(e) => setField("email", e.target.value)}
            onBlur={() => touch("email")}
            onFocus={focus}
            aria-invalid={Boolean(emailErr)}
            aria-describedby={emailErr ? "pb-email-err" : undefined}
            className={`${INPUT} ${border(Boolean(emailErr))}`}
          />
          {emailErr ? <FieldError id="pb-email-err" text={emailErr} /> : null}
        </div>

        <div className="flex flex-col gap-2 rounded-[12px] border border-pb-line bg-white py-3 pl-1.5 pr-3.5">
          <label className="flex cursor-pointer items-start gap-0.5">
            <span className="relative -mt-2.5 flex size-11 flex-none items-center justify-center">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(e) => setField("consent", e.target.checked)}
                onFocus={focus}
                aria-invalid={Boolean(consentErr)}
                aria-describedby={consentErr ? "pb-consent-err" : undefined}
                className="peer absolute inset-0 m-0 size-11 cursor-pointer opacity-0"
              />
              <span
                aria-hidden
                className={`flex size-6 items-center justify-center rounded-[7px] border-[1.5px] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-pb-focus ${
                  form.consent ? "border-pb-ink bg-pb-ink" : consentErr ? "border-pb-err-bd bg-white" : "border-pb-faint bg-white"
                }`}
              >
                {form.consent ? <IconCheck size={14} width={2.2} /> : null}
              </span>
            </span>
            <span className="text-[14px] leading-[1.5] text-pb-tx2">
              {privacyPolicyUrl ? (
                <>
                  Acepto la{" "}
                  <a href={privacyPolicyUrl} rel="noopener noreferrer" className="text-pb-ink underline underline-offset-2">
                    política de privacidad
                  </a>{" "}
                  de {siteName}. Tus datos se usan para gestionar esta cita.
                </>
              ) : (
                <>Acepto que {siteName} use mis datos solo para gestionar esta cita.</>
              )}
            </span>
          </label>
          {consentErr ? (
            <span id="pb-consent-err" className="pl-[46px] text-[13.5px] leading-[1.4] text-pb-err">
              {consentErr}
            </span>
          ) : null}
        </div>

        {turnstileMisconfigured ? (
          <p role="alert" className="m-0 rounded-[12px] bg-pb-err-bg px-3 py-2.5 text-[13px] text-pb-err-fg">
            Las reservas en línea no están disponibles en este momento. Inténtalo más tarde.
          </p>
        ) : turnstileSiteKey ? (
          <TurnstileField ref={turnstileRef} siteKey={turnstileSiteKey} onToken={onTurnstile} />
        ) : null}

        {errorCount > 0 ? (
          <span role="status" className="text-[14px] text-pb-err">
            {errorCount === 1 ? "Revisa 1 campo para confirmar." : `Revisa ${errorCount} campos para confirmar.`}
          </span>
        ) : null}
        {/* Enter in a field submits through the same guarded path as the button. */}
        <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
          Confirmar cita
        </button>
      </form>
    </div>
  );
}
