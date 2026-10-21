# Self-hosted fonts (no build-time network)

These `.woff2` files are committed so `next build` NEVER contacts Google Fonts. A
`next/font/google` import fetches the font CSS + files from Google at build time, so any
network hiccup (or an unlucky subset/weight combination) fails the whole Railway deploy —
and it's why the web app couldn't be built offline. See the layouts that consume them:
`web/app/layout.tsx` (Geist, Geist Mono) and `web/app/{book/[siteSlug],resena}/layout.tsx`
(Newsreader), all via `next/font/local`.

Rendering is unchanged: same families, same weights, same CSS variables, same fallbacks
(`Arial` for the Geist pair, `Times New Roman` for Newsreader — the metrics `next/font/google`
had picked).

## What each file is

| File | Family | Axes kept | Subsets |
|------|--------|-----------|---------|
| `geist-sans-subset.woff2`  | Geist       | `wght 100..900` (variable) | latin + latin-ext |
| `geist-mono-subset.woff2`  | Geist Mono  | `wght 100..900` (variable) | latin + latin-ext |
| `newsreader-subset.woff2`  | Newsreader  | `wght 400..500` (variable), `opsz` pinned to 18 (its default — `next/font/google` kept only `wght`) | latin + latin-ext |

Cyrillic / Vietnamese subsets are dropped (unused by a Spanish/English UI). `OFL-*.txt` are
the SIL Open Font License texts — required to ship with the fonts.

## Regenerating

Sources: the original OFL variable fonts from `github.com/google/fonts`
(`ofl/geist`, `ofl/geistmono`, `ofl/newsreader`) — the same upstream Google Fonts serves.
Processed with `fonttools` (`pip install fonttools brotli`): Newsreader is first instanced
(`opsz=18`, `wght=400:500`) then all three are `pyftsubset`-ed to the latin + latin-ext
unicode ranges with `--layout-features='*'` (keep all shaping/kerning) and `--flavor=woff2`.
