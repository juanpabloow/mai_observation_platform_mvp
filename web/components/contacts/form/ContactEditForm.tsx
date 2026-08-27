"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteContactAction, updateContactAction } from "@/lib/contactActions";
import { addNoteAction, attachTagAction, createTagAction, detachTagAction } from "@/lib/crmActions";
import { formatDateTime } from "@/lib/format";
import type { ContactEditInitial, NoteView, TagView } from "@/lib/contactShared";
import { COPY, buildEditPatch, changedFields, checkIdentity, unsavedLabel, type ContactFormValues } from "@/lib/contactForm";
import type { FieldDefView } from "../ContactProperties";
import { BTN_DANGER, BTN_PRIMARY, BTN_QUIET, BTN_SECONDARY, ContactFormDrawer } from "./ContactFormDrawer";
import { ContactSections } from "./ContactSections";
import { Avatar, INPUT_CLS, type OwnerOption } from "./formPrimitives";
import {
  ContactPanelHeader,
  PANEL_CLOSE_CLS,
  PanelCloseIcon,
} from "../shared/ContactPanelShell";
import { contactToneStyle } from "../shared/ContactHeaderBlock";

/** Re-exported so callers can keep importing it from the component they render; the
 *  shape itself lives in contactShared.ts because BOTH doors build it server-side. */
export type { ContactEditInitial };

/**
 * EDITAR CONTACTO — the same skeleton as create, pre-filled, plus the three things
 * only editing has: derived header metrics, an unsaved-changes bar, and delete.
 *
 * IT SENDS ONLY WHAT CHANGED (buildEditPatch). That is not an optimisation: sending the
 * whole object would re-assert every custom field on every save (defeating the partial
 * merge that stops one editor wiping another's enrichment) and would re-stamp
 * consent_updated_at on saves that never touched consent — silently rewriting
 * "Aceptado el 12 mar 2023" to today because someone fixed a typo in a name.
 *
 * IDENTITIES ARE ADD-ONLY here. New numbers/emails go through the spine; existing ones
 * are not removable from this form, because freeing an identity hands the value to
 * whoever claims it next and that deserves its own deliberate action, not a stray ×
 * during a name edit.
 */
