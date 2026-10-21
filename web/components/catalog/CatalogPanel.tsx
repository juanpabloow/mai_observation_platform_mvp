"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { priceLabelCOP } from "@/lib/money";
import { PRODUCT_DESCRIPTION_MAX, PRODUCT_NAME_MAX } from "@/lib/catalogValidation";
import {
  archiveProductAction,
  createProductAction,
  restoreProductAction,
  setProductStockAction,
  updateProductAction,
} from "@/lib/catalogActions";
import { Alert, Button, Field, INPUT, TEXTAREA } from "@/components/ui/controls";
import { Menu as ActionMenu, MenuButton, MenuSeparator } from "@/components/scheduling/ui/Menu";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults, ReadOnlyBanner } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, ErrorSummary, MetaChip, SaveBar, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { AffixInput, ToggleRow } from "@/components/ui/module/FormKit";
import { ConfirmLayer, DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { safeAction } from "@/components/ui/module/safeAction";

/**
 * Per-client PRODUCT catalogue («Productos»), in the module surface. INFORM ONLY: there
 * is nothing here about stock quantities, orders, payments, images or the booking page —
 * products are what the assistant may offer (machine API), and `in_stock` is a plain
 * Disponible / Agotado switch.
 *
 * Roles (server-enforced in lib/catalogActions; this is presentation only):
 *   - agency / owner (`canManage`)  create, edit, archive, restore, availability
 *   - setter                        reads the list and marks Disponible / Agotado — the
 *                                   person at the counter — and sees a «Solo lectura» note
 *
 * Categories are the business's own free text (no table): the side menu lists the ones in
 * use, «Sin categoría», and «Archivados». A product's price is required and > 0 (DB CHECK),
 * so there is no «A consultar» here, unlike services. Filters live in the URL.
 */

interface Product {
  id: string;
  name: string;
  description: string | null;
  price: string;
  category: string | null;
  in_stock: boolean;
  is_active: boolean;
}

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>) => void;

const NO_CATEGORY = "sin-categoria";
const ARCHIVED = "archivados";
const COLUMNS: ListColumn[] = [
  { key: "name", label: "Producto", className: "lg:w-[15rem]" },
  { key: "desc", label: "Descripción", className: "hidden lg:table-cell" },
  { key: "stock", label: "Disponibilidad", className: "w-[9.375rem]" },
  { key: "price", label: "Precio", align: "right", className: "w-[7.375rem]" },
];

