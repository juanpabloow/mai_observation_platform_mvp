"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ContactHeaderBlock, type ContactHeaderFacts } from "./ContactHeaderBlock";
import { PANEL_FRAME } from "@/components/ui/panelChrome";

/**
 * THE contact panel interior — one implementation for the list's quick view and the
 * edit drawer.
 *
 * Everything inside the frame is here: the panel's fill, the header's padding and
 * rule, the body's padding and vertical rhythm, the footer's rule. Only the FRAME is
 * the caller's — a card that sits beside the table, or a fixed overlay with a scrim.
 * That is the one difference worth keeping, because it is what says "you are looking"
 * versus "you are changing things".
 *
 * THREE ZONES, both surfaces: a fixed header (and, for the quick view, a fixed tab
 * strip), ONE scrolling body, and a fixed footer where there is one. The panel's
 * height therefore comes from its container, never from the active tab — switching
 * tabs cannot resize it or make the page jump.
 *
 * ONE SURFACE, DIVIDED BY HAIRLINES. The body is plain `--surface` and adds no padding
 * of its own: each section brings its own padding and closes with a full-width rule, so
 * the column reads as one continuous document. That replaced bordered per-section cards
 * on a tinted body, which put a second border inside a panel that already has one and
 * broke the content into floating slabs.
 */

/**
 * THE panel geometry — one definition, both surfaces.
 *
 * Width, radius, hairline and fill live here so the quick view and the edit drawer are
 * literally the same box. They are also anchored the same way: each renders into the
 * page's PANEL REGION (a `relative` container the page provides), the quick view in
 * flow and the drawer absolutely on top of it. That is what makes "Editar" leave the
 * frame exactly where it was — same top edge, same bottom edge, same right edge, same
 * width — with only the contents swapping.
 *
 * The drawer used to be `fixed inset-y-0` against the WINDOW, which is why it could
 * never line up: it spanned the whole viewport height while the quick view stopped at
 * the table card's bottom edge.
 *
 * The width is a CSS VARIABLE (--contact-panel-w, see globals.css) rather than a fixed
 * value: the panel shares its row with the contacts table, which starts clipping its
 * columns below ~880px. Both surfaces read the same variable, so they still match each
 * other at every viewport — which is the property that matters.
 */
export const CONTACT_PANEL_WIDTH = "var(--contact-panel-w)";

/** The box itself: fill, hairline, radius, clip. Identical on both surfaces — and now on
 *  the staff roster's panel too, which is why the definition lives in ui/panelChrome. */
export const CONTACT_PANEL_FRAME = PANEL_FRAME;

/**
 * The region a panel anchors into. The page puts this around its panel column so the
 * overlay drawer can sit exactly on top of the in-flow quick view.
 *
 * It deliberately omits both the DISPLAY and the GROW utilities:
 *  - display, because the quick view is `hidden xl:flex` and a bare `flex` here would
 *    collide with that `hidden` (two display utilities of equal specificity, resolved
 *    by Tailwind's output order rather than by the order they are written);
 *  - `flex-1`, because the axis depends on the parent. As a ROW child it made the panel
 *    grow horizontally and swallow its own `width`, taking half the screen from the
 *    table. Callers add what their axis needs.
 */
export const CONTACT_PANEL_REGION = "relative min-h-0 flex-col";

export function ContactPanelShell({
  header,
  headerToneStyle,
  subheader,
  banner,
  footer,
  scrollResetKey,
  children,
}: {
  /** The header's CONTENT (see ContactPanelHeader); the chrome around it is ours. */
  header: ReactNode;
  /**
   * The CONTACT'S own tone pair (see contactToneStyle), painted as a faint vertical wash
   * behind the header. Omitted where there is no contact yet — the create form has
   * nobody to be the colour of.
   */
  headerToneStyle?: Record<string, string>;
  /** Edge-to-edge strip under the header — the quick view's tab bar. */
  subheader?: ReactNode;
  banner?: ReactNode;
  /**
   * The fixed bottom strip.
   *
   * The rule used to be "a surface that saves nothing has no footer", which is still true
   * of SAVE BARS: the presence of one is what tells an operator they are changing things
   * rather than reading them, so the quick view must never grow one.
   *
   * An ALERT strip is a different object and the quick view does carry one (artboard 22a):
   * a dot, a sentence naming something unresolved about this contact, and the action that
   * resolves it. It sits in the same slot because it has the same job — stay put while the
   * body scrolls — but it asserts nothing about whether the panel writes.
   */
  footer?: ReactNode;
  /**
   * Change this to send the body back to the top — the quick view passes its active
   * tab. Without it, opening Notas after scrolling Actividad drops the reader into
   * the middle of a list they have not seen the start of.
   */
  scrollResetKey?: string | number;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // Only ever scrolls the panel's OWN body — never the page.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [scrollResetKey]);

  return (
    <>
      <div
        // The wash sits on the header only, and fades out downward, so the body below
        // stays a neutral reading surface.
        style={headerToneStyle as React.CSSProperties | undefined}
        className={`shrink-0 border-b border-line bg-surface px-4 pb-3 pt-3.5 ${headerToneStyle ? "u-contact-wash" : ""}`}
      >
        {header}
      </div>
      {subheader ? <div className="shrink-0 bg-surface">{subheader}</div> : null}
      {banner ? <div className="shrink-0 bg-surface px-4 pt-3">{banner}</div> : null}
      {/* THE only scrolling zone. `min-h-0` is what stops a long tab from pushing the
          panel taller than its row instead of scrolling inside it; `items-start` via
          the column flow keeps short content at the TOP rather than stretched or
          centred, so an empty tab shows honest empty space below. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface">
        {children}
      </div>
      {footer ? <div className="shrink-0 border-t border-line bg-surface">{footer}</div> : null}
    </>
  );
}

/**
 * The standard contact header: identity block, metric tiles, and whatever the surface
 * adds below them (the quick view's action row). Composed here so the two panels
 * cannot drift on the order or the spacing between the three.
 */
export function ContactPanelHeader({
  facts,
  closeAction,
  recordAction,
  extra,
}: {
  facts: ContactHeaderFacts;
  /** Null only when the contact could not be re-resolved under this client. */
  closeAction?: ReactNode;
  /** The quiet `Ficha ↗` link on the name line — see ContactHeaderBlock. */
  recordAction?: ReactNode;
  /** Rendered under the metrics. Now empty on the contacts panel: the redesign moved
   *  its three buttons onto the name line and the tab row (see ContactSidePanel). */
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <ContactHeaderBlock facts={facts} actions={closeAction} recordAction={recordAction} />
      {/*
        NO METRIC STRIP. It was a three-tile band — CITAS / ÚLTIMA / CANAL — and the
        artboard (22a) has none, for a good reason: every one of the three is restated
        within 200px of it. CITAS is now "· 14 citas" on the name line, CANAL is "Canal
        preferido" in Mensajería, and ÚLTIMA is derivable from the appointments one tab
        away. It spent ~56px of a 380px panel saying what the panel already said.

        `ContactMetrics` went with it rather than being kept "in case": this shell was its
        only caller, and a component nothing renders is dead code regardless of which
        surface might theoretically want it back.
      */}
      {extra}
    </div>
  );
}

/** The close control, re-exported from the neutral chrome where it now lives: the staff
 *  panel draws the identical glyph, so there is one definition rather than two. */
export { PANEL_CLOSE_CLS, PanelCloseIcon } from "@/components/ui/panelChrome";
