"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { priceLabelCOP } from "@/lib/money";
import { PRODUCT_DESCRIPTION_MAX } from "@/lib/catalogValidation";
import {
  archiveProductAction,
  createProductAction,
  restoreProductAction,
  setProductStockAction,
  updateProductAction,
} from "@/lib/catalogActions";

/**
 * Per-client PRODUCT catalogue manager. It mirrors the scheduling AdminPanel's visual
 * language on purpose — a new module should read as native to the platform, not as a
 * different surface. INFORM ONLY: there is nothing here about stock quantities, orders or
 * payments; `in_stock` is a plain disponible/agotado switch.
 *
 * `canManage` (agency/owner) gates create / edit / archive / restore in the UI; the server
 * actions re-enforce every tier, so this is presentation only. The availability toggle is
 * shown to everyone who can open the page (owner, setter, agency) — the Setter is the one
 * at the counter who marks a product agotado — and setProductStockAction enforces that tier.
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

// Responsive control sizes — identical to the scheduling settings (44px touch / 36px desktop).
const INPUT =
  "h-[44px] lg:h-[36px] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle disabled:text-faint";
const BTN =
  "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[44px] lg:h-[34px] items-center justify-center rounded-lg border border-line px-3 lg:px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground";

type Run = (fn: () => Promise<{ ok: boolean; error?: string }>) => void;

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
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);

  const run: Run = (fn) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };

  // Distinct categories actually in use, for the filter + the create/edit datalist.
  const categories = useMemo(
    () =>
      [...new Set(products.map((p) => p.category).filter((c): c is string => !!c))].sort((a, b) =>
        a.localeCompare(b, "es"),
      ),
    [products],
  );

  const filtered = products.filter((p) => {
    const matchesQuery = p.name.toLocaleLowerCase("es").includes(query.trim().toLocaleLowerCase("es"));
    const matchesCategory =
      categoryFilter === "all"
        ? true
        : categoryFilter === "none"
          ? !p.category
          : p.category === categoryFilter;
    return matchesQuery && matchesCategory;
  });
  const activeCount = products.filter((p) => p.is_active).length;

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">Productos</h1>
              <span className="truncate text-xs text-muted">{clientName}</span>
            </div>
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              Lo que registres aquí es lo que el asistente puede ofrecer a tus clientes.
            </p>
          </div>
          {canManage ? (
            <button type="button" className={BTN} onClick={() => setCreating(true)}>
              + Nuevo producto
            </button>
          ) : null}
        </div>
      </PageShell>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <PageShell className="overflow-y-auto" ariaLabel="Catálogo de productos">
        <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
          {products.length === 0 ? (
            <EmptyState canManage={canManage} onCreate={() => setCreating(true)} />
          ) : (
            <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 sm:p-4">
              <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar producto…"
                  aria-label="Buscar producto"
                  className={`${INPUT} min-w-0 flex-1 bg-subtle/60 sm:max-w-sm`}
                />
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filtrar por categoría"
                  className={INPUT}
                >
                  <option value="all">Todas las categorías</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="none">Sin categoría</option>
                </select>
                <span className="u-mono ml-auto text-xs text-faint">
                  {activeCount} activo{activeCount === 1 ? "" : "s"}
                </span>
              </div>

              {filtered.map((p) => (
                <ProductRow
                  key={p.id}
                  clientId={clientId}
                  product={p}
                  canManage={canManage}
                  run={run}
                  pending={pending}
                  onEdit={() => setEditing(p)}
                />
              ))}
              {filtered.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
                  <p className="text-sm font-semibold text-foreground">No encontramos productos</p>
                  <p className="mt-1 text-xs text-muted">Cambia la búsqueda o el filtro de categoría.</p>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </PageShell>

      {creating ? (
        <ProductModal
          title="Nuevo producto"
          description="Lo verá el asistente al responder qué vendes, cuánto cuesta y si está disponible."
          categories={categories}
          pending={pending}
          onClose={() => setCreating(false)}
          onSubmit={(values) =>
            run(async () => {
              const r = await createProductAction({ clientId, ...values });
              if (r.ok) setCreating(false);
              return r;
            })
          }
        />
      ) : null}

      {editing ? (
        <ProductModal
          title={editing.name}
          description="Nombre, precio, categoría, descripción y disponibilidad."
          categories={categories}
          initial={editing}
          pending={pending}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            run(async () => {
              const r = await updateProductAction(clientId, editing.id, values);
              if (r.ok) setEditing(null);
              return r;
            })
          }
        />
      ) : null}
    </main>
  );
}

function EmptyState({ canManage, onCreate }: { canManage: boolean; onCreate: () => void }) {
  return (
    <div className="flex min-h-72 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface px-4 py-12 text-center">
      <p className="text-sm font-semibold text-foreground">Aún no hay productos</p>
      <p className="mt-1 max-w-sm text-xs text-muted">
        Lo que registres aquí es lo que el asistente puede ofrecer: nombre, precio, descripción y si está
        disponible.
      </p>
      {canManage ? (
        <button type="button" className={`${BTN} mt-4`} onClick={onCreate}>
          + Nuevo producto
        </button>
      ) : null}
    </div>
  );
}

function ProductRow({
  clientId,
  product,
  canManage,
  run,
  pending,
  onEdit,
}: {
  clientId: string;
  product: Product;
  canManage: boolean;
  run: Run;
  pending: boolean;
  onEdit: () => void;
}) {
  const archived = !product.is_active;
  const label = priceLabelCOP(product.price) ?? "—";
  return (
    <article
      className={`flex flex-wrap items-center gap-3 overflow-hidden rounded-xl border border-line px-4 py-3.5 ${
        archived ? "bg-subtle/40" : "bg-surface"
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">{product.name}</h3>
          {product.category ? (
            <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">
              {product.category}
            </span>
          ) : null}
          {archived ? (
            <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">Archivado</span>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted">
          {label}
          {product.description ? ` · ${product.description}` : ""}
        </p>
      </div>

      {/* Availability — inline, one click. Hidden for archived products (they never reach
          the bot). Shown to every viewer; the Setter tier is enforced server-side. */}
      {!archived ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => setProductStockAction(clientId, product.id, !product.in_stock))}
          aria-pressed={product.in_stock}
          className={`inline-flex h-[34px] items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition disabled:opacity-50 ${
            product.in_stock
              ? "border-success/40 bg-success/10 text-success hover:bg-success/15"
              : "border-line bg-subtle text-muted hover:bg-subtle/70"
          }`}
        >
          <span aria-hidden className={`size-2 rounded-full ${product.in_stock ? "bg-success" : "bg-faintest"}`} />
          {product.in_stock ? "Disponible" : "Agotado"}
        </button>
      ) : null}

      {canManage ? (
        archived ? (
          <button
            type="button"
            className={GHOST}
            disabled={pending}
            onClick={() => run(() => restoreProductAction(clientId, product.id))}
          >
            Restaurar
          </button>
        ) : (
          <>
            <button type="button" className={GHOST} onClick={onEdit} aria-haspopup="dialog">
              Editar
            </button>
            <ArchiveButton clientId={clientId} product={product} run={run} pending={pending} />
          </>
        )
      ) : null}
    </article>
  );
}

