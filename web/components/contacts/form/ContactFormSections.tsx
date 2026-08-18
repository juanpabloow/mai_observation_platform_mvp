"use client";

import type { PreferredChannel } from "@worker/db/repositories/contacts.js";
import { COPY, consentProvenance } from "@/lib/contactForm";
import { CHANNEL_LABELS, FORM_STAGES, stageLabel } from "@/lib/contactLabels";
import { CheckRow, Field, OwnerPicker, Segmented, Switch, type OwnerOption } from "./formPrimitives";

/**
 * The two sections both forms share verbatim — the "mismo esqueleto" requirement made
 * literal, so create and edit cannot drift into offering different stages or a
 * different set of channels.
 */

const CHANNEL_OPTIONS = (Object.keys(CHANNEL_LABELS) as PreferredChannel[]).map((c) => ({
  value: c,
  label: CHANNEL_LABELS[c],
}));

export function AssignmentSection({
  owners,
  ownerId,
  onOwnerChange,
  stage,
  onStageChange,
}: {
  owners: OwnerOption[];
  ownerId: string | null;
  onOwnerChange: (v: string | null) => void;
  stage: string;
  onStageChange: (v: string) => void;
}) {
  // A contact already archived keeps its option visible: a control that cannot display
  // its own current value silently rewrites it on the next save.
  const stages = FORM_STAGES.includes(stage as (typeof FORM_STAGES)[number])
    ? FORM_STAGES
    : ([...FORM_STAGES, stage] as readonly string[]);

  return (
    <>
      <Field label="Dueño del contacto">
        <OwnerPicker options={owners} value={ownerId} onChange={onOwnerChange} />
      </Field>
      <Field label="Stage">
        <Segmented
          name="contact-stage"
          ariaLabel="Stage"
          value={stage}
          onChange={onStageChange}
          options={stages.map((s: string) => ({ value: s, label: stageLabel(s) }))}
        />
      </Field>
    </>
  );
}

export function CommunicationSection({
  channel,
  onChannelChange,
  doNotContact,
  onDoNotContactChange,
  consent,
  onConsentChange,
  consentUpdatedAt,
  consentSource,
}: {
  channel: PreferredChannel | null;
  onChannelChange: (v: PreferredChannel | null) => void;
  doNotContact: boolean;
  onDoNotContactChange: (v: boolean) => void;
  consent: string;
  /** Receives the BOX state, not a consent value: mapping "unchecked" onto a stored
   *  value is the container's call (see setConsent — unchecking must not manufacture an
   *  explicit `opted_out` the customer never gave). */
  onConsentChange: (optedIn: boolean) => void;
  /** Provenance, shown only when consent is actually on record. */
  consentUpdatedAt?: string | null;
  consentSource?: string | null;
}) {
  const provenance = consentProvenance(consent, consentUpdatedAt ?? null, consentSource ?? null);

  return (
    <>
      <Field label="Canal preferido">
        <Segmented
          name="contact-channel"
          ariaLabel="Canal preferido"
          value={channel}
          onChange={(v) => onChannelChange(v === channel ? null : v)}
          options={CHANNEL_OPTIONS}
        />
      </Field>

      {/* SEPARATE from the segmented control, and a switch rather than a checkbox: this
          is not "another channel", it is the suppression of all of them. */}
      <Switch
        checked={doNotContact}
        onChange={onDoNotContactChange}
        label={COPY.doNotContact}
        note={COPY.doNotContactNote}
      />

      {/* Consent is OFF by default and stays a plain opt-in box. `unknown` and
          `opted_out` both read as unchecked — the difference between "never asked" and
          "said no" is preserved in the stored value, but the operator's control here is
          binary, and checking it is the only thing that records an opt-in. */}
      <CheckRow
        checked={consent === "opted_in"}
        onChange={onConsentChange}
        label="Tiene consentimiento para recibir mensajes"
        note={provenance ?? "Requerido para escribirle por WhatsApp"}
      />
    </>
  );
}
