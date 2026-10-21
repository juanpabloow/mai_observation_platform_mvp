import type { Metadata } from "next";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppSidebarServer } from "@/components/AppSidebarServer";
import { ScopeProviderServer } from "@/components/ScopeProviderServer";
import { ScopeSync } from "@/components/ScopeSync";
import { Providers } from "./providers";
import { parseSidebarTheme, SIDEBAR_THEME_COOKIE } from "@/lib/sidebarTheme";
import { parseSidebarCollapsed, SIDEBAR_COLLAPSED_COOKIE } from "@/lib/sidebarCollapsed";
import { MODULE_RAIL_COOKIE, parseModuleRailOpen } from "@/lib/moduleRail";
import { isChromelessPath } from "@/lib/shellChrome";
import { parseTextScale, TEXT_SCALE_COOKIE } from "@/lib/textScale";
import { parseTopbarPref, resolveTopbarPref, TOPBAR_COOKIE } from "@/lib/topbarPref";
import { getSessionScope } from "@/lib/access";
import "./globals.css";

// Self-hosted (next/font/local) so `next build` never calls Google Fonts — that build-time
// fetch is what broke Railway deploys and offline builds. Same families, same variable weight
// axis, same CSS variables as the old next/font/google Geist pair. Files + provenance:
// web/app/fonts/README.md. adjustFontFallback defaults to "Arial" — the fallback Google used.
const geistSans = localFont({
  src: "./fonts/geist-sans-subset.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-geist-sans",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-subset.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Observability Platform",
  description: "Multi-tenant observability for n8n automations",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Sidebar appearance is a personal cookie preference, read HERE (server) and
  // stamped on <html> so the very first painted frame already has the right rail —
  // no flash, no client round-trip. An absent/unknown cookie resolves to the dark rail.
  const jar = await cookies();
  const sidebarTheme = parseSidebarTheme(jar.get(SIDEBAR_THEME_COOKIE)?.value);
  // Collapsed rail: the same kind of cookie preference (lib/sidebarCollapsed.ts). Read here
  // so the server draws the rail exactly as the browser's first render will — no
  // hydration mismatch, no expand-then-collapse jump.
  const sidebarCollapsed = parseSidebarCollapsed(jar.get(SIDEBAR_COLLAPSED_COOKIE)?.value);
  // The module screens' side menu (filters / section index), folded or open — the same
  // kind of SSR-read cookie (lib/moduleRail.ts), for the same no-mismatch reason.
  const moduleRailOpen = parseModuleRailOpen(jar.get(MODULE_RAIL_COOKIE)?.value);
  // Text size is the same kind of preference (see lib/textScale.ts): read here so the
  // very first frame is already at the chosen scale, with no resize flash.
  const textScale = parseTextScale(jar.get(TEXT_SCALE_COOKIE)?.value);
  // Screens that never carry the app chrome (auth, the public booking page). Used only
  // to decide whether the streaming placeholder for the rail is drawn — the frame
  // itself keys on the REAL rail being in the DOM (see .u-shell-frame), so a stale
  // value here can never frame a chromeless page.
  const chromeless = isChromelessPath((await headers()).get("x-pathname") ?? "");
  // Top bar (lib/topbarPref.ts): the stored choice, else the ROLE default — resolved only
  // when it matters (no choice yet, a page with chrome), so public pages pay no lookup.
  const storedTopbar = parseTopbarPref(jar.get(TOPBAR_COOKIE)?.value);
  const topbar = resolveTopbarPref(storedTopbar, storedTopbar || chromeless ? null : ((await getSessionScope())?.role ?? null));

  return (
    <html
      lang="en"
      data-sidebar-theme={sidebarTheme}
      data-text-scale={textScale}
      data-topbar={topbar}
      // next-themes sets the theme class on <html> before hydration; suppress the
      // resulting server/client class mismatch warning (no-flash approach).
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* FIXED SHELL: the body is exactly the viewport and never scrolls; the
          sidebar + header are pinned (they're non-scrolling flex items), and ONLY
          the content region scrolls. This is the single shell-level scroll
          architecture — pages don't manage the shell, they just render into the
          scrolling content region (or, under the workflow layout, into its slot).

          FINAL DESIGN: the SIDEBAR is the full-height first column and carries the
          brand at its top; the header starts AFTER it and spans only the content
          column (it is no longer a full-width bar above everything). */}
      <body className="h-full overflow-hidden flex flex-col">
        <Providers sidebarCollapsed={sidebarCollapsed} moduleRailOpen={moduleRailOpen}>
          {/* ScopeProviderServer seeds the client scope context (per-client "current
              workflow") from the request; ScopeSync keeps it URL-accurate across
              client-side navigation. Both wrap the header + sidebar so those read the
              scope from context (never a stale layout-captured value — the H-8.1 trap). */}
          <ScopeProviderServer>
            <Suspense fallback={null}>
              <ScopeSync />
            </Suspense>
            {/* [sidebar | (header / content)]. On auth screens both the sidebar and
                the header render null, so content fills the full viewport.

                FRAMED SHELL (xl+, whenever the rail is present): the page ground takes
                the rail's colour, the rail sits flush on it with no divider, and the
                header + content become ONE rounded panel inset from the ground — see
                `.u-shell-frame` in globals.css. The placeholder carries data-collapsed
                so a streaming first paint is already framed, never framed-late. */}
            <div className="flex min-h-0 flex-1">
              <Suspense
                fallback={
                  chromeless ? null : (
                    <div
                      data-collapsed={sidebarCollapsed ? "true" : "false"}
                      aria-hidden
                      className={`hidden ${sidebarCollapsed ? "w-16" : "w-[var(--sidebar-width)]"} shrink-0 border-r border-sidebar-border bg-sidebar-bg xl:block`}
                    />
                  )
                }
              >
                <AppSidebarServer />
              </Suspense>
              <div className="u-shell-frame flex min-w-0 min-h-0 flex-1 flex-col">
                <Suspense fallback={null}>
                  <AppHeader />
                </Suspense>
                {/* THE scroll container — and the single owner of the content
                    GUTTER. Pages used to pad themselves, which meant every new page
                    had to remember to, and any page that set its own width/height
                    could cancel it. Putting the padding here makes the floating-card
                    look structural: the canvas (--background) shows through on all
                    four sides of whatever the page renders. */}
                <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-y-auto p-[var(--content-pad)]">
                  {children}
                </div>
              </div>
            </div>
          </ScopeProviderServer>
        </Providers>
      </body>
    </html>
  );
}
