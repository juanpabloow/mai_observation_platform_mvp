"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { appointmentRuleText, BENEFIT_LABEL, benefitPending, canMove, publishProblems, type PromotionStatus } from "@worker/scheduling/promotions.js";
import {
  duplicatePromotionAction,
  listPromotionHistoryAction,
  removePromotionImageAction,
  savePromotionAction,
  setPromotionStatusAction,
  uploadPromotionImageAction,
  type PromotionForm,
} from "@/lib/schedulingAdminActions";
import { PromotionCard } from "@/components/booking/PromotionCard";
import { downscaleImage } from "../staff/StaffPhotoControl";
import { Alert, Button, Field, INPUT, TEXTAREA, buttonClass } from "../ui/system";
import { Menu as ActionMenu, MenuButton, MenuSeparator } from "../ui/Menu";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, MetaChip, SaveBar, countChanges } from "@/components/ui/module/Editor";
import { CheckItem, CheckList, FieldGroup, Notice } from "@/components/ui/module/FormKit";
import { ConfirmLayer, DiscardChanges, InfoDialog } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";

/**
 * PROMOCIONES — create, edit, duplicate, publish, pause and archive the business's
 * promotions, in the module surface. The rules come from src/scheduling/promotions.ts —
 * the same functions the server applies on every write and the booking POST applies on
 * every booking — so the editor can never promise something the server will refuse.
 *
 * States are the PERSISTED ones only (draft / published / paused / archived) with the
 * moves canMove() allows; nothing like «Programada» or «Finalizada» is derived here.
 * The only benefit that exists is the 2×1, and it cannot be published yet
 * (benefitPending): the editor says so instead of offering types that do not exist.
 *
 * Two windows, kept apart on screen as in the model:
 *   A. «Cuándo se puede reservar» — when customers can BOOK it (shown on the page only
 *      inside it);
 *   B. «Cuándo deben ser las citas» — weekdays / dates / hours of the APPOINTMENT, in the
 *      site's timezone. The 2×1 is applied by the day of the appointment, never by the
 *      day the booking is made.
 *
 * Existing bookings keep a snapshot of the promotion: editing, pausing or archiving never
 * changes them. Concurrency: every write sends the version it opened; if someone else
 * saved in between, the server refuses and the editor says so (nothing is overwritten).
 */

export interface PromotionAdminRow {
  id: string;
  status: PromotionStatus;
  version: number;
  booked_count: number;
  image_url: string | null;
  form: PromotionForm;
}

const STATUS_LABEL: Record<PromotionStatus, string> = { draft: "Borrador", published: "Publicada", paused: "Pausada", archived: "Archivada" };
const STATUS_TONE: Record<PromotionStatus, string> = {
  draft: "bg-chip text-muted",
  published: "bg-success/15 text-success",
  paused: "bg-warn-soft text-warn",
  archived: "bg-chip text-faint",
};
const WEEK = [
  [1, "Lun"],
  [2, "Mar"],
  [3, "Mié"],
  [4, "Jue"],
  [5, "Vie"],
  [6, "Sáb"],
  [7, "Dom"],
] as const;
const EVENT_LABEL: Record<string, string> = {
  created: "Creada",
  updated: "Editada",
  published: "Publicada",
  paused: "Pausada",
  resumed: "Reanudada",
  archived: "Archivada",
  duplicated: "Creada como copia",
};

const BLANK: PromotionForm = {
  name: "",
  description: "",
  conditions: "",
  siteId: "",
  sortOrder: "0",
  benefitType: "two_for_one",
  serviceIds: [],
  staffIds: [],
  bookableFrom: "",
  bookableUntil: "",
  weekdays: [],
  appointmentFrom: "",
  appointmentUntil: "",
  timeFrom: "",
  timeUntil: "",
};

const COLUMNS: ListColumn[] = [
  { key: "name", label: "Promoción y citas" },
  { key: "book", label: "Se puede reservar", className: "hidden w-[28%] lg:table-cell" },
  { key: "svc", label: "Servicios", className: "w-[6.5rem]" },
  { key: "status", label: "Estado", className: "w-[7rem]" },
];

