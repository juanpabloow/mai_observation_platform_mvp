"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * Qué lista enseña el panel izquierdo.
   *
   * Arranca en «Generados» cuando ya hay algo que leer y en «Plantillas» cuando
   * no: abrir en una lista vacía esconde lo único que se puede hacer.
   */
  const [lista, setLista] = useState<"generados" | "plantillas">(
    listos.length > 0 ? "generados" : "plantillas",
  );

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
        // El panel salta a «Generados»: lo que el usuario acaba de pedir está
        // ahí, y dejarlo en «Plantillas» le obligaría a buscarlo.
        setLista("generados");
        setFase({ kind: "idle" });
        router.refresh();
      } catch {
        setFase({ kind: "error", templateId, message: "No se pudo contactar con el servidor." });
      }
    },
    [clientId, fase.kind, meetingId, router],
  );

  return (
    /* DOS TARJETAS INDEPENDIENTES, no una partida por una hairline. Cada una
       con su borde, su sombra y su fondo blanco, y entre las dos el hueco de la
       rejilla — la misma separación que hay entre la barra de pestañas y el
       contenido.

       APILADO EN ESTRECHO, PARTIDO EN ANCHO. Un partido fijo de 22rem + resto
       deja el documento en 48 px a 375 px de ancho y saca la página a scroll
       horizontal — medido en el arnés. Debajo de `lg` el catálogo va arriba,
       con su propio alto acotado, y el documento debajo; los dos siguen siendo
       scrollers independientes, así que ninguno arrastra al otro y el hueco del
       dock sigue reservado en los dos. */
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--content-pad)] lg:flex-row">
      {/* ── EL PANEL IZQUIERDO, su propia tarjeta ─────────────────────────── */}
      <section className={`flex max-h-[45vh] w-full shrink-0 flex-col overflow-y-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-card)] lg:max-h-none lg:w-[22rem] ${DOCK_GAP_CLS}`}>
        {/* EL CONMUTADOR. Dos listas distintas —lo ya generado y las plantillas
            con las que generar— comparten el mismo sitio en vez de apilarse una
            debajo de la otra: apiladas, con cuatro plantillas y varios reportes,
            había que desplazarse para ver si algo existía. */}
        <div className="sticky top-0 z-10 shrink-0 border-b border-line-row bg-surface p-2">
          <div role="tablist" aria-label="Reportes o plantillas" className="flex rounded-lg border border-line bg-subtle p-0.5">
            {(
              [
                ["generados", "Generados", listos.length],
                ["plantillas", "Plantillas", templates.length],
              ] as const
            ).map(([clave, rotulo, cuenta]) => {
              const activo = lista === clave;
              return (
                <button
                  key={clave}
                  type="button"
                  role="tab"
                  aria-selected={activo}
                  onClick={() => setLista(clave)}
                  className={`u-focus inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem] transition-colors ${
                    activo ? "bg-surface font-semibold text-foreground shadow-[var(--shadow-card)]" : "text-muted hover:text-foreground"
                  }`}
                >
                  {rotulo}
                  <span className={`u-mono text-[0.65625rem] ${activo ? "text-muted" : "text-faint"}`}>{cuenta}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* El rótulo dice QUÉ es la lista, que con un conmutador de dos
            posiciones no es evidente: «Generados» podría ser todo el historial,
            y es la última versión de cada uno. */}
        <p className="u-th shrink-0 px-4 pb-1.5 pt-2.5">
          {lista === "generados" ? "Última versión de cada reporte" : "Plantillas del cliente"}
        </p>

        {lista === "plantillas"
          ? templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                clientId={clientId}
                canEdit={canEditTemplates}
                hasTranscript={hasTranscript}
                yaGenerado={listos.some((r) => r.templateId === t.id)}
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
            ))
          : listos.length === 0
            ? (
              <p className="px-4 py-3 text-[0.78125rem] text-muted">
                Todavía ninguno. Ve a <span className="font-medium text-foreground">Plantillas</span> y
                genera uno.
              </p>
            )
            : listos.map((r) => {
                const citas = citasDe(r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setAbierto(r.id)}
                    aria-current={r.id === abierto}
                    className={`flex flex-col gap-0.5 border-b border-line-row px-4 py-2.5 text-left transition-colors ${
                      r.id === abierto ? "bg-subtle" : "hover:bg-subtle/60"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.8125rem] font-medium text-foreground">{r.templateName}</span>
                      <span className="shrink-0 text-[0.6875rem] text-faint u-mono">v{r.templateVersion}</span>
                      <span className="ml-auto shrink-0">
                        {r.outdated ? <Chip tone="warn">Otra versión</Chip> : <Chip tone="success">Generado</Chip>}
                      </span>
                    </span>
                    <span className="text-[0.71875rem] text-muted">
                      {/* «Sin citas verificadas» y no «0 citas»: un reporte sin
                          ninguna cita que resistiera la comprobación es un
                          reporte del que no se puede tirar, y eso hay que
                          decirlo con palabras. */}
                      {fecha(r.createdAt)} · {citas === 0 ? "sin citas verificadas" : `${citas} citas`}
                    </span>
                  </button>
                );
              })}
      </section>

      {/* ── EL DOCUMENTO, su propia tarjeta ──────────────────────────────── */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-card)]">
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
      </section>
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
  yaGenerado,
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
  /** Ya hay un reporte de esta plantilla, así que la acción es «Regenerar». */
  yaGenerado: boolean;
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
      {/* UNA ACCIÓN VISIBLE Y EL RESTO EN EL MENÚ. Tres botones por fila —
          generar, editar, restaurar— en una columna de 22rem se envolvían a dos
          líneas y hacían que las cuatro plantillas ocuparan la pantalla entera.
          Generar es lo que se hace a diario; editar y restaurar, de vez en
          cuando. */}
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[0.8125rem] font-medium text-foreground">{t.name}</span>
            {/* «vN generada» cuando ya existe un reporte de ella; sólo «vN»
                cuando no. El número solo no dice si se ha usado. */}
            <span className="shrink-0 text-[0.6875rem] text-faint u-mono">v{t.version}</span>
            {yaGenerado ? <Chip tone="success">generada</Chip> : null}
            {/* «Modificada» se compara contra el predeterminado del CÓDIGO, que es
                el único que puede decirlo. */}
            {t.modified ? <Chip tone="muted">Modificada</Chip> : null}
          </span>
          <span className="text-[0.71875rem] leading-relaxed text-muted">{t.description}</span>
        </div>
        {editing ? null : (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy || !hasTranscript}
              aria-busy={generating}
              title={hasTranscript ? undefined : "La reunión todavía no tiene transcripción"}
              className="u-focus inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-md border border-line-strong bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:text-muted"
            >
              {generating ? "Generando…" : yaGenerado ? "Regenerar" : "Generar"}
            </button>
            {canEdit ? (
              <TemplateMenu
                template={t}
                clientId={clientId}
                onEdit={onEdit}
                onDone={onSaved}
              />
            ) : null}
          </span>
        )}
      </div>

      {editing ? (
        <InstructionsEditor
          template={t}
          clientId={clientId}
          onCancel={onCloseEdit}
          onSaved={onSaved}
        />
      ) : null}

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

/**
 * El menú de la plantilla: editar sus instrucciones y volver al predeterminado.
 *
 * Las dos son de owner/admin y las dos son poco frecuentes. Fuera del menú
 * ocupaban dos botones por fila; dentro, la fila cabe en una línea y la acción
 * de cada día —generar— queda sola y legible.
 *
 * Mismo comportamiento que los otros menús de la pantalla: clic fuera y Escape
 * cierran.
 */
function TemplateMenu({
  template: t,
  clientId,
  onEdit,
  onDone,
}: {
  template: TemplateView;
  clientId: string;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [enVuelo, setEnVuelo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAbierto(false);
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAbierto(false);
    };
    document.addEventListener("mousedown", fuera);
    document.addEventListener("keydown", tecla);
    return () => {
      document.removeEventListener("mousedown", fuera);
      document.removeEventListener("keydown", tecla);
    };
  }, [abierto]);

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
      setAbierto(false);
      onDone();
    } catch {
      setError("No se pudo contactar con el servidor.");
      setEnVuelo(false);
    }
  };

  return (
    <span ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setAbierto((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={abierto}
        aria-label={`Más acciones de la plantilla ${t.name}`}
        className="u-focus inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-foreground"
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor" aria-hidden>
          <circle cx="3" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="13" cy="8" r="1.3" />
        </svg>
      </button>
      {abierto ? (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+0.25rem)] z-30 w-56 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-[var(--shadow-float)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setAbierto(false);
              onEdit();
            }}
            className="flex min-h-9 w-full items-center px-3 text-left text-sm text-foreground transition-colors hover:bg-subtle"
          >
            Editar instrucciones
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={restaurar}
            // Sin cambios respecto al predeterminado no hay nada que restaurar,
            // y crear una versión idéntica sólo ensucia el historial.
            disabled={enVuelo || !t.modified || !t.isBuiltin}
            title={t.modified ? undefined : "Ya está en su versión predeterminada"}
            className="flex min-h-9 w-full items-center px-3 text-left text-sm text-foreground transition-colors hover:bg-subtle disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent"
          >
            {enVuelo ? "Restaurando…" : "Restaurar predeterminado"}
          </button>
          {error ? (
            <p role="alert" className="px-3 py-1.5 text-[0.71875rem] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

// ══════════════════════════════════════════════════════════════════════════
//  El documento
// ══════════════════════════════════════════════════════════════════════════

function ReportDocument({ report: r, onSeek }: { report: ReportView; onSeek: (s: number) => void }) {
  const doc = r.report;
  const citas = citasDe(r);
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

      {/* EL PIE: cuántas citas sostienen el documento.
          No lleva «Guardar» ni «Descartar» —el contenido generado no se edita a
          mano— ni enlace a Evidencia, que hoy es una pestaña vacía: un enlace a
          una pantalla sin nada es peor que no tenerlo. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line-row px-5 py-2.5">
        <span className="text-[0.78125rem] text-muted">
          {citas === 0 ? (
            <>Ninguna cita de este reporte resistió la comprobación contra el transcript.</>
          ) : (
            <>
              Se apoya en <span className="font-medium text-foreground u-mono">{citas}</span>{" "}
              {citas === 1 ? "cita" : "citas"} del transcript
            </>
          )}
        </span>
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
