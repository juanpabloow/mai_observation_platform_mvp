/** A concrete field error with an icon and text (never colour alone). */
export function FieldError({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <span id={id} role="alert" className="flex items-center gap-1 text-xs text-danger">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden className="size-3.5 shrink-0">
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 4.8v3.6M8 10.9h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {text}
    </span>
  );
}
