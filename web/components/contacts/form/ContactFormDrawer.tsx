"use client";

import { useEffect, type ReactNode } from "react";
import { useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import {
  CONTACT_PANEL_FRAME,
  CONTACT_PANEL_REGION,
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
 *
 * TWO PLACEMENTS, ONE BOX. Both draw the identical frame; they differ only in what they
 * are anchored to, because the two forms answer to different things:
 *
 *   "region" — EDITING. Absolute inside the page's panel region, i.e. exactly on top of
 *              the ficha it replaces: same top, same bottom, same right edge, same
 *              width. Pressing "Editar" must not move the frame.
 *   "lane"   — CREATING. The ficha's OWN geometry: an in-flow column from xl up (so the
 *              header card and the table narrow to make room, instead of being covered)
 *              and a fixed right-hand sheet below it. There is no ficha underneath to
 *              line up with — a new contact is not a version of an existing one — so
 *              the panel takes the lane itself rather than floating over the page.
 */
export function ContactFormDrawer({
  title,
  subtitle,
  titleBlock,
  headerToneStyle,
  onClose,
  banner,
  footer,
  children,
  labelledBy = "contact-form-title",
  placement = "region",
}: {
  title: string;
  subtitle?: string;
  /** Replaces the plain title/subtitle with the shared contact header block. Editing an
   *  EXISTING contact introduces a person, so it uses the same avatar + chips + context
   *  line the quick view does; creating one has no person to introduce yet. */
  titleBlock?: ReactNode;
  /** The contact's own tone for the header wash. Absent when creating: no contact yet. */
  headerToneStyle?: Record<string, string>;
  onClose: () => void;
  /** The state line above the form (ready / review matches / unsaved changes). */
  banner?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  labelledBy?: string;
  /** Where the box is anchored — see the note above. Defaults to the editor's geometry. */
  placement?: "region" | "lane";
}) {
  const lane = placement === "lane";
  // The SAME breakpoint the ficha beside-s at (see ContactSidePanel): a lane panel is a
  // column from xl up and an overlay below it. A region panel always covers something,
  // so it is always modal.
  const overlaying = useIsOverlayWidth(1279.98);
  const modal = lane ? overlaying : true;
  const panelRef = useTrappedPanel({ active: modal, onClose });

  // Escape closes at EVERY width. The focus trap owns that key while it is engaged, so
  // this only covers the case the trap is deliberately off: a lane panel at xl+, in flow
  // beside the list, where trapping focus would make the rest of the screen unreachable
  // by keyboard for no reason.
  useEffect(() => {
    if (modal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modal, onClose]);

  const shell = (
    <ContactPanelShell
      headerToneStyle={headerToneStyle}
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
  );

  // ── LANE: the ficha's geometry ────────────────────────────────────────────────
  // An in-flow column from xl up, so the header card and the table NARROW to make room
  // instead of being covered; a fixed right-hand sheet below xl, where there is no room
  // to narrow into. Byte-for-byte the wrapper ContactSidePanel uses, which is the point:
  // the ficha and `Nuevo contacto` occupy the same lane, at the same width, with the same
  // top and bottom edges — one of them is simply a form.
  if (lane) {
    return (
      <>
        {/* The catcher only exists while the panel COVERS the list. Beside it there is
            nothing to click through to, and a full-window layer would swallow every
            click on the table it is sitting next to. */}
        <button
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
          className="fixed inset-0 z-40 cursor-default xl:hidden"
        />
        {/* `xl:contents` makes this wrapper vanish from xl up, so the region below drops
            straight into the page's panel lane and the column is in flow. */}
        <div className="fixed inset-y-0 right-0 z-50 flex xl:contents">
          <div
            className={`flex max-w-[90vw] shrink-0 self-stretch ${CONTACT_PANEL_REGION}`}
            style={{ width: CONTACT_PANEL_WIDTH }}
          >
            <aside
              ref={panelRef as React.RefObject<HTMLElement>}
              role="dialog"
              // Only a MODAL when it covers something. Announcing aria-modal beside the
              // list would tell a screen reader the rest of the page is unavailable while
              // it plainly is.
              aria-modal={modal || undefined}
              aria-labelledby={labelledBy}
              className={`u-panel-in min-h-0 flex-1 ${CONTACT_PANEL_FRAME}`}
            >
              {shell}
            </aside>
          </div>
        </div>
      </>
    );
  }

  // ── REGION: exactly on top of the ficha it replaces ──────────────────────────
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
        {shell}
      </aside>
    </>
  );
}

/** The form banner + the footer buttons, re-exported from the neutral chrome. They were
 *  written here, but the staff editor needs the same three tones and the same four
 *  buttons — a second copy is how two editors drift into two looks. */
export { PanelBanner as FormBanner, BTN_PRIMARY, BTN_SECONDARY, BTN_QUIET, BTN_DANGER } from "@/components/ui/panelChrome";
