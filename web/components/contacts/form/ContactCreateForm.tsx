"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createContactAction } from "@/lib/contactActions";
import { COPY, checkIdentity, createDraftKey, type ContactFormValues } from "@/lib/contactForm";
import { buttonClass } from "@/components/ui/controls";
import { useLeaveGuard } from "@/components/ui/useLeaveGuard";
import type { FieldDefView } from "../ContactProperties";
import { ContactSections } from "./ContactSections";
import { ContactFormDrawer, DrawerActions, FormBanner } from "./ContactFormDrawer";
import { CheckRow, INPUT_CLS, type OwnerOption } from "./formPrimitives";

/**
 * NUEVO CONTACTO. Everything it writes goes through createContactAction → C-2's
 * resolveContactByIdentity: this form cannot insert a contact, by construction, which
 * is the whole reason the list's button was disabled before it existed.
 *
 * WHAT IT REFUSES TO DO IS THE DESIGN. It does not ask for a name; it does not ask for
 * both a phone and an email; and a duplicate never blocks the save — the operator with
 * the customer on the line knows things the database does not. The only hard stop is an
 * empty identity pair.
 *
 * THE BODY IS `ContactSections`, THE SAME ONE THE FICHA RENDERS. This file used to
 * declare its own five sections — `IDENTIDAD`, `ASIGNACIÓN`, `COMUNICACIÓN`, `INTERNO`
 * in shouting caps, its own optional divider, its own note field — while the ficha, its
 * edit drawer and the record all read the sentence-case set from ContactSections. So the
 * one surface where a contact is BORN looked like a different product from every surface
 * that shows it afterwards: different section names, different order, a divider that
 * appeared even with no business fields under it.
 *
 * Now creating, editing and reading are three modes of ONE declaration of "what a
 * contact consists of". This form owns only what is genuinely create-only: the identity
 * pair starts empty, the first note is a note rather than a field, and the footer offers
 * "guardar y crear otro".
 */
