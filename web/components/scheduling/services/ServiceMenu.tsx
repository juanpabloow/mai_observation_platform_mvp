"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { priceLabelCOP } from "@/lib/money";
import { apptCategoryClass, type ApptCategory } from "@/lib/agendaCategory";
import { activateServiceAction, countUpcomingAppointmentsAction, deactivateServiceAction } from "@/lib/schedulingAdminActions";
import type { BookingCategory, Service, Site, Staff } from "../AdminPanel";
import { Menu as ActionMenu, MenuButton, MenuLink, MenuSeparator } from "../ui/Menu";
import { Alert, Button, buttonClass } from "../ui/system";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { ConfirmLayer } from "@/components/ui/module/ConfirmLayer";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { CATEGORY_GROUPS, categoryDot, type CategoryGroup } from "./categories";
import { BookingCategoriesPanel } from "./BookingCategoriesPanel";
import { ServiceEditor } from "./ServiceEditor";

/**
 * «Servicios» — the client's service catalogue in the module surface: title and counts,
 * a fixed toolbar (search, the site filter when there is more than one site), the
 * internal CATEGORIES as the side menu with their real counts and «Archivados» last,
 * and one aligned table — Servicio · Descripción · Duración · Profesionales · Precio.
 * The categories here are the agenda's colour families (services.category); the PUBLIC
 * groupings of the booking page are a different thing, edited in Página de reservas.
 *
 * Real actions only: add / edit (the in-page editor), archive (the existing deactivate —
 * appointments and history stay, and it asks first) and reactivate. Things this
 * catalogue has no model for — packages, editable categories, manual ordering, bulk
 * edit, exports, duplicating, permanent delete — are simply not offered.
 *
 * Filters live in the URL (?filtro=…&q=…&sede=…) so Back, reload and a shared link
 * keep them. Opening the editor keeps the list mounted (hidden), so closing it returns
 * to the same scroll position and focus goes back to the row that opened it.
 */

/** URL values of the side menu: "" (todas), a category value, «sin-categoria», «archivados». */
const NO_CATEGORY = "sin-categoria";
const catKey = (v: CategoryGroup["value"]) => v || NO_CATEGORY;

const COLUMNS_BASE: ListColumn[] = [
  // The name has a fixed width from xl and the description takes the flexible space, so
  // the description sits right next to the (short) service names.
  { key: "name", label: "Servicio", className: "xl:w-[15rem]" },
  { key: "desc", label: "Descripción", className: "hidden xl:table-cell" },
  { key: "dur", label: "Duración", className: "w-[6.5rem]" },
  { key: "staff", label: "Profesionales", className: "w-[8.75rem]" },
];
const COL_SITES: ListColumn = { key: "sites", label: "Sedes", className: "w-[5.75rem]" };
// The internal category, in the agenda's own colour, right before the price: the list
// reads by colour like the calendar, and the name keeps its width (no chip beside it).
const COL_CATEGORY: ListColumn = { key: "cat", label: "Categoría", className: "hidden w-[11.5rem] lg:table-cell" };
const COL_PRICE: ListColumn = { key: "price", label: "Precio", align: "right", className: "w-[7.375rem]" };

