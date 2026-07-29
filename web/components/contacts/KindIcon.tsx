import type { ReactNode } from "react";
import type { TimelineIconKind } from "@/lib/timelineCopy";

/**
 * Inline SVG icon set for the unified timeline + record (C-4). No icon library is
 * installed; the app draws inline SVGs at the shared spec — 18px box, 1.6 stroke,
 * currentColor (so they inherit the row's text token and theme automatically). Matches
 * the AppSidebar `Icon` recipe. Sized via the `className` prop (default size-4).
 */
const paths: Record<TimelineIconKind, ReactNode> = {
  conversation: (
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v8A1.5 1.5 0 0 1 18.5 15H9l-4 3.5V15H5.5A1.5 1.5 0 0 1 4 13.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </>
  ),
  appointment: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 9h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  note: (
    <>
      <path d="M6 3.5h8L18.5 8v11.5A1 1 0 0 1 17.5 20.5H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13.5 3.5V8H18M8 12h7M8 15.5h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  task: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 12l2.5 2.5L16 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  tag: (
    <>
      <path d="M4 11.5V5.5A1.5 1.5 0 0 1 5.5 4h6l8.5 8.5a1.5 1.5 0 0 1 0 2.1l-5.4 5.4a1.5 1.5 0 0 1-2.1 0Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
    </>
  ),
  owner: (
    <>
      <circle cx="12" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 19a6.5 6.5 0 0 1 13 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  stage: (
    <>
      <path d="M5 12h14M5 6h14M5 18h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  merge: (
    <>
      <path d="M7 4v4a5 5 0 0 0 5 5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 10l3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="7" cy="4" r="1.4" fill="currentColor" />
    </>
  ),
  consent: (
    <>
      <path d="M12 3.5 19 6v5.5c0 4.4-3 7.4-7 9-4-1.6-7-4.6-7-9V6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

export function KindIcon({ kind, className = "size-4" }: { kind: TimelineIconKind; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      {paths[kind]}
    </svg>
  );
}
