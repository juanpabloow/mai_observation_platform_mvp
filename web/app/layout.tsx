import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppSidebarServer } from "@/components/AppSidebarServer";
import { Providers } from "./providers";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // next-themes sets the theme class on <html> before hydration; suppress the
      // resulting server/client class mismatch warning (no-flash approach).
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* FIXED SHELL: the body is exactly the viewport and never scrolls; the
          header + sidebar are pinned (they're non-scrolling flex items), and ONLY
          the content region scrolls. This is the single shell-level scroll
          architecture — pages don't manage the shell, they just render into the
          scrolling content region (or, under the workflow layout, into its slot). */}
      <body className="h-full overflow-hidden flex flex-col">
        <Providers>
          <Suspense fallback={null}>
            <AppHeader />
          </Suspense>
          {/* Below the full-width header: [sidebar | content]. On auth screens both
              the header and sidebar render null, so content fills the full width. */}
          <div className="flex min-h-0 flex-1">
            <Suspense
              fallback={<div className="hidden w-52 shrink-0 border-r border-line bg-sidebar md:block" />}
            >
              <AppSidebarServer />
            </Suspense>
            {/* THE scroll container. min-h-0 lets it shrink within the fixed shell
                so its own overflow (or a child's) scrolls instead of growing. */}
            <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
