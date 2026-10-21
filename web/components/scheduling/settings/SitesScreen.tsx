"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bookingPath } from "@/lib/bookingLink";
import { activateSiteAction, countUpcomingAppointmentsAction, createSiteAction, deactivateSiteAction, updateSiteAction } from "@/lib/schedulingAdminActions";
import { DAYS, gridFromWeekly, weeklyFromGrid, type HourGrid } from "../HoursGrid";
import { WeekHoursEditor } from "./WeekHoursEditor";
import { COMMON_ZONES, SLUG_RE, openDaysSummary, slugify, tzLabel } from "../mobile/config/logic";
import { SettingsOverview, WhyNothingAvailable, type Exception, type Service, type Site, type Staff } from "../AdminPanel";
import { Menu as ActionMenu, MenuButton } from "../ui/Menu";
import { Alert, Button, Field, INPUT, buttonClass } from "../ui/system";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceHeader, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, ErrorSummary, MetaChip, SaveBar, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { Notice } from "@/components/ui/module/FormKit";
import { ConfirmLayer, DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { safeAction } from "@/components/ui/module/safeAction";

/**
 * «Sedes» (Configuración) — where the business attends: name, address, public URL,
 * timezone and weekly hours of each site, in the module surface.
 *
 *  - With ONE site there is nothing to filter: the list is direct, with a note. With
 *    several, the side menu filters by state.
 *  - The editor is in the page. It saves ONLY the keys that changed through the same
 *    updateSiteAction the rest of the settings use (create: createSiteAction), so it can
 *    never overwrite another page's slice (rules, booking-page contact).
 *  - Deactivating counts the upcoming appointments first and says they are kept; it never
 *    cancels anything. A professional's absence is NOT a site closure — that lives in
 *    Horarios y ausencias.
 *  - «Resumen y diagnóstico» keeps the production setup summary and availability check
 *    reachable from here (the old «Configuración de agenda» landing).
 */

const NO_FILTER = "";
const COLUMNS: ListColumn[] = [
  { key: "name", label: "Sede" },
  { key: "url", label: "URL pública", className: "hidden w-[22%] lg:table-cell" },
  { key: "tz", label: "Zona horaria", className: "hidden w-[18%] xl:table-cell" },
  { key: "hours", label: "Horario", className: "w-[26%]" },
  { key: "state", label: "Estado", className: "w-[6.25rem]" },
];

export function SitesScreen({
  clientId,
  sites,
  services,
  staff,
  exceptions,
  siteServiceMap,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  siteServiceMap: Record<string, string[]>;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [, startCount] = useTransition();
  const [filter, setFilter] = useUrlState("estado", NO_FILTER);
  const [query, setQuery] = useUrlState("q", "");
  const [view, setView] = useUrlState("vista", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const [deactivate, setDeactivate] = useState<{ site: Site; upcoming: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef("new");

  const multi = sites.length > 1;
  const active = sites.filter((s) => s.active);
  const st = filter === "activas" || filter === "inactivas" ? filter : NO_FILTER;
  const q = query.trim().toLocaleLowerCase("es");
  const shown = sites.filter(
    (s) => (!st || (st === "activas" ? s.active : !s.active)) && (!q || s.name.toLocaleLowerCase("es").includes(q) || (s.address ?? "").toLocaleLowerCase("es").includes(q)),
  );
  const groups: FilterGroup[] = [
    {
      label: "Estado",
      options: [
        { value: NO_FILTER, label: "Todas", count: sites.length },
        { value: "activas", label: "Activas", count: active.length },
        { value: "inactivas", label: "Inactivas", count: sites.length - active.length },
      ],
    },
  ];

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };
  const askDeactivate = (site: Site) => {
    setMenu(null);
    startCount(async () => {
      const c = await safeAction(() => countUpcomingAppointmentsAction(clientId, "site", site.id));
      setDeactivate({ site, upcoming: c.ok ? c.count : 0 });
    });
  };
  const open = (s: Site | "new") => {
    setMenu(null);
    opener.current = s === "new" ? "new" : s.id;
    setEditing(s);
  };

  if (editing) {
    return (
      <ModuleSurface label="Sedes">
        <SiteEditor
          key={editing === "new" ? "new" : editing.id}
          clientId={clientId}
          site={editing === "new" ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) router.refresh();
            returnFocus(opener.current);
          }}
        />
      </ModuleSurface>
    );
  }

  if (view === "resumen") {
    return (
      <ModuleSurface label="Resumen y diagnóstico">
        <EditorHeader
          title="Resumen y diagnóstico"
          headingId="sites-summary-title"
          eyebrow="Configuración de la agenda"
          backLabel="Volver a Sedes"
          onBack={() => setView("")}
          changes={0}
          onCancel={() => setView("")}
          onSave={() => setView("")}
          readOnly
        />
        <EditorFrame
          sections={[
            { id: "sum-state", label: "Estado de la configuración" },
            { id: "sum-diag", label: "Diagnóstico de disponibilidad" },
          ]}
        >
          <EditorSection id="sum-state" title="Estado de la configuración" description="Lo que falta para recibir reservas, calculado con los datos guardados.">
            <SettingsOverview
              clientId={clientId}
              sites={sites}
              services={services}
              staff={staff}
              exceptions={exceptions}
              siteServiceMap={siteServiceMap}
              onNewSite={() => {
                setView("");
                open("new");
              }}
            />
          </EditorSection>
          <EditorSection id="sum-diag" title="Diagnóstico de disponibilidad" description="Explica por qué un día tiene o no cupos. La ausencia de un profesional no cierra la sede.">
            <WhyNothingAvailable clientId={clientId} sites={sites} staff={staff} />
          </EditorSection>
        </EditorFrame>
      </ModuleSurface>
    );
  }

  const stateChip = (s: Site) => (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${s.active ? "bg-success/15 text-success" : "bg-chip text-muted"}`}>
      {s.active ? "Activa" : "Inactiva"}
    </span>
  );
  const rowMenu = (s: Site, at: "t" | "m") => (
    <ActionMenu label={`Acciones de ${s.name}`} open={menu === `${at}:${s.id}`} onToggle={() => setMenu(menu === `${at}:${s.id}` ? null : `${at}:${s.id}`)} onClose={() => setMenu(null)}>
      <MenuButton onClick={() => open(s)}>Editar</MenuButton>
      {s.active ? (
        <MenuButton disabled={busy} onClick={() => askDeactivate(s)}>
          Desactivar
        </MenuButton>
      ) : (
        <MenuButton
          disabled={busy}
          onClick={() => {
            setMenu(null);
            run(() => activateSiteAction(clientId, s.id));
          }}
        >
          Activar
        </MenuButton>
      )}
    </ActionMenu>
  );

  return (
    <ModuleSurface label="Sedes">
      {multi ? (
        <SurfaceTop
          title="Sedes"
          summary={`Dónde atiendes · ${active.length} activa${active.length === 1 ? "" : "s"}${sites.length - active.length ? ` · ${sites.length - active.length} inactiva${sites.length - active.length === 1 ? "" : "s"}` : ""}`}
          actions={
            <Button onClick={() => setView("resumen")} data-open-key="summary">
              Resumen y diagnóstico
            </Button>
          }
          primary={
            <Button variant="primary" data-open-key="new" onClick={() => open("new")}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Nueva sede
            </Button>
          }
        >
          <RailToggle />
          <SearchField value={query} onChange={setQuery} label="Buscar sede" />
          <FilterSelect groups={groups} value={st} onChange={setFilter} label="Estado" className="w-full sm:w-auto sm:min-w-[12rem]" />
        </SurfaceTop>
      ) : (
        <SurfaceHeader
          title="Sedes"
          summary={`Dónde atiendes · ${active.length} activa${active.length === 1 ? "" : "s"}${sites.length - active.length ? ` · ${sites.length - active.length} inactiva${sites.length - active.length === 1 ? "" : "s"}` : ""}`}
          actions={
            <Button onClick={() => setView("resumen")} data-open-key="summary">
              Resumen y diagnóstico
            </Button>
          }
          primary={
            <Button variant="primary" data-open-key="new" onClick={() => open("new")}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Nueva sede
            </Button>
          }
        />
      )}
      <SurfaceBody rail={multi ? <FilterRail groups={groups} value={st} onChange={setFilter} /> : undefined} railLabel="Estado de las sedes">
        {error ? (
          <div className="px-4 pt-3 sm:px-6">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {!multi && sites.length === 1 ? (
          <div className="px-4 pt-4 sm:px-6">
            <Notice>Con una sola sede no hace falta elegir: todo lo que configures en la agenda se aplica a {sites[0].name}.</Notice>
          </div>
        ) : null}
        {sites.length === 0 ? (
          <EmptyState title="Aún no hay sedes" body="Crea la primera sede con su horario para empezar a recibir reservas.">
            <Button variant="primary" onClick={() => open("new")}>
              Nueva sede
            </Button>
          </EmptyState>
        ) : shown.length === 0 ? (
          <NoResults>
            <Button
              onClick={() => {
                setQuery("");
                setFilter(NO_FILTER);
              }}
            >
              Ver todas
            </Button>
          </NoResults>
        ) : (
          <>
            <ListTable label="Sedes" columns={COLUMNS}>
              <ListGroup span={COLUMNS.length + 1}>
                {shown.map((s) => (
                  <ListRow
                    key={s.id}
                    columns={COLUMNS}
                    name={s.name}
                    openKey={s.id}
                    onOpen={() => open(s)}
                    openLabel="Editar"
                    raised={menu === `t:${s.id}`}
                    dimmed={!s.active}
                    menu={rowMenu(s, "t")}
                    cells={[
                      <span key="n" className="flex min-w-0 flex-col py-1.5">
                        <span className="truncate">{s.name}</span>
                        <span className="truncate text-[0.7812rem] font-normal text-muted">{s.address || "Sin dirección"}</span>
                      </span>,
                      <span key="u" className="u-mono text-[0.7812rem] text-muted">{bookingPath(s.slug)}</span>,
                      <span key="z" className="text-muted" title={s.timezone}>{tzLabel(s.timezone)}</span>,
                      <span key="h" className="text-muted">{openDaysSummary(s.opening_hours)}</span>,
                      stateChip(s),
                    ]}
                  />
                ))}
              </ListGroup>
            </ListTable>
            <MobileList>
              <MobileGroup>
                {shown.map((s) => (
                  <MobileRow key={s.id} title={s.name} openKey={s.id} subtitle={`${s.address || "Sin dirección"} · ${openDaysSummary(s.opening_hours)}`} badges={stateChip(s)} onOpen={() => open(s)} openLabel="Editar" menu={rowMenu(s, "m")} dimmed={!s.active} />
                ))}
              </MobileGroup>
            </MobileList>
            <ListFoot>
              Las reglas de reserva se cambian en «Reglas de reserva», el contacto público en «Página de reservas» y las ausencias en «Horarios y ausencias».
            </ListFoot>
          </>
        )}
      </SurfaceBody>
      {deactivate ? (
        <ConfirmLayer
          id="site-deactivate"
          title={`¿Desactivar «${deactivate.site.name}»?`}
          body={`Deja de recibir reservas nuevas y su página pública deja de aceptar reservas. ${
            deactivate.upcoming > 0 ? `Tiene ${deactivate.upcoming} cita${deactivate.upcoming === 1 ? "" : "s"} próxima${deactivate.upcoming === 1 ? "" : "s"}: se conservan.` : "Sus citas y su historial se conservan."
          } Puedes reactivarla cuando quieras.`}
          confirmLabel="Desactivar"
          tone="primary"
          onCancel={() => setDeactivate(null)}
          onConfirm={() => {
            const id = deactivate.site.id;
            setDeactivate(null);
            run(() => deactivateSiteAction(clientId, id));
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

interface SiteFormState {
  name: string;
  address: string;
  slug: string;
  timezone: string;
  grid: HourGrid;
}

const DEFAULT_GRID = (): HourGrid => Object.fromEntries(DAYS.map((d) => [d, { on: d !== "sun", start: "09:00", end: "18:00" }]));

function zoneOptions(current: string): { common: string[]; rest: string[] } {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  const common = [...new Set([...COMMON_ZONES, current].filter(Boolean))];
  return { common, rest: all.filter((z) => !common.includes(z)) };
}

/** Create or edit one site, in the page. Saves only what changed. */
function SiteEditor({ clientId, site, onClose }: { clientId: string; site: Site | null; onClose: (saved: boolean) => void }) {
  const initial = useMemo<SiteFormState>(
    () => ({
      name: site?.name ?? "",
      address: site?.address ?? "",
      slug: site?.slug ?? "",
      timezone: site?.timezone ?? "America/Bogota",
      grid: site ? gridFromWeekly(site.opening_hours) : DEFAULT_GRID(),
    }),
    [site],
  );
  const [f, setF] = useState<SiteFormState>(initial);
  // A new site's URL follows its name until it is edited by hand (as on the phone).
  const [slugTouched, setSlugTouched] = useState(Boolean(site));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  const slug = slugTouched ? f.slug : slugify(f.name);
  const effective = { ...f, slug };
  const changes = countChanges({ ...initial, grid: weeklyFromGrid(initial.grid) }, { ...effective, grid: weeklyFromGrid(f.grid) });
  const set = <K extends keyof SiteFormState>(k: K, v: SiteFormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => onClose(saved.current) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };
  const zones = useMemo(() => zoneOptions(initial.timezone), [initial.timezone]);

  const errors: Partial<Record<"name" | "slug" | "address" | "hours", string>> = {};
  if (!f.name.trim()) errors.name = "Escribe el nombre de la sede.";
  if (!slug) errors.slug = "Escribe la URL pública.";
  else if (!SLUG_RE.test(slug)) errors.slug = "Solo minúsculas, números y guiones; sin guion al principio ni al final.";
  if (f.address.length > 200) errors.address = "Máximo 200 caracteres.";
  const badDay = DAYS.find((d) => f.grid[d]?.on && f.grid[d].start >= f.grid[d].end);
  if (badDay) errors.hours = "Revisa los días marcados: la hora de cierre debe ser posterior a la de apertura.";
  const show = (k: keyof typeof errors) => (attempted ? errors[k] : "") || "";

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setError(null);
    let r: { ok: boolean; error?: string };
    if (!site) {
      r = await safeAction(() => createSiteAction({ clientId, slug, name: f.name.trim(), address: f.address.trim() || undefined, timezone: f.timezone, openingHours: weeklyFromGrid(f.grid) }));
    } else {
      const patch: Parameters<typeof updateSiteAction>[2] = {};
      if (f.name !== initial.name) patch.name = f.name.trim();
      if (f.address !== initial.address) patch.address = f.address;
      if (slug !== initial.slug) patch.slug = slug;
      if (f.timezone !== initial.timezone) patch.timezone = f.timezone;
      if (JSON.stringify(weeklyFromGrid(f.grid)) !== JSON.stringify(weeklyFromGrid(initial.grid))) patch.openingHours = weeklyFromGrid(f.grid);
      r = await safeAction(() => updateSiteAction(clientId, site.id, patch));
    }
    setSaving(false);
    if (!r.ok) {
      setError(`${r.error ?? "No se pudo guardar la sede."} Lo que escribiste se conserva.`);
      return;
    }
    saved.current = true;
    guard.leave();
  };

  const summary: SummaryError[] = attempted
    ? [
        ...(errors.name ? [{ target: "site-f-name", message: `Nombre: ${errors.name}` }] : []),
        ...(errors.address ? [{ target: "site-f-address", message: `Dirección: ${errors.address}` }] : []),
        ...(errors.slug ? [{ target: "site-f-slug", message: `URL pública: ${errors.slug}` }] : []),
        ...(errors.hours ? [{ target: "site-hours-h", message: `Horario: ${errors.hours}` }] : []),
      ]
    : [];
  const hoursChanged = JSON.stringify(weeklyFromGrid(f.grid)) !== JSON.stringify(weeklyFromGrid(initial.grid));

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
        title={site ? site.name : "Nueva sede"}
        headingId="site-editor-title"
        status={site ? <span className={`shrink-0 rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${site.active ? "bg-success/15 text-success" : "bg-chip text-muted"}`}>{site.active ? "Activa" : "Inactiva"}</span> : null}
        eyebrow={site ? "Editar sede" : "Configuración · Sedes"}
        chips={
          <>
            <MetaChip>{tzLabel(f.timezone)}</MetaChip>
            <MetaChip>{openDaysSummary(weeklyFromGrid(f.grid))}</MetaChip>
          </>
        }
        backLabel="Volver a Sedes"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={site ? "Guardar cambios" : "Crear sede"}
        saving={saving}
        canSave={site ? changes > 0 : true}
      />
      <EditorFrame
        sections={[
          { id: "site-basic", label: "Información básica", dirty: f.name !== initial.name || f.address !== initial.address, errors: (attempted ? Number(Boolean(errors.name)) + Number(Boolean(errors.address)) : 0) },
          { id: "site-link", label: "Enlace y zona horaria", dirty: slug !== initial.slug || f.timezone !== initial.timezone, errors: attempted && errors.slug ? 1 : 0 },
          { id: "site-hours", label: "Horario semanal", dirty: hoursChanged, errors: attempted && errors.hours ? 1 : 0 },
          ...(site ? [{ id: "site-id", label: "Identificador" }] : []),
        ]}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={site ? "Guardar" : "Crear"} canSave={site ? changes > 0 : true} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <EditorSection id="site-basic" title="Información básica" summary={`${f.name || "Sin nombre"} · ${f.address || "Sin dirección"}`}>
          <Field label="Nombre" error={show("name")}>
            <input id="site-f-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej. Sede Chapinero" aria-invalid={Boolean(show("name"))} className={INPUT} />
          </Field>
          <Field label="Dirección" optional hint="Tal como la escribiría el cliente en Maps. Se muestra en la página de reservas." error={show("address")}>
            <input id="site-f-address" value={f.address} maxLength={220} onChange={(e) => set("address", e.target.value)} aria-invalid={Boolean(show("address"))} className={INPUT} />
          </Field>
        </EditorSection>
        <EditorSection id="site-link" title="Enlace y zona horaria" summary={`${bookingPath(slug || "…")} · ${tzLabel(f.timezone)}`}>
          <Field
            label="URL pública"
            hint={site ? `Forma parte del enlace de reservas (${bookingPath(slug || "…")}). Si la cambias, el enlace anterior deja de funcionar.` : `Se genera del nombre; puedes cambiarla. Enlace: ${bookingPath(slug || "…")}`}
            error={show("slug")}
          >
            <input
              id="site-f-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                set("slug", e.target.value);
              }}
              aria-invalid={Boolean(show("slug"))}
              className={`${INPUT} font-mono`}
            />
          </Field>
          {site && slug !== initial.slug ? <Notice tone="warn">Al guardar, el enlace {bookingPath(initial.slug)} dejará de funcionar.</Notice> : null}
          <Field label="Zona horaria" hint="Las horas de la agenda, las reglas y las promociones de esta sede se leen en esta zona.">
            <select value={f.timezone} onChange={(e) => set("timezone", e.target.value)} className={INPUT}>
              <optgroup label="Frecuentes">
                {zones.common.map((z) => (
                  <option key={z} value={z}>
                    {tzLabel(z)} · {z}
                  </option>
                ))}
              </optgroup>
              {zones.rest.length ? (
                <optgroup label="Todas">
                  {zones.rest.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </Field>
        </EditorSection>
        <EditorSection id="site-hours" title="Horario semanal" description="Los días y horas en que esta sede atiende. Un profesional sin horario propio trabaja en este mismo horario. Las ausencias puntuales están en Horarios y ausencias." summary={openDaysSummary(weeklyFromGrid(f.grid))} error={show("hours")} defaultOpen={false}>
          <WeekHoursEditor grid={f.grid} setGrid={(g) => set("grid", g)} />
        </EditorSection>
        {site ? (
          <EditorSection id="site-id" title="Identificador" description="El id que piden la API de agenda y las integraciones (site_id)." defaultOpen={false}>
            <code className="u-mono w-fit select-all rounded-sch-control border border-line bg-subtle px-3 py-2 text-[0.7812rem]">{site.id}</code>
            <a href={bookingPath(site.slug)} target="_blank" rel="noopener noreferrer" className={buttonClass({ className: "w-fit" })}>
              Abrir página de reservas<span className="sr-only"> (pestaña nueva)</span>
            </a>
          </EditorSection>
        ) : null}
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en esta sede. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
