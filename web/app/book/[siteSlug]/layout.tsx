import localFont from "next/font/local";

/**
 * The public booking segment (/book/{slug}) — page AND its not-found share the v3
 * typography: Newsreader for titles, self-hosted by next/font/local (no request to Google
 * from the visitor's browser AND none from the build server). The variable is consumed by
 * `font-pb-serif` (globals.css). Weights 400/500 only, opsz pinned to 18 (its default — the
 * old next/font/google kept only wght); fallback "Times New Roman". See web/app/fonts/README.md.
 */
const newsreader = localFont({
  src: "../../fonts/newsreader-subset.woff2",
  weight: "400 500",
  style: "normal",
  display: "swap",
  variable: "--font-pb-newsreader",
  adjustFontFallback: "Times New Roman",
});

export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${newsreader.variable} flex min-h-full flex-none flex-col`}>{children}</div>;
}
