"use client";

import { initialsOf } from "@/lib/staffTone";
import { STATUS_NAME, statusToneClass } from "../agenda/status";

/**
 * SCHEDULING DESIGN SYSTEM — the one vocabulary the agenda, the appointment detail,
 * the booking modal and the services menu are built from.
 *
 * The neutral controls (buttons, fields, segmented, the modal layer, ConfirmDialog) now
 * live in components/ui/controls.tsx so CRM shares them; they are re-exported here
 * UNCHANGED, so every Scheduling import keeps working and draws exactly as before. What
 * stays in this file is Scheduling's own: appointment states and avatars.
 */
export * from "@/components/ui/controls";

/**
 * The STATE of an appointment, everywhere it is shown: a pill in the state tone
 * (u-status-*, never the service pastel), a glyph that differs per state and the state
 * in words — so it never depends on colour alone.
 */
export function StatusChip({ status, size = "md" }: { status: string; size?: "md" | "sm" }) {
  return (
    <span
      className={`${statusToneClass(status)} inline-flex shrink-0 items-center gap-1 rounded-full font-medium ${
        size === "sm" ? "h-5 px-1.5 text-[0.625rem]" : "h-7 px-2.5 text-xs"
      }`}
    >
      <StatusGlyph status={status} />
      {STATUS_NAME[status] ?? status}
    </span>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const common = { "aria-hidden": true, viewBox: "0 0 12 12", className: "size-3 shrink-0", fill: "none", stroke: "currentColor", strokeWidth: 1.6 } as const;
  switch (status) {
    case "confirmed":
      return (
        <svg {...common}>
          <path d="M2.5 6.2l2.3 2.3 4.7-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.5" fill="currentColor" stroke="none" opacity="0.9" />
          <path d="M3.8 6.1l1.5 1.5 3-3.2" stroke="var(--status-completed-bg)" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
        </svg>
      );
    case "no_show":
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.2" />
          <path d="M3 9l6-6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="6" cy="6" r="4.2" strokeDasharray="2 1.6" />
        </svg>
      );
  }
}

/** A conflict marker (overlapping appointments) — a warning, not a state. */
export function AttentionChip({ size = "md" }: { size?: "md" | "sm" }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-warn-soft font-medium text-warn ${
        size === "sm" ? "h-5 px-1.5 text-[0.625rem]" : "h-7 px-2.5 text-xs"
      }`}
    >
      <svg aria-hidden viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M6 1.8l4.6 8.2H1.4z" strokeLinejoin="round" />
        <path d="M6 5v2.2" strokeLinecap="round" />
      </svg>
      Revisar
    </span>
  );
}

/** A person's initials in a circle, centred optically (flex + leading-none). With a
 *  `photoUrl` (a professional's public photo, the business's own R2 object) the photo
 *  takes the circle instead. */
export function Avatar({
  name,
  size = "md",
  tone = "neutral",
  photoUrl,
}: {
  name: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  tone?: "neutral" | "card";
  photoUrl?: string | null;
}) {
  const dims = { xs: "size-[1.125rem] text-[0.5rem]", sm: "size-6 text-[0.625rem]", md: "size-9 text-xs", lg: "size-12 text-sm" }[size];
  const fill = tone === "card" ? "u-appt-avatar" : "bg-chip text-foreground";
  if (photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded photo (R2)
    return <img src={photoUrl} alt="" aria-hidden className={`inline-block shrink-0 rounded-full object-cover ${dims}`} />;
  }
  return (
    <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none tracking-tight ${dims} ${fill}`}>
      {name ? initialsOf(name) : "—"}
    </span>
  );
}
