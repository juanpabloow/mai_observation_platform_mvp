import type { ReactNode } from "react";
import { Chip, type Tone } from "@/components/ui/primitives";
import type { MeetingSource, MeetingStatus, Participant } from "@/lib/meetingsData";

/* ═══════════════════════════════════════════════════════════════════════════
   The Reuniones module's own small vocabulary. Everything here is built out of
   the shared primitives (Chip, the --line/--muted/--warn tokens) so the module
   reads as part of the product rather than as an imported design.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * THE THREE PROGRESSES, deliberately different (spec rule 10).
 *
 * The design sheet had them collapsing into one another: the upload bar was
 * graphite, which is also the played portion of the waveform, and the "Subiendo"
 * chip was amber, which is also "analyzing". A person could not tell whether a
 * row was moving bytes or writing a summary.
 *
 *   upload → ACCENT, 4px, neutral track. Transferring bytes.
 *   work   → WARN,   3px, warn-tinted track. The system thinking.
 *   playback → not a bar at all. See AudioPlayer's waveform.
 *
 * `aria-valuenow` carries the number; the fill is decoration on top of it.
 */
export function ProgressBar({
  kind,
  value,
  label,
  className = "",
}: {
  kind: "upload" | "work";
  value: number;
  label: string;
  className?: string;
}) {
  const upload = kind === "upload";
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${value} %`}
      className={`relative block overflow-hidden rounded-full ${
        upload ? "h-1 bg-chip" : "h-[3px] bg-warn/20"
      } ${className}`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 rounded-full ${upload ? "bg-accent" : "bg-warn"}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </span>
  );
}

/**
 * Share of speaking time. NOT a progress bar — it is data, so it stays neutral.
 * Tinting it amber (as the sheet did for one participant) made a person's
 * talkativeness read as a system warning.
 */
export function ShareMeter({ value, name }: { value: number; name: string }) {
  return (
    <span
      role="img"
      aria-label={`${name} habló el ${value} % del tiempo`}
      className="relative block h-[3px] overflow-hidden rounded-full bg-chip"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 rounded-full bg-faint" style={{ width: `${value}%` }} />
    </span>
  );
}

/** Gradient identity disc. The initials are decoration; `name` is the label. */
export function Avatar({
  person,
  size = 24,
  ring = false,
}: {
  person: Pick<Participant, "initials" | "name">;
  size?: number;
  ring?: boolean;
}) {
  // A stable hue per person, so the same face is the same colour on every screen.
  const hues = ["from-[#2F6FA8] to-[#4E7BD0]", "from-[#2E9C7F] to-[#1F7A4D]", "from-[#8E4BC4] to-[#6B4FBF]", "from-[#B45309] to-[#8A5A0B]"];
  let h = 0;
  for (const ch of person.initials) h = (h + ch.charCodeAt(0)) % hues.length;
  const unknown = person.initials === "P4" || person.initials === "?";
  return (
    <span
      title={person.name}
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold u-mono ${
        unknown ? "bg-chip text-muted" : `bg-gradient-to-br text-white ${hues[h]}`
      } ${ring ? "ring-2 ring-surface" : ""}`}
    >
      {person.initials}
    </span>
  );
}

/** Overlapping avatar row + the "+n" remainder. */
export function AvatarStack({ people, extra }: { people: Participant[]; extra: number }) {
  if (people.length === 0) return <span className="text-sm text-faint">—</span>;
  return (
    <span className="flex items-center">
      <span className="sr-only">{people.map((p) => p.name).join(", ")}{extra > 0 ? ` y ${extra} más` : ""}</span>
      {people.map((p, i) => (
        <span key={p.initials} className={i > 0 ? "-ml-1.5" : ""}>
          <Avatar person={p} ring />
        </span>
      ))}
      {extra > 0 ? (
        <span className="-ml-1.5 inline-flex size-6 items-center justify-center rounded-full bg-chip text-[0.5625rem] font-semibold text-muted ring-2 ring-surface u-mono">
          +{extra}
        </span>
      ) : null}
    </span>
  );
}

/* ── Status ───────────────────────────────────────────────────────────────── */

