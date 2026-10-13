"use client";

import { useEffect, type ReactNode, type RefObject } from "react";
import { useIsOverlayWidth, useTrappedPanel } from "@/components/ui/Overlay";
import { ConfirmDialog, IconButton, useModalLayer } from "@/components/ui/controls";
import { useKeyboardInset } from "@/components/ui/useKeyboardInset";
import { CONTACT_PANEL_FRAME, CONTACT_PANEL_REGION, CONTACT_PANEL_WIDTH, ContactPanelShell } from "@/components/contacts/shared/ContactPanelShell";

/** What the drawer needs from useLeaveGuard to ask "¿Descartar los cambios?". */
export interface DrawerLeaveGuard {
  asking: boolean;
  onEscape: () => void;
  keepEditing: () => void;
  discard: () => void;
}

/** The close (×) control — the shared IconButton: 44px on touch, 36px from lg. */
export function DrawerCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton label="Cerrar" onClick={onClick}>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </IconButton>
  );
}

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
  guard,
  discardBody = "Lo que escribiste no se ha guardado.",
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
  /**
   * The unsaved-changes guard (useLeaveGuard). With it, `onClose` is the guard's
   * requestLeave (asks when there are real changes), Escape closes the question first,
   * and the drawer renders the shared "¿Descartar los cambios?" over itself.
   */
  guard?: DrawerLeaveGuard;
  discardBody?: string;
}) {
  const lane = placement === "lane";
  // The SAME breakpoint the ficha beside-s at (see ContactSidePanel): a lane panel is a
  // column from xl up and an overlay below it. A region panel always covers something,
  // so it is always modal.
  const overlaying = useIsOverlayWidth(1279.98);
  const modal = lane ? overlaying : true;
  const onEscape = guard ? guard.onEscape : onClose;
  const panelRef = useTrappedPanel({ active: modal, onClose: onEscape });
  // The question is a modal LAYER over the form: everything behind it is inert, focus
  // lands on "Seguir editando" (the safe choice) and returns when it closes.
  const discardLayer = useModalLayer(Boolean(guard?.asking), panelRef as RefObject<HTMLElement | null>);
  // Keep the footer (Guardar) above an on-screen keyboard, and the focused field in view.
  const keyboard = useKeyboardInset(panelRef as RefObject<HTMLElement | null>);

  // Escape closes at EVERY width. The focus trap owns that key while it is engaged, so
  // this only covers the case the trap is deliberately off: a lane panel at xl+, in flow
  // beside the list, where trapping focus would make the rest of the screen unreachable
  // by keyboard for no reason.
  useEffect(() => {
    if (modal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [modal, onEscape]);

  const discardDialog = guard?.asking ? (
    <ConfirmDialog
      layerRef={discardLayer.layerRef}
      id={`${labelledBy}-discard`}
      title="¿Descartar los cambios?"
      body={discardBody}
      cancelLabel="Seguir editando"
      confirmLabel="Descartar"
      onCancel={guard.keepEditing}
      onConfirm={guard.discard}
    />
  ) : null;

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
            <span className="-mr-2 -mt-1.5 shrink-0">
              <DrawerCloseButton onClick={onClose} />
            </span>
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
        {/* Full width on a phone (the old 90vw cap left a 44px sliver of list beside a
            346px form); the panel width from sm up. `bottom` follows the keyboard. */}
        <div className="fixed inset-y-0 right-0 z-50 flex xl:contents max-sm:left-0" style={keyboard ? { bottom: keyboard } : undefined}>
          <div
            className={`flex w-full shrink-0 self-stretch sm:w-[var(--contact-panel-region-w)] sm:max-w-[90vw] ${CONTACT_PANEL_REGION}`}
          // The shared width rides a CSS variable so the phone can take the full width
          // (a 90vw sheet left a 44px sliver of list beside the form) while sm+ keeps it.
          style={{ "--contact-panel-region-w": CONTACT_PANEL_WIDTH } as React.CSSProperties}
          >
            <aside
              ref={panelRef as React.RefObject<HTMLElement>}
              role="dialog"
              // Only a MODAL when it covers something. Announcing aria-modal beside the
              // list would tell a screen reader the rest of the page is unavailable while
              // it plainly is.
              aria-modal={modal || undefined}
              aria-labelledby={labelledBy}
              className={`u-panel-in relative min-h-0 flex-1 max-sm:rounded-none max-sm:border-0 ${CONTACT_PANEL_FRAME}`}
            >
              <div inert={guard?.asking || undefined} className="contents">
                {shell}
              </div>
              {discardDialog}
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
        // Full width on a phone; the shared panel width from sm (via a CSS variable, so
        // the class stays a static, scanner-visible string).
        style={{ "--contact-drawer-w": `min(${CONTACT_PANEL_WIDTH}, 100%)`, ...(keyboard ? { bottom: keyboard } : null) } as React.CSSProperties}
        className={`u-panel-in absolute inset-y-0 right-0 z-50 w-full sm:w-[var(--contact-drawer-w)] max-sm:rounded-none max-sm:border-0 ${CONTACT_PANEL_FRAME}`}
      >
        <div inert={guard?.asking || undefined} className="contents">
          {shell}
        </div>
        {discardDialog}
      </aside>
    </>
  );
}

/** The form banner + the footer buttons, re-exported from the neutral chrome. They were
 *  written here, but the staff editor needs the same three tones and the same four
 *  buttons — a second copy is how two editors drift into two looks. */
export { PanelBanner as FormBanner } from "@/components/ui/panelChrome";

/**
 * The footer BOTH contact forms use: the form-level message, then one row with the
 * form's own extra on the left ("Guardar y crear otro" when creating, "Eliminar" when
 * editing) and the actions on the right. On a phone the extra takes its own line and
 * the actions split the width, so neither wraps nor shrinks below 44px. The bottom
 * padding clears the iPhone home indicator.
 */
export function DrawerActions({
  error,
  notice,
  leading,
  children,
}: {
  error?: string | null;
  notice?: string | null;
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      {error ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-danger">
          <span aria-hidden>⚠</span>
          <span>{error}</span>
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-warn">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        {leading ? <div className="flex min-w-0 items-center">{leading}</div> : <span aria-hidden className="hidden sm:block" />}
        <div className="flex items-center gap-2 max-sm:[&>*]:flex-1">{children}</div>
      </div>
    </div>
  );
}
