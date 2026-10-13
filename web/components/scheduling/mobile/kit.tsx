"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { initialsOf } from "@/lib/staffTone";

/**
 * SCHEDULING · MOBILE KIT — the pieces the phone layouts are built from, measured from
 * the reference "M_AI Scheduling Móvil v2" (tokens `m-*` in globals.css). Every target
 * is a real 44×44 or larger: the size is on the BUTTON, never borrowed from a parent's
 * padding. Primary actions are 52px tall; list rows 56–64px.
 *
 * Layers (bottom sheets) share one stack: only the TOP layer reacts to Escape and owns
 * Tab; every other part of the page (including lower sheets) is `inert`; page scroll is
 * locked while any layer is open; closing a layer returns focus to what opened it.
 */

// ── Layer stack ─────────────────────────────────────────────────────────────────

interface Layer {
  id: string;
  node: HTMLElement;
  onEscape: () => void;
  restore: HTMLElement | null;
}
const stack: Layer[] = [];
let inertMarked: HTMLElement[] = [];
let listening = false;

function focusables(node: HTMLElement): HTMLElement[] {
  return Array.from(
    node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  ).filter((el) => el.getClientRects().length > 0 && !el.closest("[inert]"));
}

function syncInert() {
  for (const el of inertMarked) el.removeAttribute("inert");
  inertMarked = [];
  const top = stack[stack.length - 1];
  if (!top) return;
  // Everything in <body> except the top layer's own portal container goes inert.
  const host = top.node.closest("[data-m-layer]") as HTMLElement | null;
  for (const child of Array.from(document.body.children) as HTMLElement[]) {
    if (child === host || child.tagName === "SCRIPT" || child.hasAttribute("inert")) continue;
    child.setAttribute("inert", "");
    inertMarked.push(child);
  }
}

function onKey(e: KeyboardEvent) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    top.onEscape();
    return;
  }
  if (e.key !== "Tab") return;
  const items = focusables(top.node);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey && (active === first || !top.node.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !top.node.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

/** Register `node` as the top layer while `open`. `node` comes from a callback ref
 *  (state), not a RefObject: layers render through a Portal whose host appears one
 *  commit later, and the layer must register when the node really exists. */
export function useLayer(open: boolean, node: HTMLElement | null, onEscape: () => void) {
  const id = useId();
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    if (!open || !node) return;
    const layer: Layer = { id, node, onEscape: () => latest.current(), restore: document.activeElement as HTMLElement | null };
    stack.push(layer);
    if (!listening) {
      document.addEventListener("keydown", onKey, true);
      listening = true;
    }
    document.documentElement.style.overflow = "hidden";
    syncInert();
    // Initial focus: the layer's [data-autofocus] (the SAFE choice in a confirmation),
    // else the layer itself — announced by its label, Tab enters it.
    const auto = node.querySelector<HTMLElement>("[data-autofocus]");
    (auto ?? node).focus({ preventScroll: true });
    return () => {
      const i = stack.findIndex((l) => l.id === id);
      const wasTop = i === stack.length - 1;
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) {
        document.documentElement.style.overflow = "";
        document.removeEventListener("keydown", onKey, true);
        listening = false;
      }
      syncInert();
      if (!wasTop) {
        // A LOWER layer closed under another one (both closing together, or a parent
        // unmounting): never steal focus from the top; hand it our restore target if
        // its own one lived inside us and is about to disappear.
        const above = stack[i];
        if (above && (!above.restore || node.contains(above.restore))) above.restore = layer.restore;
        return;
      }
      const back = layer.restore;
      if (back?.isConnected && !back.closest("[inert]")) back.focus({ preventScroll: true });
      else stack[stack.length - 1]?.node.focus({ preventScroll: true });
    };
  }, [open, id, node]);
}

/**
 * The VISUAL viewport (height, offset, and how much the on-screen keyboard covers at the
 * bottom). iOS shrinks it — not the layout viewport nor 100dvh — when the keyboard opens,
 * so fixed footers and sheets follow THIS to stay above the keyboard.
 */