interface StatusFace {
  label: string;
  tone: Tone;
  /** The percentage bar under the chip, when a stage is running. */
  progress?: { kind: "upload" | "work"; value: number };
  /** Shown in the chip after the label, e.g. "72 %". */
  suffix?: string;
}

/**
 * ONE place that turns a status into a face. Every surface (list, tablet list,
 * detail header, mobile card) renders status through this, so they cannot
 * disagree about what "Generando análisis" looks like.
 *
 * Never colour-only: the chip always carries its own words, which is what makes
 * the states legible to someone who cannot separate amber from green.
 */
export function statusFace(status: MeetingStatus): StatusFace {
  switch (status.kind) {
    case "uploading":
      // Upload is the ONE stage that is not the system thinking — it is the
      // network. Accent, not amber, so it never reads as "analyzing".
      return { label: "Subiendo", tone: "neutral", suffix: `${status.percent} %`, progress: { kind: "upload", value: status.percent } };
    case "transcribing":
      return { label: "Transcribiendo", tone: "warn", suffix: `${status.percent} %`, progress: { kind: "work", value: status.percent } };
    case "diarizing":
      return { label: "Separando participantes", tone: "warn", progress: { kind: "work", value: status.percent } };
    case "analyzing":
      return { label: "Generando análisis", tone: "warn", progress: { kind: "work", value: status.percent } };
    case "done":
      return { label: "Completada", tone: "success" };
    case "done-no-speakers":
      return { label: "Sin participantes identificados", tone: "muted" };
    case "failed":
      return { label: "Falló", tone: "brand" };
    case "cancelled":
      return { label: "Cancelada", tone: "muted" };
  }
}

/** The dot that precedes a status label. Decoration on top of the word. */
const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-accent",
  success: "bg-success",
  warn: "bg-warn",
  brand: "bg-brand",
  danger: "bg-white",
  muted: "bg-faint",
};

export function StatusCell({ status, retryHref }: { status: MeetingStatus; retryHref?: string }) {
  const face = statusFace(status);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-2">
        <Chip tone={face.tone}>
          <span aria-hidden className={`mr-1.5 size-1.5 shrink-0 rounded-full ${DOT_TONE[face.tone]}`} />
          {face.label}
          {face.suffix ? <span className="ml-1 opacity-70 u-mono">{face.suffix}</span> : null}
        </Chip>
        {status.kind === "failed" && retryHref ? (
          <a href={retryHref} className="text-[0.6875rem] text-brand underline decoration-brand/40 hover:decoration-brand">
            Reintentar
          </a>
        ) : null}
      </span>
      {face.progress ? (
        <ProgressBar
          kind={face.progress.kind}
          value={face.progress.value}
          label={face.progress.kind === "upload" ? "Progreso de la subida" : "Progreso del procesamiento"}
        />
      ) : null}
    </span>
  );
}

/** The row's second line: where the recording came from. */
export function SourceLine({ source }: { source: MeetingSource }) {
  const text =
    source.kind === "file"
      ? `${source.filename} · ${source.size}`
      : source.kind === "meet"
        ? "Meet · grabación automática"
        : source.kind === "inbox"
          ? `Desde Inbox · ${source.thread}`
          : source.kind === "cancelled"
            ? `Cancelada por ${source.by}`
            : "Grabación de sala";
  return <span className="truncate text-[0.71875rem] text-muted">{text}</span>;
}

/** A timestamp that seeks the player. Mono, so a column of them aligns. */
export function StampLink({
  children,
  at,
  onSeek,
  /** BOXED inside running prose: a bare mono stamp mid-sentence reads as a typo,
   *  where a bordered chip reads as a citation you can click. */
  boxed = false,
  className = "",
}: {
  children: ReactNode;
  at: number;
  /** Required: a stamp that looks clickable and does nothing is worse than text. */
  onSeek: (seconds: number) => void;
  boxed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onSeek(at)}
      title="Ir a este momento del audio"
      className={`u-focus u-mono text-[0.6875rem] text-muted transition-colors ${
        boxed
          ? "mx-0.5 rounded-md border border-line bg-surface px-1.5 py-px align-[0.05em] hover:border-faint hover:text-foreground"
          : "rounded px-1 hover:bg-subtle hover:text-foreground"
      } ${className}`}
    >
      {children}
    </button>
  );
}
