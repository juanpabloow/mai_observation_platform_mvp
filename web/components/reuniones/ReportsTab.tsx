"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Chip, EmptyState, PRIMARY_SM_CLS } from "@/components/ui/primitives";
import { StampLink } from "@/components/reuniones/MeetingBits";
import { DOCK_GAP_CLS } from "@/components/reuniones/AudioDock";
import type {
  ReportView,
  ResolvedItem,
  ResolvedReport,
  TemplateView,
} from "@/lib/meetingsData";

/**
 * Reportes: el catálogo de plantillas a la izquierda, el documento a la derecha.
 *
 * ── Las plantillas se administran AQUÍ ─────────────────────────────────────
 *
 * No hay pantalla de administración aparte. Editar las instrucciones de «Acta
 * general» es algo que se hace mirando el acta que produjo, no en otro sitio
 * del producto: el ciclo es leer, ajustar, regenerar, comparar. Separarlos
 * obligaría a ir y volver para cada ajuste.
 *
 * ── Qué se ve del prompt y qué no ──────────────────────────────────────────
 *
 * Sólo las instrucciones en lenguaje natural. El system prompt, el esquema, las
 * reglas antiinvención, la lista cerrada de responsables y el cálculo del coste
 * no llegan hasta aquí porque la API no los devuelve — no es que estén
 * escondidos en el cliente, es que no salen del servidor.
 *
 * ── Las citas usan el reproductor QUE YA HAY ───────────────────────────────
 *
 * `onSeek` es el mismo `jumpTo` del workspace: mueve el playhead y cambia a
 * Transcript. No se crea ningún `<audio>` aquí, ni se toca el dock, ni su modo
 * compacto, ni el seguimiento. Un segundo elemento de audio es exactamente el
 * fallo que costó el arreglo del reproductor flotante.
 */

type Fase =
  | { kind: "idle" }
  | { kind: "generating"; templateId: string }
  | { kind: "error"; templateId: string; message: string };

