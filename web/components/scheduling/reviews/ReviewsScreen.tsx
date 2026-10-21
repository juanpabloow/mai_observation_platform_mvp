"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moderateReviewAction, requestExternalReviewAction } from "@/lib/reviewModerationActions";
import { longDate } from "@/lib/siteCalendar";
import { Alert, Avatar, Button, TEXTAREA, buttonClass } from "../ui/system";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, MetaChip } from "@/components/ui/module/Editor";
import { Notice } from "@/components/ui/module/FormKit";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { usePageFormGuard } from "@/components/ui/module/useEditorGuard";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";

/**
 * «Reseñas» (Presencia y marketing) — every review of the client in one list, with WHERE
 * it comes from kept visible:
 *
 *   Propias (M_AI)   written by a customer after a completed appointment, through the
 *                    review link. The business decides: Publicar / Ocultar (reversible,
 *                    the customer is not notified). moderateReview only touches these.
 *   Importadas       imported from Fresha by an M_AI platform administrator. READ-ONLY
 *   de Fresha        for the business: it can only ASK for a review or a withdrawal (one
 *                    open request per kind). Never presented as verified by an M_AI
 *                    appointment; shown with their ORIGINAL date.
 *
 * The importer is NOT here: it is /platform/reviews, for platform administrators only
 * (an env allow-list, not a tenant or client role). `canImport` only decides whether a
 * link to it is drawn; the importer re-checks on the server on every call.
 */

export interface OwnReview {
  id: string;
  status: "pending" | "approved" | "hidden";
  rating: number;
  comment: string | null;
  author: string;
  service: string;
  staff: string | null;
  site: string;
  timezone: string;
  appointmentAt: string;
  submittedAt: string;
}
export interface ImportedReview {
  id: string;
  status: string;
  provenance: string;
  rating: number;
  comment: string | null;
  author: string;
  staff: string | null;
  service: string | null;
  writtenAt: string;
  site: string;
  openKinds: Array<"review" | "withdraw">;
}

type Row =
  | { kind: "own"; id: string; author: string; rating: number; comment: string | null; service: string; date: string; state: "pending" | "approved" | "hidden"; own: OwnReview }
  | { kind: "imported"; id: string; author: string; rating: number; comment: string | null; service: string; date: string; state: "pending" | "approved" | "hidden"; imported: ImportedReview };

const STATE_LABEL = { pending: "Pendiente", approved: "Publicada", hidden: "Oculta" } as const;
const STATE_TONE = { pending: "bg-warn-soft text-warn", approved: "bg-success/15 text-success", hidden: "bg-chip text-muted" } as const;

/** What the business may read about an imported review's state (never the evidence). */
const importedState = (x: ImportedReview) =>
  x.provenance === "rejected"
    ? "No publicada: su procedencia no se pudo comprobar"
    : x.status === "approved"
      ? "Publicada en la página"
      : x.status === "hidden"
        ? "Oculta por M_AI"
        : "Pendiente de revisión por M_AI";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** «19 oct», with the year only when it is not this year. */
const dateOnly = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`}`;
};

const COLUMNS: ListColumn[] = [
  { key: "who", label: "Cliente y reseña" },
  { key: "rating", label: "Calificación", className: "w-[6.75rem]" },
  { key: "svc", label: "Servicio", className: "hidden w-[18%] lg:table-cell" },
  { key: "date", label: "Fecha", className: "w-[5.5rem]" },
  { key: "origin", label: "Procedencia", className: "w-[6.25rem]" },
  { key: "state", label: "Estado", className: "w-[7.375rem]" },
];

function Stars({ value, size = 13 }: { value: number; size?: number }) {
  return (
    <span role="img" aria-label={`${value} de 5 estrellas`} className="inline-flex gap-px">
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} width={size} height={size} viewBox="0 0 16 16" aria-hidden>
          <path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.3l-3.9 2.1.9-4.3-3.3-3 4.4-.5z" fill={i < value ? "#E8A317" : "var(--color-line-strong, #c9ccd1)"} />
        </svg>
      ))}
    </span>
  );
}

