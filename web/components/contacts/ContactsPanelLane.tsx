"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { ContactCreateForm } from "@/components/contacts/form/ContactCreateForm";
import type { FieldDefView } from "@/components/contacts/ContactProperties";
import type { OwnerOption } from "@/components/contacts/form/formPrimitives";

/**
 * THE CONTACTS PANEL LANE — the page's right-hand column, and the one place that decides
 * who is in it.
 *
 * There are two panels on this screen and they are the same object at the same width:
 * the FICHA (a row is selected, `?c=`) and NUEVO CONTACTO. They differ in what they hold,
 * not in where they live, so they share the lane and only one occupies it at a time.
 *
 * WHY THIS EXISTS. The create drawer used to be local state inside the header card's
 * button, rendered `absolute inset-y-0 right-0` — and with no positioned ancestor up
 * that subtree it resolved against the document, so it floated OVER the header and the
 * table. Two panels of identical width behaved like two different kinds of thing: pick a
 * row and the list politely narrowed; press `Nuevo contacto` and a sheet dropped on top
 * of it. Now both narrow the list, because both are the lane.
 *
 * The open state stays STATE, not a route. `?c=` is a selection — a fact about what you
 * are looking at, worth putting in a URL that can be shared and navigated back through.
 * A half-filled form is not: making it `?new=1` would let the Back button discard typing,
 * and a shared link would open somebody else's blank form. So the button (in the header
 * card) and the lane (a sibling of the whole list column) talk through a context instead
 * of through the URL — one provider, one consumer, no prop threaded through the toolbar.
 *
 * The lane renders NO box of its own. Each occupant brings the geometry, from the same
 * two constants: ContactSidePanel and ContactFormDrawer's "lane" placement are the same
 * wrapper — an in-flow column from xl up, a fixed sheet below it.
 */

export interface NewContactProps {
  clientId: string;
  owners: OwnerOption[];
  fieldDefs: FieldDefView[];
  defaultOwnerId?: string | null;
  canManageTagCatalog: boolean;
}

/** Null outside a lane, which is what makes the button inert rather than silently dead. */
const OpenNewContactCtx = createContext<(() => void) | null>(null);

/** For the toolbar's primary. Returns null when rendered outside the lane. */
export function useOpenNewContact(): (() => void) | null {
  return useContext(OpenNewContactCtx);
}

export function ContactsPanelLane({
  create,
  ficha,
  children,
}: {
  /** Everything the create form needs, loaded with the page (owners, business fields). */
  create: NewContactProps;
  /**
   * The selected contact's panel, server-rendered. A ReactNode rather than a flag,
   * because its data comes from the page's own loaders — the lane only decides whether
   * it is on screen, never what is in it.
   */
  ficha: ReactNode;
  /** The list column: the duplicate callout, the header card, the table card. */
  children: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const open = useCallback(() => setCreating(true), []);
  const close = useCallback(() => setCreating(false), []);

  return (
    <OpenNewContactCtx.Provider value={open}>
      {children}
      {/*
        ONE OCCUPANT. Creating REPLACES the ficha for as long as the form is open rather
        than opening a second 384px column beside it: at 1280px two lanes leave the table
        about 300px, which is narrower than its own columns and turns a "+" into a broken
        list. The selection survives in `?c=` — closing the form brings the same ficha
        straight back, no navigation, nothing refetched.
      */}
      {creating ? <ContactCreateForm {...create} placement="lane" onClose={close} /> : ficha}
    </OpenNewContactCtx.Provider>
  );
}