export function useVisualViewport(): { h: number; top: number; bottomInset: number } | null {
  // A string snapshot keeps it stable between identical reads (useSyncExternalStore).
  const key = useSyncExternalStore(
    (cb) => {
      const v = window.visualViewport;
      v?.addEventListener("resize", cb);
      v?.addEventListener("scroll", cb);
      return () => {
        v?.removeEventListener("resize", cb);
        v?.removeEventListener("scroll", cb);
      };
    },
    () => {
      const v = window.visualViewport;
      return v ? `${v.height}|${v.offsetTop}|${Math.max(0, window.innerHeight - v.height - v.offsetTop)}` : "";
    },
    () => "",
  );
  if (!key) return null;
  const [h, top, bottomInset] = key.split("|").map(Number);
  return { h, top, bottomInset };
}

/** Renders into <body>, inside its own `[data-m-layer]` box (what the inert sweep
 *  spares for the top layer). Mounted synchronously on the client — no effect — so the
 *  layer's node exists in the same commit that opens it. */
function Portal({ children }: { children: ReactNode }) {
  const client = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  return client ? createPortal(<div data-m-layer="">{children}</div>, document.body) : null;
}

// ── Sheet ─────────────────────────────────────────────────────────────────────────

/**
 * A bottom sheet: velo (tap = close), 24px top radius, a 40×5 handle on a 44px-tall
 * target. `expandable` sheets open part-way (below `peekTop`) and the handle — tapped
 * or dragged — takes them full screen and back. Footer is pinned with the safe area.
 */
export function Sheet({
  open,
  onClose,
  label,
  alert = false,
  expandable = false,
  peekTop = 112,
  header,
  footer,
  children,
  bodyClassName = "",
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  alert?: boolean;
  expandable?: boolean;
  peekTop?: number;
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [full, setFull] = useState(false);
  const drag = useRef<{ y: number; moved: number } | null>(null);
  useLayer(open, node, onClose);
  const vv = useVisualViewport();
  if (!open) return null;
  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, moved: 0 };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) drag.current.moved = e.clientY - drag.current.y;
  };
  const onUp = () => {
    const d = drag.current?.moved ?? 0;
    drag.current = null;
    if (d < -40) setFull(true);
    else if (d > 60) {
      if (full) setFull(false);
      else onClose();
    }
  };
  const handle = (
    <button
      type="button"
      aria-label={expandable ? (full ? "Reducir hoja" : "Ampliar hoja") : "Cerrar hoja"}
      onClick={() => (expandable ? setFull(!full) : onClose())}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className="flex h-[44px] w-full flex-none touch-none items-center justify-center"
    >
      <span aria-hidden className="h-[5px] w-10 rounded-[3px] bg-m-bd" />
    </button>
  );
  return (
    <Portal>
      <div className="u-sch-m">
        <div aria-hidden onClick={onClose} className="fixed inset-0 z-[80] bg-m-scrim" />
        <div
          ref={setNode}
          role={alert ? "alertdialog" : "dialog"}
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          style={{
            // Lifted above the on-screen keyboard (iOS), capped to what stays visible.
            bottom: vv?.bottomInset ?? 0,
            ...(expandable ? { top: full ? vv?.top ?? 0 : peekTop } : vv ? { maxHeight: vv.h * 0.92 } : {}),
          }}
          className={`fixed inset-x-0 bottom-0 z-[81] flex flex-col bg-m-sf text-m-tx shadow-[0_-8px_30px_rgba(0,0,0,0.15)] transition-[top,border-radius] focus-visible:outline-none duration-200 md:left-1/2 md:right-auto md:w-[min(34rem,100vw)] md:-translate-x-1/2 ${
            expandable ? (full ? "rounded-none pt-[env(safe-area-inset-top)]" : "rounded-t-[24px]") : "max-h-[92dvh] rounded-t-[24px]"
          }`}
        >
          {handle}
          {header}
          <div className={`u-noscroll min-h-0 flex-1 overflow-y-auto overscroll-contain ${bodyClassName}`}>{children}</div>
          {footer ? <div className="flex-none border-t border-m-dv bg-m-sf px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-3">{footer}</div> : null}
        </div>
      </div>
    </Portal>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────────

type BtnKind = "primary" | "secondary" | "danger" | "soft";
const BTN: Record<BtnKind, string> = {
  primary: "border-0 bg-m-pri font-semibold text-m-onpri disabled:bg-m-sf2 disabled:text-m-tx3",
  secondary: "border border-m-bd bg-m-sf text-m-tx disabled:text-m-tx3",
  danger: "border-0 bg-m-dn font-semibold text-m-onpri disabled:opacity-60",
  soft: "border-0 bg-m-sf2 text-m-tx",
};

/** 52px action button (sheet footers, primary bars). */
export function MButton({
  kind = "secondary",
  grow = false,
  loading = false,
  loadingLabel,
  className = "",
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; grow?: boolean; loading?: boolean; loadingLabel?: string }) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`flex h-[52px] items-center justify-center whitespace-nowrap rounded-[12px] px-4 text-[16px] disabled:cursor-default ${grow ? "min-w-0 flex-1" : "flex-none"} ${BTN[kind]} ${className}`}
    >
      {loading && loadingLabel ? loadingLabel : children}
    </button>
  );
}

