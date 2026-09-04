/**
 * THE panel icon set — 14px, 1.8 stroke, currentColor.
 *
 * Neutral by design: these label section headings and buttons on every detail surface in
 * the app (the contact form, the contact quick view, the staff roster's panel), so they
 * cannot live inside one screen's module. One `ico` spread is what keeps ten glyphs on
 * the same weight and box — a 16px or 1.5-stroke one-off is visible the moment it sits
 * beside its neighbours.
 */
const ico = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8 } as const;

export const IconIdentity = () => (
  <svg {...ico} aria-hidden>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
  </svg>
);
export const IconAssign = () => (
  <svg {...ico} aria-hidden>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.5 20c0-3.4 2.9-5.7 6.5-5.7s6.5 2.3 6.5 5.7" />
    <path d="M18 7.5v5M20.5 10h-5" />
  </svg>
);
export const IconComms = () => (
  <svg {...ico} aria-hidden>
    <path d="M20 14.5c0 1.1-.9 2-2 2H8l-4 3.5v-14c0-1.1.9-2 2-2h12c1.1 0 2 .9 2 2z" />
  </svg>
);
export const IconInternal = () => (
  <svg {...ico} aria-hidden>
    <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z" />
    <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" />
  </svg>
);
export const IconBusiness = () => (
  <svg {...ico} aria-hidden>
    <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h10M18 17h2" />
    <circle cx="16" cy="7" r="1.8" />
    <circle cx="10" cy="12" r="1.8" />
    <circle cx="16" cy="17" r="1.8" />
  </svg>
);
export const IconPhone = () => (
  <svg {...ico} aria-hidden>
    <rect x="7" y="2.5" width="10" height="19" rx="2" />
    <path d="M11 18.5h2" />
  </svg>
);
export const IconCalendar = () => (
  <svg {...ico} aria-hidden>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);
export const IconTask = () => (
  <svg {...ico} aria-hidden>
    <path d="M9 11.5l2 2 4.5-4.5" />
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
  </svg>
);
export const IconPencil = () => (
  <svg {...ico} aria-hidden>
    <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5z" />
    <path d="M13.5 6.5 17.5 10.5" />
  </svg>
);
/** A NOTE — a page with two lines of writing on it. The Notas section used to borrow
 *  IconInternal (a tag), which is the glyph for Etiquetas sitting right above it. */
export const IconNote = () => (
  <svg {...ico} aria-hidden>
    <path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V4a.5.5 0 0 1 .5-.5z" />
    <path d="M14.5 3.5V8h4.5M9.5 13h6M9.5 16.5h4" strokeLinecap="round" />
  </svg>
);

/** The `+` on a create action. 1.8 stroke like the rest, so it sits on the same weight
 *  as the glyphs beside it rather than reading as a heavier plus. */
export const IconPlus = () => (
  <svg {...ico} aria-hidden>
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
);
export const IconMail = () => (
  <svg {...ico} aria-hidden>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3 6.5 9 6 9-6" />
  </svg>
);
