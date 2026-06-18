import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { AppSidebar } from "@/components/AppSidebar";
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
      <body className="min-h-full flex flex-col">
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
              <AppSidebar />
            </Suspense>
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