export function ReviewsScreen({ clientId, own, imported, canImport }: { clientId: string; own: OwnReview[]; imported: ImportedReview[]; canImport: boolean }) {
  const router = useRouter();
  const [ownItems, setOwnItems] = useState(own);
  const [origin, setOrigin] = useUrlState("origen", "");
  const [state, setState] = useUrlState("estado", "");
  const [query, setQuery] = useUrlState("q", "");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows: Row[] = useMemo(
    () =>
      [
        ...ownItems.map((r): Row => ({ kind: "own", id: r.id, author: r.author, rating: r.rating, comment: r.comment, service: r.service, date: r.submittedAt, state: r.status, own: r })),
        ...imported.map(
          (x): Row => ({
            kind: "imported",
            id: x.id,
            author: x.author,
            rating: x.rating,
            comment: x.comment,
            service: x.service ?? "Servicio no indicado",
            date: x.writtenAt,
            state: x.provenance === "rejected" ? "hidden" : x.status === "approved" ? "approved" : x.status === "hidden" ? "hidden" : "pending",
            imported: x,
          }),
        ),
      ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)),
    [ownItems, imported],
  );
  const o = origin === "propias" || origin === "fresha" ? origin : "";
  const st = state === "pending" || state === "approved" || state === "hidden" ? state : "";
  const q = query.trim().toLocaleLowerCase("es");
  const byOrigin = rows.filter((r) => !o || (o === "propias" ? r.kind === "own" : r.kind === "imported"));
  const shown = byOrigin.filter((r) => (!st || r.state === st) && (!q || r.author.toLocaleLowerCase("es").includes(q) || (r.comment ?? "").toLocaleLowerCase("es").includes(q)));
  const published = rows.filter((r) => r.state === "approved");
  const avg = published.length ? published.reduce((n, r) => n + r.rating, 0) / published.length : null;

  const originGroups: FilterGroup[] = [
    {
      label: "Procedencia",
      options: [
        { value: "", label: "Todas las procedencias", count: rows.length },
        { value: "propias", label: "Propias (M_AI)", count: rows.filter((r) => r.kind === "own").length },
        { value: "fresha", label: "Importadas de Fresha", count: rows.filter((r) => r.kind === "imported").length },
      ],
    },
  ];
  const stateGroups: FilterGroup[] = [
    {
      label: "Estado",
      options: [
        { value: "", label: "Todos los estados", count: byOrigin.length },
        { value: "pending", label: "Pendientes", count: byOrigin.filter((r) => r.state === "pending").length },
        { value: "approved", label: "Publicadas", count: byOrigin.filter((r) => r.state === "approved").length },
        { value: "hidden", label: "Ocultas", count: byOrigin.filter((r) => r.state === "hidden").length },
      ],
    },
  ];

  const decide = async (id: string, decision: "approved" | "hidden") => {
    setError(null);
    const r = await moderateReviewAction(clientId, id, decision);
    if (!r.ok) {
      setError(r.error);
      return false;
    }
    setOwnItems((all) => all.map((i) => (i.id === id ? { ...i, status: decision } : i)));
    router.refresh();
    return true;
  };

  const openRow = rows.find((r) => r.id === openId) ?? null;
  if (openRow) {
    return (
      <ModuleSurface label="Reseñas">
        <ReviewDetail
          key={openRow.id}
          clientId={clientId}
          row={openRow}
          onBack={() => {
            setOpenId(null);
            returnFocus(openRow.id);
          }}
          onDecide={decide}
        />
      </ModuleSurface>
    );
  }

  const originChip = (r: Row) => (
    <span className={`rounded-md px-1.5 py-0.5 text-[0.7188rem] font-medium ${r.kind === "own" ? "bg-chip text-foreground/80" : "bg-[color-mix(in_srgb,var(--service-purple)_14%,transparent)] text-service-purple"}`}>
      {r.kind === "own" ? "Propia" : "Fresha"}
    </span>
  );
  const stateChip = (r: Row) => <span className={`rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${STATE_TONE[r.state]}`}>{STATE_LABEL[r.state]}</span>;

  return (
    <ModuleSurface label="Reseñas">
      <SurfaceTop
        title="Reseñas"
        summary={`Solo las publicadas aparecen en tu página de reservas · ${rows.length} reseña${rows.length === 1 ? "" : "s"}${avg !== null ? ` · promedio de las publicadas ${avg.toLocaleString("es-CO", { maximumFractionDigits: 1 })} de 5` : ""}`}
        actions={
          canImport ? (
            <Link href="/platform/reviews" className={buttonClass()}>
              Importar de Fresha
            </Link>
          ) : null
        }
      >
        <RailToggle />
        <SearchField value={query} onChange={setQuery} label="Buscar por cliente o texto" />
        <FilterSelect groups={originGroups} value={o} onChange={setOrigin} label="Procedencia" className="w-full sm:w-auto sm:min-w-[12rem]" />
        <FilterSelect groups={stateGroups} value={st} onChange={setState} label="Estado" className="w-full sm:w-auto sm:min-w-[10rem]" />
      </SurfaceTop>
      <SurfaceBody
        rail={
          <div className="flex flex-col gap-4">
            <FilterRail groups={originGroups} value={o} onChange={setOrigin} />
            <FilterRail groups={stateGroups} value={st} onChange={setState} />
          </div>
        }
        railLabel="Filtros de reseñas"
      >
        {error ? (
          <div className="px-4 pt-3 sm:px-6">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState title="Todavía no hay reseñas" body="Crea el enlace de reseña desde una cita completada (Agenda → cita → Reseña) o pídelo desde n8n. Nada se publica sin tu aprobación." />
        ) : shown.length === 0 ? (
          <NoResults>
            {q ? <Button onClick={() => setQuery("")}>Borrar búsqueda</Button> : null}
            {o || st ? (
              <Button
                onClick={() => {
                  setOrigin("");
                  setState("");
                }}
              >
                Ver todas
              </Button>
            ) : null}
          </NoResults>
        ) : (
          <>
            <ListTable label="Reseñas" columns={COLUMNS} withMenu={false}>
              <ListGroup span={COLUMNS.length}>
                {shown.map((r) => (
                  <ListRow
                    key={r.id}
                    columns={COLUMNS}
                    name={`reseña de ${r.author}`}
                    openKey={r.id}
                    onOpen={() => setOpenId(r.id)}
                    openLabel="Abrir"
                    cells={[
                      <span key="w" className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={r.author} size="sm" />
                        <span className="shrink-0">{r.author}</span>
                        <span className="min-w-0 truncate font-normal text-muted">{r.comment || "Sin comentario"}</span>
                      </span>,
                      <Stars key="s" value={r.rating} />,
                      <span key="v" className="text-muted">{r.service}</span>,
                      <span key="d" className="tabular-nums text-muted">{dateOnly(r.date)}</span>,
                      originChip(r),
                      stateChip(r),
                    ]}
                  />
                ))}
              </ListGroup>
            </ListTable>
            <MobileList>
              <MobileGroup>
                {shown.map((r) => (
                  <MobileRow
                    key={r.id}
                    title={r.author}
                    openKey={r.id}
                    subtitle={`${"★".repeat(r.rating)} · ${dateOnly(r.date)} · ${r.comment || "Sin comentario"}`}
                    badges={
                      <>
                        {originChip(r)}
                        {stateChip(r)}
                      </>
                    }
                    onOpen={() => setOpenId(r.id)}
                    openLabel="Abrir"
                  />
                ))}
              </MobileGroup>
            </MobileList>
            <ListFoot>
              Mostrando {shown.length} reseña{shown.length === 1 ? "" : "s"}. Las importadas muestran su fecha original.
            </ListFoot>
          </>
        )}
      </SurfaceBody>
    </ModuleSurface>
  );
}