export function ServiceMenu({
  clientId,
  sites,
  services,
  staff,
  siteServiceMap,
  bookingCategories = [],
  showBookingCategories = true,
  onOpenBookingLink,
  agendaHref,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  bookingCategories?: BookingCategory[];
  /** The booking-page categories panel. Off on the Servicios page, where they belong to
   *  Página de reservas (one place to edit them). */
  showBookingCategories?: boolean;
  /** "Página de reservas" — the link, public info and catalogue order of each site. */
  onOpenBookingLink: () => void;
  /** «Ver agenda», kept in the Opciones menu. */
  agendaHref?: string;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  // Counting upcoming appointments is its OWN transition: the confirmation opens at the end
  // of it, and must not open with its buttons disabled by a still-pending `busy` (focus
  // could not land on «Volver»).
  const [, startCount] = useTransition();
  const [filter, setFilter] = useUrlState("filtro", "");
  const [query, setQuery] = useUrlState("q", "");
  const [siteFilter, setSiteFilter] = useUrlState("sede", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: "edit"; service: Service } | { kind: "new"; category: string | null } | null>(null);
  const [archive, setArchive] = useState<{ service: Service; upcoming: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<string>("new");

  const activeSites = sites.filter((s) => s.active);
  const activeStaff = staff.filter((p) => p.active);
  const multiSite = activeSites.length > 1;
  const q = query.trim().toLocaleLowerCase("es");
  const site = multiSite ? siteFilter : "";
  const matches = (s: Service) =>
    (!q || s.name.toLocaleLowerCase("es").includes(q) || (s.description ?? "").toLocaleLowerCase("es").includes(q)) &&
    (!site || (siteServiceMap[site] ?? []).includes(s.id));
  const active = services.filter((s) => s.active);
  const archived = services.filter((s) => !s.active);
  const byGroup = useMemo(() => {
    const m = new Map<string, Service[]>();
    for (const g of CATEGORY_GROUPS) m.set(g.value, []);
    for (const s of active) (m.get(s.category ?? "") ?? m.get(""))?.push(s);
    return m;
  }, [active]);

  const known = filter === "archivados" || filter === NO_CATEGORY || CATEGORY_GROUPS.some((g) => g.value && g.value === filter);
  const view = known ? filter : "";
  const pickedCat = view === "" || view === "archivados" ? null : view === NO_CATEGORY ? "" : view;
  const groupsShown = CATEGORY_GROUPS.filter((g) => pickedCat === null || g.value === pickedCat);

  const staffCount = (s: Service) => activeStaff.filter((p) => p.serviceIds.includes(s.id)).length;
  const siteCount = (s: Service) => activeSites.filter((x) => (siteServiceMap[x.id] ?? []).includes(s.id)).length;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startBusy(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };
  const askArchive = (service: Service) => {
    setMenu(null);
    startCount(async () => {
      const c = await countUpcomingAppointmentsAction(clientId, "service", service.id);
      setArchive({ service, upcoming: c.ok ? c.count : 0 });
    });
  };
  const open = (next: NonNullable<typeof editor>) => {
    setMenu(null);
    opener.current = next.kind === "edit" ? next.service.id : "new";
    setEditor(next);
  };
  const closeEditor = (saved: boolean) => {
    setEditor(null);
    if (saved) router.refresh();
    // Back to the row (or «Añadir servicio») that opened the editor.
    returnFocus(opener.current);
  };

  const railGroups: FilterGroup[] = [
    {
      label: "Categorías",
      options: [
        { value: "", label: "Todas las categorías", count: active.length },
        ...CATEGORY_GROUPS.map((g) => ({ value: catKey(g.value), label: g.label, count: byGroup.get(g.value)?.length ?? 0, dot: categoryDot(g.value) })),
      ],
    },
    { label: "Otros", options: [{ value: "archivados", label: "Archivados", count: archived.length }] },
  ];

  const columns = [...COLUMNS_BASE, ...(multiSite ? [COL_SITES] : []), COL_CATEGORY, COL_PRICE];
  const span = columns.length + 1;
  const newIn = pickedCat !== null ? pickedCat || null : null;

  const rowMenu = (s: Service, at: "t" | "m" = "t") => (
    <ActionMenu label={`Acciones de ${s.name}`} open={menu === `${at}:${s.id}`} onToggle={() => setMenu(menu === `${at}:${s.id}` ? null : `${at}:${s.id}`)} onClose={() => setMenu(null)}>
      <MenuButton onClick={() => open({ kind: "edit", service: s })}>Editar</MenuButton>
      {s.active ? (
        <MenuButton disabled={busy} onClick={() => askArchive(s)}>
          Archivar
        </MenuButton>
      ) : (
        <MenuButton
          disabled={busy}
          onClick={() => {
            setMenu(null);
            run(() => activateServiceAction(clientId, s.id));
          }}
        >
          Reactivar
        </MenuButton>
      )}
    </ActionMenu>
  );
  const cells = (s: Service) => {
    const price = priceLabelCOP(s.price);
    const n = staffCount(s);
    const buffers = s.buffer_before_min + s.buffer_after_min;
    return [
      <span key="n" className="flex min-w-0 items-center gap-2">
        <span className="truncate">{s.name}</span>
        {s.featured ? (
          <span title="Destacado: se ofrece primero" className="shrink-0 text-[0.75rem] text-muted">
            <span aria-hidden>★</span>
            <span className="sr-only">(destacado)</span>
          </span>
        ) : null}
      </span>,
      <span key="d" className="text-muted">{s.description || "Sin descripción"}</span>,
      <span key="t" className="inline-flex items-center gap-1.5 tabular-nums" title={buffers ? `Ocupa además ${buffers} min de preparación y tiempo después` : undefined}>
        <ClockIcon />
        {s.duration_min} min
      </span>,
      <span key="p" className={`inline-flex items-center gap-1.5 ${n === 0 ? "text-warn" : ""}`}>
        <PeopleIcon />
        {`${n} profesional${n === 1 ? "" : "es"}`}
      </span>,
      ...(multiSite ? [<span key="s" className="tabular-nums">{`${siteCount(s)} de ${activeSites.length}`}</span>] : []),
      <CategoryChip key="c" value={s.category ?? ""} />,
      <span key="$" className={`tabular-nums ${price ? "font-semibold" : "text-muted"}`}>{price ?? "A consultar"}</span>,
    ];
  };

  const archivedShown = archived.filter(matches);
  const totalShown = view === "archivados" ? archivedShown.length : groupsShown.reduce((n, g) => n + (byGroup.get(g.value) ?? []).filter(matches).length, 0);
  const archivedHits = view !== "archivados" && q ? archived.filter(matches).length : 0;
  const filtering = Boolean(q || site);

  return (
    <ModuleSurface label="Servicios">
      <div hidden={Boolean(editor)} className="flex min-h-0 flex-1 flex-col">
        <SurfaceTop
          title="Servicios"
          summary={`Configura los servicios que se pueden reservar · ${active.length} activo${active.length === 1 ? "" : "s"} · ${archived.length} archivado${archived.length === 1 ? "" : "s"}`}
          actions={
            <ActionMenu
              label="Opciones"
              open={menu === "options"}
              onToggle={() => setMenu(menu === "options" ? null : "options")}
              onClose={() => setMenu(null)}
              trigger={
                <span className={buttonClass({ className: "pointer-events-none" })}>
                  Opciones
                  <Chevron />
                </span>
              }
            >
              <MenuButton
                onClick={() => {
                  setMenu(null);
                  onOpenBookingLink();
                }}
              >
                Página de reservas
              </MenuButton>
              <MenuButton
                onClick={() => {
                  setMenu(null);
                  setFilter(view === "archivados" ? "" : "archivados");
                }}
              >
                {view === "archivados" ? "Ver servicios activos" : `Ver archivados (${archived.length})`}
              </MenuButton>
              {agendaHref ? (
                <>
                  <MenuSeparator />
                  <MenuLink href={agendaHref}>Ver agenda</MenuLink>
                </>
              ) : null}
            </ActionMenu>
          }
          primary={
            <Button variant="primary" data-open-key="new" onClick={() => open({ kind: "new", category: newIn })}>
              <PlusIcon />
              Añadir servicio
            </Button>
          }
        >
          <RailToggle />
          <SearchField value={query} onChange={setQuery} label="Buscar servicio" />
          <FilterSelect groups={railGroups} value={view} onChange={setFilter} label="Categoría" className="w-full sm:w-auto sm:min-w-[14rem]" />
          {multiSite ? (
            <select
              value={site}
              onChange={(e) => setSiteFilter(e.target.value)}
              aria-label="Filtrar por sede"
              className="u-focus h-[44px] w-full rounded-sch-control border border-line-strong bg-surface px-3 text-base text-foreground sm:w-auto lg:h-[2.5rem] lg:text-sm"
            >
              <option value="">Todas las sedes</option>
              {activeSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
        </SurfaceTop>

        <SurfaceBody rail={<FilterRail groups={railGroups} value={view} onChange={setFilter} />} railLabel="Categorías de servicios">
          {error ? (
            <div className="px-4 pt-3 sm:px-6">
              <Alert>{error}</Alert>
            </div>
          ) : null}
          {showBookingCategories ? (
            <div className="px-4 pt-4 sm:px-6">
              <BookingCategoriesPanel clientId={clientId} categories={bookingCategories} />
            </div>
          ) : null}

          {services.length === 0 ? (
            <EmptyState title="Todavía no hay servicios" body="Añade el primero con su duración, precio y quién lo presta. Hasta entonces no se puede reservar nada.">
              <Button variant="primary" onClick={() => open({ kind: "new", category: null })}>
                Añadir servicio
              </Button>
            </EmptyState>
          ) : view === "archivados" ? (
            archivedShown.length === 0 ? (
              filtering ? (
                <NoResults>
                  <Button onClick={() => { setQuery(""); setSiteFilter(""); }}>Borrar filtros</Button>
                </NoResults>
              ) : (
                <EmptyState title="No hay servicios archivados" body="Al archivar un servicio deja de poder reservarse; sus citas y su historial se conservan." />
              )
            ) : (
              <>
                <ListTable label="Servicios archivados" columns={columns}>
                  <ListGroup span={span}>
                    {archivedShown.map((s) => (
                      <ListRow key={s.id} columns={columns} cells={cells(s)} name={s.name} onOpen={() => open({ kind: "edit", service: s })} openLabel="Editar" openKey={s.id} menu={rowMenu(s)} raised={menu === `t:${s.id}`} dimmed />
                    ))}
                  </ListGroup>
                </ListTable>
                <MobileList>
                  <MobileGroup title="Archivados">
                    {archivedShown.map((s) => (
                      <MobileRow key={s.id} title={s.name} subtitle={`${s.duration_min} min`} value={priceLabelCOP(s.price) ?? "A consultar"} onOpen={() => open({ kind: "edit", service: s })} openLabel="Editar" openKey={s.id} menu={rowMenu(s, "m")} dimmed />
                    ))}
                  </MobileGroup>
                </MobileList>
                <ListFoot>Mostrando {archivedShown.length} archivado{archivedShown.length === 1 ? "" : "s"}</ListFoot>
              </>
            )
          ) : pickedCat !== null && (byGroup.get(pickedCat)?.length ?? 0) === 0 ? (
            <EmptyState title="Esta categoría todavía no tiene servicios" body="La categoría define el color de sus citas en la agenda.">
              <Button onClick={() => open({ kind: "new", category: pickedCat || null })}>Añadir servicio</Button>
            </EmptyState>
          ) : totalShown === 0 && !filtering && pickedCat === null && active.length === 0 ? (
            // Nothing searched or filtered: every service is archived.
            <EmptyState
              title="No hay servicios activos"
              body={`${archived.length === 1 ? "El único servicio está archivado" : `Los ${archived.length} servicios están archivados`}: no se pueden reservar. Sus citas y su historial se conservan.`}
            >
              <Button variant="primary" onClick={() => open({ kind: "new", category: null })}>
                Añadir servicio
              </Button>
              <Button onClick={() => setFilter("archivados")}>Ver archivados</Button>
            </EmptyState>
          ) : totalShown === 0 ? (
            <NoResults body={archivedHits ? `Ningún servicio activo coincide. ${archivedHits} archivado${archivedHits === 1 ? "" : "s"} sí coincide${archivedHits === 1 ? "" : "n"}.` : undefined}>
              {archivedHits ? <Button onClick={() => setFilter("archivados")}>Ver en Archivados</Button> : null}
              <Button
                onClick={() => {
                  setQuery("");
                  setSiteFilter("");
                }}
              >
                Borrar filtros
              </Button>
            </NoResults>
          ) : (
            <>
              {/* One continuous list, in category order: no group rows cutting the table —
                  the side menu is how you go to a category. */}
              <ListTable label="Servicios activos" columns={columns}>
                <ListGroup span={span}>
                  {groupsShown.flatMap((g) =>
                    (byGroup.get(g.value) ?? []).filter(matches).map((s) => (
                      <ListRow key={s.id} columns={columns} cells={cells(s)} name={s.name} onOpen={() => open({ kind: "edit", service: s })} openLabel="Editar" openKey={s.id} menu={rowMenu(s)} raised={menu === `t:${s.id}`} />
                    )),
                  )}
                </ListGroup>
              </ListTable>
              <MobileList>
                {groupsShown.map((g) => {
                  const list = (byGroup.get(g.value) ?? []).filter(matches);
                  if (list.length === 0) return null;
                  return (
                    <MobileGroup key={g.value || "none"} title={g.label} dot={categoryDot(g.value)} count={String(list.length)}>
                      {list.map((s) => (
                        <MobileRow
                          key={s.id}
                          title={s.name}
                          subtitle={`${s.duration_min} min · ${staffCount(s)} profesional${staffCount(s) === 1 ? "" : "es"}`}
                          value={priceLabelCOP(s.price) ?? "A consultar"}
                          onOpen={() => open({ kind: "edit", service: s })}
                          openLabel="Editar"
                          openKey={s.id}
                          menu={rowMenu(s, "m")}
                        />
                      ))}
                    </MobileGroup>
                  );
                })}
              </MobileList>
              <ListFoot>
                Mostrando {totalShown} servicio{totalShown === 1 ? "" : "s"}
                {filtering ? " · con filtros" : ""}
              </ListFoot>
            </>
          )}
        </SurfaceBody>
      </div>

      {editor ? (
        <ServiceEditor
          clientId={clientId}
          mode={editor}
          sites={activeSites}
          staff={activeStaff}
          siteServiceMap={siteServiceMap}
          bookingCategories={bookingCategories}
          allServices={active}
          backLabel="Volver a Servicios"
          onClose={() => closeEditor(false)}
          onSaved={() => closeEditor(true)}
        />
      ) : null}

      {archive ? (
        <ConfirmLayer
          id="svc-archive"
          title={`¿Archivar «${archive.service.name}»?`}
          body={`Dejará de poder reservarse. ${
            archive.upcoming > 0
              ? `Tiene ${archive.upcoming} cita${archive.upcoming === 1 ? "" : "s"} próxima${archive.upcoming === 1 ? "" : "s"}: se conservan.`
              : "Sus citas y su historial se conservan."
          } Puedes reactivarlo cuando quieras.`}
          confirmLabel="Archivar"
          tone="primary"
          pending={busy}
          onCancel={() => setArchive(null)}
          onConfirm={() => {
            const id = archive.service.id;
            setArchive(null);
            run(() => deactivateServiceAction(clientId, id));
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

/** The category as a soft pill in its agenda colour («Sin categoría» stays neutral). */
function CategoryChip({ value }: { value: string }) {
  const group = CATEGORY_GROUPS.find((g) => g.value === value) ?? CATEGORY_GROUPS.find((g) => g.value === "");
  if (!value) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2 py-0.5 text-[0.75rem] font-medium text-muted">{group?.label}</span>;
  }
  return (
    <span className={`${apptCategoryClass(value as ApptCategory)} inline-flex max-w-full items-center gap-1.5 truncate rounded-full bg-[var(--appt-fill)] px-2 py-0.5 text-[0.75rem] font-medium text-[var(--appt-title)]`}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--appt-rule)]" />
      <span className="truncate">{group?.label}</span>
    </span>
  );
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}
function PlusIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2 1.3" />
    </svg>
  );
}
function PeopleIcon() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="6" cy="5.6" r="2.2" />
      <path d="M2.2 13c.3-2.2 1.9-3.5 3.8-3.5s3.5 1.3 3.8 3.5" />
      <path d="M10.6 3.6a2.1 2.1 0 0 1 0 4M12 9.7c1 .4 1.7 1.5 1.8 3.3" />
    </svg>
  );
}
