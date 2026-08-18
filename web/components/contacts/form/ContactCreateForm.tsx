"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PreferredChannel } from "@worker/db/repositories/contacts.js";
import { createContactAction } from "@/lib/contactActions";
import { COPY, checkIdentity } from "@/lib/contactForm";
import type { FieldDefView } from "../ContactProperties";
import { ClientFieldsSection } from "./ClientFieldsSection";
import { AssignmentSection, CommunicationSection } from "./ContactFormSections";
import { BTN_PRIMARY, BTN_SECONDARY, ContactFormDrawer, FormBanner } from "./ContactFormDrawer";
import { IdentitySection } from "./IdentitySection";
import {
  CheckRow,
  Field,
  FormSection,
  IconAssign,
  IconBusiness,
  IconComms,
  IconIdentity,
  IconInternal,
  INPUT_CLS,
  OptionalDivider,
  TagChips,
  type OwnerOption,
} from "./formPrimitives";

/**
 * NUEVO CONTACTO. Everything it writes goes through createContactAction → C-2's
 * resolveContactByIdentity: this form cannot insert a contact, by construction, which
 * is the whole reason the list's button was disabled before it existed.
 *
 * WHAT IT REFUSES TO DO IS THE DESIGN. It does not require a name; it does not require
 * both a phone and an email; and a duplicate never blocks the save — the operator with
 * the customer on the line knows things the database does not. The only hard stop is an
 * empty identity pair.
 */
