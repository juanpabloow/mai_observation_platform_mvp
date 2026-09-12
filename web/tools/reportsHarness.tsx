"use client";

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReportsTab } from "../components/reuniones/ReportsTab";
import type { ReportView, TemplateView } from "../lib/meetingsData";
import { BUILTIN_TEMPLATES } from "@worker/meetings/analysis/reports/templates.js";

/**
 * ARNÉS DE LA PESTAÑA REPORTES.
 *
 * Lo que hay que comprobar aquí son EFECTOS en un navegador: que el catálogo y
 * el documento quepan a la vez, que el editor de instrucciones no rompa la
 * columna, que las citas se vean como citas, y que en móvil no haya que hacer
 * scroll horizontal para llegar a los botones.
 *
 * ── Por qué un arnés y no la aplicación ───────────────────────────────────
 *
 * Porque probar esto en la aplicación significa GENERAR un reporte, y generar
 * cuesta dinero y necesita las claves, que viven sólo en Railway. Aquí el
 * `fetch` está sustituido: «Generar» devuelve un reporte sintético, «Guardar»
 * sube la versión en memoria y «Restaurar» la devuelve. Ninguna llamada sale de
 * la máquina y ningún dato real entra.
 *
 * Los componentes son los DE VERDAD, y las cuatro plantillas son las
 * predeterminadas del código, no una copia.
 */

const CLIENTE = "22222222-2222-4222-8222-222222222222";
const REUNION = "aaaaaaaa-0000-4000-8000-000000000001";

/** Las cuatro plantillas reales, como las devolvería el servidor tras sembrar. */
function plantillasIniciales(): TemplateView[] {
  return BUILTIN_TEMPLATES.map((b, i) => ({
    id: `tttttttt-0000-4000-8000-00000000000${i + 1}`,
    slug: b.slug,
    name: b.name,
    description: b.description,
    instructions: b.instructions,
    version: 1,
    isBuiltin: true,
    modified: false,
    editedByUser: false,
    updatedAt: "2026-09-11T10:00:00.000Z",
  }));
}

/**
 * Un reporte como el que sale del servidor: cabecera desde la base, citas
 * resueltas, un responsable respaldado, otro sin asignar y una fecha que no
 * consta. Es el caso que hay que poder LEER de un vistazo.
 */
function reporteSintetico(templateId: string, templateName: string, version: number): ReportView {
  return {
    id: `rrrrrrrr-0000-4000-8000-${String(Date.now()).slice(-12)}`,
    templateId,
    templateName,
    templateVersion: version,
    transcriptId: "cccccccc-0000-4000-8000-000000000001",
    outdated: false,
    status: "ready",
    model: "gpt-4o-mini",
    modelReturned: "gpt-4o-mini-2024-07-18",
    inputTokens: 4210,
    outputTokens: 612,
    costUsd: 0.001,
    costEstimated: true,
    createdAt: new Date().toISOString(),
    instructionsSnapshot: "…",
    report: {
      header: {
        title: "ARNÉS · revisión del índice de búsqueda",
        clientName: "Cliente de prueba",
        dateIso: "2026-09-10T09:30:00.000Z",
        dateIsUpload: false,
        durationSeconds: 2462,
        participants: ["Ana Ruiz", "Hablante 2", "Hablante 3"],
      },
      purpose:
        "Se revisó el estado del índice de búsqueda y su coste de mantenimiento. " +
        "La reunión terminó con la decisión de migrarlo y con dos tareas repartidas.",
      sections: [
        {
          heading: "Temas tratados",
          body:
            "El índice tarda más de lo aceptable en reconstruirse y el coste mensual ha subido. " +
            "Se discutieron dos alternativas y se descartó una por el tiempo de migración.",
          items: [],
          citation: { segmentIndex: 12, at: 184, stamp: "3:04", by: "Ana Ruiz", initials: "AR" },
        },
        {
          heading: "Decisiones",
          body: null,
          citation: null,
          items: [
            {
              id: "s1i0",
              text: "Se migra el índice a la configuración nueva antes del cierre de trimestre.",
              owner: "Ana Ruiz",
              dueText: "antes del cierre de trimestre",
              citation: { segmentIndex: 34, at: 742, stamp: "12:22", by: "Ana Ruiz", initials: "AR" },
            },
          ],
        },
        {
          heading: "Compromisos",
          body: null,
          citation: null,
          items: [
            {
              id: "s2i0",
              text: "Avisar al equipo de soporte del corte de servicio previsto.",
              owner: "Hablante 2",
              dueText: "el viernes",
              citation: { segmentIndex: 51, at: 1130, stamp: "18:50", by: "Hablante 2", initials: "2" },
            },
            {
              id: "s2i1",
              text: "Medir el tamaño real del índice en producción para dimensionar la máquina.",
              owner: null,
              dueText: null,
              citation: { segmentIndex: 58, at: 1301, stamp: "21:41", by: "Hablante 3", initials: "3" },
            },
          ],
        },
        {
          heading: "Próximos pasos",
          body: null,
          citation: null,
          items: [
            {
              id: "s3i0",
              text: "Volver a mirar el coste una vez migrado, para confirmar el ahorro.",
              owner: null,
              dueText: null,
              citation: { segmentIndex: 71, at: 1590, stamp: "26:30", by: "Ana Ruiz", initials: "AR" },
            },
          ],
        },
      ],
      caveat:
        "No se concretó quién dimensiona la máquina. " +
        "1 responsable no correspondía a ningún participante de la reunión y quedó sin asignar. " +
        "1 fecha no constaba en el segmento citado y se omitió.",
    },
  };
}

