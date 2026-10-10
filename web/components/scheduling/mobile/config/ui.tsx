"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { initialsOf } from "@/lib/staffTone";
import { MButton, MConfirm, MToggle, Sheet, staffColors } from "../kit";

/**
 * CONFIGURACIÓN · MÓVIL — the frame every phone settings screen is built from (measured
 * from the reference "M_AI Scheduling Móvil v2", screens 4.1–4.14): a pinned header, ONE
 * scrolling body, and a pinned footer with the safe area, all in a flex column so the
 * footer never covers the content and a focused input scrolls into view.
 */

// ── Navigation (URL state, so the browser / system back works) ───────────────────

export type ConfigScreen =
  | "sedes"
  | "sede"
  | "sede-editar"
  | "sede-nueva"
  | "servicios"
  | "servicio"
  | "bloqueos"
  | "bloqueo-nuevo"
  | "reglas";

const OWN_PARAMS = ["m", "id", "cat", "plantilla", "vista"];

export interface ConfigNav {
  screen: ConfigScreen | null;
  id: string | null;
  param: (k: string) => string | null;
  go: (screen: ConfigScreen | null, id?: string | null, extra?: Record<string, string>) => void;
  /** Leave to the parent: a real history.back() when we pushed this entry (so the
   *  browser stack stays honest), else a replace to `parent`. */
  back: (parent: ConfigScreen | null, parentId?: string | null) => void;
  /** Change a parameter of the CURRENT screen without a history entry. */
  setParam: (k: string, v: string | null) => void;
}

/**
 * Screens live in `?m=` (+ `id`, …). Changes go through the native history API, which
 * the Next.js router integrates with (useSearchParams follows it) — no server round
 * trip per screen, and Back/Forward walk the screens.
 */
