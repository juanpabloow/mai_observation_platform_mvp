/**
 * Empaqueta el arnés interactivo del transcript y escribe el HTML que lo carga.
 *
 *   cd web && node tools/buildTranscriptHarness.mjs <dir-de-salida> <css>
 *
 * `next/link` se sustituye por un stub: entra en el grafo sólo porque `ui/primitives`
 * lo importa, y fuera de Next no hay router al que hablar. Un <a> hace el trabajo que
 * este arnés necesita.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "./harness");
const css = process.argv[3] ?? "harness.css";
mkdirSync(out, { recursive: true });

// El stub vive DENTRO del proyecto: escrito en el directorio de salida, esbuild no
// podía resolver "react" desde allí.
const stub = resolve("tools/.next-link-stub.jsx");
writeFileSync(
  stub,
  `import { createElement } from "react";\n` +
    `export default function Link({ href, children, ...rest }) {\n` +
    `  return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);\n` +
    `}\n`,
);

await build({
  entryPoints: ["tools/transcriptHarness.tsx"],
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: { "next/link": stub },
  outfile: join(out, "transcript-harness.js"),
  logLevel: "warning",
});

writeFileSync(
  join(out, "transcript-harness.html"),
  `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Transcript · arnés interactivo</title><link rel="stylesheet" href="${css}">
</head><body class="bg-background"><div id="root"></div>
<script src="transcript-harness.js"></script></body></html>`,
);
console.log(`  ✓ ${join(out, "transcript-harness.html")}`);
