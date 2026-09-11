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
 * EL AUDIO, AHORA SÍ. `src` apunta a la ruta de sesión que firma un GET
 * temporal del audio NORMALIZADO (16 kHz mono WAV: el formato que todo
 * navegador decodifica, y el fichero sobre el que se midieron los tiempos de
 * los segmentos, así que el playhead y la transcripción usan el mismo reloj).
 *
 * `src` es OPCIONAL y todo lo de abajo sigue funcionando sin él: sin fichero,
 * el playhead se mueve localmente y los estados del diseño —loading, buffering,
 * unavailable, error— siguen siendo alcanzables. Eso es lo que permite que la
 * pantalla se revise sin almacenamiento y que una reunión cuyo audio borró la
 * retención muestre «no disponible» en vez de un reproductor roto.
 *
 * El elemento va oculto y sin `controls`: los controles nativos serían un
 * segundo reproductor con otra apariencia dentro del que el diseño define. Y
 * `preload="none"` a propósito — precargar pediría la URL firmada al pintar la
 * página, que es justo lo que se evita para que la caducidad cuente desde que
 * alguien le da a reproducir.
 */

export type AudioState = "ready" | "playing" | "loading" | "buffering" | "unavailable" | "error";

/**
 * El seguimiento de la transcripción, como CUATRO estados y no un booleano.
 *
 * `suspended` es el que no cabía en un booleano y es el que importa: el usuario
 * desplazó el texto a mano mientras el audio seguía sonando. No es «apagado»
 * —hay un sitio al que volver— ni «encendido» —no se está desplazando—. Con dos
 * valores había que inferirlo de `follow === false && playhead > 0`, que es la
 * clase de condición que se desincroniza.
 *
 * `unavailable` = no estamos en Transcript, así que no hay texto que seguir.
 */