/** One review, in the surface: the full text and what the business may do with it. */
function ReviewDetail({
  clientId,
  row,
  onBack,
  onDecide,
}: {
  clientId: string;
  row: Row;
  onBack: () => void;
  onDecide: (id: string, decision: "approved" | "hidden") => Promise<boolean>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<"review" | "withdraw" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Array<"review" | "withdraw">>([]);
  const [pending, start] = useTransition();
  const guard = usePageFormGuard(Boolean(request && note.trim()));

  const send = () =>
    start(async () => {
      if (!request) return;
      setError(null);
      const r = await requestExternalReviewAction(clientId, row.id, request, note);
      if (!r.ok) {
        setError(`${r.error} Tu nota se conserva.`);
        return;
      }
      setSent((s) => [...s, request]);
      setRequest(null);
      setNote("");
      router.refresh();
    });

  const decide = async (d: "approved" | "hidden") => {
    setBusy(true);
    await onDecide(row.id, d);
    setBusy(false);
  };

  const isOwn = row.kind === "own";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("textarea")) return;
        e.preventDefault();
        onBack();
      }}
    >
      <EditorHeader
        title={`Reseña de ${row.author}`}
        headingId="review-detail-title"
        eyebrow={isOwn ? "Reseña propia · de una cita completada en M_AI" : "Reseña importada de Fresha"}
        chips={
          <>
            <MetaChip>{`${row.rating} de 5`}</MetaChip>
            <MetaChip>{STATE_LABEL[row.state]}</MetaChip>
          </>
        }
        status={null}
        backLabel="Volver a Reseñas"
        onBack={onBack}
        changes={0}
        onCancel={onBack}
        onSave={onBack}
        readOnly
      />
      <EditorFrame
        layout="rows"
        sections={[
          { id: "rv-text", label: "Reseña" },
          { id: "rv-actions", label: isOwn ? "Publicación" : "Solicitudes" },
        ]}
      >
        <EditorSection id="rv-text" title="Reseña" summary={`${row.rating} de 5`}>
          <div className="flex items-center gap-3">
            <Avatar name={row.author} />
            <div>
              <p className="text-[0.9062rem] font-semibold">{row.author}</p>
              <Stars value={row.rating} size={15} />
            </div>
          </div>
          {row.comment ? <p className="whitespace-pre-line text-[0.9062rem] leading-relaxed">{row.comment}</p> : <p className="text-[0.8125rem] italic text-muted">Sin comentario.</p>}
          <dl className="grid gap-3 rounded-sch-card border border-line p-4 text-[0.8125rem] sm:grid-cols-2">
            {row.kind === "own" ? (
              <>
                <Fact label="Servicio">{row.own.service}{row.own.staff ? ` · ${row.own.staff}` : ""}</Fact>
                <Fact label="Sede">{row.own.site}</Fact>
                <Fact label="Cita">{longDate(row.own.appointmentAt, row.own.timezone)}</Fact>
                <Fact label="Recibida">{longDate(row.own.submittedAt, row.own.timezone)}</Fact>
              </>
            ) : (
              <>
                <Fact label="Artista">{row.imported.staff ?? "Sin atribuir a un artista"}</Fact>
                <Fact label="Servicio">{row.imported.service ?? "Servicio no indicado"}</Fact>
                <Fact label="Sede">{row.imported.site}</Fact>
                <Fact label="Escrita el (fecha original)">{new Date(row.imported.writtenAt).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" })}</Fact>
                <Fact label="Estado">{importedState(row.imported)}</Fact>
              </>
            )}
          </dl>
        </EditorSection>

        <EditorSection id="rv-actions" title={isOwn ? "Publicación" : "Solicitudes a M_AI"} summary={isOwn ? STATE_LABEL[row.state] : "Revisión o retirada"}>
          {error ? <Alert>{error}</Alert> : null}
          {row.kind === "own" ? (
            <>
              <p className="text-[0.8438rem] text-muted">Solo las publicadas aparecen en tu página de reservas y cuentan en la calificación. Puedes cambiar la decisión cuando quieras; el cliente no recibe ningún aviso.</p>
              <div className="flex flex-wrap gap-2">
                {row.state !== "approved" ? (
                  <Button variant="primary" loading={busy} loadingLabel="Guardando…" onClick={() => void decide("approved")}>
                    Publicar
                  </Button>
                ) : null}
                {row.state !== "hidden" ? (
                  <Button disabled={busy} onClick={() => void decide("hidden")}>
                    Ocultar
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <Notice>
                Importada de Fresha por M_AI, que revisa su procedencia y es quien la publica u oculta. En la página se muestra como «Reseña importada de Fresha», con su fecha original. No puedes cambiar su texto,
                calificación, autor, fecha ni procedencia: sí puedes pedir que se revise o se retire.
              </Notice>
              <div className="flex flex-wrap items-center gap-2">
                {(["review", "withdraw"] as const).map((kind) =>
                  row.imported.openKinds.includes(kind) || sent.includes(kind) ? (
                    <span key={kind} className="rounded-full bg-chip px-2.5 py-1 text-[0.7812rem] text-muted">
                      {kind === "review" ? "Revisión solicitada" : "Retirada solicitada"}
                    </span>
                  ) : (
                    <Button key={kind} variant={request === kind ? "primary" : "secondary"} aria-pressed={request === kind} onClick={() => setRequest(request === kind ? null : kind)} disabled={pending}>
                      {kind === "review" ? "Solicitar revisión" : "Solicitar retirada"}
                    </Button>
                  ),
                )}
              </div>
              {request ? (
                <div className="flex flex-col gap-2 rounded-sch-card border border-line p-4">
                  <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium">
                    {request === "review" ? "¿Qué debería revisar M_AI?" : "¿Por qué debería retirarse?"} <span className="font-normal text-muted">(opcional, máximo 500 caracteres)</span>
                    <textarea value={note} maxLength={500} rows={3} onChange={(e) => setNote(e.target.value)} className={TEXTAREA} />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button
                      onClick={() => {
                        setRequest(null);
                        setNote("");
                      }}
                      disabled={pending}
                    >
                      Cancelar
                    </Button>
                    <Button variant="primary" onClick={send} loading={pending} loadingLabel="Enviando…">
                      Enviar solicitud
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </EditorSection>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="La nota de la solicitud no se ha enviado. Si sales ahora, se pierde." /> : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
