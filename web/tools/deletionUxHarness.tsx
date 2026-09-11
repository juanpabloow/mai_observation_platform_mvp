"use client";

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MeetingsTable } from "../components/reuniones/MeetingsTable";
import {
  MeetingActionsMenu,
  MeetingDeletionProvider,
} from "../components/reuniones/MeetingDeletion";
import { HANDOFF_KEY } from "../lib/meetingsDeletionFlow";
import type { MeetingListItem } from "../lib/meetingsData";

/**
 * ARNÉS DEL CIERRE DE «ELIMINAR REUNIÓN».
 *
 * Lo que hay que ver aquí son EFECTOS en un navegador, no código: que la fila
 * desaparezca en el mismo gesto, que el aviso salga y se vaya solo, que un 500
 * deje la reunión donde estaba con el botón otra vez disponible, y que la ficha
 * pida irse al listado en vez de quedarse mirando algo que ya no existe.
 *
 * ── Por qué un arnés y no la aplicación ───────────────────────────────────
 *
 * Porque probar esto en la aplicación real significa ELIMINAR una reunión real,
 * y las doce que hay en staging son grabaciones de verdad. Aquí el `fetch` está
 * sustituido por uno que contesta lo que se le pida —202, 500 o nada— así que
 * se ejercita la pantalla sin tocar ninguna base de datos, ningún bucket y
 * ningún dato de nadie.
 *
 * Los componentes son los DE VERDAD: el mismo proveedor, el mismo diálogo, la
 * misma tabla y el mismo menú que monta la pantalla. Lo único falso son las
 * tres reuniones, la respuesta HTTP y el router (ver el stub del empaquetado,
 * que además anota a dónde se pidió navegar).
 */

declare global {
  interface Window {
    /** Lo que el stub de `next/navigation` anotó. */
    __rutas?: { tipo: string; href: string }[];
    /** Lo que el arnés contestará al próximo POST …/delete. */
    __respuesta?: "202" | "500" | "409" | "red";
    /** Cada llamada que llegó al `fetch` falso, sin cuerpos. */
    __llamadas?: { url: string; metodo: string }[];
  }
}

window.__rutas = [];
window.__llamadas = [];
window.__respuesta = "202";

const originalFetch = window.fetch.bind(window);
window.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
  if (!url.includes("/delete")) return originalFetch(entrada as RequestInfo, init);

  window.__llamadas!.push({ url, metodo: init?.method ?? "GET" });
  // Un retardo corto y real: es lo que hace visible el estado «Eliminando…».
  await new Promise((r) => setTimeout(r, 400));

  if (window.__respuesta === "red") throw new TypeError("Failed to fetch");
  if (window.__respuesta === "500") {
    return new Response(JSON.stringify({ message: "boom" }), { status: 500 });
  }
  if (window.__respuesta === "409") {
    return new Response(JSON.stringify({ message: "La reunión está siendo procesada." }), { status: 409 });
  }
  return new Response(JSON.stringify({ reserved: true, state: "deleting" }), { status: 202 });
}) as typeof window.fetch;

// ── Tres reuniones inventadas ──────────────────────────────────────────────

const CLIENTE = "22222222-2222-4222-8222-222222222222";

function reunion(n: number, titulo: string): MeetingListItem {
  return {
    id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
    title: titulo,
    source: { kind: "file", filename: `arnes-${n}.m4a`, size: "12,4 MB" },
    when: "11 sept 2026, 10:30",
    duration: "41:02",
    participants: [
      { initials: "AB", name: "A. Baeza", role: null, share: 62 },
      { initials: "CD", name: "C. Duarte", role: null, share: 38 },
    ],
    extraParticipants: 0,
    status: { kind: "done" },
    tasks: 3,
    reports: 1,
    updated: "hace 2 h",
    deletionState: "live",
  };
}

const REUNIONES = [
  reunion(1, "ARNÉS · primera (elimina ésta)"),
  reunion(2, "ARNÉS · segunda"),
  reunion(3, "ARNÉS · tercera"),
];

// ── Los mandos ─────────────────────────────────────────────────────────────