/** 44px secondary control (Hoy, Cambiar, Ver mes…). */
export const M_SMALL = "flex h-[44px] flex-none items-center gap-2 rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[15px] text-m-tx disabled:text-m-tx3";

/** A 44×44 icon button (search, filters, back, close). */
export function MIconButton({ label, onClick, round = false, soft = false, children }: { label: string; onClick: () => void; round?: boolean; soft?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`relative flex size-[44px] flex-none items-center justify-center border-0 ${round ? "rounded-full" : "rounded-[12px]"} ${soft ? "bg-m-sf2 text-m-tx2" : "bg-transparent text-m-tx"}`}
    >
      {children}
    </button>
  );
}

export function Icon({ d, size = 20, width = 1.5 }: { d: string; size?: number; width?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
export const ICON = {
  search: "M7 11.6A4.6 4.6 0 1 0 7 2.4a4.6 4.6 0 0 0 0 9.2zM10.5 10.5 14 14",
  filter: "M2 4h12M4.5 8h7M7 12h2",
  back: "M10 3 5 8l5 5",
  next: "M6 3l5 5-5 5",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  calendar: "M3 4.5h10v8.5H3zM3 7h10M5.5 3v2.5M10.5 3v2.5",
  phone: "M4 2.5h2l1 3-1.5 1a7 7 0 0 0 4 4l1-1.5 3 1v2a1.5 1.5 0 0 1-1.5 1.5A10.5 10.5 0 0 1 2.5 4 1.5 1.5 0 0 1 4 2.5z",
  chat: "M2.5 13.5l1-3a5.5 5.5 0 1 1 2 2z",
  person: "M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4",
};

// ── Segmented, pills, rows, toggles ─────────────────────────────────────────────

/** Segmented control: a 2px track; every segment is itself 44px tall. */
export function MSegmented<T extends string>({
  label,
  value,
  options,
  onChange,
  stretch = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  stretch?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={`flex flex-none rounded-[12px] bg-m-sf2 p-[2px] ${stretch ? "w-full" : ""}`}>
      {options.map((o) => {
        const sel = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={sel}
            onClick={() => onChange(o.value)}
            className={`flex h-[44px] min-w-[44px] flex-1 items-center justify-center whitespace-nowrap rounded-[10px] border-0 px-[14px] text-[15px] ${
              sel ? "bg-m-sf font-semibold text-m-tx shadow-[0_1px_2px_rgba(0,0,0,0.14)]" : "bg-transparent text-m-tx2"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Selectable pill (categories, filters, reasons): 44px, selected = primary fill. */
export function MPill({ selected, onClick, children, role = "button", dot }: { selected: boolean; onClick: () => void; children: ReactNode; role?: "button" | "radio"; dot?: string }) {
  return (
    <button
      type="button"
      role={role === "radio" ? "radio" : undefined}
      aria-pressed={role === "button" ? selected : undefined}
      aria-checked={role === "radio" ? selected : undefined}
      onClick={onClick}
      className={`flex min-h-[44px] flex-none items-center gap-2 rounded-[12px] border px-[14px] text-[15px] ${
        selected ? "border-m-pri bg-m-pri font-semibold text-m-onpri" : "border-m-bd bg-m-sf text-m-tx"
      }`}
    >
      {dot ? <span aria-hidden className={`size-[10px] flex-none rounded-full ${dot}`} style={{ background: "var(--m-dot)" }} /> : null}
      {children}
    </button>
  );
}

export function MToggle({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`relative block h-[31px] w-[51px] flex-none rounded-[16px] ${on ? "bg-m-pri" : "bg-m-bd"}`}>
      <span className={`absolute top-[2px] size-[27px] rounded-full bg-m-sf shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-[left] ${on ? "left-[22px]" : "left-[2px]"}`} />
    </span>
  );
}
export function MCheck({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={`flex size-6 flex-none items-center justify-center rounded-[7px] text-[14px] font-bold ${on ? "bg-m-pri text-m-onpri" : "border-[1.5px] border-m-tx3"}`}>
      {on ? "✓" : null}
    </span>
  );
}
export function MRadio({ on }: { on: boolean }) {
  return <span aria-hidden className={`block size-6 flex-none rounded-full bg-m-sf ${on ? "border-[7px] border-m-pri" : "border-[1.5px] border-m-tx3"}`} />;
}

/** A card holding rows separated by hairlines. */
export const M_CARD = "overflow-hidden rounded-[16px] border border-m-bd bg-m-sf";
export const M_ROW = "flex w-full items-center gap-3 border-0 border-t border-m-dv bg-transparent py-[10px] pl-[14px] pr-3 text-left text-m-tx first:border-t-0";

// ── State + people ───────────────────────────────────────────────────────────────

export const STATE_LABEL: Record<string, string> = {
  scheduled: "Sin confirmar",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "Inasistencia",
};
export const STATE_ICON: Record<string, string> = { scheduled: "○", confirmed: "✓", completed: "✓✓", cancelled: "✕", no_show: "⊘" };

/** The state chip — glyph + words, never colour alone (26px, radius 8, 13/600). */
export function MStateChip({ status, className = "" }: { status: string; className?: string }) {
  const s = status in STATE_LABEL ? status : "scheduled";
  return (
    <span className={`u-m-st-${s} inline-flex h-[26px] flex-none items-center gap-1 self-start whitespace-nowrap rounded-[8px] px-[9px] text-[13px] font-semibold ${className}`}>
      <span aria-hidden>{STATE_ICON[s]}</span>
      {STATE_LABEL[s]}
    </span>
  );
}

/** Professional avatar colours — saturated (white initials ≥ 4.5:1), decoration only
 *  (the name is always beside it), independent of the appointment's category colour. */
const AVATAR_COLORS = ["#4A5FB5", "#9A5B22", "#6A4BA6", "#2B7650", "#AE3F67", "#28778A"];

/**
 * Colours for a site's team: assigned in a STABLE order (sorted staff ids) so nobody
 * shares a colour up to six people, and every screen that is handed the same team
 * (agenda, booking, Equipo) paints each person the same. Pass it to MStaffAvatar.
 */
export function staffColors(ids: readonly string[]): Map<string, string> {
  return new Map([...new Set(ids)].sort().map((id, i) => [id, AVATAR_COLORS[i % AVATAR_COLORS.length]]));
}

/** Fallback for a person outside a known team list (hash of the id). */
export function staffAvatarColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AVATAR_COLORS[(h >>> 0) % AVATAR_COLORS.length];
}

export function MStaffAvatar({
  id,
  name,
  size = 24,
  color,
  photoUrl,
}: {
  id: string | null;
  name: string | null;
  size?: number;
  color?: string;
  /** The professional's public photo (Equipo → Perfil público); initials when absent. */
  photoUrl?: string | null;
}) {
  const fs = size >= 56 ? 18 : size >= 40 ? 14 : size >= 28 ? 11 : 9.5;
  if (id && photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
    return <img src={photoUrl} alt="" aria-hidden className="flex-none rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full font-semibold leading-none tracking-[0.02em]"
      style={{ width: size, height: size, fontSize: fs, background: id ? color ?? staffAvatarColor(id) : "var(--m-sf2)", color: id ? "#fff" : "var(--m-tx2)" }}
    >
      {id ? initialsOf(name) : "✱"}
    </span>
  );
}

/** A client avatar: neutral circle with initials. */
export function MClientAvatar({ name, size = 44 }: { name: string | null; size?: number }) {
  return (
    <span aria-hidden className="flex flex-none items-center justify-center rounded-full bg-m-sf2 font-semibold leading-none text-m-tx" style={{ width: size, height: size, fontSize: size >= 44 ? 14 : 13 }}>
      {name ? initialsOf(name) : "—"}
    </span>
  );
}

/** The confirmation body every destructive step uses (inside a <Sheet alert>). */
export function MConfirm({ title, body, children }: { title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-[14px] px-4 pb-2">
      <span aria-hidden className="flex size-[44px] items-center justify-center rounded-full bg-m-dnbg text-[20px] font-semibold text-m-dn">
        !
      </span>
      <div className="flex flex-col gap-1.5">
        <span className="text-[20px] font-semibold leading-[1.25]">{title}</span>
        <span className="text-[15px] leading-[1.45] text-m-tx2">{body}</span>
      </div>
      {children}
    </div>
  );
}

/** Short success notice after an action (role=status). */
export function MToast({ message, bottom = 100 }: { message: string | null; bottom?: number }) {
  if (!message) return null;
  return (
    // `u-sch-m` sets the scope's text colour unlayered, so the toast's own colours live on
    // an INNER element (on the same element they would lose to it).
    <div className="u-sch-m">
      <div role="status" aria-live="polite" style={{ bottom }} className="fixed inset-x-4 z-[90] flex min-h-[48px] items-center gap-2.5 rounded-[12px] bg-m-pri px-4 py-3 text-[15px] text-m-onpri shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
        <span aria-hidden>✓</span>
        {message}
      </div>
    </div>
  );
}

// ── Full-screen layer ────────────────────────────────────────────────────────────

/**
 * A full-screen flow (booking): same layer contract as Sheet — inert background, focus
 * trap, Escape, scroll lock, focus restore — but covering the whole viewport, with a
 * fixed header and footer and a scrolling body between them, sized to the VISUAL
 * viewport so the on-screen keyboard shrinks the body instead of covering the footer.
 */
export function MScreen({ label, onEscape, header, footer, children }: { label: string; onEscape: () => void; header: ReactNode; footer: ReactNode; children: ReactNode }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  useLayer(true, node, onEscape);
  // On iOS the keyboard shrinks the VISUAL viewport but not 100dvh — follow it, so the
  // footer (Continuar / Crear cita) never ends up under the keyboard.
  const vh = useVisualViewport();
  return (
    <Portal>
      <div className="u-sch-m">
        <div
          ref={setNode}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
          style={{ height: vh ? `${vh.h}px` : "100dvh", top: vh ? `${vh.top}px` : 0 }}
          className="fixed inset-x-0 z-[75] flex flex-col bg-m-bg text-m-tx focus-visible:outline-none"
        >
          <header className="flex-none border-b border-m-bd bg-m-sf px-4 pb-3 pt-[max(8px,env(safe-area-inset-top))]">{header}</header>
          <div className="u-noscroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 pt-4">{children}</div>
          <footer className="flex-none border-t border-m-bd bg-m-sf px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[10px]">{footer}</footer>
        </div>
      </div>
    </Portal>
  );
}