const fmtLocal = (v: string) => {
  // "YYYY-MM-DDTHH:MM" (site wall clock) or "YYYY-MM-DD" → «1 nov 2026, 10:00». Read as
  // written (no timezone shift): it already IS the site's time.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(v);
  if (!m) return v;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)));
  const day = d.toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return m[4] ? `${day}, ${m[4]}:${m[5]}` : day;
};
const windowText = (from: string, until: string, none: string) =>
  from && until ? `${fmtLocal(from)} → ${fmtLocal(until)}` : from ? `Desde ${fmtLocal(from)}` : until ? `Hasta ${fmtLocal(until)}` : none;
export function PromotionsSection({
  clientId,
  promotions,
  services,
  staff,
  sites,
}: {
  clientId: string;
  promotions: PromotionAdminRow[];
  services: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string; site_id: string }>;
  sites: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useUrlState("estado", "");
  const [query, setQuery] = useUrlState("q", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<PromotionAdminRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [history, setHistory] = useState<{ name: string; events: Array<{ type: string; actor: string | null; at: string }> } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<PromotionAdminRow | null>(null);
  const opener = useRef("new");

  const svcName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const count = (st: PromotionStatus) => promotions.filter((p) => p.status === st).length;
  const live = promotions.filter((p) => p.status !== "archived");
  const view = (["draft", "published", "paused", "archived"] as const).includes(filter as PromotionStatus) ? (filter as PromotionStatus) : "";
  const q = query.trim().toLocaleLowerCase("es");
  const list = (view ? promotions.filter((p) => p.status === view) : live).filter((p) => !q || p.form.name.toLocaleLowerCase("es").includes(q));

  const railGroups: FilterGroup[] = [
    {
      label: "Estado",
      options: [
        { value: "", label: "Todas", count: live.length },
        { value: "draft", label: "Borrador", count: count("draft") },
        { value: "published", label: "Publicada", count: count("published") },
        { value: "paused", label: "Pausada", count: count("paused") },
      ],
    },
    { label: "Otros", options: [{ value: "archived", label: "Archivadas", count: count("archived") }] },
  ];

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    setStale(false);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error ?? "No se pudo guardar.");
        if ((r.error ?? "").startsWith("Otra persona cambió")) setStale(true);
        return;
      }
      after?.();
      router.refresh();
    });
  };
  const move = (p: PromotionAdminRow, to: PromotionStatus) => act(() => setPromotionStatusAction(clientId, p.id, p.version, to), () => setConfirmArchive(null));
  const openHistory = (p: PromotionAdminRow) =>
    start(async () => {
      const r = await listPromotionHistoryAction(clientId, p.id);
      if (r.ok) setHistory({ name: p.form.name, events: r.events });
      else setError(r.error);
    });
  const openEditor = (p: PromotionAdminRow | "new") => {
    setMenu(null);
    setError(null);
    setStale(false);
    opener.current = p === "new" ? "new" : p.id;
    setEditing(p);
  };
  const closeEditor = (saved: boolean) => {
    setEditing(null);
    if (saved) router.refresh();
    returnFocus(opener.current);
  };

  const rule = (p: PromotionAdminRow) =>
    appointmentRuleText({ appointment_weekdays: p.form.weekdays.length ? p.form.weekdays : null, appointment_time_from: p.form.timeFrom || null, appointment_time_until: p.form.timeUntil || null }) ?? "Cualquier día";
  const statusChip = (st: PromotionStatus) => <span className={`inline-flex rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${STATUS_TONE[st]}`}>{STATUS_LABEL[st]}</span>;

  const rowMenu = (p: PromotionAdminRow, at: "t" | "m") => (
    <ActionMenu label={`Acciones de ${p.form.name}`} open={menu === `${at}:${p.id}`} onToggle={() => setMenu(menu === `${at}:${p.id}` ? null : `${at}:${p.id}`)} onClose={() => setMenu(null)}>
      {p.status !== "archived" ? <MenuButton onClick={() => openEditor(p)}>Editar</MenuButton> : null}
      <MenuButton
        disabled={pending}
        onClick={() => {
          setMenu(null);
          act(() => duplicatePromotionAction(clientId, p.id));
        }}
      >
        Duplicar como borrador
      </MenuButton>
      <MenuButton
        onClick={() => {
          setMenu(null);
          openHistory(p);
        }}
      >
        Ver historial
      </MenuButton>
      {canMove(p.status, "published") || canMove(p.status, "paused") || canMove(p.status, "archived") ? <MenuSeparator /> : null}
      {canMove(p.status, "published") ? (
        <MenuButton
          disabled={pending}
          onClick={() => {
            setMenu(null);
            move(p, "published");
          }}
        >
          {p.status === "paused" ? "Reanudar" : "Publicar"}
        </MenuButton>
      ) : null}
      {canMove(p.status, "paused") ? (
        <MenuButton
          disabled={pending}
          onClick={() => {
            setMenu(null);
            move(p, "paused");
          }}
        >
          Pausar
        </MenuButton>
      ) : null}
      {canMove(p.status, "archived") ? (
        <MenuButton
          disabled={pending}
          onClick={() => {
            setMenu(null);
            setConfirmArchive(p);
          }}
        >
          Archivar
        </MenuButton>
      ) : null}
    </ActionMenu>
  );

  const errorBar = error ? (
    <Alert>
      {error}
      {stale ? (
        <button type="button" className="ml-2 underline" onClick={() => router.refresh()}>
          Recargar
        </button>
      ) : null}
    </Alert>
  ) : null;

  return (
    <ModuleSurface label="Promociones">
      <div hidden={Boolean(editing)} className="flex min-h-0 flex-1 flex-col">
        <SurfaceTop
          title="Promociones"
          summary={`Se muestran en la página de reservas solo publicadas y dentro de su vigencia · ${live.length} activa${live.length === 1 ? "" : "s"} o en preparación · ${count("archived")} archivada${count("archived") === 1 ? "" : "s"}`}
          primary={
            <Button variant="primary" data-open-key="new" onClick={() => openEditor("new")} disabled={pending}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Nueva promoción
            </Button>
          }
        >
          <RailToggle />
          <SearchField value={query} onChange={setQuery} label="Buscar promoción" />
          <FilterSelect groups={railGroups} value={view} onChange={setFilter} label="Estado" className="w-full sm:w-auto sm:min-w-[12rem]" />
        </SurfaceTop>
        <SurfaceBody rail={<FilterRail groups={railGroups} value={view} onChange={setFilter} />} railLabel="Estado de las promociones">
          {errorBar && !editing ? <div className="px-4 pt-3 sm:px-6">{errorBar}</div> : null}
          {promotions.length === 0 ? (
            <EmptyState title="Todavía no hay promociones" body="Una promoción se muestra en la página de reservas mientras está publicada y vigente. Nunca cambia el precio base de un servicio.">
              <Button variant="primary" onClick={() => openEditor("new")}>
                Nueva promoción
              </Button>
            </EmptyState>
          ) : list.length === 0 ? (
            q ? (
              <NoResults>
                <Button onClick={() => setQuery("")}>Borrar búsqueda</Button>
              </NoResults>
            ) : (
              <EmptyState
                title={view ? `No hay promociones en «${STATUS_LABEL[view]}»` : "No hay promociones activas ni en preparación"}
                body={view ? "Cambia el filtro de estado para ver las demás." : `Las archivadas (${count("archived")}) están en «Archivadas»; puedes duplicarlas como borrador.`}
              >
                {!view ? <Button variant="primary" onClick={() => openEditor("new")}>Nueva promoción</Button> : null}
              </EmptyState>
            )
          ) : (
            <>
              <ListTable label="Promociones" columns={COLUMNS}>
                <ListGroup span={COLUMNS.length + 1}>
                  {list.map((p) => (
                    <ListRow
                      key={p.id}
                      columns={COLUMNS}
                      name={p.form.name}
                      openKey={p.id}
                      onOpen={p.status !== "archived" ? () => openEditor(p) : undefined}
                      openLabel="Editar"
                      dimmed={p.status === "archived"}
                      raised={menu === `t:${p.id}`}
                      menu={rowMenu(p, "t")}
                      cells={[
                        <span key="n" className="flex min-w-0 flex-col py-1.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate">{p.form.name}</span>
                            <span className="shrink-0 rounded-md bg-chip px-1.5 py-px text-[0.7188rem] font-medium">{BENEFIT_LABEL.two_for_one}</span>
                          </span>
                          <span className="truncate text-[0.7812rem] font-normal text-muted">{rule(p)}</span>
                        </span>,
                        <span key="v" className="text-muted">{windowText(p.form.bookableFrom, p.form.bookableUntil, "Sin límite de fechas")}</span>,
                        <span key="s" title={p.form.serviceIds.map((id) => svcName.get(id)).filter(Boolean).join(", ")}>
                          {p.form.serviceIds.length} servicio{p.form.serviceIds.length === 1 ? "" : "s"}
                        </span>,
                        statusChip(p.status),
                      ]}
                    />
                  ))}
                </ListGroup>
              </ListTable>
              <MobileList>
                <MobileGroup>
                  {list.map((p) => (
                    <MobileRow
                      key={p.id}
                      title={p.form.name}
                      openKey={p.id}
                      subtitle={`${BENEFIT_LABEL.two_for_one} · ${rule(p)} · ${p.form.serviceIds.length} servicio${p.form.serviceIds.length === 1 ? "" : "s"}`}
                      badges={statusChip(p.status)}
                      onOpen={p.status !== "archived" ? () => openEditor(p) : undefined}
                      openLabel="Editar"
                      dimmed={p.status === "archived"}
                      menu={rowMenu(p, "m")}
                    />
                  ))}
                </MobileGroup>
              </MobileList>
              <ListFoot>
                Mostrando {list.length} promoción{list.length === 1 ? "" : "es"} · Las reservas ya hechas conservan la promoción con la que se reservaron.
              </ListFoot>
            </>
          )}
        </SurfaceBody>
      </div>

      {editing ? (
        <PromotionEditor
          key={editing === "new" ? "new" : editing.id}
          clientId={clientId}
          row={editing === "new" ? null : editing}
          imageUrl={editing === "new" ? null : (promotions.find((p) => p.id === editing.id)?.image_url ?? null)}
          services={services}
          staff={staff}
          sites={sites}
          svcName={svcName}
          onClose={() => closeEditor(false)}
          onSaved={() => closeEditor(true)}
          // A state move from the editor closes it on success (the promotion is unchanged
          // there, and the row it holds would show the old state and version).
          onMove={(p, to) =>
            to === "archived" ? setConfirmArchive(p) : act(() => setPromotionStatusAction(clientId, p.id, p.version, to), () => closeEditor(false))
          }
          onHistory={openHistory}
          onImageChanged={() => router.refresh()}
          pending={pending}
          listError={errorBar}
        />
      ) : null}

      {confirmArchive ? (
        <ConfirmLayer
          id="promo-archive"
          title={`¿Archivar «${confirmArchive.form.name}»?`}
          body="Deja de mostrarse y no se puede volver a publicar. Las reservas ya hechas no cambian."
          confirmLabel="Archivar"
          tone="primary"
          pending={pending}
          onCancel={() => setConfirmArchive(null)}
          onConfirm={() => {
            const p = confirmArchive;
            act(
              () => setPromotionStatusAction(clientId, p.id, p.version, "archived"),
              () => {
                setConfirmArchive(null);
                if (editing && editing !== "new" && editing.id === p.id) setEditing(null);
              },
            );
          }}
        />
      ) : null}

      {history ? (
        <InfoDialog id="promo-history" title={`Historial · ${history.name}`} onClose={() => setHistory(null)}>
          {history.events.length === 0 ? (
            <p className="text-muted">Sin movimientos registrados.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {history.events.map((e, i) => (
                <li key={i} className="flex flex-col">
                  <span className="font-medium text-foreground">{EVENT_LABEL[e.type] ?? e.type}</span>
                  <span className="text-xs text-muted">
                    {e.actor ?? "Alguien del equipo"} · {new Date(e.at).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </InfoDialog>
      ) : null}
    </ModuleSurface>
  );
}

/** The in-page promotion editor. One save («Guardar» never changes the state); the state
 *  moves live in their own section and only on a saved, unchanged promotion. */
function PromotionEditor({
  clientId,
  row,
  imageUrl,
  services,
  staff,
  sites,
  svcName,
  onClose,
  onSaved,
  onMove,
  onHistory,
  onImageChanged,
  pending,
  listError,
}: {
  clientId: string;
  row: PromotionAdminRow | null;
  imageUrl: string | null;
  services: Array<{ id: string; name: string }>;
  staff: Array<{ id: string; name: string; site_id: string }>;
  sites: Array<{ id: string; name: string }>;
  svcName: Map<string, string>;
  onClose: () => void;
  onSaved: () => void;
  onMove: (p: PromotionAdminRow, to: PromotionStatus) => void;
  onHistory: (p: PromotionAdminRow) => void;
  onImageChanged: () => void;
  pending: boolean;
  listError: React.ReactNode;
}) {
  const initial = useMemo<PromotionForm>(() => (row ? { ...row.form } : { ...BLANK }), [row]);
  const [f, setF] = useState<PromotionForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [image, setImage] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const saved = useRef(false);
  const router = useRouter();

  const changes = countChanges(initial, f);
  const dirty = changes > 0;
  const guard = useEditorGuard({ dirty: dirty && !saving, onLeave: () => (saved.current ? onSaved() : onClose()) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };
  const set = (patch: Partial<PromotionForm>) => setF((x) => ({ ...x, ...patch }));
  // Functional updates: two quick taps never read a stale list.
  const toggleIn = <K extends "serviceIds" | "staffIds" | "weekdays">(k: K, v: PromotionForm[K][number]) =>
    setF((x) => {
      const list = x[k] as Array<typeof v>;
      const next = list.includes(v) ? list.filter((y) => y !== v) : [...list, v];
      return { ...x, [k]: k === "weekdays" ? (next as number[]).sort((a, b) => a - b) : next };
    });

  const rules = {
    status: "draft" as const,
    benefit_type: "two_for_one" as const,
    benefit_params: {},
    site_id: f.siteId || null,
    service_ids: f.serviceIds,
    staff_ids: f.staffIds,
    bookable_from: f.bookableFrom ? new Date(f.bookableFrom) : null,
    bookable_until: f.bookableUntil ? new Date(f.bookableUntil) : null,
    appointment_weekdays: f.weekdays.length ? f.weekdays : null,
    appointment_from: f.appointmentFrom || null,
    appointment_until: f.appointmentUntil || null,
    appointment_time_from: f.timeFrom || null,
    appointment_time_until: f.timeUntil || null,
    name: f.name,
  };
  const problems = publishProblems(rules);
  const pendingBenefit = benefitPending("two_for_one", {});
  const ruleText = appointmentRuleText({ appointment_weekdays: rules.appointment_weekdays, appointment_time_from: rules.appointment_time_from, appointment_time_until: rules.appointment_time_until });
  const includedNames = f.serviceIds.map((id) => svcName.get(id) ?? "").filter(Boolean);
  const singleSite = sites.length <= 1;

  const save = async () => {
    setSaving(true);
    setError(null);
    setStale(false);
    const r = await savePromotionAction(clientId, row?.id ?? null, row?.version ?? null, f);
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "No se pudo guardar.");
      if ((r.error ?? "").startsWith("Otra persona cambió")) setStale(true);
      return;
    }
    saved.current = true;
    guard.leave();
  };
  const upload = async (file: File | undefined) => {
    if (!file || !row) return;
    setImage({ busy: true, error: null });
    try {
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("promotionId", row.id);
      fd.set("image", await downscaleImage(file));
      const r = await uploadPromotionImageAction(fd);
      setImage({ busy: false, error: r.ok ? null : r.error });
      if (r.ok) onImageChanged();
    } catch {
      setImage({ busy: false, error: "No pudimos subir la imagen. Inténtalo de nuevo." });
    }
  };
  const removeImage = async () => {
    if (!row) return;
    setImage({ busy: true, error: null });
    const r = await removePromotionImageAction(clientId, row.id);
    setImage({ busy: false, error: r.ok ? null : (r.error ?? "No se pudo quitar la imagen.") });
    if (r.ok) onImageChanged();
  };

  const sections = [
    { id: "pr-basic", label: "Información básica", dirty: countChanges({ a: initial.name, b: initial.description, c: initial.conditions }, { a: f.name, b: f.description, c: f.conditions }) > 0 },
    { id: "pr-benefit", label: "Beneficio" },
    { id: "pr-services", label: "Servicios incluidos", dirty: countChanges({ a: initial.serviceIds, b: initial.staffIds, c: initial.siteId }, { a: f.serviceIds, b: f.staffIds, c: f.siteId }) > 0 },
    {
      id: "pr-window",
      label: "Vigencia y citas",
      dirty:
        countChanges(
          { a: initial.bookableFrom, b: initial.bookableUntil, c: initial.weekdays, d: initial.appointmentFrom, e: initial.appointmentUntil, g: initial.timeFrom, h: initial.timeUntil },
          { a: f.bookableFrom, b: f.bookableUntil, c: f.weekdays, d: f.appointmentFrom, e: f.appointmentUntil, g: f.timeFrom, h: f.timeUntil },
        ) > 0,
    },
    { id: "pr-summary", label: "Resumen" },
    { id: "pr-image", label: "Imagen" },
    ...(row ? [{ id: "pr-state", label: "Estado" }] : []),
  ];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("select, [role=menu]")) return;
        e.preventDefault();
        requestClose();
      }}
    >
      <EditorHeader
        title={row ? row.form.name : "Nueva promoción"}
        headingId="promo-editor-title"
        status={row ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span> : null}
        eyebrow={row ? "Editar promoción" : "Catálogo · Promociones"}
        chips={
          <>
            <MetaChip>{BENEFIT_LABEL.two_for_one}</MetaChip>
            <MetaChip>{`${f.serviceIds.length} servicio${f.serviceIds.length === 1 ? "" : "s"}`}</MetaChip>
            {row?.booked_count ? <MetaChip>{`${row.booked_count} reserva${row.booked_count === 1 ? "" : "s"}`}</MetaChip> : null}
          </>
        }
        backLabel="Volver a Promociones"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={row ? "Guardar cambios" : "Crear borrador"}
        saving={saving}
        canSave={row ? dirty : true}
      />
      <EditorFrame sections={sections} saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={row ? "Guardar" : "Crear"} canSave={row ? dirty : true} />}>
        {listError ? <div className="mb-2">{listError}</div> : null}
        {error ? (
          <div className="mb-2">
            <Alert>
              {error} Lo que escribiste se conserva.
              {stale ? (
                <button type="button" className="ml-2 underline" onClick={() => router.refresh()}>
                  Recargar
                </button>
              ) : null}
            </Alert>
          </div>
        ) : null}

        <EditorSection id="pr-basic" title="Información básica" summary={f.name || "Sin nombre"}>
          <Field label="Nombre" hint="Máximo 80 caracteres. Se muestra en la página de reservas.">
            <input id="pr-f-name" value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Ej. 2×1 universitario" className={INPUT} />
          </Field>
          <Field label="Descripción para el cliente" optional hint="Se muestra junto a los servicios incluidos. Sin enlaces, correos ni teléfonos.">
            <textarea value={f.description} maxLength={600} rows={3} onChange={(e) => set({ description: e.target.value })} className={TEXTAREA} />
          </Field>
          <Field label="Condiciones" optional hint="Solo contenido aprobado. Se muestra bajo «Condiciones».">
            <textarea value={f.conditions} maxLength={600} rows={3} onChange={(e) => set({ conditions: e.target.value })} className={TEXTAREA} />
          </Field>
        </EditorSection>

        <EditorSection id="pr-benefit" title="Beneficio" summary={BENEFIT_LABEL.two_for_one}>
          <FieldGroup legend="Tipo de beneficio" hint="Es el único tipo disponible hoy.">
            <span className="inline-flex h-[2.5rem] w-fit items-center rounded-sch-control border border-ink bg-ink px-3 text-[0.8125rem] font-medium text-ink-fg">{BENEFIT_LABEL.two_for_one}</span>
          </FieldGroup>
          {pendingBenefit.length ? (
            <Notice tone="warn">
              El 2×1 todavía no se puede publicar: faltan por definir sus reglas ({pendingBenefit.join("; ")}). Puedes prepararla como borrador.
            </Notice>
          ) : null}
        </EditorSection>

        <EditorSection
          id="pr-services"
          title="Servicios incluidos"
          description="Solo estos servicios reciben la promoción. Hace falta al menos uno para publicarla."
          summary={includedNames.length ? includedNames.join(", ") : "Ningún servicio"}
          defaultOpen={false}
        >
          <CheckList>
            {services.map((s) => (
              <CheckItem key={s.id} checked={f.serviceIds.includes(s.id)} onChange={() => toggleIn("serviceIds", s.id)}>
                {s.name}
              </CheckItem>
            ))}
          </CheckList>
          {singleSite ? (
            <p className="text-xs text-muted">Aplica en {sites[0]?.name ?? "la sede"}.</p>
          ) : (
            <Field label="Sede" hint="Al cambiar la sede se vacía la selección de artistas.">
              <select value={f.siteId} onChange={(e) => set({ siteId: e.target.value, staffIds: [] })} className={INPUT}>
                <option value="">Todas las sedes</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <FieldGroup legend="Artistas participantes" optional hint="Ninguno marcado = cualquier artista que haga el servicio.">
            <CheckList>
              {staff
                .filter((p) => !f.siteId || p.site_id === f.siteId)
                .map((p) => (
                  <CheckItem key={p.id} checked={f.staffIds.includes(p.id)} onChange={() => toggleIn("staffIds", p.id)}>
                    {p.name}
                  </CheckItem>
                ))}
            </CheckList>
          </FieldGroup>
          <Field label="Orden en la página" hint="Número de 0 a 999; las de menor número van primero.">
            <input inputMode="numeric" value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} className={`${INPUT} max-w-[8rem]`} />
          </Field>
        </EditorSection>

        <EditorSection
          id="pr-window"
          title="Vigencia y citas"
          description="Dos cosas distintas: cuándo se puede hacer la reserva, y qué citas reciben el beneficio. Todo en la hora de la sede."
          summary={`${windowText(f.bookableFrom, f.bookableUntil, "Reservas sin límite de fechas")} · ${ruleText ?? "Citas cualquier día"}`}
          defaultOpen={false}
        >
          <div className="flex flex-col gap-3 rounded-sch-card border border-line p-4">
            <div>
              <h3 className="text-[0.875rem] font-semibold">A. Cuándo se puede reservar</h3>
              <p className="mt-0.5 text-xs text-muted">Fuera de estas fechas la promoción no se muestra en la página.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Desde" optional>
                <input type="datetime-local" value={f.bookableFrom} onChange={(e) => set({ bookableFrom: e.target.value })} className={INPUT} />
              </Field>
              <Field label="Hasta" optional>
                <input type="datetime-local" value={f.bookableUntil} onChange={(e) => set({ bookableUntil: e.target.value })} className={INPUT} />
              </Field>
            </div>
          </div>
          <div className="flex flex-col gap-3 rounded-sch-card border border-line p-4">
            <div>
              <h3 className="text-[0.875rem] font-semibold">B. Cuándo deben ser las citas</h3>
              <p className="mt-0.5 text-xs text-muted">
                El beneficio se aplica según el <strong className="font-semibold text-foreground">día de la cita</strong>, no el día en que se reserva. La promoción se ve cualquier día; solo las citas que cumplen
                esto la reciben. Sin días marcados = todos.
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Días de las citas">
              {WEEK.map(([d, label]) => {
                const on = f.weekdays.includes(d);
                return (
                  <button key={d} type="button" aria-pressed={on} onClick={() => toggleIn("weekdays", d)} className={buttonClass({ size: "sm", variant: on ? "primary" : "secondary" })}>
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Citas desde" optional>
                <input type="date" value={f.appointmentFrom} onChange={(e) => set({ appointmentFrom: e.target.value })} className={INPUT} />
              </Field>
              <Field label="Citas hasta" optional>
                <input type="date" value={f.appointmentUntil} onChange={(e) => set({ appointmentUntil: e.target.value })} className={INPUT} />
              </Field>
              <Field label="Hora desde" optional>
                <input type="time" value={f.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} className={INPUT} />
              </Field>
              <Field label="Hora hasta" optional hint="Las dos horas o ninguna.">
                <input type="time" value={f.timeUntil} onChange={(e) => set({ timeUntil: e.target.value })} className={INPUT} />
              </Field>
            </div>
          </div>
        </EditorSection>

        <EditorSection id="pr-summary" title="Resumen" description="Así queda con lo que ves en pantalla; se aplica al guardar." summary={problems.length ? `Falta: ${problems.length}` : "Lista para publicar"}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.8438rem] text-foreground">
            <li>Se puede reservar: {windowText(f.bookableFrom, f.bookableUntil, "sin límite de fechas")}.</li>
            <li>
              {ruleText ?? "Disponible para citas de cualquier día y hora"}
              {f.appointmentFrom || f.appointmentUntil ? ` (citas ${windowText(f.appointmentFrom, f.appointmentUntil, "").toLocaleLowerCase("es")})` : ""} — el {BENEFIT_LABEL.two_for_one} se decide por el día de la cita.
            </li>
            <li>Servicios: {includedNames.length ? includedNames.join(", ") : "ninguno todavía"}.</li>
            <li>Las reservas ya hechas no cambian al editar, pausar o archivar.</li>
          </ul>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
            <div className="rounded-sch-card border border-line p-3.5 text-[0.8125rem]">
              <p className="font-medium">{problems.length ? "Antes de publicar falta:" : "Lista para publicar."}</p>
              {problems.length ? (
                <ul className="mt-1.5 list-disc pl-5 text-muted">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div aria-label="Vista previa en la página" className="rounded-sch-card bg-subtle p-3">
              <PromotionCard
                promo={{
                  name: f.name || "Nombre de la promoción",
                  description: f.description || null,
                  conditions: f.conditions || null,
                  image_url: imageUrl,
                  benefit_label: BENEFIT_LABEL.two_for_one,
                  rule_text: ruleText,
                  services: includedNames,
                }}
                preview
              />
            </div>
          </div>
        </EditorSection>

        <EditorSection id="pr-image" title="Imagen" summary={imageUrl ? "Con imagen" : "Sin imagen"} defaultOpen={false}>
          <Field label="Imagen" optional hint={row ? "PNG, JPEG o WebP. Se guarda al subirla, aparte de «Guardar»." : "Guarda la promoción para poder subir su imagen."}>
            <span className="flex flex-wrap items-center gap-3">
              <label className={buttonClass({ className: row && !image.busy ? "cursor-pointer" : "pointer-events-none opacity-60" })}>
                {image.busy ? "Subiendo…" : imageUrl ? "Cambiar imagen" : "Subir imagen"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={!row || image.busy}
                  className="sr-only"
                  onChange={(e) => {
                    void upload(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              {imageUrl && row ? (
                <Button size="sm" variant="tertiary" onClick={() => void removeImage()} disabled={image.busy}>
                  Quitar
                </Button>
              ) : null}
            </span>
          </Field>
          {image.error ? <Alert>{image.error}</Alert> : null}
        </EditorSection>

        {row ? (
          <EditorSection id="pr-state" title="Estado" description="Cambiar el estado no edita la promoción, y nunca cambia las reservas ya hechas." summary={STATUS_LABEL[row.status]} defaultOpen={false}>
            <p className="text-[0.8438rem]">
              Ahora: <strong className="font-semibold">{STATUS_LABEL[row.status]}</strong>
              {row.booked_count ? ` · ${row.booked_count} reserva${row.booked_count === 1 ? "" : "s"} con esta promoción` : ""}
            </p>
            {dirty ? <Notice>Guarda o descarta los cambios antes de cambiar el estado.</Notice> : null}
            <div className="flex flex-wrap gap-2">
              {canMove(row.status, "published") ? (
                <Button variant="primary" disabled={dirty || pending} onClick={() => onMove(row, "published")}>
                  {row.status === "paused" ? "Reanudar" : "Publicar"}
                </Button>
              ) : null}
              {canMove(row.status, "paused") ? (
                <Button disabled={dirty || pending} onClick={() => onMove(row, "paused")}>
                  Pausar
                </Button>
              ) : null}
              {canMove(row.status, "archived") ? (
                <Button variant="tertiary" disabled={dirty || pending} onClick={() => onMove(row, "archived")}>
                  Archivar
                </Button>
              ) : null}
              <Button variant="tertiary" onClick={() => onHistory(row)}>
                Ver historial
              </Button>
            </div>
          </EditorSection>
        ) : null}
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en esta promoción. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
