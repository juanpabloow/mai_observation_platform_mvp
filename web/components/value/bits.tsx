"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import s from "./valueDashboard.module.css";
import type { Tip, Tone } from "@/lib/valueDashboardView";

export const cx = (...c: Array<string | false | null | undefined>): string => c.filter(Boolean).join(" ");

const CHIP: Record<Tone, string> = { ok: s.chipOk, warn: s.chipWarn, info: s.chipInfo, est: s.chipEst };

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={cx(s.chip, CHIP[tone])}>{children}</span>;
}

/** «Medido» vs «Estimación»: the label is text, the dot style only repeats it. */
export function KindTag({ kind }: { kind: "measured" | "estimate" }) {
  return <span className={cx(s.tag, kind === "estimate" ? s.tagEst : s.tagMeasured)}>{kind === "estimate" ? "Estimación" : "Medido"}</span>;
}

/**
 * ONE data-dependent value. While the period loads it is a neutral placeholder of the same
 * box (never the old number, never $0); when the value arrives it is shown EXACTLY, fading in
 * (opacity only — no counter). `k` changes whenever the value's meaning changes (period,
 * lens, mode), which replays the fade.
 */
export function V({
  loading,
  k,
  children,
  w = "5ch",
  className,
  style,
}: {
  loading: boolean;
  k: string;
  children: ReactNode;
  w?: string;
  className?: string;
  style?: CSSProperties;
}) {
  if (loading) {
    return (
      <span className={cx(s.slot, className)} style={{ ...style, width: w }} aria-hidden>
        {" "}
      </span>
    );
  }
  return (
    <span key={k} className={cx(s.swap, className)} style={style}>
      {children}
    </span>
  );
}

/** A horizontal meter. Grows from 0 on first paint, then eases between values; 0 while loading. */
export function Meter({ pct, tone, loading, height = 8 }: { pct: number; tone: string; loading: boolean; height?: number }) {
  return (
    <span className={s.track} style={{ height }} aria-hidden>
      <span className={cx(s.fill, tone)} style={{ width: `${loading ? 0 : Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

export function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v4M8 4.9v.2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function NoteList({ notes }: { notes: Array<{ mark: string; warn?: boolean; text: string }> }) {
  return (
    <div className={s.notes}>
      {notes.map((n, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span className={cx(s.noteIc, n.warn && s.noteIcWarn)} aria-hidden>
            {n.mark}
          </span>
          <span style={{ flex: 1 }}>
            {n.warn ? <span className="sr-only">Aviso: </span> : null}
            {n.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- tooltip -- */

type TipState = { x: number; y: number; w: number; tip: Tip } | null;

/** Put on each bar: the exact numbers its tooltip shows. */
export const tipAttr = (tip: Tip, off = false) => (off ? {} : { "data-tip": JSON.stringify(tip) });

/**
 * Hover / tap details for the bars inside it. The CONTAINER handles the pointer (events
 * delegated to the nearest `[data-tip]` bar), so the tooltip is never clipped by a bar's
 * overflow and needs no refs during render.
 *  - mouse / pen: follows the pointer, hides on leave;
 *  - touch: a tap shows it and it hides by itself (there is no hover on a phone).
 * It only REPEATS exact numbers already on screen (and in each chart's aria-label), so it
 * is decorative for assistive tech (aria-hidden).
 */
export function TipBox({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  const [state, setState] = useState<TipState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = (e: ReactPointerEvent<HTMLDivElement>): boolean => {
    const bar = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (!bar || !e.currentTarget.contains(bar)) return false;
    const r = e.currentTarget.getBoundingClientRect();
    setState({ x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, tip: JSON.parse(bar.dataset.tip ?? "{}") as Tip });
    return true;
  };
  const W = 220;
  return (
    <div
      className={cx(s.tipBox, className)}
      style={style}
      onPointerMove={(e) => {
        if (e.pointerType === "touch") return;
        if (!show(e)) setState(null);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") setState(null);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        if (timer.current) clearTimeout(timer.current);
        if (show(e)) timer.current = setTimeout(() => setState(null), 2600);
        else setState(null);
      }}
    >
      {state ? (
        <div
          aria-hidden
          className={s.tip}
          style={{
            left: Math.min(Math.max(state.x, W / 2 + 4), Math.max(W / 2 + 4, state.w - W / 2 - 4)),
            top: state.y,
            width: "max-content",
            maxWidth: W,
          }}
        >
          <span className={s.tipTitle}>{state.tip.title}</span>
          {state.tip.lines.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}
