import { Newsreader } from "next/font/google";

/** The public review segment (/resena/{token}) — same v3 typography as /book. */
const newsreader = Newsreader({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-pb-newsreader",
});

export default function PublicReviewLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${newsreader.variable} flex min-h-full flex-none flex-col`}>{children}</div>;
}
