"use client";

import Link from "next/link";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  DEFAULT_SIDEBAR_THEME,
  SIDEBAR_THEMES,
  SIDEBAR_THEME_LABELS,
  parseSidebarTheme,
  sidebarThemeCookie,
  type SidebarTheme,
} from "@/lib/sidebarTheme";
import {
  DEFAULT_TEXT_SCALE,
  TEXT_SCALES,
  TEXT_SCALE_LABELS,
  parseTextScale,
  textScaleCookie,
  type TextScale,
} from "@/lib/textScale";

/**
 * The shared ACCOUNT menu content (identity + theme + real account actions). ONE
 * implementation, rendered by BOTH the header's profile dropdown and the sidebar's
 * bottom account popover — so the two never diverge and nothing is duplicated. Every
 * action here is a REAL existing route/control:
 *   - Theme: light / dark / system (next-themes).
 *   - Team + n8n connections: owner/admin only (a member would be bounced).
 *   - Sign-in & security: per-user, every role.
 *   - Log out.
 * `onNavigate` lets the host close its popover when a link is followed.
 */
export function AccountMenu({
  email,
  role,
  clientLabel,
  canSwitchClients,
  onNavigate,
}: {
  email: string;
  role: "owner" | "admin" | "member";
  /** A member's client name (so they see where they're scoped); else null. */
  clientLabel: string | null;
  /** false for a member — hides the tenant-wide management links. */
  canSwitchClients: boolean;
  onNavigate?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <div className="border-b border-line px-3 py-2">
        <p className="text-[10px] font-medium uppercase tracking-wider text-faint">Signed in as</p>
        <p className="truncate text-sm text-foreground">{email}</p>
        <p className="mt-0.5 truncate text-xs capitalize text-muted">
          {role}
          {clientLabel ? <span className="text-faint"> · {clientLabel}</span> : null}
        </p>
      </div>
      <div className="border-b border-line px-3 py-2.5">
        <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">Theme</p>
        <div className="flex gap-0.5 rounded-lg border border-line p-0.5">
          {(["light", "dark", "system"] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setTheme(opt)}
              aria-pressed={theme === opt}
              className={`flex-1 rounded-md px-2 py-1 text-xs capitalize transition-colors ${
                theme === opt
                  ? "bg-subtle font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
      <SidebarAppearance />
      <TextSize />
      <div className="py-1">
        {/* Owner/admin-only management — hidden for a member (they'd be bounced). */}
        {canSwitchClients ? (
          <>
            <Link
              href="/settings/team"
              onClick={onNavigate}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
            >
              Team
            </Link>
            <Link
              href="/settings/connections"
              onClick={onNavigate}
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
            >
              n8n connections
            </Link>
          </>
        ) : null}
        {/* Per-USER sign-in settings — every role manages their own credentials. */}
        <Link
          href="/settings/security"
          onClick={onNavigate}
          className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-subtle"
        >
          Sign-in &amp; security
        </Link>
        <Link
          href="/logout"
          onClick={onNavigate}
          className="flex w-full items-center px-3 py-1.5 text-left text-sm text-danger transition-colors hover:bg-red-500/10"
        >
          Log out
        </Link>
      </div>
    </>
  );
}

/**
 * SIDEBAR APPEARANCE — recolors ONLY the navigation rail (Light | Black). It is a
 * personal interface preference, so it lives in a cookie: no table, no migration,
 * nothing tenant- or client-scoped.
 *
 * The authoritative value at paint time is the `data-sidebar-theme` attribute the
 * ROOT LAYOUT stamps on <html> from that cookie during SSR — which is what makes
 * the rail correct on the very first frame. Here we simply mirror it: the current
 * value is read from the DOM after mount (never during render, which would break
 * SSR), and choosing an option writes the attribute immediately (instant feedback,
 * no re-render, no round-trip) AND the cookie (so the next SSR agrees).
 */
/**
 * TEXT SIZE — the same mechanics as SidebarAppearance above: seed from the attribute
 * the server stamped, write the attribute (instant rescale) and the cookie (so the
 * next SSR agrees). Scaling the rem root moves type AND spacing together, which is
 * why this reads as a density control rather than a font-size slider.
 */
function TextSize() {
  const [scale, setScale] = useState<TextScale>(() =>
    typeof document === "undefined"
      ? DEFAULT_TEXT_SCALE
      : parseTextScale(document.documentElement.dataset.textScale),
  );

  useEffect(() => {
    document.documentElement.dataset.textScale = scale;
    document.cookie = textScaleCookie(scale);
  }, [scale]);

  return (
    <div className="border-b border-line px-3 py-2.5">
      <p id="text-size-label" className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
        Text size
      </p>
      <div role="group" aria-labelledby="text-size-label" className="flex gap-0.5 rounded-lg border border-line p-0.5">
        {TEXT_SCALES.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setScale(opt)}
            aria-pressed={scale === opt}
            className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
              scale === opt ? "bg-subtle font-medium text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {TEXT_SCALE_LABELS[opt]}
          </button>
        ))}
      </div>
    </div>
  );
}

function SidebarAppearance() {
  // Seeded from the attribute the server stamped. The menu only ever mounts AFTER
  // the user opens the popover, so this initializer never runs during SSR — the
  // typeof guard is belt-and-braces for any future caller that renders it eagerly.
  const [theme, setTheme] = useState<SidebarTheme>(() =>
    typeof document === "undefined"
      ? DEFAULT_SIDEBAR_THEME
      : parseSidebarTheme(document.documentElement.dataset.sidebarTheme),
  );

  // Push the choice OUT to the DOM (instant repaint of the rail) and to the cookie
  // (so the next SSR agrees). This is the sanctioned direction for an effect —
  // synchronising an external system with React state — which is why the click
  // handler only setStates and never touches `document` itself.
  useEffect(() => {
    document.documentElement.dataset.sidebarTheme = theme;
    document.cookie = sidebarThemeCookie(theme);
  }, [theme]);

  return (
    <div className="border-b border-line px-3 py-2.5">
      <p id="sidebar-appearance-label" className="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
        Sidebar appearance
      </p>
      <div role="group" aria-labelledby="sidebar-appearance-label" className="flex gap-0.5 rounded-lg border border-line p-0.5">
        {SIDEBAR_THEMES.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setTheme(opt)}
            aria-pressed={theme === opt}
            className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
              theme === opt ? "bg-subtle font-medium text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {SIDEBAR_THEME_LABELS[opt]}
          </button>
        ))}
      </div>
    </div>
  );
}