export function ContactCreateForm({
  clientId,
  owners,
  fieldDefs,
  defaultOwnerId,
  onClose,
}: {
  clientId: string;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  /** Pre-selects the current user when they can own contacts — the common case. */
  defaultOwnerId?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [name, setName] = useState("");
  const [phones, setPhones] = useState<string[]>([""]);
  const [emails, setEmails] = useState<string[]>([""]);
  const [ownerId, setOwnerId] = useState<string | null>(defaultOwnerId ?? null);
  const [stage, setStage] = useState<string>("new");
  const [channel, setChannel] = useState<PreferredChannel | null>(null);
  const [doNotContact, setDoNotContact] = useState(false);
  // Consent OFF by default — non-negotiable. `unknown` (never asked), not `opted_out`.
  const [consent, setConsent] = useState("unknown");
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [createAnother, setCreateAnother] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const identity = useMemo(() => checkIdentity(phones, emails), [phones, emails]);
  // The banner reflects the identity rule only. The duplicate state lives per-field
  // (they resolve independently), so a global "matches" banner would have to lie about
  // which field it meant.
  const banner = identity.canSubmit
    ? { tone: "success" as const, text: COPY.readyToSave }
    : { tone: "muted" as const, text: COPY.identityHint };

  const reset = () => {
    setName("");
    setPhones([""]);
    setEmails([""]);
    setStage("new");
    setChannel(null);
    setDoNotContact(false);
    setConsent("unknown");
    setCustom({});
    setTags([]);
    setNote("");
  };

  const submit = () => {
    setError(null);
    setNotice(null);
    if (!identity.canSubmit) {
      setError(COPY.needsIdentity);
      return;
    }
    start(async () => {
      const r = await createContactAction(clientId, {
        name: name.trim() || undefined,
        phones: identity.phones,
        emails: identity.emails,
        stage,
        assigned_to: ownerId,
        preferred_channel: channel,
        do_not_contact: doNotContact,
        messaging_consent: consent,
        consent_source: consent === "opted_in" ? "manual" : undefined,
        ...(fieldDefs.length > 0 ? { custom_fields: custom } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // The spine may have RESOLVED to somebody who already had this number rather than
      // creating anyone. Saying "contacto creado" then would teach operators to ignore
      // the duplicate warning, so the two outcomes are reported differently.
      if (!r.created) {
        setNotice(
          "Ese dato ya pertenecía a un contacto existente, así que se actualizó ese contacto en vez de crear uno nuevo.",
        );
        router.refresh();
        return;
      }
      if (r.skippedTags.length > 0) {
        setNotice(`Contacto creado. No se pudieron crear estas etiquetas: ${r.skippedTags.join(", ")}.`);
        router.refresh();
        return;
      }
      router.refresh();
      if (createAnother) reset();
      else onClose();
    });
  };

  return (
    <ContactFormDrawer
      title="Nuevo contacto"
      subtitle="Solo necesitas un teléfono o un email — el resto se puede completar después."
      onClose={onClose}
      banner={<FormBanner tone={banner.tone}>{banner.text}</FormBanner>}
      footer={
        <div className="flex flex-col gap-2 px-3 py-3">
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="text-xs text-warn">
              {notice}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                checked={createAnother}
                onChange={(e) => setCreateAnother(e.target.checked)}
                className="size-3.5 accent-[var(--brand)]"
              />
              <span className="whitespace-nowrap">Guardar y crear otro</span>
            </label>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className={BTN_SECONDARY} disabled={pending}>
                Cancelar
              </button>
              <button type="button" onClick={submit} className={BTN_PRIMARY} disabled={pending || !identity.canSubmit}>
                {pending ? "Creando…" : "Crear contacto"}
              </button>
            </div>
          </div>
        </div>
      }
    >
      <FormSection title="IDENTIDAD" icon={<IconIdentity />}>
        <IdentitySection
          clientId={clientId}
          name={name}
          onNameChange={setName}
          phones={phones}
          onPhonesChange={setPhones}
          emails={emails}
          onEmailsChange={setEmails}
          identityError={error === COPY.needsIdentity ? COPY.needsIdentity : null}
        />
      </FormSection>

      <FormSection title="ASIGNACIÓN" icon={<IconAssign />}>
        <AssignmentSection
          owners={owners}
          ownerId={ownerId}
          onOwnerChange={setOwnerId}
          stage={stage}
          onStageChange={setStage}
        />
      </FormSection>

      <FormSection title="COMUNICACIÓN" icon={<IconComms />}>
        <CommunicationSection
          channel={channel}
          onChannelChange={setChannel}
          doNotContact={doNotContact}
          onDoNotContactChange={setDoNotContact}
          consent={consent}
          // On CREATE there is no prior consent to preserve, so unchecking returns to
          // `unknown` ("never asked") rather than recording a refusal nobody made.
          onConsentChange={(optedIn) => setConsent(optedIn ? "opted_in" : "unknown")}
        />
      </FormSection>

      <div className="px-4 py-3">
        <OptionalDivider label={COPY.optionalDivider} />
      </div>

      {/* Renders NOTHING when the tenant has defined no fields — an empty "configured by
          the business" heading would be worse than its absence. */}
      {fieldDefs.length > 0 ? (
        <FormSection
          title={COPY.businessConfigured}
          icon={<IconBusiness />}
          trailing={
            <span className="u-mono rounded border border-line bg-chip px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-faint">
              custom fields
            </span>
          }
        >
          <ClientFieldsSection fieldDefs={fieldDefs} values={custom} onChange={setCustom} />
        </FormSection>
      ) : null}

      <FormSection title="INTERNO" icon={<IconInternal />}>
        <Field label="Etiquetas">
          <TagChips
            tags={tags}
            onAdd={(t) => setTags((cur) => (cur.some((x) => x.toLowerCase() === t.toLowerCase()) ? cur : [...cur, t]))}
            onRemove={(t) => setTags((cur) => cur.filter((x) => x !== t))}
          />
        </Field>
        {/* On CREATE this is a single box: there is no history to append to yet, and it
            becomes the contact's FIRST note (a real contact_notes row, authored and
            timestamped) rather than a field on the contact. */}
        <Field label="Nota" htmlFor="contact-note">
          <textarea
            id="contact-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Algo que el equipo deba saber…"
            className={`${INPUT_CLS} resize-none`}
          />
        </Field>
      </FormSection>

      {/* The welcome message has no infrastructure behind it — there is no template
          registry and no send path in this codebase. Rather than fake one, the control
          renders in its documented "no template configured" state: permanently
          disabled, with the tooltip saying why. */}
      <div className="p-4">
      <CheckRow
        checked={false}
        onChange={() => {}}
        disabled
        title="No hay ninguna plantilla de bienvenida configurada para este negocio."
        label="Enviar mensaje de bienvenida"
        note="Sin plantilla configurada"
      />
      </div>
    </ContactFormDrawer>
  );
}
