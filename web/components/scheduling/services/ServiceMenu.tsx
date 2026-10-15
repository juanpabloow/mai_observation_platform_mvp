"use client";

import { useMemo, useState, useTransition, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import { priceLabelCOP } from "@/lib/money";
import { activateServiceAction, countUpcomingAppointmentsAction, deactivateServiceAction } from "@/lib/schedulingAdminActions";
import type { BookingCategory, Service, Site, Staff } from "../AdminPanel";
import { Menu as ActionMenu, MenuButton } from "../ui/Menu";
import { Alert, Button, CARD, ConfirmDialog, FIELD, buttonClass, useModalLayer } from "../ui/system";
import { CATEGORY_GROUPS, type CategoryGroup } from "./categories";
import { BookingCategoriesPanel } from "./BookingCategoriesPanel";
import { ServiceEditor } from "./ServiceEditor";

/**
 * "Menú de servicios" — the client's service catalogue, laid out the way a salon reads
 * its menu: categories on the left with their counts, the services of each category on
 * the right as compact horizontal cards (colour stripe = the agenda colour, name +
 * duration + description on the left, price on the right, its own ⋯ menu).
 *
 * Real actions only: add / edit (the wide editor), archive (the existing deactivate —
 * appointments and history stay, and it asks first) and reactivate. Archived services
 * have their own view. Things this catalogue has no model for — packages, editable
 * categories, manual ordering, bulk edit, exports, per-service booking links,
 * duplicating, permanent delete — are simply not offered.
 */

type View = { kind: "all" } | { kind: "category"; value: CategoryGroup["value"] } | { kind: "archived" };

export function ServiceMenu({
  clientId,
  sites,
  services,
  staff,
  siteServiceMap,
  bookingCategories = [],
  onOpenBookingLink,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  bookingCategories?: BookingCategory[];
  /** "Enlace de reservas" lives on each site — jump to Sedes y horarios. */
  onOpenBookingLink: () => void;
}) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [view, setView] = useState<View>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: "edit"; service: Service } | { kind: "new"; category: string | null } | null>(null);
  const [archive, setArchive] = useState<{ service: Service; upcoming: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeSites = sites.filter((s) => s.active);
  const activeStaff = staff.filter((p) => p.active);
  const q = query.trim().toLocaleLowerCase("es");
  const matches = (s: Service) =>
    (!q || s.name.toLocaleLowerCase("es").includes(q) || (s.description ?? "").toLocaleLowerCase("es").includes(q)) &&
    (!siteFilter || (siteServiceMap[siteFilter] ?? []).includes(s.id));
  const active = services.filter((s) => s.active);
  const archived = services.filter((s) => !s.active);
  const byGroup = useMemo(() => {
    const m = new Map<string, Service[]>();
    for (const g of CATEGORY_GROUPS) m.set(g.value, []);
    for (const s of active) {
      const bucket = m.get(s.category ?? "") ?? m.get("");
      bucket?.push(s);
    }
    return m;
  }, [active]);

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
    startBusy(async () => {
      const c = await countUpcomingAppointmentsAction(clientId, "service", service.id);
      setArchive({ service, upcoming: c.ok ? c.count : 0 });
    });
  };

  const groupsShown = CATEGORY_GROUPS.filter((g) => view.kind === "all" || (view.kind === "category" && view.value === g.value));

  return (
    <section aria-labelledby="svc-menu-title" className="flex flex-col gap-4">
      {/* Title row: what this is, and the two top-level actions. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 sm:flex-1">
          <h2 id="svc-menu-title" className="text-xl font-semibold tracking-[-0.01em]">
            Menú de servicios
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">Configura los servicios que se pueden reservar, su precio, duración y quién los presta.</p>
        </div>
        <div className="flex items-center gap-2">
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
          <MenuButton onClick={() => { setMenu(null); onOpenBookingLink(); }}>Enlace de reservas</MenuButton>
          <MenuButton onClick={() => { setMenu(null); setView(view.kind === "archived" ? { kind: "all" } : { kind: "archived" }); }}>
            {view.kind === "archived" ? "Ver servicios activos" : `Ver archivados (${archived.length})`}
          </MenuButton>
        </ActionMenu>
        <Button variant="primary" onClick={() => setEditor({ kind: "new", category: view.kind === "category" ? view.value || null : null })}>
          Añadir servicio
        </Button>
        </div>
      </div>

      <BookingCategoriesPanel clientId={clientId} categories={bookingCategories} />

      {/* Search + filters. */}
      <div className={`flex flex-wrap items-center gap-2 p-3 ${CARD}`}>
        <label className={`${FIELD} flex h-[44px] min-w-0 flex-1 items-center gap-2 sm:max-w-sm lg:h-[40px]`}>
          <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="4.4" />
            <path d="M10.4 10.4 13.6 13.6" />
          </svg>
          <span className="sr-only">Buscar servicio</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar servicio" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
        </label>
        {activeSites.length > 1 ? (
          <select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            aria-label="Filtrar por sede"
            className={`${FIELD} h-[44px] w-auto lg:h-[40px]`}
          >
            <option value="">Todas las sedes</option>
            {activeSites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        ) : null}
        <span className="u-mono ml-auto hidden text-xs text-faint sm:inline">
          {active.length} activo{active.length === 1 ? "" : "s"} · {archived.length} archivado{archived.length === 1 ? "" : "s"}
        </span>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        {/* CATEGORIES — a list on desktop, a horizontal strip on smaller screens. */}
        <nav aria-label="Categorías" className="min-w-0 lg:self-start">
          <div className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:rounded-sch-card lg:border lg:border-line lg:bg-surface lg:p-3 lg:pb-3">
            <h3 className="hidden px-2 pb-2 pt-1 text-[15px] font-semibold lg:block">Categorías</h3>
            <CategoryButton label="Todas las categorías" count={active.length} on={view.kind === "all"} onClick={() => setView({ kind: "all" })} />
            {CATEGORY_GROUPS.map((g) => (
              <CategoryButton
                key={g.value || "none"}
                label={g.label}
                count={byGroup.get(g.value)?.length ?? 0}
                on={view.kind === "category" && view.value === g.value}
                onClick={() => setView({ kind: "category", value: g.value })}
              />
            ))}
            <span aria-hidden className="mx-2 my-1.5 hidden h-px bg-line lg:block" />
            <CategoryButton label="Archivados" count={archived.length} on={view.kind === "archived"} onClick={() => setView({ kind: "archived" })} />
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {view.kind === "archived" ? (
            <div className="flex flex-col gap-2.5">
              <div>
                <h3 className="text-[17px] font-semibold">Archivados</h3>
                <p className="mt-0.5 text-[13px] text-muted">No se pueden reservar. Sus citas y su historial se conservan.</p>
              </div>
              {archived.filter(matches).length === 0 ? (
                <EmptyState text="No hay servicios archivados." />
              ) : (
                archived.filter(matches).map((s) => (
                  <ServiceCard
                    key={s.id}
                    service={s}
                    siteCount={activeSites.filter((site) => (siteServiceMap[site.id] ?? []).includes(s.id)).length}
                    menuOpen={menu === s.id}
                    onMenu={() => setMenu(menu === s.id ? null : s.id)}
                    onCloseMenu={() => setMenu(null)}
                    onEdit={() => { setMenu(null); setEditor({ kind: "edit", service: s }); }}
                    onArchive={null}
                    onReactivate={() => { setMenu(null); run(() => activateServiceAction(clientId, s.id)); }}
                    busy={busy}
                  />
                ))
              )}
            </div>
          ) : (
            groupsShown.map((g) => {
              const list = (byGroup.get(g.value) ?? []).filter(matches);
              const all = byGroup.get(g.value) ?? [];
              // In "all", empty groups are skipped; a picked empty category says so.
              if (view.kind === "all" && all.length === 0) return null;
              return (
                <section key={g.value || "none"} aria-labelledby={`svc-group-${g.value || "none"}`} className="flex flex-col gap-2.5">
                  <div className="flex items-start gap-3">
                    <span aria-hidden className={`u-appt-service ${apptCategoryClass(g.value ? g.value : "cut")} mt-1.5 size-2.5 shrink-0 rounded-full ${g.value ? "bg-[var(--appt-ink)] opacity-70" : "border border-dashed border-line-strong"}`} />
                    <div className="min-w-0 flex-1">
                      <h3 id={`svc-group-${g.value || "none"}`} className="text-[17px] font-semibold">
                        {g.label}
                      </h3>
                      <p className="mt-0.5 text-[13px] text-muted">
                        {g.value
                          ? `${all.length} servicio${all.length === 1 ? "" : "s"}`
                          : "Sin categoría: la agenda les asigna un color según el nombre."}
                      </p>
                    </div>
                    <ActionMenu
                      label={`Acciones de ${g.label}`}
                      open={menu === `group:${g.value}`}
                      onToggle={() => setMenu(menu === `group:${g.value}` ? null : `group:${g.value}`)}
                      onClose={() => setMenu(null)}
                      trigger={
                        <span className={buttonClass({ size: "sm", className: "pointer-events-none" })}>
                          Acciones
                          <Chevron />
                        </span>
                      }
                    >
                      <MenuButton onClick={() => { setMenu(null); setEditor({ kind: "new", category: g.value || null }); }}>Añadir servicio</MenuButton>
                    </ActionMenu>
                  </div>
                  {list.length === 0 ? (
                    <EmptyState
                      text={all.length === 0 ? "Esta categoría todavía no tiene servicios." : "Ningún servicio coincide con la búsqueda."}
                      action={all.length === 0 ? { label: "Añadir servicio", onClick: () => setEditor({ kind: "new", category: g.value || null }) } : undefined}
                    />
                  ) : (
                    list.map((s) => (
                      <ServiceCard
                        key={s.id}
                        service={s}
                        siteCount={activeSites.filter((site) => (siteServiceMap[site.id] ?? []).includes(s.id)).length}
                        menuOpen={menu === s.id}
                        onMenu={() => setMenu(menu === s.id ? null : s.id)}
                        onCloseMenu={() => setMenu(null)}
                        onEdit={() => { setMenu(null); setEditor({ kind: "edit", service: s }); }}
                        onArchive={() => askArchive(s)}
                        onReactivate={null}
                        busy={busy}
                      />
                    ))
                  )}
                </section>
              );
            })
          )}
          {view.kind === "all" && active.length === 0 ? (
            <EmptyState text="Todavía no hay servicios activos." action={{ label: "Añadir servicio", onClick: () => setEditor({ kind: "new", category: null }) }} />
          ) : null}
        </div>
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
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            router.refresh();
          }}
        />
      ) : null}

      {archive ? (
        <ArchiveConfirm
          name={archive.service.name}
          upcoming={archive.upcoming}
          pending={busy}
          onCancel={() => setArchive(null)}
          onConfirm={() => {
            const id = archive.service.id;
            setArchive(null);
            run(() => deactivateServiceAction(clientId, id));
          }}
        />
      ) : null}
    </section>
  );
}

