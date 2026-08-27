"use client";

import { DuplicateBanner, type CandidateView } from "./DuplicateBanner";
import { Panel } from "@/components/ui/primitives";
import { ContactSections, type ContactReadValues } from "./form/ContactSections";

/**
 * The record's LEFT column: who this is, then the contact's properties AS FACTS.
 *
 * IT IS READ-ONLY, and that is the change. It used to edit field by field — click a
 * value, get an input, save a one-field patch — which made it a SECOND editor
 * competing with the drawer. Two editors is not a redundancy, it is a fork: they
 * offered different fields (this one never had "no contactar" or a preferred channel),
 * they wrote through different code paths, and they printed different words for the
 * same value ("new" here, "Nuevo" there).
 *
 * So writing now happens in exactly one place — the "Editar contacto" button in the
 * record header, which opens the drawer. This column renders the SAME
 * `ContactSections` component the drawer does, in `read` mode, so the two cannot
 * disagree about which fields exist, their order, or what they are called.
 *
 * `updateContactAction` is deliberately still alive: the drawer is its caller now.
 */

export type FieldType = "text" | "number" | "date" | "select" | "boolean";
export interface FieldDefView {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
}

export function ContactProperties({
  clientId,
  contactId,
  candidates,
  canManageDuplicates,
  values,
  fieldDefs,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  candidates: CandidateView[];
  canManageDuplicates: boolean;
  /** The contact's properties, already humanised-ready (raw stored values in, labels
   *  applied by the shared section renderer). */
  values: ContactReadValues;
  fieldDefs: FieldDefView[];
  onChanged?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* The duplicate banner sits OUTSIDE the card: it is about a problem with this
          record, not one of its sections, and putting it inside would make the card's
          first hairline separate an alert from a field list. */}
      {canManageDuplicates ? (
        <DuplicateBanner clientId={clientId} contactId={contactId} candidates={candidates} onChanged={onChanged} />
      ) : null}

      {/*
        ONE WHITE CARD holds every section, divided by hairlines (artboard 23a).

        The sections used to sit straight on the grey canvas, which made the column read as
        four loose lists rather than as one document about a person — and it was the single
        biggest reason the page did not look like the design. Each section already brings
        its own padding and closes with a full-width rule (see ContactSections), so the
        card only has to supply the fill, the edge and the clip; `overflow-hidden` is what
        lets those edge-to-edge rules stop at the rounded corners instead of squaring them.
      */}
      <Panel className="flex flex-1 flex-col overflow-hidden shadow-[var(--shadow-card)]">
        <ContactSections mode="read" columns={1} clientId={clientId} fieldDefs={fieldDefs} read={values} />
      </Panel>
    </div>
  );
}
