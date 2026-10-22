"use client";

import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import { useIsOverlayWidth } from "@/components/ui/Overlay";

/**
 * THE AGENDA SIDE PANEL — one frame for the appointment detail, Nueva cita, Atención sin
 * cita, blocks/absences and the schedule editors, so they open, scroll, close and guard
 * their drafts the same way.
 *
 * Desktop (≥ 768 px): a floating panel 520 px wide, 12 px from the top, bottom and right
 * edges, the whole available height. It does NOT darken or trap the screen: the agenda
 * stays readable and usable beside it. Phone: the full screen, actions fixed at the bottom
 * above the safe area. The body scrolls on its own; the header and the footer never cover
 * a field.
 *
 * Closing — the X, Escape, a click outside the panel, Cancelar, or a link elsewhere in the
 * app — asks «Seguir editando / Descartar cambios» while `dirty`; without changes it just
 * closes. Escape closes only the TOP layer (an open menu/listbox/confirmation handles its
 * own Escape first and stops it), so closing a dropdown never discards the form. Focus goes
 * to the panel on open and back to the control that opened it on close.
 */
export interface SidePanelHandle {
  /** Ask to close (runs the unsaved-changes guard). */
  requestClose: () => void;
}

export function SidePanel(props: {
  /** Accessible name. */
  title: ReactNode;
  subtitle?: ReactNode;
  /** Left of the title (a colour stripe, an avatar). */
  leading?: ReactNode;
  /** Right of the title, before the X (a status chip). */
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  dirty?: boolean;
  onClose: () => void;
  /** Lets the parent ask to close through the guard (e.g. a footer "Cancelar"). */
  handleRef?: RefObject<SidePanelHandle | null>;
  /** A layer open above (a confirmation): outside clicks and Escape belong to it. */
  covered?: boolean;
  /** Elements that are part of this interaction although outside the panel (a portalled
   *  menu, the calendar cell that re-targets the draft): clicks there are not "outside". */
  insideSelector?: string;
  /** Close (guarded) on a pointer-down outside the panel. Default true. */
  closeOnOutside?: boolean;
  labelledById?: string;
  /** Phone: back arrow instead of X in the header (multi-step flows). */
  onBack?: () => void;
  backLabel?: string;
  /** data-attribute hook for tests/QA. */
  name?: string;
}) {
  const autoId = useId();
  const titleId = props.labelledById ?? `${autoId}-title`;
  const phone = useIsOverlayWidth(767.98);
  const panelRef = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const [asking, setAsking] = useState(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const nav = useNavigationGuard({ dirty: Boolean(props.dirty), onAsk: () => setAsking(true) });

  const requestClose = useCallback(() => {
    if (latest.current.dirty) setAsking(true);
    else latest.current.onClose();
  }, []);

  useImperativeHandle(props.handleRef, () => ({ requestClose }), [requestClose]);

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panelRef.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]");
    (first ?? node)?.focus({ preventScroll: true });
    return () => {
      const back = returnTo.current;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // Escape: only when nothing above handled it (menus/listboxes call preventDefault).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (latest.current.covered || asking) return;
      // A native <select> open, or a field with its own popup, keeps its Escape.
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-own-escape]")) return;
      e.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [asking, requestClose]);

  // Outside pointer-down (desktop only: on the phone the panel IS the screen).
  useEffect(() => {
    if (phone || props.closeOnOutside === false) return;
    const onDown = (e: PointerEvent) => {
      if (latest.current.covered || asking) return;
      const t = e.target as Element | null;
      if (!t || !t.isConnected) return;
      if (panelRef.current?.contains(t)) return;
      // Layers that belong to the panel (portalled menus, dialogs, toasts).
      if (t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-panel-layer]')) return;
      const sel = latest.current.insideSelector;
      if (sel && t.closest(sel)) return;
      requestClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [phone, props.closeOnOutside, asking, requestClose]);

  return (
    <>
      <aside
        ref={panelRef as RefObject<HTMLElement>}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-side-panel={props.name ?? ""}
        className={
          phone
            ? "u-side-panel-in fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-none"
            : "u-side-panel-in fixed bottom-3 right-3 top-3 z-50 flex w-[min(520px,calc(100vw-24px))] flex-col overflow-hidden rounded-[16px] border border-line bg-popover text-popover-foreground shadow-[var(--shadow-float)] outline-none"
        }
      >
        <header className={`flex shrink-0 items-start gap-3 border-b border-line px-5 pb-3.5 ${phone ? "pt-[max(0.875rem,env(safe-area-inset-top))]" : "pt-4"}`}>
          {phone && props.onBack ? (
            <PanelIconButton label={props.backLabel ?? "Volver"} onClick={props.onBack}>
              <path d="M10 3.5L5.5 8l4.5 4.5" />
            </PanelIconButton>
          ) : null}
          {props.leading}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[17px] font-semibold leading-6 tracking-tight">
              {props.title}
            </h2>
            {props.subtitle ? <div className="mt-0.5 text-[13px] leading-5 text-muted">{props.subtitle}</div> : null}
          </div>
          {props.aside}
          <PanelIconButton label="Cerrar" onClick={requestClose}>
            <path d="M4 4l8 8M12 4l-8 8" />
          </PanelIconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{props.children}</div>
        {props.footer ? (
          <footer className={`shrink-0 border-t border-line bg-inherit px-5 pt-3 ${phone ? "pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "pb-3"}`}>
            {props.footer}
          </footer>
        ) : null}
      </aside>
      {asking ? (
        <ConfirmLayer
          id="panel-discard"
          title="¿Descartar los cambios?"
          body="Hay cambios sin guardar. Si cierras ahora, se pierden."
          cancelLabel="Seguir editando"
          confirmLabel="Descartar cambios"
          onCancel={() => {
            setAsking(false);
            nav.forget();
          }}
          onConfirm={() => {
            setAsking(false);
            if (nav.hasPending()) {
              latest.current.onClose();
              nav.follow();
            } else {
              latest.current.onClose();
            }
          }}
        />
      ) : null}
    </>
  );
}

export function PanelIconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="u-focus -mr-1 grid size-[44px] shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-chip hover:text-foreground md:size-[36px]"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/** A section inside a panel: a small heading and its content, no card. */
export function PanelSection({ title, hint, children, id, action }: { title: ReactNode; hint?: ReactNode; children: ReactNode; id?: string; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5 border-b border-line-soft py-4 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex items-baseline gap-2">
        <h3 id={id} className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">
          {title}
        </h3>
        {action}
      </div>
      {hint ? <p className="-mt-1.5 text-[12.5px] leading-5 text-muted">{hint}</p> : null}
      {children}
    </section>
  );
}
