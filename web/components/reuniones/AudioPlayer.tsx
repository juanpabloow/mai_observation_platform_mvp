"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * THE audio player — one component, two densities, and the module's single
 * answer to "where am I in this recording".
 *
 * WHY A WAVEFORM AND NOT A SLIDER. There are three different progresses on this
 * screen (bytes uploading, the system analyzing, the audio playing). A track
 * with a filled left side is what the first two already look like, so a fourth
 * bar would have been the third meaning of the same shape. The waveform is
 * categorically different: it shows the SHAPE of the recording, which also makes
 * "the quiet stretch before 12:00" findable in a way no bar can be.
 *
 *   played  → graphite (--foreground)
 *   pending → light grey (--line-strong)
 *   no audio → flat, dimmer (--line)
 *   position → a 2px line with a dot, never colour alone
 *
 * ACCESSIBILITY. The track is a real `role="slider"`: it owns aria-valuemin /
 * max / now, publishes `aria-valuetext` as "12:04 de 48:22" (a screen reader
 * reading "724" would be useless), and takes ← → (5s), PageUp/Down (30s) and
 * Home/End. Dragging and clicking are conveniences on top of that, not the only
 * way in.
 *
 * NO AUDIO ELEMENT YET. This module ships its screens before its storage, so
 * there is no file to attach. `state` lets the caller show every playback state
 * the spec covers (loading / buffering / unavailable / error) without inventing
 * a backend, and the playhead moves locally so seeking is real to the touch.
 * When the recordings land, the internals get an <audio> ref and the public
 * props do not change.
 */

export type AudioState = "ready" | "playing" | "loading" | "buffering" | "unavailable" | "error";

