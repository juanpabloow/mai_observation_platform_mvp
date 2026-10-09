"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

/**
 * A quiet light/dark toggle for the PUBLIC booking page — one ghost icon button, so it
 * never competes with the booking itself. It writes the same next-themes setting the
 * app's account menu does (this origin only, no cookie, no server state); until the
 * visitor touches it, the page follows their device.
 *
 * The resolved theme is only known in the browser, so the icon renders after hydration
 * (an empty, same-size button before) — no server/client mismatch, no layout shift.
 */

const subscribe = () => () => undefined;

export function BookingThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, () => true, () => false);
  const isDark = mounted && resolvedTheme === "dark";
  const label = isDark ? "Usar tema claro" : "Usar tema oscuro";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={mounted ? label : "Cambiar tema"}
      title={mounted ? label : undefined}
      className="u-focus inline-flex size-[44px] shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface text-foreground/80 transition-colors hover:bg-subtle hover:text-foreground"
    >
      {!mounted ? null : isDark ? (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <path d="M13.5 9.6A5.5 5.5 0 0 1 6.4 2.5a5.5 5.5 0 1 0 7.1 7.1Z" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}