export function useConfigNav(): ConfigNav {
  const params = useSearchParams();
  const pushed = useRef(0);
  useEffect(() => {
    const onPop = () => {
      if (pushed.current > 0) pushed.current -= 1;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const urlFor = useCallback((screen: ConfigScreen | null, id?: string | null, extra?: Record<string, string>) => {
    const p = new URLSearchParams(window.location.search);
    for (const k of OWN_PARAMS) p.delete(k);
    if (screen) p.set("m", screen);
    if (id) p.set("id", id);
    for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
    const q = p.toString();
    return q ? `${window.location.pathname}?${q}` : window.location.pathname;
  }, []);

  const go = useCallback<ConfigNav["go"]>(
    (screen, id, extra) => {
      pushed.current += 1;
      window.history.pushState(null, "", urlFor(screen, id, extra));
    },
    [urlFor],
  );
  const back = useCallback<ConfigNav["back"]>(
    (parent, parentId) => {
      if (pushed.current > 0) window.history.back();
      else window.history.replaceState(null, "", urlFor(parent, parentId));
    },
    [urlFor],
  );
  const setParam = useCallback<ConfigNav["setParam"]>((k, v) => {
    const p = new URLSearchParams(window.location.search);
    if (v === null) p.delete(k);
    else p.set(k, v);
    const q = p.toString();
    window.history.replaceState(null, "", q ? `${window.location.pathname}?${q}` : window.location.pathname);
  }, []);

  return {
    screen: (params.get("m") as ConfigScreen | null) ?? null,
    id: params.get("id"),
    param: (k) => params.get(k),
    go,
    back,
    setParam,
  };
}

/** true after hydration (no setState-in-effect). */
const noop = () => () => {};
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}

/** A short-lived success notice. */
export function useToast(): [string | null, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const show = useCallback((m: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMsg(m);
    timer.current = setTimeout(() => setMsg(null), 2600);
  }, []);
  return [msg, show];
}

/** Avatar colours exactly as the agenda paints them: per SITE team, inactive included. */
export function siteStaffColors(staff: ReadonlyArray<{ id: string; site_id: string }>, siteId: string): Map<string, string> {
  return staffColors(staff.filter((p) => p.site_id === siteId).map((p) => p.id));
}

// ── Icons (16-unit paths, from the reference) ────────────────────────────────────

export const CFG_ICON = {
  sede: "M8 14s5-4.2 5-8A5 5 0 0 0 3 6c0 3.8 5 8 5 8zM8 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
  svc: "M3 3.5h10M3 8h10M3 12.5h6",
  team: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM11 7a2 2 0 1 0 0-4M1.5 13c.4-2.2 2-3.5 4-3.5s3.6 1.3 4 3.5M11 9.5c1.8 0 3.2 1.2 3.5 3.5",
  block: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4",
  rules: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
};

export function Glyph({ d, size = 20, width = 1.4 }: { d: string; size?: number; width?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export function Chevron({ open }: { open?: boolean }) {
  return (
    <span aria-hidden className={`inline-block flex-none text-[20px] leading-none text-m-tx3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
      ›
    </span>
  );
}

// ── Classes ──────────────────────────────────────────────────────────────────────

export const INPUT_M =
  "h-[48px] w-full min-w-0 rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx placeholder:text-m-tx3 aria-[invalid=true]:border-m-dn";
export const SELECT_M =
  "h-[48px] w-full min-w-0 rounded-[12px] border border-m-bd bg-m-sf px-[12px] text-[16px] text-m-tx";
export const CARD_M = "overflow-hidden rounded-[16px] border border-m-bd bg-m-sf";
/** A tappable list row (reference H.row): ≥60px, hairline between rows. */
export const ROW_M =
  "flex w-full min-h-[60px] items-center gap-[12px] border-0 border-t border-m-dv bg-transparent py-[10px] pl-[14px] pr-[12px] text-left text-m-tx first:border-t-0";
export const H2_M = "m-0 text-[15px] font-semibold";
export const LABEL_M = "text-[14px] font-semibold";
export const META_M = "text-[13px] text-m-tx3";

// ── Frame ────────────────────────────────────────────────────────────────────────

/** The top-level header (Inicio): client avatar, 21px title, sub. */
export function TopHeader({ name, title, sub }: { name: string; title: string; sub: string }) {
  return (
    <header className="flex-none border-b border-m-bd bg-m-sf px-[16px] pb-[12px] pt-[10px]">
      <div className="flex min-h-[44px] items-center gap-[10px]">
        <span aria-hidden className="flex size-[36px] flex-none items-center justify-center rounded-full bg-m-pri text-[12px] font-semibold text-m-onpri">
          {initialsOf(name)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="m-0 truncate text-[21px] font-semibold leading-[1.2] tracking-[-0.01em]">{title}</h1>
          <span className="truncate text-[13px] leading-[1.3] text-m-tx3">{sub}</span>
        </div>
      </div>
    </header>
  );
}

/** A sub-screen header: "‹ Atrás"-style back row, optional 44×44 action, 24px title. */
export function SubHeader({
  backLabel,
  onBack,
  title,
  sub,
  action,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  sub?: string | null;
  action?: { label: string; text: ReactNode; onClick: () => void } | null;
}) {
  return (
    <header className="flex-none border-b border-m-bd bg-m-sf px-[8px] pb-[14px] pt-[6px]">
      <div className="flex min-h-[44px] items-center">
        <button
          type="button"
          onClick={onBack}
          className="flex h-[44px] min-w-[44px] max-w-[70%] flex-none items-center gap-[2px] rounded-[12px] border-0 bg-transparent pl-[4px] pr-[8px] text-[16px] text-m-tx"
        >
          <Glyph d="M10 3 5 8l5 5" width={1.6} />
          <span className="truncate">{backLabel}</span>
        </button>
        {action ? (
          <button
            type="button"
            aria-label={action.label}
            onClick={action.onClick}
            className="ml-auto flex size-[44px] flex-none items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[20px] text-m-tx"
          >
            {action.text}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-[2px] px-[8px] pt-[4px]">
        <h1 className="m-0 text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] [overflow-wrap:anywhere]">{title}</h1>
        {sub ? <span className="text-[14px] leading-[1.35] text-m-tx3">{sub}</span> : null}
      </div>
    </header>
  );
}

export function Screen({
  header,
  footer,
  children,
  bodyRef,
  label,
}: {
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  bodyRef?: React.Ref<HTMLDivElement>;
  label?: string;
}) {
  return (
    <section aria-label={label} className="flex min-h-0 flex-1 flex-col">
      {header}
      <div ref={bodyRef} className="u-noscroll flex min-h-0 flex-1 flex-col gap-[16px] overflow-y-auto overscroll-contain px-[16px] pb-[32px] pt-[16px] [&>*]:shrink-0">
        {children}
      </div>
      {footer ? (
        <footer className="flex flex-none gap-[8px] border-t border-m-bd bg-m-sf px-[16px] pb-[max(20px,env(safe-area-inset-bottom))] pt-[12px]">{footer}</footer>
      ) : null}
    </section>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="m-0 text-[12.5px] font-semibold uppercase tracking-[0.04em] text-m-tx3">{children}</h2>;
}

/** A row of the Inicio card list: icon tile, title + summary, chevron. */
export function NavRow({ icon, title, sub, onClick, href }: { icon: string; title: string; sub: string; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <span className="flex size-[40px] flex-none items-center justify-center rounded-[12px] bg-m-sf2 text-m-tx">
        <Glyph d={icon} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="text-[16px] leading-[1.3]">{title}</span>
        <span className="text-[14px] leading-[1.3] text-m-tx3">{sub}</span>
      </span>
      <Chevron />
    </>
  );
  const cls = `${ROW_M} min-h-[68px]`;
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  );
}

/** A labelled field with a visible label, optional hint and inline error. */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  children,
}: {
  id?: string;
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      {id ? (
        <label htmlFor={id} className={LABEL_M}>
          {label}
          {optional ? <span className="font-normal text-m-tx3"> (opcional)</span> : null}
        </label>
      ) : (
        <span className={LABEL_M}>
          {label}
          {optional ? <span className="font-normal text-m-tx3"> (opcional)</span> : null}
        </span>
      )}
      {children}
      {error ? (
        <span role="alert" className="text-[13px] text-m-dn">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[13px] text-m-tx3">{hint}</span>
      ) : null}
    </div>
  );
}

/** A full-width switch row (role=switch) with the kit toggle. */
export function SwitchRow({
  checked,
  onChange,
  label,
  sub,
  icon,
  className = "",
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  sub?: string;
  icon?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`flex w-full items-center gap-[12px] border border-m-bd bg-m-sf px-[14px] text-left text-m-tx ${className}`}
    >
      {icon ? (
        <span className="flex size-[40px] flex-none items-center justify-center rounded-[12px] bg-m-sf2">
          <Glyph d={icon} size={18} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span className="text-[16px]">{label}</span>
        {sub ? <span className="text-[13px] text-m-tx3">{sub}</span> : null}
      </span>
      <MToggle on={checked} />
    </button>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-[12px] border border-m-dnbd bg-m-dnbg px-[14px] py-[12px] text-[14px] leading-[1.45] text-m-dn">
      {children}
    </div>
  );
}

/** A status chip (26px, radius 8, 13/600) with a glyph — never colour alone. */
export function Chip({ tone, children }: { tone: "ok" | "off" | "warn"; children: ReactNode }) {
  const cls = tone === "ok" ? "u-m-st-confirmed" : tone === "warn" ? "u-m-st-scheduled" : "u-m-st-completed";
  return (
    <span className={`${cls} inline-flex h-[26px] flex-none items-center gap-[4px] self-start whitespace-nowrap rounded-[8px] px-[9px] text-[13px] font-semibold`}>
      {children}
    </span>
  );
}

/**
 * A confirmation as a bottom sheet (alertdialog): the SAFE option first and focused,
 * the consequential one second. Escape / tapping the veil = the safe option.
 */
export function ConfirmSheet({
  open,
  title,
  body,
  cancelLabel,
  okLabel,
  onCancel,
  onOk,
  busy = false,
  busyLabel,
  danger = true,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  cancelLabel: string;
  okLabel: string;
  onCancel: () => void;
  onOk: () => void;
  busy?: boolean;
  busyLabel?: string;
  danger?: boolean;
}) {
  return (
    <Sheet open={open} onClose={onCancel} label={title} alert>
      <div className="pb-[max(20px,env(safe-area-inset-bottom))]">
        <MConfirm title={title} body={body}>
          <div className="flex flex-col gap-[8px]">
            <MButton data-autofocus kind="secondary" className="w-full font-semibold" onClick={onCancel}>
              {cancelLabel}
            </MButton>
            <MButton kind={danger ? "danger" : "primary"} className="w-full" onClick={onOk} loading={busy} loadingLabel={busyLabel ?? "Guardando…"}>
              {okLabel}
            </MButton>
          </div>
        </MConfirm>
      </div>
    </Sheet>
  );
}

/** A plain option button inside an action sheet (56px, bordered). */
export function SheetOption({ children, onClick, danger, disabled }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    // aria-disabled, not disabled: a disabled button drops focus to <body>, and the
    // confirmation it opens must hand focus back to it when it closes.
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      className={`flex min-h-[56px] w-full items-center rounded-[12px] border px-[14px] text-left text-[16px] aria-disabled:opacity-60 ${
        danger ? "border-m-dnbd bg-transparent text-m-dn" : "border-m-bd bg-m-sf text-m-tx"
      }`}
    >
      {children}
    </button>
  );
}

/** Copy to the clipboard; resolves false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