export function ContactCreateForm({
  clientId,
  owners,
  fieldDefs,
  defaultOwnerId,
  canManageTagCatalog,
  placement,
  onClose,
}: {
  clientId: string;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  /** Pre-selects the current user when they can own contacts — the common case. */
  defaultOwnerId?: string | null;
  /** Same flag the edit drawer gets (owner/admin): whether NEW tag names may be coined
   *  here, or only ones the catalogue already has. The server re-checks it and reports
   *  what it skipped; this only tells the operator before they type. */
  canManageTagCatalog: boolean;
  /** Passed straight to the drawer — "lane" is the ficha's geometry (see ContactFormDrawer). */
  placement?: "region" | "lane";
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  // ONE values object, in the SAME shape the edit drawer tracks (ContactFormValues) —
  // that is what lets both hand the identical `edit` handles to ContactSections. It was
  // eight separate useStates, which is also why the two forms drifted: adding a field
  // meant remembering to add it here in a different style.
  const blank: ContactFormValues = {
    name: "",
    stage: "new",
    assignedTo: defaultOwnerId ?? null,
    preferredChannel: null,
    doNotContact: false,
    // Consent OFF by default — non-negotiable. `unknown` (never asked), not `opted_out`.
    consent: "unknown",
    customFields: {},
    tags: [],
  };
  const [values, setValues] = useState<ContactFormValues>(blank);
  // The fingerprint of the last CLEAN state: the blank form, the blank form with the
  // owner that survived "Guardar y crear otro", or what a save already wrote.
  const [cleanKey, setCleanKey] = useState(() => createDraftKey(blank, [""], [""], ""));
  const patch = (p: Partial<ContactFormValues>) => setValues((v) => ({ ...v, ...p }));

  const [phones, setPhones] = useState<string[]>([""]);
  const [emails, setEmails] = useState<string[]>([""]);
  const [note, setNote] = useState("");
  const [createAnother, setCreateAnother] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const identity = useMemo(() => checkIdentity(phones, emails), [phones, emails]);

  // REAL changes only (see createDraftKey): an opened-and-left-empty identity row or a
  // whitespace note is not a draft, so closing then does not ask.
  const dirty = createDraftKey(values, phones, emails, note) !== cleanKey;
  // Every way out — Cancelar, Cerrar, the scrim, Escape, Back — goes through this.
  const guard = useLeaveGuard({ dirty, onLeave: onClose });

  const reset = () => {
    // The OWNER survives: someone creating five contacts in a row is assigning all five
    // to the same person, and re-picking them each time is the kind of friction that
    // makes "guardar y crear otro" not worth using.
    const next = { ...blank, assignedTo: values.assignedTo };
    setValues(next);
    setCleanKey(createDraftKey(next, [""], [""], ""));
    setPhones([""]);
    setEmails([""]);
    setNote("");
  };

  const submit = () => {
    setError(null);
    setNotice(null);
    if (!identity.canSubmit) {
      setError(identity.error ?? COPY.needsIdentity);
      return;
    }
    start(async () => {
      const r = await createContactAction(clientId, {
        name: values.name.trim() || undefined,
        phones: identity.phones,
        emails: identity.emails,
        stage: values.stage,
        assigned_to: values.assignedTo,
        preferred_channel: values.preferredChannel,
        do_not_contact: values.doNotContact,
        messaging_consent: values.consent,
        consent_source: values.consent === "opted_in" ? "manual" : undefined,
        ...(fieldDefs.length > 0 ? { custom_fields: values.customFields } : {}),
        ...(values.tags.length > 0 ? { tags: values.tags } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Written: what is on screen is saved, so closing from here does not ask.
      setCleanKey(createDraftKey(values, phones, emails, note));
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
      // Saved: leave without asking (and drop the Back guard's history entry).
      else guard.leave();
    });
  };

  return (
    <ContactFormDrawer
      title="Nuevo contacto"
      subtitle="Solo necesitas un teléfono o un email — el resto se puede completar después."
      placement={placement}
      onClose={guard.requestLeave}
      guard={guard}
      discardBody="El contacto no se ha creado. Lo que escribiste se perderá."
      /*
        ONE STATE LINE, AND ONLY WHEN IT SAYS SOMETHING NEW. The banner used to carry
        `identityHint` while the identity rule was unmet — the exact sentence
        IdentitySection already prints under the email field, and a near-copy of the
        subtitle above it, so the same rule was on screen three times before a single
        character was typed. What is left is the transition worth announcing: the moment
        the form becomes saveable. Below it, the rule stays where it is enforced.
      */
      banner={identity.canSubmit ? <FormBanner tone="success">{COPY.readyToSave}</FormBanner> : undefined}
      footer={
        <DrawerActions
          error={error}
          notice={notice}
          leading={
            <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-xs text-muted lg:min-h-0">
              <input
                type="checkbox"
                checked={createAnother}
                onChange={(e) => setCreateAnother(e.target.checked)}
                className="u-focus size-4 accent-[var(--ink)]"
              />
              <span className="whitespace-nowrap">Guardar y crear otro</span>
            </label>
          }
        >
          <button type="button" onClick={guard.requestLeave} className={buttonClass({ variant: "secondary" })} disabled={pending}>
            Cancelar
          </button>
          <button type="button" onClick={submit} className={buttonClass({ variant: "primary" })} disabled={pending || !identity.canSubmit}>
            {pending ? "Creando…" : "Crear contacto"}
          </button>
        </DrawerActions>
      }
    >
      {/* The SAME component the ficha reads and the edit drawer writes — one declaration
          of which sections exist, in what order, with which fields. */}
      <ContactSections
        mode="edit"
        clientId={clientId}
        fieldDefs={fieldDefs}
        edit={{
          values,
          onChange: patch,
          owners,
          // Nothing is "on record" yet, so the drawer's "En el registro" block renders
          // nothing and both identity lists are the editable pair.
          existingPhones: [],
          existingEmails: [],
          newPhones: phones,
          newEmails: emails,
          onNewPhones: setPhones,
          onNewEmails: setEmails,
          // No contact to exclude from the duplicate lookup: every match found here is
          // somebody else, which is exactly what the operator needs to see.
          excludeContactId: null,
          identityError: error === COPY.needsIdentity ? COPY.needsIdentity : null,
          consentUpdatedAt: null,
          consentSource: null,
          // On CREATE there is no prior consent to preserve, so unchecking returns to
          // `unknown` ("never asked") rather than recording a refusal nobody made.
          onConsentToggle: (optedIn: boolean) => patch({ consent: optedIn ? "opted_in" : "unknown" }),
          canManageTagCatalog,
          notesSlot: (
            /* ONE box, not the editor's timeline + composer: there is no history to
               append to yet. It becomes the contact's FIRST note (a real contact_notes
               row, authored and timestamped), never a field on the contact. */
            <div className="flex flex-col gap-1.5">
              <label htmlFor="contact-note" className="text-xs font-medium text-muted">
                Nota
              </label>
              <textarea
                id="contact-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Algo que el equipo deba saber…"
                className={`${INPUT_CLS} resize-none`}
              />
            </div>
          ),
        }}
      />

      {/* The welcome message has no infrastructure behind it — there is no template
          registry and no send path in this codebase. Rather than fake one, the control
          renders in its documented "no template configured" state: permanently
          disabled, with the tooltip saying why. `border-t` because it sits OUTSIDE the
          section stack, whose last section drops its own rule. */}
      <div className="border-t border-line p-4">
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