function ServiceCard({
  service: s,
  siteCount,
  menuOpen,
  onMenu,
  onCloseMenu,
  onEdit,
  onArchive,
  onReactivate,
  busy,
}: {
  service: Service;
  siteCount: number;
  menuOpen: boolean;
  onMenu: () => void;
  onCloseMenu: () => void;
  onEdit: () => void;
  onArchive: (() => void) | null;
  onReactivate: (() => void) | null;
  busy: boolean;
}) {
  // The stripe is the colour the AGENDA actually paints — the inferred family for an
  // uncategorised service, so the menu never shows a colour the board doesn't.
  const family = serviceCategory(s.name, s.category);
  const price = priceLabelCOP(s.price);
  return (
    // No overflow-hidden here: it would clip the ⋯ menu. The stripe rounds its own corners
    // instead, and the open card is lifted above its siblings (an archived card's opacity
    // would make its own stacking context — it dims the content, not the card).
    <article
      className={`group relative flex min-w-0 items-stretch transition-colors hover:border-line-strong ${CARD} ${menuOpen ? "z-10" : ""}`}
    >
      <span aria-hidden className={`u-appt-service ${apptCategoryClass(family)} w-1.5 shrink-0 rounded-l-sch-card bg-[var(--appt-ink)] opacity-70`} />
      <button
        type="button"
        onClick={onEdit}
        className={`u-focus flex min-w-0 flex-1 items-start gap-4 rounded-r-sch-card px-4 py-3.5 text-left ${s.active ? "" : "opacity-75"}`}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words text-[15px] font-semibold text-foreground">{s.name}</span>
            {s.featured ? <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-muted">Destacado</span> : null}
            {!s.active ? <span className="rounded-full bg-chip px-2 py-0.5 text-[11px] font-medium text-muted">Archivado</span> : null}
          </span>
          <span className="text-[13px] text-muted">
            {s.duration_min} min · {siteCount} sede{siteCount === 1 ? "" : "s"}
          </span>
          {s.description ? <span className="truncate text-[13px] text-muted">{s.description}</span> : null}
        </span>
        <span className="u-mono shrink-0 pt-0.5 text-[15px] font-medium text-foreground">{price ?? "A consultar"}</span>
      </button>
      <div className="flex shrink-0 items-start py-2.5 pr-2">
        <ActionMenu label={`Acciones de ${s.name}`} open={menuOpen} onToggle={onMenu} onClose={onCloseMenu}>
          <MenuButton onClick={onEdit}>Editar</MenuButton>
          {onArchive ? (
            <MenuButton disabled={busy} onClick={onArchive}>
              Archivar
            </MenuButton>
          ) : null}
          {onReactivate ? (
            <MenuButton disabled={busy} onClick={onReactivate}>
              Reactivar
            </MenuButton>
          ) : null}
        </ActionMenu>
      </div>
    </article>
  );
}

function CategoryButton({ label, count, on, onClick }: { label: string; count: number; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`u-focus flex h-[44px] shrink-0 items-center gap-3 rounded-sch-control border px-3.5 text-sm transition-colors lg:h-[40px] lg:border-transparent lg:px-2.5 ${
        on ? "border-foreground bg-subtle font-medium text-foreground" : "border-line text-muted hover:bg-subtle hover:text-foreground"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="u-mono ml-auto rounded-full bg-chip px-2 py-0.5 text-[11px] text-muted">{count}</span>
    </button>
  );
}

function EmptyState({ text, action }: { text: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-sch-card border border-dashed border-line px-4 py-8 text-center">
      <p className="text-[13px] text-muted">{text}</p>
      {action ? (
        <Button size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/** "¿Archivar …?" — a page-level modal: focus is trapped in it, Escape cancels, and
 *  focus returns to the menu that opened it. Archiving is reversible, so the confirm is
 *  the ink primary, not the destructive red. */
function ArchiveConfirm({
  name,
  upcoming,
  pending,
  onCancel,
  onConfirm,
}: {
  name: string;
  upcoming: number;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const trapRef = useTrappedPanel({ active: true, onClose: onCancel });
  const layer = useModalLayer(true);
  return (
    <div ref={trapRef as RefObject<HTMLDivElement>} className="fixed inset-0 z-50">
      <ConfirmDialog
        layerRef={layer.layerRef}
        id="svc-archive"
        title={`¿Archivar «${name}»?`}
        body={`Dejará de poder reservarse. ${
          upcoming > 0 ? `Tiene ${upcoming} cita${upcoming === 1 ? "" : "s"} próxima${upcoming === 1 ? "" : "s"}: se conservan.` : "Sus citas y su historial se conservan."
        } Puedes reactivarlo cuando quieras.`}
        confirmLabel="Archivar"
        tone="primary"
        pending={pending}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </div>
  );
}
