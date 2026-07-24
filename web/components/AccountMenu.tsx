"use client";

import Link from "next/link";
import { useTheme } from "next-themes";

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
