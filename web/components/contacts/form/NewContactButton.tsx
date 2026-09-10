"use client";

import { TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/icons";
import { useOpenNewContact } from "@/components/contacts/ContactsPanelLane";

/**
 * The contacts list's primary action. It replaces the DISABLED placeholder that stood
 * here while there was no creation path through C-2's identity chokepoint — see
 * createContactAction, which is that path.
 *
 * It is now ONLY the button. It used to own the open state and mount the drawer itself,
 * which is what made `Nuevo contacto` float over the page: rendered from inside the
 * header card, an absolutely-positioned panel has no lane to drop into. The drawer moved
 * to ContactsPanelLane — a sibling of the whole list column, i.e. where the ficha already
 * lives — and this asks the lane to open it.
 *
 * Still state and not a route: creating a contact is a detour from the list, and putting
 * a half-filled form in the URL would let the Back button discard it.
 */
export function NewContactButton({ compact = false }: { /** When the detail panel is open (design image 18), shorten to "+ Nuevo". */ compact?: boolean }) {
  const open = useOpenNewContact();
  return (
    <button
      type="button"
      onClick={() => open?.()}
      // Inert outside a lane, visibly. There is nowhere for the drawer to go from there,
      // and a primary that looks live and does nothing is the worse failure.
      disabled={open === null}
      className={TOOLBAR_PRIMARY_CLS}
    >
      <IconPlus />
      {compact ? "Nuevo" : "Nuevo contacto"}
    </button>
  );
}
