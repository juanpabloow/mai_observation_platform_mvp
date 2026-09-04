"use client";

import { TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/icons";

import { useState } from "react";
import type { FieldDefView } from "../ContactProperties";
import { ContactCreateForm } from "./ContactCreateForm";
import type { OwnerOption } from "./formPrimitives";

/**
 * The contacts list's primary action. It replaces the DISABLED placeholder that stood
 * here while there was no creation path through C-2's identity chokepoint — see
 * createContactAction, which is that path.
 *
 * The drawer is state, not a route: creating a contact is a detour from the list, and
 * putting it in the URL would make the browser Back button discard a half-filled form.
 */
export function NewContactButton({
  clientId,
  owners,
  fieldDefs,
  defaultOwnerId,
  compact = false,
}: {
  clientId: string;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  defaultOwnerId?: string | null;
  /** When the detail panel is open (design frame 20f), shorten to "+ Nuevo". */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={TOOLBAR_PRIMARY_CLS}
      >
        <IconPlus />
        {compact ? "Nuevo" : "Nuevo contacto"}
      </button>
      {open ? (
        <ContactCreateForm
          clientId={clientId}
          owners={owners}
          fieldDefs={fieldDefs}
          defaultOwnerId={defaultOwnerId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