export function ContactEditForm({
  clientId,
  initial,
  owners,
  fieldDefs,
  tags,
  tagCatalogue,
  notes,
  canDelete,
  canManageTagCatalog,
  onClose,
}: {
  clientId: string;
  initial: ContactEditInitial;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  tags: TagView[];
  /** The client's WHOLE tag catalogue, not just this contact's. Without it, re-adding a
   *  tag the client already defined would try to CREATE it, hit the unique-name
   *  constraint, and be silently dropped. */
  tagCatalogue: TagView[];
  notes: NoteView[];
  canDelete: boolean;
  canManageTagCatalog: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const baseline: ContactFormValues = useMemo(
    () => ({
      name: initial.name ?? "",
      stage: initial.stage,
      assignedTo: initial.assignedTo,
      preferredChannel: initial.preferredChannel,
      doNotContact: initial.doNotContact,
      consent: initial.consent,
      customFields: initial.customFields,
      tags: tags.map((t) => t.name),
    }),
    [initial, tags],
  );

  const [values, setValues] = useState<ContactFormValues>(baseline);
  // Identities are separate state: they are add-only and never part of the patch.
  const [newPhones, setNewPhones] = useState<string[]>([]);
  const [newEmails, setNewEmails] = useState<string[]>([]);
  const [newNote, setNewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const patch = (p: Partial<ContactFormValues>) => setValues((v) => ({ ...v, ...p }));

  const changes = useMemo(() => changedFields(baseline, values), [baseline, values]);
  const addedIdentities = useMemo(() => {
    const c = checkIdentity(newPhones, newEmails);
    return c.phones.length + c.emails.length;
  }, [newPhones, newEmails]);
  const noteAdded = newNote.trim() !== "" ? 1 : 0;
  const totalChanges = changes.length + (addedIdentities > 0 ? 1 : 0) + noteAdded;
  const dirty = totalChanges > 0;

  // A contact must never be left with no way to reach it. The existing identities are
  // not removable here, so this can only trip if a contact somehow has none on record.
  const identityOk = initial.phones.length + initial.emails.length + addedIdentities > 0;

  const discard = () => {
    setValues(baseline);
    setNewPhones([]);
    setNewEmails([]);
    setNewNote("");
    setError(null);
  };

  const save = () => {
    setError(null);
    if (!identityOk) {
      setError(COPY.needsIdentity);
      return;
    }
    start(async () => {
      const body = buildEditPatch(baseline, values);
      // Added identities ride along on the same patch: updateContact's phone/email are
      // the scalar mirror, and a NEW value only fills them when they were empty.
      const added = checkIdentity(newPhones, newEmails);
      if (added.phones.length > 0 && initial.phones.length === 0) body.phone = added.phones[0];
      if (added.emails.length > 0 && initial.emails.length === 0) body.email = added.emails[0];

      if (Object.keys(body).length > 0) {
        const r = await updateContactAction(clientId, initial.contactId, body);
        if (!r.ok) {
          setError(r.error);
          return;
        }
      }

      // Tags are their own rows — diffed here rather than patched. Three cases, and the
      // middle one is the easy bug: a name already in the CATALOGUE must be attached,
      // not created (creating it fails on the unique name and the tag would vanish).
      if (changes.includes("tags")) {
        const attached = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
        const catalogue = new Map(tagCatalogue.map((t) => [t.name.toLowerCase(), t]));
        const after = new Set(values.tags.map((t) => t.toLowerCase()));

        for (const t of tags) {
          if (!after.has(t.name.toLowerCase())) await detachTagAction(clientId, initial.contactId, t.id);
        }
        for (const name of values.tags) {
          const key = name.toLowerCase();
          if (attached.has(key)) continue; // already on the contact
          const known = catalogue.get(key);
          if (known) {
            await attachTagAction(clientId, initial.contactId, known.id);
            continue;
          }
          // Genuinely new. Only owner/admin may extend the catalogue; a member's
          // unknown name is skipped rather than failing the whole save.
          if (!canManageTagCatalog) continue;
          const created = await createTagAction(clientId, name, "gray");
          if (created.ok && created.id) await attachTagAction(clientId, initial.contactId, created.id);
        }
      }

      if (noteAdded) {
        const n = await addNoteAction(clientId, initial.contactId, newNote.trim());
        if (!n.ok) {
          setError(n.error);
          return;
        }
      }

      router.refresh();
      onClose();
    });
  };

  const remove = () => {
    setError(null);
    start(async () => {
      const r = await deleteContactAction(clientId, initial.contactId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(`/clients/${clientId}/contacts`);
      router.refresh();
    });
  };

  const now = useMemo(() => new Date(), []);

  return (
    <ContactFormDrawer
      title={initial.displayName}
      headerToneStyle={contactToneStyle({
        displayName: initial.displayName,
        primaryIdentity: initial.phones[0] ?? initial.emails[0] ?? null,
      })}
      titleBlock={
        <ContactPanelHeader
          now={now}
          closeAction={
            <button type="button" onClick={onClose} aria-label="Cerrar" className={PANEL_CLOSE_CLS}>
              <PanelCloseIcon />
            </button>
          }
          facts={{
            displayName: initial.displayName,
            primaryIdentity: initial.phones[0] ?? initial.emails[0] ?? null,
            stage: initial.stage,
            isCustomer: initial.isCustomer,
            consent: initial.consent,
            createdAt: initial.createdAt,
            activityCount: initial.activityCount,
          }}
          metrics={{
            activityCount: initial.activityCount,
            lastContactAt: initial.lastContactAt,
            sourceChannel: initial.sourceChannel,
          }}
        />
      }
      onClose={onClose}
      footer={
        <div className="flex flex-col">
          {/* The unsaved-changes bar. Amber, above the actions, with its own Descartar —
              the reference's shape, and the only place the count is stated. */}
          {dirty ? (
            <div className="flex items-center justify-between gap-2 border-b border-warn/25 bg-warn-soft px-3 py-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-warn">
                <span aria-hidden>⚠</span>
                {unsavedLabel(totalChanges)}
              </span>
              <button type="button" onClick={discard} disabled={pending} className="whitespace-nowrap text-xs font-medium text-warn hover:opacity-80">
                Descartar
              </button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="px-3 pt-2 text-xs text-danger">
              {error}
            </p>
          ) : null}

          {confirmDelete ? (
            <div className="flex flex-col gap-2 px-3 py-3">
              <p className="text-xs leading-4 text-foreground">
                ¿Eliminar a <strong>{initial.displayName}</strong>? Se borran sus notas, etiquetas y tareas. Sus
                conversaciones y citas se conservan, pero quedan sin contacto. Si solo quieres sacarlo de la lista,
                cambia el stage a Archivado.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button type="button" onClick={() => setConfirmDelete(false)} className={BTN_SECONDARY} disabled={pending}>
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={remove}
                  disabled={pending}
                  className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-md bg-danger px-3.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45"
                >
                  {pending ? "Eliminando…" : "Sí, eliminar"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 px-3 py-3">
              {/* Delete sits on the LEFT, away from Guardar — they are not neighbours. */}
              {canDelete ? (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={pending} className={BTN_DANGER}>
                  Eliminar
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={onClose} disabled={pending} className={BTN_QUIET}>
                  Cancelar
                </button>
                <button type="button" onClick={save} disabled={pending || !dirty} className={BTN_PRIMARY}>
                  {pending ? "Guardando…" : "Guardar cambios"}
                </button>
              </div>
            </div>
          )}
        </div>
      }
    >
      {/* The SAME component the record's left column renders in `read` mode — one
          declaration of which sections exist, in what order, with which fields. */}
      <ContactSections
        mode="edit"
        clientId={clientId}
        fieldDefs={fieldDefs}
        edit={{
          values,
          onChange: patch,
          owners,
          existingPhones: initial.phones,
          existingEmails: initial.emails,
          newPhones,
          newEmails,
          onNewPhones: setNewPhones,
          onNewEmails: setNewEmails,
          excludeContactId: initial.contactId,
          identityError: identityOk ? null : COPY.needsIdentity,
          consentUpdatedAt: initial.consentUpdatedAt,
          consentSource: initial.consentSource,
          // Unchecking must not invent an explicit refusal: it returns to `unknown`
          // only when the record actually said "opted_in", i.e. the operator is
          // retracting an opt-in rather than asserting a no.
          onConsentToggle: (optedIn: boolean) =>
            patch({
              consent: optedIn ? "opted_in" : initial.consent === "opted_in" ? "unknown" : initial.consent,
            }),
          canManageTagCatalog,
          notesSlot: (
            /* APPEND-ONLY. Existing notes are a timeline with author and date; the
               composer adds an entry. Not a textarea holding "the note" that a second
               save would overwrite. */
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Notas</span>
              {notes.length === 0 ? <p className="text-[11px] text-faint">Todavía no hay notas.</p> : null}
              <ul className="flex flex-col gap-2">
                {notes.map((n) => (
                  <li key={n.id} className="flex gap-2">
                    <Avatar name={n.authorName} fallback={n.createdByUserId ?? "sistema"} size={22} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-1.5">
                        <span className="text-xs font-medium text-foreground">{n.authorName ?? "Sistema"}</span>
                        <span className="u-mono text-[10px] text-faint">{formatDateTime(new Date(n.createdAt))}</span>
                      </span>
                      <p className="whitespace-pre-wrap break-words text-[0.8125rem] leading-5 text-muted">{n.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <textarea
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                rows={2}
                placeholder="Agregar nota…"
                aria-label="Agregar nota"
                className={`${INPUT_CLS} resize-none`}
              />
            </div>
          ),
        }}
      />
    </ContactFormDrawer>
  );
}
