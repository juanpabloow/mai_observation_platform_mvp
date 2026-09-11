/**
 * Empaqueta el arnés del dock, genera un WAV audible y escribe el HTML.
 *   cd web && node tools/buildDockHarness.mjs <dir-de-salida> <css>
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
// `useRouter().refresh()` sólo lo llama el diálogo de eliminación tras un 202,
// que este arnés no ejercita. Un stub que no hace nada es fiel: fuera de Next
// no hay router al que hablar.
const navStub = resolve("tools/.next-nav-stub.jsx");
writeFileSync(
  navStub,
  `export function useRouter() { return { refresh() {}, push() {}, replace() {} }; }\n` +
    `export function usePathname() { return "/"; }\n` +
    `export function useSearchParams() { return new URLSearchParams(); }\n`,
);

await build({
  entryPoints: ["tools/dockHarness.tsx"],
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"' },
  alias: { "next/link": linkStub, "next/navigation": navStub },
  outfile: join(out, "dock-harness.js"),
  logLevel: "warning",
});

/* ── Un WAV de 240 s que se puede oír ──────────────────────────────────────
 * PCM 16 bits, 8 kHz mono. Un tono suave con pulsos cada segundo: al
 * reproducirlo se distingue que avanza, que es lo que hace falta para creerse
 * una captura. 240 s coincide con `durationSeconds` del arnés, así que la onda
 * y los tiempos cuadran.
 */
const RATE = 8000;
const SECS = 240;
const muestras = RATE * SECS;
const datos = Buffer.alloc(muestras * 2);
for (let i = 0; i < muestras; i += 1) {
  const t = i / RATE;
  const pulso = t % 1 < 0.08 ? 1 : 0.25;
  const v = Math.sin(2 * Math.PI * 220 * t) * 0.22 * pulso;
  datos.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2);
}
const cab = Buffer.alloc(44);
cab.write("RIFF", 0);
cab.writeUInt32LE(36 + datos.length, 4);
cab.write("WAVE", 8);
cab.write("fmt ", 12);
cab.writeUInt32LE(16, 16);
cab.writeUInt16LE(1, 20);
cab.writeUInt16LE(1, 22);
cab.writeUInt32LE(RATE, 24);
cab.writeUInt32LE(RATE * 2, 28);
cab.writeUInt16LE(2, 32);
cab.writeUInt16LE(16, 34);
cab.write("data", 36);
cab.writeUInt32LE(datos.length, 40);
writeFileSync(join(out, "tono.wav"), Buffer.concat([cab, datos]));

writeFileSync(
  join(out, "dock-harness.html"),
  `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dock del reproductor · arnés</title><link rel="stylesheet" href="${css}">
</head><body class="bg-background"><div id="root"></div>
<script src="dock-harness.js"></script></body></html>`,
);
console.log(`  ✓ ${join(out, "dock-harness.html")}  (+ tono.wav de ${SECS} s)`);
