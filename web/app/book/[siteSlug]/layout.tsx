import { Newsreader } from "next/font/google";

/**
 * The public booking segment (/book/{slug}) — page AND its not-found share the v3
 * typography: Newsreader for titles, self-hosted by next/font (no request to Google from
 * the visitor's browser). The variable is consumed by `font-pb-serif` (globals.css).
 */
const newsreader = Newsreader({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-pb-newsreader",
});

export default function PublicBookingLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${newsreader.variable} flex min-h-full flex-none flex-col`}>{children}</div>;
}
