import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppSidebarServer } from "@/components/AppSidebarServer";
import { ScopeProviderServer } from "@/components/ScopeProviderServer";
import { ScopeSync } from "@/components/ScopeSync";
import { Providers } from "./providers";
import { parseSidebarTheme, SIDEBAR_THEME_COOKIE } from "@/lib/sidebarTheme";
import { parseTextScale, TEXT_SCALE_COOKIE } from "@/lib/textScale";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
  // no flash, no client round-trip. An absent/unknown cookie resolves to Light.
  const jar = await cookies();
  const sidebarTheme = parseSidebarTheme(jar.get(SIDEBAR_THEME_COOKIE)?.value);
  // Text size is the same kind of preference (see lib/textScale.ts): read here so the
  // very first frame is already at the chosen scale, with no resize flash.
  const textScale = parseTextScale(jar.get(TEXT_SCALE_COOKIE)?.value);

  return (
    <html
      lang="en"
      data-sidebar-theme={sidebarTheme}
      data-text-scale={textScale}
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
        <Providers>
          {/* ScopeProviderServer seeds the client scope context (per-client "current
              workflow") from the request; ScopeSync keeps it URL-accurate across
              client-side navigation. Both wrap the header + sidebar so those read the
              scope from context (never a stale layout-captured value — the H-8.1 trap). */}
          <ScopeProviderServer>
            <Suspense fallback={null}>
              <ScopeSync />
            </Suspense>
            {/* [sidebar | (header / content)]. On auth screens both the sidebar and
                the header render null, so content fills the full viewport. */}
            <div className="flex min-h-0 flex-1">
              <Suspense
                fallback={<div className="hidden w-60 shrink-0 border-r border-line bg-sidebar md:block" />}
              >
                <AppSidebarServer />
              </Suspense>
              <div className="flex min-w-0 min-h-0 flex-1 flex-col">
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
