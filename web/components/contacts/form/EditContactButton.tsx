"use client";

import { useState } from "react";
import type { NoteView, TagView } from "@/lib/contactShared";
import type { FieldDefView } from "../ContactProperties";
import { ContactEditForm, type ContactEditInitial } from "./ContactEditForm";
import type { OwnerOption } from "./formPrimitives";

/**
 * THE WAY IN. Without this the contact form would exist and be unreachable — the record
 * page edits field-by-field and has no whole-contact editor, and the list's row menu
 * opens the side panel, not a form.
 *
 * Deliberately the MINIMUM entry point: one button in the record header opening the
 * drawer. Redesigning the record page (or the list) is out of scope for this change,
 * so this adds a door and touches nothing else on either screen.
 */
export function EditContactButton({
  clientId,
  initial,
  owners,
  fieldDefs,
  tags,
  tagCatalogue,
  notes,
  canDelete,
  canManageTagCatalog,
  className,
}: {
  clientId: string;
  initial: ContactEditInitial;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  tags: TagView[];
  tagCatalogue: TagView[];
  notes: NoteView[];
  canDelete: boolean;
  canManageTagCatalog: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong bg-surface px-3 text-sm text-foreground transition-colors hover:bg-subtle"
        }
      >
        Editar contacto
      </button>
      {open ? (
        <ContactEditForm
          clientId={clientId}
          initial={initial}
          owners={owners}
          fieldDefs={fieldDefs}
          tags={tags}
          tagCatalogue={tagCatalogue}
          notes={notes}
          canDelete={canDelete}
          canManageTagCatalog={canManageTagCatalog}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