/** Speaker turns as fractions of the whole, for the hover tooltip. */
export interface SpeakerTurn {
  from: number;
  to: number;
  name: string;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function fmt(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/**
 * A deterministic envelope. Derived from the meeting id so the same recording
 * always draws the same silhouette (a random one would reshuffle on every
 * render and make the waveform read as decoration).
 */
function envelope(seed: string, bars: number): number[] {
  let h = 2166136261;
  for (const ch of seed) h = ((h ^ ch.charCodeAt(0)) * 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const a = (h >>> 8) / 0xffffff;
    h = (h * 1664525 + 1013904223) >>> 0;
    const b = (h >>> 8) / 0xffffff;
    // Two octaves plus a slow swell, so it looks like speech rather than noise.
    const swell = 0.55 + 0.45 * Math.sin((i / bars) * Math.PI * 3);
    out.push(Math.max(0.12, Math.min(1, (0.35 * a + 0.65 * b) * swell)));
  }
  return out;
}

export function AudioPlayer({
  meetingId,
  durationSeconds,
  /** Where to start. The evidence and summary chips seek by changing this. */
  startAt = 0,
  state = "ready",
  speakers = [],
  density = "dock",
  variant = "waveform",
  className = "",
  /** Buffering shows a hint beside the time ("Buffering · 2 s"). */
  note,
}: {
  meetingId: string;
  durationSeconds: number;
  startAt?: number;
  state?: AudioState;
  speakers?: SpeakerTurn[];
  density?: "dock" | "compact";
  /**
   * "waveform" = the detailed timeline, for Transcript, where the shape of the
   * audio is what you navigate by. "bar" = a plain seekable progress line for a
   * screen HEADER, where the player is a utility and a 160-bar waveform would
   * be the loudest object on a page that is about text.
   */
  variant?: "waveform" | "bar";
  className?: string;
  note?: string;
}) {
  const dock = density === "dock";
  const bar = variant === "bar";
  const bars = dock ? 160 : 56;
  const heights = useMemo(() => envelope(meetingId, bars), [meetingId, bars]);
  const [at, setAt] = useState(Math.min(startAt, durationSeconds));
  const [playing, setPlaying] = useState(state === "playing");
  const [speed, setSpeed] = useState<number>(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [hover, setHover] = useState<{ pct: number; label: string } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const speedId = useId();

  // A seek from elsewhere on the page (an evidence chip, a summary stamp) arrives
  // as a prop change, so the player follows without the parent owning its state.
  // Adjusted DURING render against the tracked previous value — React's
  // documented alternative to a setState-in-effect, and the same pattern the
  // search fields in this app use.
  const [lastStart, setLastStart] = useState(startAt);
  if (lastStart !== startAt) {
    setLastStart(startAt);
    setAt(Math.min(startAt, durationSeconds));
  }

  const seekable = state !== "loading" && state !== "unavailable" && state !== "error";
  const pct = durationSeconds > 0 ? at / durationSeconds : 0;

  const nameAt = useCallback(
    (fraction: number) => speakers.find((s) => fraction >= s.from && fraction < s.to)?.name ?? null,
    [speakers],
  );

  const seekTo = useCallback(
    (fraction: number) => {
      setAt(Math.min(durationSeconds, Math.max(0, fraction * durationSeconds)));
    },
    [durationSeconds],
  );

  const fractionFromEvent = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }, []);

  /** Drag to scrub. Pointer events so mouse, pen and touch share one path. */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!seekable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(fractionFromEvent(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const f = fractionFromEvent(e.clientX);
    const who = nameAt(f);
    setHover({ pct: f * 100, label: `${fmt(f * durationSeconds)}${who ? ` · ${who}` : ""}` });
    if (seekable && e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(f);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!seekable) return;
    const step = 5 / durationSeconds;
    const page = 30 / durationSeconds;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = pct - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = pct + step;
        break;
      case "PageDown":
        next = pct - page;
        break;
      case "PageUp":
        next = pct + page;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 1;
        break;
      case " ":
        e.preventDefault();
        setPlaying((p) => !p);
        return;
      default:
        return;
    }
    e.preventDefault();
    seekTo(Math.min(1, Math.max(0, next)));
  };

  // Close the speed menu on Escape or an outside click — a menu that only closes
  // by picking is a trap for keyboard users.
  useEffect(() => {
    if (!speedOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpeedOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest(`[data-speed="${speedId}"]`)) setSpeedOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [speedOpen, speedId]);

  const cut = seekable ? Math.round(pct * bars) : 0;
  const flat = state === "loading" || state === "unavailable" || state === "error";
  const timeLabel = state === "unavailable" || state === "error" ? "—" : state === "loading" ? `--:-- / ${fmt(durationSeconds)}` : `${fmt(at)} / ${fmt(durationSeconds)}`;

  return (
    <div
      className={`flex shrink-0 items-center gap-2.5 ${
        dock
          ? "h-[4.375rem] gap-3 border-t border-line bg-surface px-4"
          : bar
            ? // In a header the player carries NO chrome of its own: a bordered
              // pill inside a bordered card is a second frame around a utility.
              "h-8"
            : "h-11 rounded-xl border border-line-soft bg-subtle px-2.5"
      } ${className}`}
    >
      {/* PLAY / PAUSE — left, as the spec fixes it. Loading and buffering replace
          it with a spinner so the control never lies about being pressable. */}
      {state === "loading" || state === "buffering" ? (
        <span
          role="img"
          aria-label={state === "loading" ? "Cargando el audio" : "Buffering"}
          className={`${dock ? "size-8" : "size-7"} shrink-0 animate-spin rounded-full border-2 border-line border-t-muted`}
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          disabled={!seekable}
          aria-label={playing ? "Pausar" : "Reproducir"}
          title={playing ? "Pausar · barra espaciadora" : "Reproducir · barra espaciadora"}
          className={`u-focus inline-flex shrink-0 items-center justify-center rounded-full transition-colors ${
            dock ? "size-8" : "size-7"
          } ${
            seekable
              ? "bg-ink text-ink-fg hover:bg-ink-hover"
              : // Disabled at 4.4:1, not the 1.9:1 the sheet had.
                "border border-line bg-chip text-muted"
          }`}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
              <rect x="3.4" y="2.6" width="3.4" height="10.8" rx="1" />
              <rect x="9.2" y="2.6" width="3.4" height="10.8" rx="1" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
              <path d="M4 2.6l8 5.4-8 5.4z" />
            </svg>
          )}
        </button>
      )}

      {/* THE WAVEFORM as the timeline. */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Posición del audio"
        aria-valuemin={0}
        aria-valuemax={durationSeconds}
        aria-valuenow={seekable ? Math.round(at) : 0}
        aria-valuetext={
          state === "unavailable"
            ? "audio no disponible"
            : state === "error"
              ? "no se pudo reproducir"
              : state === "loading"
                ? "cargando el audio"
                : `${fmt(at)} de ${fmt(durationSeconds)}`
        }
        aria-disabled={!seekable || undefined}
        title={seekable ? "Clic para ir a un punto · arrastra para hacer scrubbing · ← → 5 s · Inicio / Fin" : "Sin audio disponible"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        className={`u-focus relative flex min-w-0 flex-1 items-center ${
          bar ? "h-4" : dock ? "h-9 justify-between gap-px" : "h-6 justify-between gap-px"
        } ${seekable ? "cursor-pointer" : "cursor-not-allowed"}`}
      >
        {bar ? (
          /* A plain progress line: 4px track, filled to the playhead, with the
             same knob the waveform uses so the two read as one control. */
          <span aria-hidden className={`relative h-1 w-full rounded-full ${flat ? "bg-line" : "bg-line-strong"}`}>
            {!flat ? <span className="absolute inset-y-0 left-0 rounded-full bg-foreground" style={{ width: `${pct * 100}%` }} /> : null}
            {seekable ? (
              <span
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-surface"
                style={{ left: `${pct * 100}%` }}
              />
            ) : null}
          </span>
        ) : (
          <>
            {heights.map((h, i) => (
              <span
                key={i}
                aria-hidden
                style={{ height: `${Math.round(h * (dock ? 34 : 22))}px` }}
                className={`block max-w-[2px] flex-1 rounded-[1px] ${
                  flat ? "bg-line" : i < cut ? "bg-foreground" : "bg-line-strong"
                }`}
              />
            ))}

            {/* Position: a line AND a dot, so it survives greyscale. */}
            {seekable ? (
              <span aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: `${pct * 100}%` }}>
                <span className="absolute inset-y-0 -left-px w-0.5 rounded-[1px] bg-foreground" />
                <span className="absolute -top-0.5 -left-[3px] size-2 rounded-full bg-foreground ring-2 ring-surface" />
              </span>
            ) : null}
          </>
        )}

        {/* Hover: the minute and who is talking there. */}
        {hover && seekable && !bar ? (
          <span
            aria-hidden
            className={`pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-[0.625rem] text-ink-fg u-mono ${
              dock ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
            }`}
            style={{ left: `${hover.pct}%` }}
          >
            {hover.label}
          </span>
        ) : null}
      </div>

      {/* Time, right — current and total, tabular so it does not jitter. */}
      <span className="shrink-0 whitespace-nowrap text-[0.71875rem] text-muted u-mono">{timeLabel}</span>

      {note ? <span className="shrink-0 whitespace-nowrap text-[0.6875rem] text-warn">{note}</span> : null}

      {state === "unavailable" ? (
        <span className="shrink-0 whitespace-nowrap text-[0.6875rem] text-muted">Audio no disponible · el transcript sigue completo</span>
      ) : null}
      {state === "error" ? (
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.6875rem] text-brand">
          No se pudo reproducir
          <button type="button" className="u-focus rounded-md border border-brand/35 px-2 py-0.5 hover:bg-brand-soft">
            Reintentar
          </button>
        </span>
      ) : null}

