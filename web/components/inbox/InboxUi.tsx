"use client";

import type { ReactNode } from "react";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { avatarToneIndex } from "@/lib/avatarColor";

/**
 * Small shared pieces of the inbox redesign ("Inbox de Gallery"): the state chips, the
 * avatar, the confirmation dialog and the icons. Everything carries its meaning in TEXT
 * (+ an icon); the tint only groups — colour is never the only signal.
 */

export type ChipKind = "pending" | "you" | "other" | "bot" | "open" | "closed";

const CHIP_CLS: Record<ChipKind, string> = {
  pending: "bg-chip-pending-bg text-chip-pending-fg",
  you: "bg-chip-you-bg text-chip-you-fg",
  other: "bg-chip-you-bg text-chip-you-fg",
  bot: "bg-chip-bot-bg text-chip-bot-fg",
  open: "bg-chip-open-bg text-chip-open-fg",
  closed: "bg-chip-closed-bg text-chip-closed-fg",
};

export function StateChip({ kind, children, size = "md" }: { kind: ChipKind; children: ReactNode; size?: "sm" | "md" }) {
  const icon =
    kind === "pending" ? <IconAlert /> : kind === "you" || kind === "other" ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : kind === "bot" ? <IconBotDiamond /> : kind === "closed" ? <IconLock /> : null;
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-md font-medium ${
        size === "sm" ? "px-1.5 py-px text-[0.6875rem]" : "px-1.5 py-px text-[0.6875rem] md:px-2 md:py-0.5 md:text-xs"
      } ${CHIP_CLS[kind]}`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * The redesign's avatars: PASTEL discs with DARK initials, in both themes (S3b). The tone
 * is the contact's own (avatarToneIndex — the same index the rest of the app uses), so one
 * person keeps one colour. "#" (bare phone) and "?" (unknown) sit on a neutral disc.
 */
const PASTELS: ReadonlyArray<readonly [string, string]> = [
  ["#ece8f7", "#3d3373"],
  ["#e2eee5", "#21503a"],
  ["#f3ebdb", "#5c431d"],
  ["#e3ecf8", "#22446c"],
  ["#f6e2e2", "#682828"],
  ["#e6eef0", "#2d4650"],
];
const NEUTRAL: readonly [string, string] = ["#eceef1", "#474c54"];

export function InboxAvatar({ text, toneKey, large = false }: { text: string; toneKey: string; large?: boolean }) {
  const [bg, fg] = text === "#" || text === "?" ? NEUTRAL : PASTELS[(avatarToneIndex(toneKey) - 1) % PASTELS.length];
  // The tone travels as variables (not an inline colour) so Grafito can use its one neutral
  // disc (inbox-grafito.css · [data-ib-avatar]).
  return (
    <span
      aria-hidden
      data-ib-avatar=""
      style={{ "--av-bg": bg, "--av-fg": fg } as React.CSSProperties}
      className={`flex shrink-0 items-center justify-center rounded-full bg-[var(--av-bg)] font-semibold text-[var(--av-fg)] ${
        large ? "size-10 text-[0.8125rem] md:size-9 md:text-xs" : "size-9 text-xs md:size-8 md:text-[0.6875rem]"
      }`}
    >
      {text}
    </span>
  );
}

/**
 * The confirmation for taking or returning a conversation (frames 1j / 2h). The focus
 * starts on "Cancelar" (first control), Escape closes, focus returns to the trigger, and
 * Tab cannot leave the dialog. A bottom sheet on the phone, a centred card otherwise.
 */
export function InboxConfirm({
  open,
  title,
  body,
  confirmLabel,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ref = useTrappedPanel({ active: open, onClose: onCancel });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:items-center sm:p-4">
      <button type="button" aria-label="Cancelar" tabIndex={-1} onClick={onCancel} className="absolute inset-0 cursor-default" />
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="inbox-confirm-title"
        aria-describedby="inbox-confirm-body"
        className="relative w-full max-w-sm rounded-2xl border border-line bg-popover p-5 text-popover-foreground shadow-[0_16px_40px_rgba(18,21,27,0.2)]"
      >
        <h2 id="inbox-confirm-title" className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        <p id="inbox-confirm-body" className="mt-1.5 text-sm leading-relaxed text-muted">
          {body}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={pending} className={BTN_SECONDARY}>
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} disabled={pending} aria-busy={pending || undefined} className={BTN_PRIMARY}>
            {pending ? "Guardando…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The inbox's buttons: 44px tall on touch, 36px from md up. */
export const BTN_PRIMARY =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-ink px-4 text-sm font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:px-3 md:text-[0.8125rem]";
export const BTN_SECONDARY =
  "inline-flex h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border border-line-strong bg-surface px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-50 md:h-8 md:px-3 md:text-[0.8125rem]";

// ── Icons (decorative; the text beside them carries the meaning) ────────────────────

const ic = "size-3.5 shrink-0";
export function IconAlert() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={ic}>
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.8v3.6M8 10.9h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
export function IconLock() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={ic}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
export function IconBotDiamond() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-2.5 shrink-0">
      <path d="M8 1.5 14.5 8 8 14.5 1.5 8z" fill="currentColor" />
    </svg>
  );
}
export function IconPerson({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${className} shrink-0`}>
      <circle cx="8" cy="5.2" r="2.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 13c0-2.3 2-3.6 4.5-3.6s4.5 1.3 4.5 3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
export function IconBot({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`${className} shrink-0`}>
      <rect x="3" y="5" width="10" height="8" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.5V5M6 9h.01M10 9h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
export function IconClockAlert() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5 shrink-0">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.8V8l2 1.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
export function IconFilter() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 shrink-0">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
export function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-4 shrink-0">
      <circle cx="11" cy="11" r="6.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="m15.8 15.8 3.7 3.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
export function IconBack() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 shrink-0">
      <path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconSend() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-4 shrink-0">
      <path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5 shrink-0">
      <path d="m3.5 8.3 2.8 2.8 6.2-6.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconArrowDown() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5 shrink-0">
      <path d="M8 3v9.5M3.8 8.3 8 12.5l4.2-4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function IconClose() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5 shrink-0">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
