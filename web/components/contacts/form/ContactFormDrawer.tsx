"use client";

import type { ReactNode } from "react";
import { useTrappedPanel } from "@/components/ui/Overlay";
import {
  CONTACT_PANEL_FRAME,
  CONTACT_PANEL_WIDTH,
  ContactPanelShell,
  PANEL_CLOSE_CLS,
  PanelCloseIcon,
} from "@/components/contacts/shared/ContactPanelShell";

/**
 * The shell both contact forms render into: a right-hand drawer that COVERS the list.
 *
 * It takes the three obligations ui/Overlay.tsx defines for a covering panel and does
 * not re-invent any of them — scrim, Escape/scrim-to-close, and a focus trap that
 * restores focus on close. A form is exactly the case where the trap earns its keep:
 * tabbing out of a half-filled contact into the table behind it loses the operator's
 * place in a way they cannot see.
 *
 * LAYOUT. Header and footer are fixed; only the middle scrolls. The footer holds the
 * save actions, and a form long enough to scroll (this one is) must never put its
 * primary action below the fold — the reference pins it for the same reason.
 */
export function ContactFormDrawer({
  title,
  subtitle,
  titleBlock,
  headerTone,
  onClose,
  banner,
  footer,
  children,
  labelledBy = "contact-form-title",
}: {
  title: string;
  subtitle?: string;
  /** Replaces the plain title/subtitle with the shared contact header block. Editing an
   *  EXISTING contact introduces a person, so it uses the same avatar + chips + context
   *  line the quick view does; creating one has no person to introduce yet. */
  titleBlock?: ReactNode;
  /** The contact's own tone for the header wash. Absent when creating: no contact yet. */
  headerTone?: string;
  onClose: () => void;
  /** The state line above the form (ready / review matches / unsaved changes). */
  banner?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  labelledBy?: string;
}) {
  const panelRef = useTrappedPanel({ active: true, onClose });

  return (
    <>
      {/* A TRANSPARENT catcher, not a scrim. The dark overlay is gone by design: the
          editor opens on exactly the same box the quick view occupied, so darkening the
          whole window to announce a panel that does not move was noise. What the layer
          still buys is worth keeping — click-outside dismisses, and a stray click on a
          table row cannot navigate away from unsaved edits. */}
      <button type="button" aria-label="Cerrar" onClick={onClose} className="fixed inset-0 z-40 cursor-default" />
      <aside
        ref={panelRef as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        // ABSOLUTE within the page's panel region — NOT fixed to the window. That is
        // the whole reason the frame can land exactly on the quick view it replaces.
        // Width is an inline style, not a Tailwind arbitrary value: a class built from
        // a template literal is invisible to the scanner, so the utility would only
        // exist for as long as some earlier build happened to emit it.
        style={{ width: `min(${CONTACT_PANEL_WIDTH}, 100%)` }}
        className={`u-panel-in absolute inset-y-0 right-0 z-50 ${CONTACT_PANEL_FRAME}`}
      >
        <ContactPanelShell
          headerTone={headerTone}
          banner={banner}
          footer={footer}
          header={
            <div className="flex items-start gap-3">
              {titleBlock ? (
                <div id={labelledBy} className="min-w-0 flex-1">
                  {titleBlock}
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <h2 id={labelledBy} className="truncate text-base font-semibold tracking-tight text-foreground">
                    {title}
                  </h2>
                  {subtitle ? <p className="text-xs leading-4 text-muted">{subtitle}</p> : null}
                </div>
              )}
              {titleBlock ? null : (
                <button type="button" onClick={onClose} aria-label="Cerrar" className={PANEL_CLOSE_CLS}>
                  <PanelCloseIcon />
                </button>
              )}
            </div>
          }
        >
          {children}
        </ContactPanelShell>
      </aside>
    </>
  );
}

/** The form banner + the footer buttons, re-exported from the neutral chrome. They were
 *  written here, but the staff editor needs the same three tones and the same four
 *  buttons — a second copy is how two editors drift into two looks. */
export { PanelBanner as FormBanner, BTN_PRIMARY, BTN_SECONDARY, BTN_QUIET, BTN_DANGER } from "@/components/ui/panelChrome";