      {/* Speed — part of the player, not an extra control in the header. */}
      {seekable ? (
        <span className="relative shrink-0" data-speed={speedId}>
          <button
            type="button"
            onClick={() => setSpeedOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={speedOpen}
            aria-label={`Velocidad de reproducción, ${speed}×`}
            className={`u-focus rounded-md border px-1.5 py-0.5 text-[0.65625rem] transition-colors u-mono ${
              speedOpen ? "border-ink bg-ink text-ink-fg" : "border-line bg-surface text-muted hover:bg-subtle"
            }`}
          >
            {speed}×
          </button>
          {speedOpen ? (
            <span
              role="menu"
              aria-label="Velocidad de reproducción"
              className="absolute right-0 top-[calc(100%+0.25rem)] z-20 flex w-20 flex-col gap-px rounded-lg border border-line bg-surface p-1 shadow-[var(--shadow-float)]"
            >
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="menuitemradio"
                  aria-checked={s === speed}
                  onClick={() => {
                    setSpeed(s);
                    setSpeedOpen(false);
                  }}
                  className={`u-focus rounded px-2 py-1 text-left text-[0.6875rem] u-mono ${
                    s === speed ? "bg-chip font-semibold text-foreground" : "text-muted hover:bg-subtle"
                  }`}
                >
                  {s}×
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