export function ReportsTab({
  meetingId,
  clientId,
  templates,
  reports,
  canEditTemplates,
  hasTranscript,
  onSeek,
}: {
  meetingId: string;
  clientId: string;
  templates: readonly TemplateView[];
  reports: readonly ReportView[];
  /** owner/admin. El servidor lo vuelve a exigir: esto sólo decide qué se pinta. */
  canEditTemplates: boolean;
  hasTranscript: boolean;
  onSeek: (seconds: number) => void;
}) {
  const router = useRouter();
  const listos = useMemo(() => reports.filter((r) => r.status === "ready"), [reports]);
  const [abierto, setAbierto] = useState<string | null>(listos[0]?.id ?? null);
  const [fase, setFase] = useState<Fase>({ kind: "idle" });
  const [editando, setEditando] = useState<string | null>(null);

  const reporte = listos.find((r) => r.id === abierto) ?? null;

  const generar = useCallback(
    async (templateId: string) => {
      if (fase.kind === "generating") return;
      setFase({ kind: "generating", templateId });
      try {
        const r = await fetch(`/api/meetings/v1/meetings/${meetingId}/reports`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, templateId }),
        });
        const cuerpo = (await r.json().catch(() => null)) as
          | { report?: { id?: string } | null; error?: { message?: string } }
          | null;
        if (!r.ok) {
          setFase({
            kind: "error",
            templateId,
            message: cuerpo?.error?.message ?? `No se pudo generar el reporte (HTTP ${r.status}).`,
          });
          return;
        }
        // El id llega en la respuesta, así que el reporte nuevo queda abierto sin
        // esperar a que el refresco del servidor vuelva con la lista.
        if (cuerpo?.report?.id) setAbierto(cuerpo.report.id);
        setFase({ kind: "idle" });
        router.refresh();
      } catch {
        setFase({ kind: "error", templateId, message: "No se pudo contactar con el servidor." });
      }
    },
    [clientId, fase.kind, meetingId, router],
  );

  return (
    /* APILADO EN ESTRECHO, PARTIDO EN ANCHO.
       Un partido fijo de 22rem + resto deja el documento en 48 px a 375 px de
       ancho y saca la página a scroll horizontal — medido en el arnés. Debajo de
       `lg` el catálogo va arriba, con su propio alto acotado, y el documento
       debajo; los dos siguen siendo scrollers independientes, así que ninguno
       arrastra al otro y el hueco del dock sigue reservado en los dos. */
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      {/* ── EL CATÁLOGO ─────────────────────────────────────────────────── */}
      <div className={`flex max-h-[45vh] w-full shrink-0 flex-col overflow-y-auto border-b border-line lg:max-h-none lg:w-[22rem] lg:border-b-0 lg:border-r ${DOCK_GAP_CLS}`}>
        <h3 className="u-th flex items-center gap-1.5 border-b border-line-row px-4 py-2">
          Plantillas
          <span className="text-faint u-mono">{templates.length}</span>
        </h3>
        {templates.map((t) => (
          <TemplateRow
            key={t.id}
            template={t}
            clientId={clientId}
            canEdit={canEditTemplates}
            hasTranscript={hasTranscript}
            generating={fase.kind === "generating" && fase.templateId === t.id}
            busy={fase.kind === "generating"}
            error={fase.kind === "error" && fase.templateId === t.id ? fase.message : null}
            editing={editando === t.id}
            onEdit={() => setEditando(t.id)}
            onCloseEdit={() => setEditando(null)}
            onGenerate={() => generar(t.id)}
            onSaved={() => {
              setEditando(null);
              router.refresh();
            }}
          />
        ))}

        <h3 className="u-th flex items-center gap-1.5 border-b border-t border-line-row px-4 py-2">
          Reportes generados
          <span className="text-faint u-mono">{listos.length}</span>
        </h3>
        {listos.length === 0 ? (
          <p className="px-4 py-3 text-[0.78125rem] text-muted">
            Todavía ninguno. Genera uno con cualquier plantilla.
          </p>
        ) : (
          listos.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setAbierto(r.id)}
              aria-current={r.id === abierto}
              className={`flex flex-col gap-0.5 border-b border-line-row px-4 py-2.5 text-left transition-colors hover:bg-subtle ${
                r.id === abierto ? "bg-subtle" : ""
              }`}
            >
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[0.8125rem] font-medium text-foreground">{r.templateName}</span>
                <span className="shrink-0 text-[0.6875rem] text-faint u-mono">v{r.templateVersion}</span>
                {r.outdated ? <Chip tone="warn">Otra versión</Chip> : null}
              </span>
              <span className="text-[0.71875rem] text-muted">
                {fecha(r.createdAt)} · {citasDe(r)} citas
              </span>
            </button>
          ))
        )}
      </div>

      {/* ── EL DOCUMENTO ────────────────────────────────────────────────── */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {fase.kind === "generating" ? (
          <div className="p-6">
            <EmptyState
              title="Generando el reporte…"
              hint="Se está leyendo la transcripción activa. Puedes cambiar de pestaña: al volver estará aquí."
            />
          </div>
        ) : reporte === null ? (
          <div className="p-6">
            <EmptyState
              title={listos.length === 0 ? "Todavía no hay reportes" : "Elige un reporte"}
              hint={
                listos.length === 0
                  ? hasTranscript
                    ? "Elige una plantilla y pulsa Generar. El reporte cita el segmento del que sale cada línea, y no inventa responsables ni fechas: lo que no se dijo, no aparece."
                    : "Todavía no hay transcripción sobre la que informar."
                  : "Abre uno de los reportes generados de la lista."
              }
            />
          </div>
        ) : (
          <ReportDocument report={reporte} onSeek={onSeek} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  Una plantilla del catálogo
// ══════════════════════════════════════════════════════════════════════════

function TemplateRow({
  template: t,
  clientId,
  canEdit,
  hasTranscript,
  generating,
  busy,
  error,
  editing,
  onEdit,
  onCloseEdit,
  onGenerate,
  onSaved,
}: {
  template: TemplateView;
  clientId: string;
  canEdit: boolean;
  hasTranscript: boolean;
  generating: boolean;
  busy: boolean;
  error: string | null;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  onGenerate: () => void;
  onSaved: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-line-row px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-medium text-foreground">{t.name}</span>
            <span className="shrink-0 text-[0.6875rem] text-faint u-mono">v{t.version}</span>
            {/* «Modificada» se compara contra el predeterminado del CÓDIGO, que es
                el único que puede decirlo. */}
            {t.modified ? <Chip tone="muted">Modificada</Chip> : null}
          </span>
          <span className="text-[0.71875rem] leading-relaxed text-muted">{t.description}</span>
        </div>
      </div>

      {editing ? (
        <InstructionsEditor
          template={t}
          clientId={clientId}
          onCancel={onCloseEdit}
          onSaved={onSaved}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy || !hasTranscript}
            aria-busy={generating}
            title={hasTranscript ? undefined : "La reunión todavía no tiene transcripción"}
            className={PRIMARY_SM_CLS}
          >
            {generating ? "Generando…" : "Generar"}
          </button>
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={onEdit}
                className="u-focus inline-flex h-8 items-center rounded-md border border-line px-2.5 text-xs text-foreground transition-colors hover:bg-subtle"
              >
                Editar instrucciones
              </button>
              {t.isBuiltin ? (
                <RestoreButton template={t} clientId={clientId} onDone={onSaved} />
              ) : null}
            </>
          ) : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-[0.78125rem] text-danger">
          {error}{" "}
          <button type="button" onClick={onGenerate} className="u-focus underline decoration-danger/40">
            Reintentar
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * El editor de instrucciones.
 *
 * Manda `expectedVersion`, que es el testigo contra las ediciones perdidas: si
 * otra persona guardó mientras esto estaba abierto, el servidor responde 409 y
 * aquí se dice, en vez de pisar su versión sin que nadie se entere.
 */
function InstructionsEditor({
  template: t,
  clientId,
  onCancel,
  onSaved,
}: {
  template: TemplateView;
  clientId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [texto, setTexto] = useState(t.instructions);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sinCambios = texto.trim() === t.instructions.trim();

  const guardar = async () => {
    if (guardando || sinCambios) return;
    setGuardando(true);
    setError(null);
    try {
      const r = await fetch(`/api/meetings/v1/report-templates/${t.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, instructions: texto, expectedVersion: t.version }),
      });
      if (!r.ok) {
        const cuerpo = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(cuerpo?.error?.message ?? `No se pudo guardar (HTTP ${r.status}).`);
        setGuardando(false);
        return;
      }
      onSaved();
    } catch {
      setError("No se pudo contactar con el servidor.");
      setGuardando(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`instr-${t.id}`} className="text-[0.71875rem] text-muted">
        Instrucciones para el modelo. Dicen qué destacar y con qué forma; no pueden cambiar las
        reglas internas que evitan inventar responsables, fechas o decisiones.
      </label>
      <textarea
        id={`instr-${t.id}`}
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        rows={12}
        maxLength={6000}
        spellCheck
        className="u-focus w-full resize-y rounded-lg border border-line bg-background px-2.5 py-2 text-[0.78125rem] leading-relaxed text-foreground"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={guardar}
          disabled={guardando || sinCambios}
          aria-busy={guardando}
          className={PRIMARY_SM_CLS}
        >
          {guardando ? "Guardando…" : `Guardar como v${t.version + 1}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={guardando}
          className="u-focus inline-flex h-8 items-center rounded-md border border-line px-2.5 text-xs text-foreground transition-colors hover:bg-subtle disabled:opacity-50"
        >
          Cancelar
        </button>
        <span className="ml-auto text-[0.6875rem] text-faint u-mono">{texto.length}/6000</span>
      </div>
      {/* Se dice ANTES de guardar, no después: guardar no altera nada de lo ya
          generado, y quien edite tiene que saberlo para no buscar el cambio en
          un reporte viejo. */}
      <p className="text-[0.6875rem] leading-relaxed text-faint">
        Guardar crea la versión {t.version + 1}. Los reportes ya generados no cambian: cada uno
        guarda las instrucciones con las que se hizo. Para ver el efecto, genera uno nuevo.
      </p>
      {error ? (
        <p role="alert" className="text-[0.78125rem] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RestoreButton({
  template: t,
  clientId,
  onDone,
}: {
  template: TemplateView;
  clientId: string;
  onDone: () => void;
}) {
  const [enVuelo, setEnVuelo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restaurar = async () => {
    if (enVuelo) return;
    setEnVuelo(true);
    setError(null);
    try {
      const r = await fetch(`/api/meetings/v1/report-templates/${t.id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId, expectedVersion: t.version }),
      });
      if (!r.ok) {
        const cuerpo = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(cuerpo?.error?.message ?? `No se pudo restaurar (HTTP ${r.status}).`);
        setEnVuelo(false);
        return;
      }
      onDone();
    } catch {
      setError("No se pudo contactar con el servidor.");
      setEnVuelo(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={restaurar}
        // Sin cambios respecto al predeterminado no hay nada que restaurar, y un
        // botón que crea una versión idéntica sólo ensucia el historial.
        disabled={enVuelo || !t.modified}
        title={t.modified ? undefined : "Ya está en su versión predeterminada"}
        className="u-focus inline-flex h-8 items-center rounded-md border border-line px-2.5 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground disabled:opacity-40"
      >
        {enVuelo ? "Restaurando…" : "Restaurar predeterminado"}
      </button>
      {error ? (
        <p role="alert" className="basis-full text-[0.78125rem] text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  El documento
// ══════════════════════════════════════════════════════════════════════════

function ReportDocument({ report: r, onSeek }: { report: ReportView; onSeek: (s: number) => void }) {
  const doc = r.report;
  if (doc === null) {
    return (
      <div className="p-6">
        <EmptyState title="Este reporte no tiene contenido." hint="La transcripción sigue disponible: puedes leerla, buscarla y citarla." />
      </div>
    );
  }
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-row px-5 py-2.5">
        <span className="text-[0.8125rem] font-medium text-foreground">{r.templateName}</span>
        <span className="text-[0.6875rem] text-faint u-mono">v{r.templateVersion}</span>
        {r.outdated ? <Chip tone="warn">Generado con otra versión del transcript</Chip> : null}
        {/* SIN COSTE. Se sigue guardando —`cost_usd`, `input_tokens` y
            `output_tokens` en `meeting_analyses`, que es lo que permite sumar el
            gasto cuando haga falta— pero no se pinta: a quien lee un acta no le
            aporta nada y convierte un documento de trabajo en una factura. */}
        <span className="ml-auto text-[0.71875rem] text-muted">
          {fecha(r.createdAt)} · {r.model}
        </span>
      </div>

      <div className={`min-h-0 flex-1 overflow-y-auto ${DOCK_GAP_CLS}`}>
        <article className="flex max-w-[58rem] flex-col gap-5 px-6 py-6 sm:px-9 sm:py-7">
          <ReportHeaderBlock doc={doc} />

          {doc.purpose ? (
            <section className="flex flex-col gap-1.5">
              <h4 className="text-[0.875rem] font-semibold">Propósito</h4>
              <p className="text-[0.9375rem] leading-[1.8] text-foreground/90">{doc.purpose}</p>
            </section>
          ) : null}

          {doc.sections.map((sec, i) => (
            <section key={`${sec.heading}-${i}`} className="flex flex-col gap-2">
              <h4 className="flex items-baseline gap-2 text-[0.875rem] font-semibold">
                {sec.heading}
                {sec.citation ? (
                  <StampLink at={sec.citation.at} onSeek={onSeek} boxed>
                    {sec.citation.stamp}
                  </StampLink>
                ) : null}
              </h4>
              {sec.body ? (
                <p className="text-[0.9375rem] leading-[1.8] text-foreground/90">{sec.body}</p>
              ) : null}
              {sec.items.length > 0 ? (
                <ul className="flex flex-col gap-2.5">
                  {sec.items.map((it) => (
                    <ReportItem key={it.id} item={it} onSeek={onSeek} />
                  ))}
                </ul>
              ) : null}
            </section>
          ))}

          {/* EL CAVEAT NO ES DECORACIÓN. Aquí se dice qué se descartó: citas que
              no correspondían a ningún segmento, responsables que no eran de la
              reunión y fechas que no constaban. Un documento al que le faltan
              líneas sin avisar parece completo. */}
          {doc.caveat ? (
            <section className="flex flex-col gap-1.5 rounded-xl border border-line-strong bg-subtle px-3.5 py-3">
              <h4 className="text-[0.78125rem] font-semibold text-foreground">Advertencia</h4>
              <p className="text-[0.78125rem] leading-relaxed text-muted">{doc.caveat}</p>
            </section>
          ) : null}
        </article>
      </div>
    </>
  );
}

/** La cabecera: todo esto sale de la base, y el modelo no lo escribe. */
function ReportHeaderBlock({ doc }: { doc: ResolvedReport }) {
  const h = doc.header;
  return (
    <header className="flex flex-col gap-2 border-b border-line-soft pb-4">
      <h3 className="text-[1.375rem] font-semibold tracking-[-0.02em]">{h.title}</h3>
      <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78125rem] text-muted">
        <Dato etiqueta="Cliente" valor={h.clientName} />
        <Dato
          etiqueta={h.dateIsUpload ? "Subida" : "Fecha"}
          valor={fechaLarga(h.dateIso)}
        />
        <Dato etiqueta="Duración" valor={h.durationSeconds === null ? "No consta" : duracion(h.durationSeconds)} />
      </dl>
      <div className="flex flex-wrap items-baseline gap-1.5 text-[0.78125rem]">
        <span className="text-muted">Participantes:</span>
        {h.participants.length === 0 ? (
          <span className="text-muted">No consta</span>
        ) : (
          h.participants.map((p) => (
            <span key={p} className="rounded-md border border-line px-1.5 py-0.5 text-[0.71875rem] text-foreground">
              {p}
            </span>
          ))
        )}
      </div>
    </header>
  );
}

function Dato({ etiqueta, valor }: { etiqueta: string; valor: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <dt className="text-faint">{etiqueta}:</dt>
      <dd className="text-foreground">{valor}</dd>
    </span>
  );
}

function ReportItem({ item, onSeek }: { item: ResolvedItem; onSeek: (s: number) => void }) {
  return (
    <li className="flex flex-col gap-1 border-l-2 border-line pl-3">
      <span className="text-[0.9375rem] leading-[1.7] text-foreground/90">{item.text}</span>
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.71875rem] text-muted">
        {/* «Sin asignar» y «No consta» son AFIRMACIONES, no huecos: la reunión no
            dijo quién, o no dijo cuándo. Rellenarlos con una suposición es
            exactamente lo que este módulo no hace. */}
        <span>
          <span className="text-faint">Responsable: </span>
          {item.owner === null ? (
            <span className="text-muted">Sin asignar</span>
          ) : (
            <span className="font-medium text-foreground">{item.owner}</span>
          )}
        </span>
        <span aria-hidden className="text-faintest">·</span>
        <span>
          <span className="text-faint">Fecha: </span>
          {item.dueText === null ? (
            <span className="text-muted">No consta</span>
          ) : (
            <span className="font-medium text-foreground">{item.dueText}</span>
          )}
        </span>
        <span aria-hidden className="text-faintest">·</span>
        <span className="flex items-center gap-1">
          <span className="text-faint">{item.citation.by}</span>
          <StampLink at={item.citation.at} onSeek={onSeek} boxed>
            {item.citation.stamp}
          </StampLink>
        </span>
      </span>
    </li>
  );
}

/* ── Formato ─────────────────────────────────────────────────────────────── */

function citasDe(r: ReportView): number {
  const doc = r.report;
  if (!doc) return 0;
  return doc.sections.reduce(
    (n, s) => n + s.items.length + (s.citation ? 1 : 0),
    0,
  );
}

function fecha(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fechaLarga(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function duracion(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const dos = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}
