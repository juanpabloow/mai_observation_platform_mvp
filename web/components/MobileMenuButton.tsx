"use client";

import { useSidebar } from "./SidebarContext";

/**
 * The phone's navigation, INSIDE a screen's own header (2026-10-23: «solo deja el hamburguer
 * menu pero mejor integrado, sin que se vea esa franja arriba»). It opens the same drawer the
 * top bar's button opened. A phone screen that renders it marks itself with
 * `data-integrated-nav`, and below 768px that hides the global top strip (globals.css) — a
 * screen without its own header keeps the strip, so no screen is ever left without navigation.
 */
export function MobileMenuButton({ className = "" }: { className?: string }) {
  const { setMobileOpen } = useSidebar();
  return (
    <button
      type="button"
      data-integrated-nav=""
      onClick={() => setMobileOpen(true)}
      aria-label="Abrir menú"
      className={`flex size-9 flex-none items-center justify-center rounded-full bg-m-sf2 text-m-tx ${className}`}
    >
      <svg aria-hidden viewBox="0 0 20 20" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
        <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
      </svg>
    </button>
  );
}
