"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, ICON, MToggle, useLayer } from "@/components/scheduling/mobile/kit";

/**
 * A FULL-SCREEN form layer for the phone Equipo screens (create, edit profile, hours,
 * certification). It joins the kit's layer stack (`useLayer`): the page behind goes
 * inert, Tab stays inside, Escape closes the top layer, focus returns to the opener and
 * page scroll is locked.
 *
 * KEYBOARD. A `fixed inset-0` box does not shrink when the on-screen keyboard opens (the
 * LAYOUT viewport stays the same; only the VISUAL viewport shrinks), so a pinned footer
 * and the focused field would sit under the keyboard. The layer follows
 * `window.visualViewport` instead — its height and offset — so the footer rides above
 * the keyboard and the body (the only scrolling zone) scrolls the focused field into view.
 */

function subscribeViewport(cb: () => void) {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", cb);
  vv.addEventListener("scroll", cb);
  return () => {
    vv.removeEventListener("resize", cb);
    vv.removeEventListener("scroll", cb);
  };
}
function viewportSnapshot(): string {
  const vv = window.visualViewport;
  return vv ? `${Math.round(vv.height)}|${Math.round(vv.offsetTop)}` : "";
}
function useVisualViewport(): { height: number; top: number } | null {
  const snap = useSyncExternalStore(subscribeViewport, viewportSnapshot, () => "");
  if (!snap) return null;
  const [height, top] = snap.split("|").map(Number);
  return { height, top };
}

const noop = () => () => {};
/** Portals into <body> inside its own `[data-m-layer]` host — the element the kit's inert
 *  sweep leaves alone for the top layer. Client-only (null during SSR/hydration). */
export function LayerPortal({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(noop, () => true, () => false);
  return client ? createPortal(<div data-m-layer="">{children}</div>, document.body) : null;
}

export function FullScreen({
  open,
  onClose,
  backLabel,
  title,
  sub,
  footer,
  children,
}: {
  open: boolean;
  /** Back / Escape. The caller decides whether that asks to discard first. */
  onClose: () => void;
  backLabel: string;
  title: string;
  sub?: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <LayerPortal>
      <Layer onClose={onClose} backLabel={backLabel} title={title} sub={sub} footer={footer}>
        {children}
      </Layer>
    </LayerPortal>
  );
}

function Layer({
  onClose,
  backLabel,
  title,
  sub,
  footer,
  children,
}: {
  onClose: () => void;
  backLabel: string;
  title: string;
  sub?: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  // A callback ref held in state: the node exists only once the portal has committed, and
  // the kit's useLayer registers the layer when it arrives.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const vv = useVisualViewport();
  useLayer(true, node, onClose);
  return (
    <div className="u-sch-m">
      <div
        ref={setNode}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={vv ? { top: vv.top, height: vv.height } : undefined}
        className={`fixed inset-x-0 z-[82] flex flex-col bg-m-bg text-m-tx ${vv ? "" : "inset-y-0"}`}
      >
        <header className="flex-none border-b border-m-bd bg-m-sf px-2 pb-[14px] pt-[max(6px,env(safe-area-inset-top))]">
          <div className="flex min-h-[44px] items-center">
            <button
              type="button"
              onClick={onClose}
              className="flex h-[44px] flex-none items-center gap-0.5 rounded-[12px] border-0 bg-transparent pl-1 pr-2 text-[16px] text-m-tx"
            >
              <Icon d={ICON.back} width={1.6} />
              <span className="whitespace-nowrap">{backLabel}</span>
            </button>
          </div>
          <div className="flex flex-col gap-0.5 px-2 pt-1">
            <h2 className="m-0 text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] [text-wrap:pretty]">{title}</h2>
            {sub ? <span className="text-[14px] leading-[1.35] text-m-tx3">{sub}</span> : null}
          </div>
        </header>
        <div
          className="u-noscroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-8 pt-4"
          // Keep the field being typed into visible once the keyboard has resized us.
          onFocus={(e) => {
            const el = e.target as HTMLElement;
            if (!/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
            window.setTimeout(() => el.scrollIntoView({ block: "nearest" }), 260);
          }}
        >
          {children}
        </div>
        <footer className="flex flex-none gap-2 border-t border-m-bd bg-m-sf px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3">{footer}</footer>
      </div>
    </div>
  );
}

// ── Form pieces (reference: 16px fields, radius 12, labels always visible) ──────────

export const M_INPUT =
  "h-12 w-full min-w-0 rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx placeholder:text-m-tx3 disabled:bg-m-sf2 disabled:text-m-tx3";

export function MField({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-[15px] font-semibold text-m-tx">
        {label}
        {hint ? <span className="font-normal text-m-tx3"> {hint}</span> : null}
      </label>
      {children}
    </div>
  );
}

/** A labelled section of a long form or of the detail screen. */
export function MSection({ title, meta, action, children }: { title: string; meta?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-[24px] items-center gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {meta ? <span className="text-[13px] text-m-tx3">{meta}</span> : null}
        {action ? <span className="ml-auto flex">{action}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function MError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-[12px] border border-m-dnbd bg-m-dnbg px-[14px] py-3 text-[15px] leading-[1.4] text-m-dn">
      {message}
    </div>
  );
}

/** A switch row (52px+): label + consequence on the left, the kit toggle on the right. */
export function MSwitchRow({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex min-h-[56px] w-full items-center gap-3 rounded-[16px] border border-m-bd bg-m-sf px-[14px] py-2 text-left text-m-tx"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[16px]">{label}</span>
        {hint ? <span className="text-[13px] leading-[1.35] text-m-tx3">{hint}</span> : null}
      </span>
      <MToggle on={on} />
    </button>
  );
}
