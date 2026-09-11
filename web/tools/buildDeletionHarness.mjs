/**
 * Empaqueta el arnés del cierre de eliminación y escribe el HTML.
 *   cd web && node tools/buildDeletionHarness.mjs <dir-de-salida> <css>
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "./harness");
const css = process.argv[3] ?? "harness.css";
mkdirSync(out, { recursive: true });

const linkStub = resolve("tools/.next-link-stub.jsx");
writeFileSync(
  linkStub,
  `import { createElement } from "react";\n` +
    `export default function Link({ href, children, ...rest }) {\n` +
    `  return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children);\n` +
    `}\n`,
);

// Aquí el router SÍ importa: lo que hay que comprobar de la ficha es que pide
// irse al listado del cliente. El stub lo ANOTA en vez de tragárselo, porque
// fuera de Next no hay a dónde navegar pero sí hay qué verificar.
const navStub = resolve("tools/.next-nav-del-stub.jsx");
writeFileSync(
  navStub,
  `const anota = (tipo) => (href) => {\n` +
    `  (window.__rutas ||= []).push({ tipo, href: String(href) });\n` +
    `};\n` +
    `export function useRouter() {\n` +
    `  return { refresh: () => anota("refresh")(""), push: anota("push"), replace: anota("replace") };\n` +
    `}\n` +
    `export function usePathname() { return "/"; }\n` +
    `export function useSearchParams() { return new URLSearchParams(); }\n`,
);

await build({
  entryPoints: ["tools/deletionUxHarness.tsx"],
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: { "next/link": linkStub, "next/navigation": navStub },
  outfile: join(out, "deletion-harness.js"),
  logLevel: "warning",
});

writeFileSync(
  join(out, "deletion-harness.html"),
  `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cierre de «Eliminar reunión» · arnés</title><link rel="stylesheet" href="${css}">
</head><body class="bg-background"><div id="root"></div>
<script src="deletion-harness.js"></script></body></html>`,
);
console.log(`  ✓ ${join(out, "deletion-harness.html")}`);