/**
 * El estado vive en un módulo, no en un ref dentro del render.
 *
 * El `fetch` falso se instala una vez y tiene que leer las plantillas VIGENTES
 * cuando llega la petición, no las que había cuando se instaló. Un `ref`
 * construido en el cuerpo del render no sirve para eso —se crea nuevo en cada
 * pasada—, así que la fuente de verdad es esto y React sólo se enrola para
 * repintar.
 */
let plantillasVivas: TemplateView[] = plantillasIniciales();
let reportesVivos: ReportView[] = [];
const suscriptores = new Set<() => void>();
const avisar = () => suscriptores.forEach((f) => f());

let instalado = false;
function instalarFetch() {
  if (instalado) return;
  instalado = true;
  const original = window.fetch.bind(window);
  window.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof entrada === "string" ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const cuerpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    // Un retardo real: es lo que hace visible «Generando…» y «Guardando…».
    await new Promise((r) => setTimeout(r, 700));

    if (url.includes("/reports")) {
      const t = plantillasVivas.find((x) => x.id === String(cuerpo.templateId))!;
      const nuevo = reporteSintetico(t.id, t.name, t.version);
      reportesVivos = [nuevo, ...reportesVivos];
      avisar();
      return new Response(JSON.stringify({ state: "ready", report: nuevo, reused: false }), { status: 200 });
    }
    if (url.includes("/restore")) {
      const id = url.split("/report-templates/")[1].split("/")[0];
      const base = plantillasIniciales().find((b) => b.id === id)!;
      plantillasVivas = plantillasVivas.map((t) =>
        t.id === id
          ? { ...t, version: t.version + 1, modified: false, editedByUser: false, instructions: base.instructions }
          : t,
      );
      avisar();
      return new Response(JSON.stringify({ template: {} }), { status: 200 });
    }
    if (url.includes("/report-templates/")) {
      const id = url.split("/report-templates/")[1];
      plantillasVivas = plantillasVivas.map((t) =>
        t.id === id
          ? { ...t, version: t.version + 1, modified: true, editedByUser: true, instructions: String(cuerpo.instructions) }
          : t,
      );
      avisar();
      return new Response(JSON.stringify({ template: {} }), { status: 200 });
    }
    return original(entrada as RequestInfo, init);
  }) as typeof window.fetch;
}

function Arnes() {
  const [, repintar] = useState(0);
  const [vacio, setVacio] = useState(true);
  const [ultimoSeek, setUltimoSeek] = useState<number | null>(null);

  useEffect(() => {
    instalarFetch();
    const f = () => repintar((n) => n + 1);
    suscriptores.add(f);
    return () => { suscriptores.delete(f); };
  }, []);

  const conReporte = reportesVivos.length > 0
    ? reportesVivos
    : [reporteSintetico(plantillasVivas[0].id, plantillasVivas[0].name, plantillasVivas[0].version)];

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="text-[0.8125rem] font-medium text-foreground">Arnés · pestaña Reportes</span>
        <button
          type="button"
          id="alternar-vacio"
          onClick={() => setVacio((v) => !v)}
          className="rounded-lg border border-line px-2.5 py-1 text-[0.78125rem] text-muted"
        >
          {vacio ? "Mostrar un reporte" : "Volver al estado vacío"}
        </button>
        <span className="ml-auto text-[0.78125rem] text-muted">
          último seek: <span className="u-mono text-foreground" id="ultimo-seek">{ultimoSeek === null ? "—" : `${ultimoSeek}s`}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <ReportsTab
          meetingId={REUNION}
          clientId={CLIENTE}
          templates={plantillasVivas}
          reports={vacio ? [] : conReporte}
          canEditTemplates
          hasTranscript
          // En la aplicación esto es `jumpTo`, que además cambia a Transcript.
          // Aquí sólo se anota: lo que hay que ver es que la cita es pulsable y
          // lleva el segundo correcto.
          onSeek={(s) => setUltimoSeek(s)}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Arnes />);