export function CatalogPanel({
  clientId,
  clientName,
  canManage,
  products,
}: {
  clientId: string;
  clientName: string;
  canManage: boolean;
  products: Product[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useUrlState("q", "");
  const [filter, setFilter] = useUrlState("filtro", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ kind: "new" } | { kind: "edit"; product: Product } | null>(null);
  const [archiving, setArchiving] = useState<Product | null>(null);
  const [opener, setOpener] = useState("new");

  const run: Run = (fn) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };

  // Distinct categories actually in use, for the side menu + the editor's suggestions.
  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, "es")),
    [products],
  );
  const active = products.filter((p) => p.is_active);
  const archived = products.filter((p) => !p.is_active);
  const q = query.trim().toLocaleLowerCase("es");
  const matchesQuery = (p: Product) => !q || p.name.toLocaleLowerCase("es").includes(q) || (p.description ?? "").toLocaleLowerCase("es").includes(q);
  const view = filter === ARCHIVED || filter === NO_CATEGORY || categories.includes(filter) ? filter : "";

  const railGroups: FilterGroup[] = [
    {
      label: "Categorías",
      options: [
        { value: "", label: "Todas las categorías", count: active.length },
        ...categories.map((c) => ({ value: c, label: c, count: active.filter((p) => p.category === c).length })),
        { value: NO_CATEGORY, label: "Sin categoría", count: active.filter((p) => !p.category).length },
      ],
    },
    { label: "Otros", options: [{ value: ARCHIVED, label: "Archivados", count: archived.length }] },
  ];

  // Groups shown: archived as one group; otherwise one group per category (+ none).
  const groups: Array<{ key: string; title: string; items: Product[] }> =
    view === ARCHIVED
      ? [{ key: ARCHIVED, title: "Archivados", items: archived.filter(matchesQuery) }]
      : [
          ...categories.map((c) => ({ key: c, title: c, items: active.filter((p) => p.category === c) })),
          { key: NO_CATEGORY, title: "Sin categoría", items: active.filter((p) => !p.category) },
        ]
          .filter((g) => view === "" || g.key === view)
          .map((g) => ({ ...g, items: g.items.filter(matchesQuery) }));
  const shown = groups.reduce((n, g) => n + g.items.length, 0);

  const open = (next: NonNullable<typeof editor>) => {
    setMenu(null);
    setOpener(next.kind === "edit" ? next.product.id : "new");
    setEditor(next);
  };
  const closeEditor = (saved: boolean) => {
    setEditor(null);
    if (saved) router.refresh();
    returnFocus(opener);
  };

  const stockToggle = (p: Product) => (
    <button
      type="button"
      disabled={pending}
      onClick={() => run(() => setProductStockAction(clientId, p.id, !p.in_stock))}
      aria-pressed={p.in_stock}
      aria-label={`${p.name}: ${p.in_stock ? "disponible" : "agotado"}. Cambiar disponibilidad`}
      className={`u-focus inline-flex h-[1.875rem] items-center gap-1.5 rounded-full border px-2.5 text-[0.75rem] font-medium transition-colors disabled:opacity-50 ${
        p.in_stock ? "border-success/35 bg-success/10 text-success hover:bg-success/15" : "border-line bg-subtle text-muted hover:bg-chip"
      }`}
    >
      <span aria-hidden className={`size-1.5 rounded-full ${p.in_stock ? "bg-success" : "bg-faint"}`} />
      {p.in_stock ? "Disponible" : "Agotado"}
    </button>
  );

  const rowMenu = (p: Product, at: "t" | "m" = "t") => {
    if (!canManage && !p.is_active) return null;
    return (
      <ActionMenu label={`Acciones de ${p.name}`} open={menu === `${at}:${p.id}`} onToggle={() => setMenu(menu === `${at}:${p.id}` ? null : `${at}:${p.id}`)} onClose={() => setMenu(null)}>
        {p.is_active ? (
          <MenuButton
            disabled={pending}
            onClick={() => {
              setMenu(null);
              run(() => setProductStockAction(clientId, p.id, !p.in_stock));
            }}
          >
            {p.in_stock ? "Marcar como agotado" : "Marcar como disponible"}
          </MenuButton>
        ) : null}
        {canManage ? (
          <>
            {p.is_active ? <MenuSeparator /> : null}
            {p.is_active ? <MenuButton onClick={() => open({ kind: "edit", product: p })}>Editar</MenuButton> : null}
            {p.is_active ? (
              <MenuButton
                disabled={pending}
                onClick={() => {
                  setMenu(null);
                  setArchiving(p);
                }}
              >
                Archivar
              </MenuButton>
            ) : (
              <MenuButton
                disabled={pending}
                onClick={() => {
                  setMenu(null);
                  run(() => restoreProductAction(clientId, p.id));
                }}
              >
                Restaurar
              </MenuButton>
            )}
          </>
        ) : null}
      </ActionMenu>
    );
  };

  const canOpen = (p: Product) => canManage && p.is_active;

  return (
    <ModuleSurface label="Productos">
      <div hidden={Boolean(editor)} className="flex min-h-0 flex-1 flex-col">
        <SurfaceTop
          title="Productos"
          summary={`Lo que el asistente puede ofrecer · ${active.length} activo${active.length === 1 ? "" : "s"} · ${archived.length} archivado${archived.length === 1 ? "" : "s"}`}
          primary={
            canManage ? (
              <Button variant="primary" data-open-key="new" onClick={() => open({ kind: "new" })}>
                <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M8 3v10M3 8h10" />
                </svg>
                Añadir producto
              </Button>
            ) : null
          }
        >
          <RailToggle />
          <SearchField value={query} onChange={setQuery} label="Buscar producto" />
          <FilterSelect groups={railGroups} value={view} onChange={setFilter} label="Categoría" className="w-full sm:w-auto sm:min-w-[14rem]" />
        </SurfaceTop>
        <SurfaceBody rail={<FilterRail groups={railGroups} value={view} onChange={setFilter} />} railLabel="Categorías de productos">
          {!canManage ? <ReadOnlyBanner>Puedes marcar productos como disponibles o agotados. Crear, editar y archivar lo hace la persona responsable del negocio.</ReadOnlyBanner> : null}
          {error ? (
            <div className="px-4 pt-3 sm:px-6">
              <Alert>{error}</Alert>
            </div>
          ) : null}

          {products.length === 0 ? (
            <EmptyState title="Aún no hay productos" body="Lo que registres aquí es lo que el asistente puede ofrecer: nombre, precio, descripción y si está disponible.">
              {canManage ? (
                <Button variant="primary" onClick={() => open({ kind: "new" })}>
                  Añadir producto
                </Button>
              ) : null}
            </EmptyState>
          ) : shown === 0 ? (
            view === ARCHIVED && archived.length === 0 ? (
              <EmptyState title="No hay productos archivados" body="Un producto archivado deja de ofrecerse y se puede restaurar." />
            ) : !q && view === "" && active.length === 0 ? (
              // Nothing searched or filtered: every product is archived.
              <EmptyState title="No hay productos activos" body={`${archived.length === 1 ? "El único producto está archivado" : `Los ${archived.length} productos están archivados`}: el asistente no los ofrece. Puedes restaurarlos desde «Archivados».`}>
                {canManage ? (
                  <Button variant="primary" onClick={() => open({ kind: "new" })}>
                    Añadir producto
                  </Button>
                ) : null}
                <Button onClick={() => setFilter(ARCHIVED)}>Ver archivados</Button>
              </EmptyState>
            ) : (
              <NoResults>
                {q ? <Button onClick={() => setQuery("")}>Borrar búsqueda</Button> : null}
                {view ? <Button onClick={() => setFilter("")}>Ver todas las categorías</Button> : null}
              </NoResults>
            )
          ) : (
            <>
              {/* One continuous list in category order; the side menu filters by category. */}
              <ListTable label={view === ARCHIVED ? "Productos archivados" : "Productos"} columns={COLUMNS}>
                <ListGroup span={COLUMNS.length + 1}>
                  {groups.flatMap((g) =>
                    g.items.map((p) => (
                      <ListRow
                          key={p.id}
                          columns={COLUMNS}
                          name={p.name}
                          openKey={p.id}
                          onOpen={canOpen(p) ? () => open({ kind: "edit", product: p }) : undefined}
                          openLabel="Editar"
                          dimmed={!p.is_active}
                          raised={menu === `t:${p.id}`}
                          menu={rowMenu(p)}
                          cells={[
                            <span key="n">{p.name}</span>,
                            <span key="d" className="text-muted">{p.description || "Sin descripción"}</span>,
                            p.is_active ? stockToggle(p) : <span key="s" className="text-muted">Archivado</span>,
                            <span key="$" className="font-semibold tabular-nums">{priceLabelCOP(p.price) ?? "—"}</span>,
                          ]}
                        />
                    )),
                  )}
                </ListGroup>
              </ListTable>
              <MobileList>
                {groups.map((g) =>
                  g.items.length === 0 ? null : (
                    <MobileGroup key={g.key} title={g.title} count={String(g.items.length)}>
                      {g.items.map((p) => (
                        <MobileRow
                          key={p.id}
                          title={p.name}
                          openKey={p.id}
                          subtitle={p.description || "Sin descripción"}
                          value={priceLabelCOP(p.price) ?? "—"}
                          badges={p.is_active && !p.in_stock ? <span className="rounded-full bg-chip px-1.5 py-px text-[0.6875rem] font-medium text-muted">Agotado</span> : null}
                          onOpen={canOpen(p) ? () => open({ kind: "edit", product: p }) : undefined}
                          openLabel="Editar"
                          dimmed={!p.is_active}
                          menu={rowMenu(p, "m")}
                        />
                      ))}
                    </MobileGroup>
                  ),
                )}
              </MobileList>
              <ListFoot>
                Mostrando {shown} producto{shown === 1 ? "" : "s"}
                {q ? " · con búsqueda" : ""}
              </ListFoot>
            </>
          )}
        </SurfaceBody>
      </div>

      {editor ? (
        <ProductEditor
          key={editor.kind === "edit" ? editor.product.id : "new"}
          clientId={clientId}
          clientName={clientName}
          product={editor.kind === "edit" ? editor.product : null}
          categories={categories}
          onClose={() => closeEditor(false)}
          onSaved={() => closeEditor(true)}
        />
      ) : null}

      {archiving ? (
        <ConfirmLayer
          id="product-archive"
          title={`¿Archivar «${archiving.name}»?`}
          body="Se deja de ofrecer: el asistente ya no lo verá. Puedes restaurarlo cuando quieras."
          confirmLabel="Archivar"
          tone="primary"
          onCancel={() => setArchiving(null)}
          onConfirm={() => {
            const id = archiving.id;
            setArchiving(null);
            run(() => archiveProductAction(clientId, id));
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

interface ProductForm {
  name: string;
  category: string;
  description: string;
  price: string;
  inStock: boolean;
}

function validateProduct(f: ProductForm): Partial<Record<keyof ProductForm, string>> {
  const e: Partial<Record<keyof ProductForm, string>> = {};
  if (!f.name.trim()) e.name = "Escribe el nombre del producto.";
  else if (f.name.trim().length > PRODUCT_NAME_MAX) e.name = `Máximo ${PRODUCT_NAME_MAX} caracteres.`;
  const n = Number(f.price);
  if (!f.price.trim()) e.price = "Escribe el precio del producto.";
  else if (!Number.isFinite(n) || n <= 0) e.price = "El precio debe ser mayor que 0.";
  if (f.description.length > PRODUCT_DESCRIPTION_MAX) e.description = `Máximo ${PRODUCT_DESCRIPTION_MAX} caracteres.`;
  return e;
}

const FIELD_ID: Record<keyof ProductForm, string> = {
  name: "prd-f-name",
  category: "prd-f-category",
  description: "prd-f-description",
  price: "prd-f-price",
  inStock: "prd-f-stock",
};
const FIELD_LABEL: Record<keyof ProductForm, string> = {
  name: "Nombre",
  category: "Categoría",
  description: "Descripción",
  price: "Precio",
  inStock: "Disponibilidad",
};

/** The in-page product editor: one save (create or update), errors beside each field and
 *  linked on top, everything typed kept when the server refuses (e.g. a duplicate name). */
function ProductEditor({
  clientId,
  clientName,
  product,
  categories,
  onClose,
  onSaved,
}: {
  clientId: string;
  clientName: string;
  product: Product | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = useMemo<ProductForm>(
    () => ({
      name: product?.name ?? "",
      category: product?.category ?? "",
      description: product?.description ?? "",
      // "45000.00" → "45000" so an untouched price is not a change.
      price: product ? String(Number(product.price)) : "",
      inStock: product?.in_stock ?? true,
    }),
    [product],
  );
  const [form, setForm] = useState<ProductForm>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof ProductForm, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);

  const errors = validateProduct(form);
  const show = (k: keyof ProductForm) => ((attempted || touched[k]) && errors[k]) || "";
  const changes = countChanges(initial, form);
  const set = <K extends keyof ProductForm>(k: K, v: ProductForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k: keyof ProductForm) => () => setTouched((t) => ({ ...t, [k]: true }));
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => (saved.current ? onSaved() : onClose()) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setError(null);
    const values = {
      name: form.name.trim(),
      price: form.price.trim(),
      category: form.category.trim() === "" ? null : form.category.trim(),
      description: form.description,
      inStock: form.inStock,
    };
    const r = product ? await safeAction(() => updateProductAction(clientId, product.id, values)) : await safeAction(() => createProductAction({ clientId, ...values }));
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "No se pudo guardar el producto.");
      return;
    }
    saved.current = true;
    guard.leave();
  };

  const summary: SummaryError[] = attempted
    ? (Object.keys(errors) as (keyof ProductForm)[]).map((k) => ({ target: FIELD_ID[k], message: `${FIELD_LABEL[k]}: ${errors[k]}` }))
    : [];
  const sections = [
    { id: "prd-basic", label: "Información básica", dirty: countChanges({ a: initial.name, b: initial.category, c: initial.description }, { a: form.name, b: form.category, c: form.description }) > 0, errors: attempted ? Number(Boolean(errors.name)) + Number(Boolean(errors.description)) : 0 },
    { id: "prd-price", label: "Precio", dirty: initial.price !== form.price, errors: attempted && errors.price ? 1 : 0 },
    { id: "prd-stock", label: "Disponibilidad", dirty: initial.inStock !== form.inStock },
  ];
  const isNew = !product;

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
        title={isNew ? "Nuevo producto" : product.name}
        headingId="prd-editor-title"
        eyebrow={isNew ? `Catálogo · Productos · ${clientName}` : "Editar producto"}
        chips={
          <>
            {form.category.trim() ? <MetaChip>{form.category.trim()}</MetaChip> : <MetaChip>Sin categoría</MetaChip>}
            <MetaChip>{(form.price.trim() && Number(form.price) > 0 && priceLabelCOP(form.price.trim())) || "Sin precio"}</MetaChip>
            <MetaChip>{form.inStock ? "Disponible" : "Agotado"}</MetaChip>
          </>
        }
        backLabel="Volver a Productos"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={isNew ? "Crear producto" : "Guardar cambios"}
        saving={saving}
        canSave={isNew ? true : changes > 0}
      />
      <EditorFrame
        sections={sections}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={isNew ? "Crear" : "Guardar"} canSave={isNew ? true : changes > 0} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error} Lo que escribiste se conserva.</Alert>
          </div>
        ) : null}
        <EditorSection id="prd-basic" title="Información básica" summary={`${form.name || "Sin nombre"}${form.category ? ` · ${form.category}` : ""}`}>
          <Field label="Nombre" error={show("name")}>
            <input id="prd-f-name" value={form.name} onChange={(e) => set("name", e.target.value)} onBlur={touch("name")} maxLength={PRODUCT_NAME_MAX + 20} placeholder="Ej. Óleo para barba" aria-invalid={Boolean(show("name"))} className={INPUT} />
          </Field>
          <Field label="Categoría" optional hint="Texto libre: agrupa el listado. Elige una existente o escribe una nueva.">
            <input id="prd-f-category" value={form.category} onChange={(e) => set("category", e.target.value)} list="catalog-categories" placeholder="Ej. Cuidado de barba" className={INPUT} />
          </Field>
          <datalist id="catalog-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Field label="Descripción" optional hint={`Qué es el producto — lo usa el asistente para responder «¿qué es X?». ${form.description.length}/${PRODUCT_DESCRIPTION_MAX}`} error={show("description")}>
            <textarea
              id="prd-f-description"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              onBlur={touch("description")}
              rows={3}
              maxLength={PRODUCT_DESCRIPTION_MAX}
              aria-invalid={Boolean(show("description"))}
              className={TEXTAREA}
            />
          </Field>
        </EditorSection>
        <EditorSection id="prd-price" title="Precio" summary={(form.price.trim() && priceLabelCOP(form.price.trim())) || "Sin precio"}>
          <Field label="Precio" hint="Obligatorio y mayor que 0. Los productos no admiten «A consultar»." error={show("price")}>
            <AffixInput id="prd-f-price" inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} onBlur={touch("price")} aria-invalid={Boolean(show("price"))} prefix="$" suffix="COP" className="max-w-[16rem]" />
          </Field>
        </EditorSection>
        <EditorSection id="prd-stock" title="Disponibilidad" summary={form.inStock ? "Disponible" : "Agotado"}>
          <ToggleRow id="prd-f-stock" checked={form.inStock} onChange={(v) => set("inStock", v)} label="Disponible" hint="El asistente lo verá al responder qué vendes, cuánto cuesta y si está disponible. Sin inventario: es un sí o no." />
        </EditorSection>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en este producto. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
