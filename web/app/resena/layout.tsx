import localFont from "next/font/local";

/** The public review segment (/resena/{token}) — same v3 typography as /book, self-hosted by
 *  next/font/local (no Google fetch at build or run time). See web/app/fonts/README.md. */
const newsreader = localFont({
  src: "../fonts/newsreader-subset.woff2",
  weight: "400 500",
  style: "normal",
  display: "swap",
  variable: "--font-pb-newsreader",
  adjustFontFallback: "Times New Roman",
});

export default function PublicReviewLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${newsreader.variable} flex min-h-full flex-none flex-col`}>{children}</div>;
}