function Mando({ etiqueta, valor, actual, onElegir }: {
  etiqueta: string;
  valor: NonNullable<Window["__respuesta"]>;
  actual: string;
  onElegir: (v: NonNullable<Window["__respuesta"]>) => void;
}) {
  return (
    <button
      type="button"
      id={`respuesta-${valor}`}
      onClick={() => onElegir(valor)}
      className={`rounded-lg border px-2.5 py-1 text-[0.78125rem] ${
        actual === valor ? "border-accent text-foreground" : "border-line text-muted"
      }`}
    >
      {etiqueta}
    </button>
  );
}

function Arnes() {
  const [respuesta, setRespuesta] = useState<NonNullable<Window["__respuesta"]>>("202");
  const [montaje, setMontaje] = useState(0);

  const elegir = (v: NonNullable<Window["__respuesta"]>) => {
    window.__respuesta = v;
    setRespuesta(v);
  };

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-background p-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <span className="text-[0.8125rem] font-medium text-foreground">El servidor contesta:</span>
        <Mando etiqueta="202 aceptado" valor="202" actual={respuesta} onElegir={elegir} />
        <Mando etiqueta="500" valor="500" actual={respuesta} onElegir={elegir} />
        <Mando etiqueta="409 con mensaje" valor="409" actual={respuesta} onElegir={elegir} />
        <Mando etiqueta="la red se cae" valor="red" actual={respuesta} onElegir={elegir} />
        <button
          type="button"
          id="remontar-listado"
          // Una recarga del listado, que es lo que pasa al aterrizar desde la
          // ficha: el proveedor se monta de nuevo y consume el relevo del aviso.
          onClick={() => setMontaje((m) => m + 1)}
          className="ml-auto rounded-lg border border-line px-2.5 py-1 text-[0.78125rem] text-muted"
        >
          Remontar el listado
        </button>
      </div>

      {/* ── EL LISTADO ──────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line-row px-3 py-2 text-[0.8125rem] font-semibold text-foreground">
          Listado · surface=&quot;list&quot;
        </h2>
        <div className="overflow-auto p-1" key={montaje}>
          <MeetingDeletionProvider clientId={CLIENTE} canDelete surface="list">
            <MeetingsTable
              meetings={REUNIONES}
              detailedIds={REUNIONES.map((m) => m.id)}
              basePath={`/clients/${CLIENTE}/reuniones`}
            />
          </MeetingDeletionProvider>
        </div>
      </section>

      {/* ── LA FICHA ───────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line-row px-3 py-2 text-[0.8125rem] font-semibold text-foreground">
          Ficha · surface=&quot;detail&quot;
        </h2>
        <div className="flex items-center gap-3 p-3">
          <span className="text-[0.8125rem] text-muted">
            El mismo menú de tres puntos que la cabecera de la reunión:
          </span>
          <MeetingDeletionProvider clientId={CLIENTE} canDelete surface="detail">
            <MeetingActionsMenu meeting={REUNIONES[0]} />
          </MeetingDeletionProvider>
        </div>
      </section>

      {/* ── LO QUE PASÓ ────────────────────────────────────────────────── */}
      <Registro />
    </div>
  );
}

/** Lo anotado por el router falso y el relevo del aviso, para poder leerlo. */
function Registro() {
  const [, tick] = useState(0);
  return (
    <section className="rounded-xl border border-line bg-surface p-3">
      <button
        type="button"
        id="refrescar-registro"
        onClick={() => tick((t) => t + 1)}
        className="rounded-lg border border-line px-2.5 py-1 text-[0.78125rem] text-muted"
      >
        Refrescar el registro
      </button>
      <dl className="mt-2 grid gap-1 text-[0.78125rem]">
        <div id="registro-rutas">
          <dt className="inline text-muted">Navegación pedida: </dt>
          <dd className="inline text-foreground u-mono">
            {(window.__rutas ?? []).map((r) => `${r.tipo}(${r.href})`).join(" · ") || "—"}
          </dd>
        </div>
        <div id="registro-relevo">
          <dt className="inline text-muted">Relevo del aviso: </dt>
          <dd className="inline text-foreground u-mono">
            {window.sessionStorage.getItem(HANDOFF_KEY) ?? "—"}
          </dd>
        </div>
        <div id="registro-llamadas">
          <dt className="inline text-muted">Llamadas: </dt>
          <dd className="inline text-foreground u-mono">
            {(window.__llamadas ?? []).map((l) => `${l.metodo} …${l.url.slice(-24)}`).join(" · ") || "—"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<Arnes />);