export type FollowState = "off" | "on" | "suspended" | "unavailable";

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
  /**
   * `expanded` = onda, tiempos, velocidad y seguimiento. `compact` = cápsula:
   * play/pausa, tiempo y el botón de expandir, nada más.
   *
   * Es una PROP y no dos componentes a propósito: cambiar de modo sólo cambia
   * qué controles se pintan, y el `<audio>` —que va fuera de esa rama— conserva
   * su identidad. Dos componentes distintos lo desmontarían, y compactar
   * pararía la reproducción.
   */
  density = "dock",
  variant = "waveform",
  mode = "expanded",
  followState = "unavailable",
  onFollowToggle,
  onFollowResume,
  onToggleMode,
  className = "",
  /** Buffering shows a hint beside the time ("Buffering · 2 s"). */
  note,
  /** La ruta que firma el GET del audio. `null` = no hay nada que reproducir. */
  src = null,
  /**
   * El segundo en curso, hacia arriba. Se avisa SÓLO al cambiar de segundo entero:
   * `timeupdate` dispara unas cuatro veces por segundo y repintar el área de trabajo a
   * ese ritmo se nota. El que sigue el audio necesita resolución de segundo, no de
   * fotograma.
   *
   * NO se realimenta como `startAt`: `startAt` es para saltos EXPLÍCITOS. Devolver el
   * tiempo por esa misma vía crearía un lazo —el elemento manda 12,3 s, el padre baja
   * 12 s, el efecto 3 ve 0,3 de diferencia y a punto de pasar el umbral de 0,35 empieza
   * a dar saltos.
   */
  onTimeChange,
}: {
  meetingId: string;
  durationSeconds: number;
  src?: string | null;
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
  mode?: "expanded" | "compact";
  followState?: FollowState;
  onFollowToggle?: () => void;
  onFollowResume?: () => void;
  onToggleMode?: () => void;
  className?: string;
  note?: string;
  onTimeChange?: (seconds: number) => void;
}) {
  const compacto = mode === "compact";
  const dock = !compacto && density === "dock";
  const bar = !compacto && variant === "bar";
  // En el dock flotante la onda ya no ocupa el ancho de la pantalla, así que
  // 160 barras quedarían de menos de un píxel. 96 es lo que se distingue.
  const bars = dock ? 96 : 56;
  const heights = useMemo(() => envelope(meetingId, bars), [meetingId, bars]);
  const [at, setAt] = useState(Math.min(startAt, durationSeconds));
  const [playing, setPlaying] = useState(state === "playing");
  const [speed, setSpeed] = useState<number>(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [hover, setHover] = useState<{ pct: number; label: string } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const speedId = useId();

  /**
   * Con fichero, el estado lo dicta el ELEMENTO, no la prop.
   *
   * La prop dice lo que el servidor sabía al pintar («hay audio»); el elemento
   * dice lo que está pasando ahora («esperando datos», «el 302 falló»). Sin
   * `src` la prop manda, que es el comportamiento de siempre.
   */
  const [mediaState, setMediaState] = useState<AudioState | null>(null);
  const effectiveState: AudioState = src === null ? state : (mediaState ?? state);

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

  const seekable =
    effectiveState !== "loading" && effectiveState !== "unavailable" && effectiveState !== "error";
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

  /* ── El cableado del elemento de audio ─────────────────────────────────
   *
   * Cuatro efectos, uno por dirección del flujo. Todos salen sin hacer nada
   * cuando no hay `src`, que es lo que mantiene intacto el comportamiento sin
   * fichero.
   */

  // 1 · play/pause. `play()` devuelve una promesa que RECHAZA si el navegador
  //     bloquea la reproducción; sin capturarla, sale por consola como error no
  //     manejado y el botón queda mintiendo en "pausar".
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || src === null) return;
    if (playing) {
      void audio.play().catch(() => {
        setPlaying(false);
        setMediaState("error");
      });
    } else {
      audio.pause();
    }
  }, [playing, src]);

  // 2 · la velocidad.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio && src !== null) audio.playbackRate = speed;
  }, [speed, src]);

  // 3 · buscar. El elemento es la fuente de la verdad del tiempo, así que un
  //     seek de la onda o de una cita se le empuja a él y el `timeupdate`
  //     devuelve la posición. Sin esto, la aguja y el sonido se separan.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || src === null) return;
    if (Math.abs(audio.currentTime - at) > 0.35) audio.currentTime = at;
  }, [at, src]);

  // 4 · lo que el elemento cuenta.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || src === null) return;
    let lastWhole = -1;
    const onTime = () => {
      setAt(audio.currentTime);
      const whole = Math.floor(audio.currentTime);
      if (whole !== lastWhole) {
        lastWhole = whole;
        onTimeChange?.(audio.currentTime);
      }
    };
    const onWaiting = () => setMediaState("buffering");
    const onPlaying = () => setMediaState("playing");
    const onCanPlay = () => setMediaState("ready");
    const onEnded = () => setPlaying(false);
    // Un 404 o un 302 caducado llegan aquí: la etiqueta de audio no propaga el
    // código HTTP, así que "no se pudo cargar" es todo lo que se puede decir —
    // y decirlo es mejor que un botón que no responde.
    const onError = () => {
      setPlaying(false);
      setMediaState("error");
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
  }, [src, onTimeChange]);

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
  const flat =
    effectiveState === "loading" || effectiveState === "unavailable" || effectiveState === "error";
  const timeLabel =
    effectiveState === "unavailable" || effectiveState === "error"
      ? "—"
      : effectiveState === "loading"
        ? `--:-- / ${fmt(durationSeconds)}`
        : `${fmt(at)} / ${fmt(durationSeconds)}`;

  /**
   * DOS RAMAS, UN SOLO `<audio>`.
   *
   * El elemento se renderiza FUERA del condicional de modo y siempre en la
   * misma posición (segundo hijo del contenedor), así que React lo reconcilia
   * como el mismo nodo al cambiar de modo. Si viviera dentro de una de las
   * ramas, compactar lo desmontaría y la reproducción se cortaría — que es
   * exactamente el fallo que este cambio viene a arreglar, y sería absurdo
   * reintroducirlo por la puerta de al lado.
   */
  const elementoAudio =
    src !== null ? (
      // `preload="none"` para que la URL firmada se pida al reproducir y no al
      // pintar. `crossOrigin` NO se pone: la ruta es del mismo origen y firma
      // una redirección, y declararlo forzaría un preflight CORS contra R2 que
      // el bucket privado no tiene configurado.
      <audio ref={audioRef} src={src} preload="none" className="hidden" aria-hidden />
    ) : null;

  const controlesCompactos = (
    <>
        <span className="flex items-center gap-2">
          {effectiveState === "loading" || effectiveState === "buffering" ? (
            <span
              role="img"
              aria-label={effectiveState === "loading" ? "Cargando el audio" : "Buffering"}
              className="size-7 shrink-0 animate-spin rounded-full border-2 border-line border-t-muted"
            />
          ) : (
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={!seekable}
              aria-label={playing ? "Pausar" : "Reproducir"}
              className={`u-focus inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors ${
                seekable ? "bg-ink text-ink-fg hover:bg-ink-hover" : "border border-line bg-chip text-muted"
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
          {/* Posición y duración, y NADA de onda: en una cápsula de 44px de alto
              una onda de 96 barras es un adorno ilegible. */}
          <span className="whitespace-nowrap text-[0.8125rem] text-foreground u-mono">
            {effectiveState === "unavailable" || effectiveState === "error" ? "—" : fmt(at)}
          </span>
          <span aria-hidden className="text-faint">/</span>
          <span className="whitespace-nowrap text-[0.8125rem] text-muted u-mono">{fmt(durationSeconds)}</span>
          {onToggleMode ? (
            <button
              type="button"
              onClick={onToggleMode}
              aria-label="Expandir el reproductor"
              title="Expandir el reproductor"
              className="u-focus ml-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M6 10L2.5 13.5M2.5 10.5v3h3M10 6l3.5-3.5M13.5 5.5v-3h-3" />
              </svg>
            </button>
          ) : null}
        </span>
    </>
  );

  return (
    // UN solo contenedor y SIEMPRE dos hijos: los controles del modo vigente y
    // el elemento de audio. Así `elementoAudio` está siempre en el índice 1 del
    // array de hijos, y React lo reconcilia como el mismo nodo al cambiar de
    // modo. Con un `return` temprano por rama caía en otro índice y se
    // remontaba, que es el fallo que hay que evitar.
    <div
      className={`flex shrink-0 flex-wrap items-center gap-2.5 ${
        compacto
          ? "gap-2"
          : dock
          ? "gap-3 px-1 py-0.5"
          : bar
            ? // In a header the player carries NO chrome of its own: a bordered
              // pill inside a bordered card is a second frame around a utility.
              "h-8"
            : "h-11 rounded-xl border border-line-soft bg-subtle px-2.5"
      } ${className}`}
    >
      {compacto ? controlesCompactos : (
      <>
      {/* PLAY / PAUSE — left, as the spec fixes it. Loading and buffering replace
          it with a spinner so the control never lies about being pressable. */}
      {effectiveState === "loading" || effectiveState === "buffering" ? (
        <span
          role="img"
          aria-label={effectiveState === "loading" ? "Cargando el audio" : "Buffering"}
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
          effectiveState === "unavailable"
            ? "audio no disponible"
            : effectiveState === "error"
              ? "no se pudo reproducir"
              : effectiveState === "loading"
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
            className={`pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-0.5 text-[0.75rem] text-ink-fg u-mono ${
              dock ? "bottom-[calc(100%+0.5rem)]" : "top-[calc(100%+0.5rem)]"
            }`}
            style={{ left: `${hover.pct}%` }}
          >
            {hover.label}
          </span>
        ) : null}
      </div>

      {/* Time, right — current and total, tabular so it does not jitter.
          13 px y no 11,5: es el dato que se lee mientras suena el audio. */}
      <span className={`shrink-0 whitespace-nowrap u-mono ${dock ? "text-[0.8125rem] text-foreground" : "text-[0.75rem] text-muted"}`}>
        {timeLabel}
      </span>

      {note ? <span className="shrink-0 whitespace-nowrap text-[0.75rem] text-warn">{note}</span> : null}

      {effectiveState === "unavailable" ? (
        <span className="shrink-0 whitespace-nowrap text-[0.75rem] text-muted">Audio no disponible todavía</span>
      ) : null}
      {effectiveState === "error" ? (
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.75rem] text-brand">
          No se pudo reproducir
          {/* ESTE BOTÓN NO HACÍA NADA: `type="button"` y ningún `onClick`. Un control
              que dice «Reintentar» y no reintenta es peor que su ausencia, porque
              consume el intento del usuario. Su función sí estaba definida por su
              propia etiqueta, así que se conecta: `load()` vuelve a pedir la URL
              firmada —que pudo caducar, y es la causa más probable de llegar aquí— y
              se limpia el estado de error para que el control vuelva a ser pulsable. */}
          <button
            type="button"
            onClick={() => {
              const audio = audioRef.current;
              if (!audio) return;
              setMediaState("loading");
              audio.load();
            }}
            aria-label="Reintentar la carga del audio"
            title="Vuelve a pedir el audio · la URL firmada pudo caducar"
            className="u-focus rounded-md border border-brand/35 px-2 py-0.5 hover:bg-brand-soft"
          >
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
            className={`u-focus rounded-md border px-2 py-1 text-[0.75rem] transition-colors u-mono ${
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
                  className={`u-focus rounded px-2 py-1 text-left text-[0.75rem] u-mono ${
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

      {/*
        SEGUIR TRANSCRIPCIÓN. Antes era una barra pegada arriba del transcript,
        separada del reproductor que la gobierna. Vive aquí porque es una
        preferencia SOBRE LA REPRODUCCIÓN: lo que hace es que el texto siga al
        audio, y tenerla a dos regiones de distancia del play obligaba a
        explicarla con un título.

        Tres estados visibles y no dos. «Volver a seguir» aparece sólo cuando el
        seguimiento está suspendido —el usuario desplazó el texto a mano— porque
        entonces hay un sitio concreto al que volver; activar el modo y recuperar
        el sitio son acciones distintas.
      */}
      {followState !== "unavailable" ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onFollowToggle}
            aria-pressed={followState === "on"}
            aria-label={
              followState === "on" ? "Dejar de seguir la transcripción" : "Seguir la transcripción"
            }
            title={
              followState === "on"
                ? "Siguiendo la transcripción · el texto se desplaza con lo que suena"
                : "Resalta y desplaza el bloque que está sonando"
            }
            className={`u-focus inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[0.75rem] font-medium transition-colors ${
              followState === "on"
                ? "bg-ink text-ink-fg hover:bg-ink-hover"
                : "border border-line-strong text-muted hover:text-foreground"
            }`}
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${followState === "on" ? "bg-ink-fg" : "bg-line-strong"}`}
            />
            Seguir transcripción
          </button>
          {followState === "suspended" ? (
            <button
              type="button"
              onClick={onFollowResume}
              aria-label="Volver a seguir la transcripción desde el punto que suena"
              title="Vuelve al bloque que está sonando y retoma el seguimiento"
              className="u-focus inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[0.75rem] text-accent transition-colors hover:bg-accent/10"
            >
              Volver a seguir
            </button>
          ) : null}
        </span>
      ) : null}

      {onToggleMode ? (
        <button
          type="button"
          onClick={onToggleMode}
          aria-label="Compactar el reproductor"
          title="Compactar el reproductor"
          className="u-focus inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M2.5 6h3v-3M13.5 10h-3v3M6 2.5v3h-3M10 13.5v-3h3" />
          </svg>
        </button>
      ) : null}
      </>
      )}
      {elementoAudio}
    </div>
  );
}
