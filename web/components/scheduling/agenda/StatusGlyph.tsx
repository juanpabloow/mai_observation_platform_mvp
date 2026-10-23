/**
 * The appointment STATE as a small glyph next to its words (never colour alone):
 * ○ Sin confirmar · ✓ Confirmada · ✓✓ Completada · ✕ Cancelada · ! Inasistencia.
 * Used on calendar cards, the one-touch state control and legends.
 */
export function StatusGlyphInline({ status, className = "size-3.5" }: { status: string; className?: string }) {
  const common = { "aria-hidden": true, viewBox: "0 0 16 16", className: `${className} shrink-0`, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (status) {
    case "confirmed":
      return (
        <svg {...common}>
          <path d="M3.5 8.4l2.9 2.9 6-6.6" />
        </svg>
      );
    case "completed":
      return (
        <svg {...common}>
          <path d="M1.8 8.6l2.6 2.6 5.2-5.8M7.4 10.6l.6.6 5.2-5.8" />
        </svg>
      );
    case "cancelled":
      return (
        <svg {...common}>
          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
        </svg>
      );
    case "no_show":
      return (
        <svg {...common}>
          <path d="M8 3.5v5.5M8 12.2v.1" strokeWidth={2} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.6" />
        </svg>
      );
  }
}