/** Archive behind an inline confirm — it pulls the product from the bot's offer, so it's
 *  worth one deliberate beat, but it's reversible (Restaurar), so no blocking dialog. */
function ArchiveButton({
  clientId,
  product,
  run,
  pending,
}: {
  clientId: string;
  product: Product;
  run: Run;
  pending: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={GHOST} disabled={pending} onClick={() => setConfirming(true)}>
        Archivar
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-amber-700 dark:text-amber-400">Se deja de ofrecer. Puedes restaurarlo.</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setConfirming(false);
          run(() => archiveProductAction(clientId, product.id));
        }}
        className="rounded border border-amber-500/40 px-2 py-0.5 text-[11px] text-amber-700 transition-colors hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
      >
        Archivar
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded border border-line px-2 py-0.5 text-[11px] transition-colors hover:bg-subtle"
      >
        Cancelar
      </button>
    </div>
  );
}

interface ProductValues {
  name: string;
  price: string;
  category: string | null;
  description: string;
  inStock: boolean;
}

function ProductModal({
  title,
  description,
  categories,
  initial,
  pending,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  categories: string[];
  initial?: Product;
  pending: boolean;
  onClose: () => void;
  onSubmit: (values: ProductValues) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(initial?.price ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [inStock, setInStock] = useState(initial?.in_stock ?? true);

  // Keep `close` STABLE (so useTrappedPanel's focus trap doesn't re-subscribe every render)
  // without reading a ref during render — the latest onClose is stored in an effect.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });

  const priceOk = price.trim() !== "" && Number(price) > 0;
  const submit = () =>
    onSubmit({
      name: name.trim(),
      price: price.trim(),
      category: category.trim() === "" ? null : category.trim(),
      description: desc,
      inStock,
    });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${title}`} className={OVERLAY_SCRIM} onClick={close} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-50 flex max-h-[min(760px,calc(100dvh-2rem))] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:max-w-2xl sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Cerrar"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-lg text-muted transition hover:bg-subtle hover:text-foreground"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nombre">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Óleo para barba" className={`${INPUT} w-full`} />
            </Field>
            <Field label="Precio" hint="Lo que cuesta el producto.">
              <input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="Ej. 35000"
                className={`${INPUT} w-full`}
              />
            </Field>
            <Field label="Categoría" hint="Texto libre, opcional. Ej. «Cuidado de barba».">
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                list="catalog-categories"
                placeholder="Opcional"
                className={`${INPUT} w-full`}
              />
              <datalist id="catalog-categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">Disponibilidad</span>
              <label className="inline-flex h-[44px] items-center gap-2 text-sm text-foreground lg:h-[36px]">
                <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} />
                {inStock ? "Disponible" : "Agotado"}
              </label>
            </label>
          </div>

          <div className="mt-4">
            <label className="mb-1.5 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Descripción <span className="font-normal text-faint">(opcional)</span>
              </span>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                rows={3}
                maxLength={PRODUCT_DESCRIPTION_MAX}
                placeholder="Qué es el producto — lo usa el bot para responder «¿qué es X?». Texto plano, sin formato."
                className="min-h-[4.5rem] w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none transition focus:border-foreground"
              />
            </label>
            <p className="text-right text-[0.6875rem] text-faint">
              {desc.length}/{PRODUCT_DESCRIPTION_MAX}
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-card/50 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={close}
            className="inline-flex h-[44px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle lg:h-[36px]"
          >
            Cancelar
          </button>
          <button className={BTN} disabled={pending || !name.trim() || !priceOk} onClick={submit}>
            {initial ? "Guardar cambios" : "Crear producto"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[0.6875rem] text-faint">{hint}</span> : null}
    </label>
  );
}
