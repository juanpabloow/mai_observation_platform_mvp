"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTrappedPanel } from "@/components/ui/Overlay";
import { apptCategoryClass, serviceCategory } from "@/lib/agendaCategory";
import {
  createServiceAction,
  removeServiceImageAction,
  setSiteServiceAction,
  setStaffServiceAction,
  updateServiceAction,
  updateServicePresentationAction,
  uploadServiceImageAction,
} from "@/lib/schedulingAdminActions";
import { checkIncludes, featuredMissing, INCLUDES_ITEM_MAX, INCLUDES_MAX_ITEMS } from "@/lib/bookingPage";
import { downscaleImage } from "../staff/StaffPhotoControl";
import { runServiceSave, type PersistedService } from "@/lib/serviceSave";
import { SERVICE_DESCRIPTION_MAX } from "@/lib/serviceDescription";
import type { BookingCategory, Service, Site, Staff } from "../AdminPanel";
import { Alert, Button, CARD, CheckRow, ConfirmDialog, Field, INPUT, TEXTAREA, buttonClass, useModalLayer } from "../ui/system";
import { CATEGORY_CHOICES } from "./categories";

/**
 * The SERVICE EDITOR — a wide view (not a cramped modal) with section navigation and
 * persistent Cerrar / Guardar. It edits EVERY real field the catalogue stores, and only
 * those: name, category (= the agenda colour), description, featured, duration, price,
 * prep/clean-up buffers, which professionals perform it, and which sites offer it online.
 *
 * Nothing is saved until Guardar. The save itself is lib/serviceSave.runServiceSave: a
 * create is atomic with its initial sites (createServiceWithSites), and if a later step
 * fails (featured, a site toggle, a professional) the next Guardar RESUMES — it updates
 * the service it already created instead of creating it again. Validation shows beside
 * each field after it is touched or on a save attempt. Closing with unsaved changes asks
 * first, in a confirmation that makes everything behind it inert.
 *
 * Archiving lives on the card menu (it is the existing deactivate — appointments and
 * history are kept). There is no permanent delete: it would orphan that history.
 */

export type Mode = { kind: "edit"; service: Service } | { kind: "new"; category: string | null };

const SECTIONS = [
  { id: "svc-basic", label: "Información básica" },
  { id: "svc-pricing", label: "Precio y duración" },
  { id: "svc-staff", label: "Profesionales" },
  { id: "svc-sites", label: "Sedes y reserva en línea" },
  { id: "svc-page", label: "Página de reservas" },
] as const;

/** How the service is PRESENTED on the public booking page (migration 1804). Saved after
 *  the service itself, by its own action; it never changes the agenda or the bot. */
interface PageForm {
  categoryId: string;
  visible: boolean;
  sort: string;
  recommended: boolean;
  includes: string;
  upgradeId: string;
}

function initialPage(mode: Mode): PageForm {
  const s = mode.kind === "edit" ? mode.service : null;
  return {
    categoryId: s?.public_category_id ?? "",
    visible: s?.public_visible ?? true,
    sort: String(s?.public_sort ?? 0),
    recommended: Boolean(s?.public_recommended),
    includes: (s?.public_includes ?? []).join("\n"),
    upgradeId: s?.public_upgrade_service_id ?? "",
  };
}

export interface FormState {
  name: string;
  category: string;
  description: string;
  featured: boolean;
  duration: string;
  price: string;
  bBefore: string;
  bAfter: string;
  staffIds: string[];
  siteIds: string[];
}

const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

export function validate(f: FormState, mode: Mode): Partial<Record<keyof FormState, string>> {
  const e: Partial<Record<keyof FormState, string>> = {};
  if (!f.name.trim()) e.name = "Escribe el nombre del servicio.";
  else if (f.name.trim().length > 120) e.name = "Máximo 120 caracteres.";
  if (!intIn(f.duration, 1, 1440)) e.duration = "Escribe la duración en minutos (entre 1 y 1440).";
  if (f.price.trim() && !(Number(f.price) >= 0 && Number.isFinite(Number(f.price)))) e.price = "El precio debe ser un número igual o mayor que 0.";
  if (!intIn(f.bBefore || "0", 0, 240)) e.bBefore = "Entre 0 y 240 minutos.";
  if (!intIn(f.bAfter || "0", 0, 240)) e.bAfter = "Entre 0 y 240 minutos.";
  if (f.description.trim().length > SERVICE_DESCRIPTION_MAX) e.description = `Máximo ${SERVICE_DESCRIPTION_MAX} caracteres.`;
  if (mode.kind === "new" && f.siteIds.length === 0) e.siteIds = "Elige al menos una sede donde se pueda reservar.";
  return e;
}

/** The form as the editor opens it — an existing service's stored values, or a new
 *  one's defaults. Shared with the phone editor (mobile/config/ServicesMobile.tsx). */
export function initialForm(mode: Mode, sites: Site[], staff: Staff[], siteServiceMap: Record<string, string[]>): FormState {
  if (mode.kind === "edit") {
    const s = mode.service;
    return {
      name: s.name,
      category: s.category ?? "",
      description: s.description ?? "",
      featured: s.featured,
      duration: String(s.duration_min),
      price: s.price == null ? "" : String(Number(s.price)),
      bBefore: String(s.buffer_before_min),
      bAfter: String(s.buffer_after_min),
      staffIds: staff.filter((p) => p.serviceIds.includes(s.id)).map((p) => p.id),
      siteIds: sites.filter((site) => (siteServiceMap[site.id] ?? []).includes(s.id)).map((site) => site.id),
    };
  }
  return {
    name: "",
    category: mode.category ?? "",
    description: "",
    featured: false,
    duration: "60",
    price: "",
    bBefore: "0",
    bAfter: "0",
    staffIds: [],
    siteIds: sites.map((s) => s.id),
  };
}

/** The save itself — runServiceSave over the real server actions. `persisted` is what the
 *  server holds and is advanced in place, so a retry resumes instead of repeating. Shared
 *  by the desktop and phone editors so there is exactly one save path. */
export async function saveServiceForm(clientId: string, persisted: PersistedService, form: FormState, sites: Site[], staff: Staff[]) {
  const out = await runServiceSave(
    persisted,
    {
      fields: {
        name: form.name.trim(),
        description: form.description.trim(),
        durationMin: Number(form.duration),
        price: form.price.trim() === "" ? null : Number(form.price),
        bufferBeforeMin: Number(form.bBefore || 0),
        bufferAfterMin: Number(form.bAfter || 0),
        category: form.category === "" ? null : form.category,
      },
      featured: form.featured,
      siteIds: form.siteIds,
      staffIds: form.staffIds,
      allSiteIds: sites.map((s) => s.id),
      allStaffIds: staff.map((p) => p.id),
    },
    {
      create: (fields, siteIds) => createServiceAction({ clientId, ...fields, siteIds }),
      update: (id, patch) => updateServiceAction(clientId, id, patch),
      setSite: (siteId, serviceId, on) => setSiteServiceAction(clientId, siteId, serviceId, on),
      setStaff: (staffId, serviceId, on) => setStaffServiceAction(clientId, staffId, serviceId, on),
    },
  );
  return out;
}

export function ServiceEditor({
  clientId,
  mode,
  sites,
  staff,
  siteServiceMap,
  bookingCategories = [],
  allServices = [],
  onClose,
  onSaved,
}: {
  clientId: string;
  mode: Mode;
  /** Active sites of this client. */
  sites: Site[];
  /** Active professionals of this client. */
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  /** The business's booking-page categories. */
  bookingCategories?: BookingCategory[];
  /** Active services of this client, for "Alternativa superior". */
  allServices?: Service[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const initial = useMemo<FormState>(() => initialForm(mode, sites, staff, siteServiceMap), [mode, sites, staff, siteServiceMap]);
  const initialPageForm = useMemo(() => initialPage(mode), [mode]);
  // The image uploads at once, so it needs a saved service: an existing one (a new service
  // gets its image after the first Guardar, when the editor reopens it).
  const editId = mode.kind === "edit" ? mode.service.id : null;
  const [page, setPage] = useState<PageForm>(initialPageForm);
  const [image, setImage] = useState<string | null>(mode.kind === "edit" ? (mode.service.public_image_url ?? null) : null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(initial);
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  // What the SERVER holds right now (see runServiceSave).
  const persisted = useRef<PersistedService>({
    id: mode.kind === "edit" ? mode.service.id : null,
    siteIds: initial.siteIds,
    staffIds: initial.staffIds,
  });
  const wrote = useRef(false);
  // Leaving after a partial save still refreshes the list, so what was written shows.
  const leave = () => (wrote.current ? onSaved() : onClose());

  const errors = validate(form, mode);
  const includesCheck = checkIncludes(page.includes);
  const pageError = !includesCheck.ok ? includesCheck.error : !/^\d{1,3}$/.test(page.sort.trim()) ? "El orden debe ser un número entre 0 y 999." : null;
  const show = (k: keyof FormState) => ((attempted || touched[k]) && errors[k]) || "";
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || JSON.stringify(page) !== JSON.stringify(initialPageForm);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k: keyof FormState) => () => setTouched((t) => ({ ...t, [k]: true }));
  const toggle = (k: "staffIds" | "siteIds", id: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] }));

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty) setConfirmClose(true);
    else if (wrote.current) onSaved();
    else onClose();
  }, [dirty, onClose, onSaved, saving]);
  const latest = useRef({ confirmClose, requestClose });
  useEffect(() => {
    latest.current = { confirmClose, requestClose };
  });
  // Escape peels the confirmation first, then asks to close the editor.
  const onEscape = useCallback(() => {
    if (latest.current.confirmClose) setConfirmClose(false);
    else latest.current.requestClose();
  }, []);
  const panelRef = useTrappedPanel({ active: true, onClose: onEscape });
  const discard = useModalLayer(confirmClose, panelRef as RefObject<HTMLElement | null>);

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0 || pageError) {
      setError(pageError ?? "Revisa los campos marcados.");
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveServiceForm(clientId, persisted.current, form, sites, staff);
    if (out.ok && persisted.current.id && JSON.stringify(page) !== JSON.stringify(initialPageForm)) {
      const pr = await updateServicePresentationAction(clientId, persisted.current.id, {
        categoryId: page.categoryId || null,
        visible: page.visible,
        sort: page.sort.trim(),
        recommended: page.recommended,
        includes: page.includes,
        upgradeServiceId: page.upgradeId || null,
      });
      setSaving(false);
      if (pr.ok) return onSaved();
      wrote.current = true;
      setError(`El servicio se guardó, pero no su presentación en la página. ${pr.error} Pulsa Guardar para reintentar.`);
      return;
    }
    setSaving(false);
    if (out.ok) return onSaved();
    if (out.partial) wrote.current = true;
    // Say so when part of it IS saved: Guardar again finishes the rest, it does not repeat it.
    setError(wrote.current ? `Parte de los cambios ya se guardó. ${out.error} Pulsa Guardar para completar el resto.` : out.error);
  };

  const jump = (id: string) => bodyRef.current?.querySelector(`#${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const family = serviceCategory(form.name || "servicio", form.category || null);
  const title = mode.kind === "edit" ? mode.service.name : "Nuevo servicio";
  const staffBySite = sites.map((site) => ({ site, people: staff.filter((p) => p.site_id === site.id) })).filter((g) => g.people.length > 0);

  return (
    <div
      ref={panelRef as RefObject<HTMLDivElement>}
      role="dialog"
      aria-modal="true"
      aria-labelledby="svc-editor-title"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
    >
      <header
        inert={discard.inert}
        className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:gap-3 sm:px-6"
      >
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted">{mode.kind === "edit" ? "Editar servicio" : "Añadir servicio"}</p>
          <h2 id="svc-editor-title" className="truncate text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <Button onClick={requestClose} disabled={saving}>
          Cerrar
        </Button>
        <Button variant="primary" onClick={save} loading={saving} loadingLabel="Guardando…">
          Guardar
        </Button>
      </header>

      <div inert={discard.inert} className="mx-auto grid min-h-0 w-full max-w-5xl flex-1 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8 lg:px-6">
        <nav aria-label="Secciones del servicio" className="hidden flex-col gap-1 py-6 lg:flex">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => jump(s.id)} className={buttonClass({ variant: "tertiary", size: "sm", className: "justify-start" })}>
              {s.label}
            </button>
          ))}
        </nav>

        <div ref={bodyRef} className="min-h-0 overflow-y-auto px-4 py-5 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:px-6 lg:px-0 lg:py-6">
          {error ? (
            <div className="mb-4">
              <Alert>{error}</Alert>
            </div>
          ) : null}

          <div className="flex flex-col gap-5">
            <Section id="svc-basic" title="Información básica">
              <Field label="Nombre" error={show("name")}>
                <input value={form.name} onChange={(e) => set("name", e.target.value)} onBlur={touch("name")} maxLength={160} placeholder="Ej. Corte clásico" aria-invalid={Boolean(show("name"))} className={INPUT} />
              </Field>
              <Field label="Categoría" hint="Define el color de la cita en la agenda.">
                <span className="flex items-center gap-2.5">
                  <span aria-hidden className={`u-appt-service ${apptCategoryClass(family)} size-[44px] shrink-0 rounded-sch-control border border-[var(--appt-edge)] bg-[var(--appt-fill)] lg:size-[40px]`} />
                  <select value={form.category} onChange={(e) => set("category", e.target.value)} className={INPUT}>
                    {CATEGORY_CHOICES.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </span>
              </Field>
              <Field label="Descripción" optional hint="Se muestra en la reserva en línea." error={show("description")}>
                <textarea
                  value={form.description}
                  onChange={(e) => set("description", e.target.value)}
                  onBlur={touch("description")}
                  rows={3}
                  maxLength={SERVICE_DESCRIPTION_MAX}
                  aria-invalid={Boolean(show("description"))}
                  className={TEXTAREA}
                />
              </Field>
              <CheckRow checked={form.featured} onChange={() => set("featured", !form.featured)} hint="Se ofrece primero cuando el cliente no especifica un servicio.">
                Destacado
              </CheckRow>
            </Section>

            <Section id="svc-pricing" title="Precio y duración">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Duración (min)" error={show("duration")}>
                  <input inputMode="numeric" value={form.duration} onChange={(e) => set("duration", e.target.value)} onBlur={touch("duration")} aria-invalid={Boolean(show("duration"))} className={INPUT} />
                </Field>
                <Field label="Precio" optional hint="Vacío = precio a consultar." error={show("price")}>
                  <input inputMode="decimal" value={form.price} onChange={(e) => set("price", e.target.value)} onBlur={touch("price")} aria-invalid={Boolean(show("price"))} className={INPUT} />
                </Field>
                <Field label="Preparación antes (min)" error={show("bBefore")}>
                  <input inputMode="numeric" value={form.bBefore} onChange={(e) => set("bBefore", e.target.value)} onBlur={touch("bBefore")} aria-invalid={Boolean(show("bBefore"))} className={INPUT} />
                </Field>
                <Field label="Tiempo después (min)" error={show("bAfter")}>
                  <input inputMode="numeric" value={form.bAfter} onChange={(e) => set("bAfter", e.target.value)} onBlur={touch("bAfter")} aria-invalid={Boolean(show("bAfter"))} className={INPUT} />
                </Field>
              </div>
            </Section>

            <Section id="svc-staff" title="Profesionales" subtitle="Quién puede prestar este servicio.">
              {staffBySite.length === 0 ? (
                <p className="text-sm text-muted">No hay profesionales activos todavía.</p>
              ) : (
                staffBySite.map(({ site, people }) => (
                  <div key={site.id} className="flex flex-col gap-0.5">
                    {sites.length > 1 ? <p className="px-2 text-xs font-medium text-muted">{site.name}</p> : null}
                    {people.map((p) => (
                      <CheckRow key={p.id} checked={form.staffIds.includes(p.id)} onChange={() => toggle("staffIds", p.id)}>
                        {p.name}
                      </CheckRow>
                    ))}
                  </div>
                ))
              )}
            </Section>

            <PageSection
              clientId={clientId}
              serviceId={editId}
              page={page}
              setPage={setPage}
              categories={bookingCategories}
              others={allServices.filter((x) => x.id !== editId)}
              image={image}
              setImage={setImage}
              imageBusy={imageBusy}
              setImageBusy={setImageBusy}
              imageError={imageError}
              setImageError={setImageError}
              form={form}
              error={pageError && attempted ? pageError : null}
            />

            <Section id="svc-sites" title="Sedes y reserva en línea" subtitle="Dónde se puede reservar este servicio (agenda interna, agente y página pública)." error={show("siteIds")}>
              {sites.length === 0 ? (
                <p className="text-sm text-muted">No hay sedes activas.</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {sites.map((site) => (
                    <CheckRow key={site.id} checked={form.siteIds.includes(site.id)} onChange={() => toggle("siteIds", site.id)}>
                      {site.name}
                    </CheckRow>
                  ))}
                </div>
              )}
            </Section>
          </div>
        </div>
      </div>

      {confirmClose ? (
        <ConfirmDialog
          layerRef={discard.layerRef}
          id="svc-discard"
          title="¿Descartar los cambios?"
          body="Hay cambios sin guardar en este servicio."
          cancelLabel="Seguir editando"
          confirmLabel="Descartar"
          onCancel={() => setConfirmClose(false)}
          onConfirm={leave}
        />
      ) : null}
    </div>
  );
}

function Section({ id, title, subtitle, error, children }: { id: string; title: string; subtitle?: string; error?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-4 p-4 sm:p-5 ${CARD}`}>
      <h3 id={`${id}-title`} className="text-[15px] font-semibold">
        {title}
      </h3>
      {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** "Página de reservas": group, visibility, order, badge, image, "Qué incluye" and the
 *  explicit better alternative. The image uploads at once (existing services only); the
 *  rest is saved with Guardar. */
function PageSection({
  clientId,
  serviceId,
  page,
  setPage,
  categories,
  others,
  image,
  setImage,
  imageBusy,
  setImageBusy,
  imageError,
  setImageError,
  form,
  error,
}: {
  clientId: string;
  serviceId: string | null;
  page: PageForm;
  setPage: (p: PageForm) => void;
  categories: BookingCategory[];
  others: Service[];
  image: string | null;
  setImage: (url: string | null) => void;
  imageBusy: boolean;
  setImageBusy: (b: boolean) => void;
  imageError: string | null;
  setImageError: (e: string | null) => void;
  form: FormState;
  error: string | null;
}) {
  const cat = categories.find((c) => c.id === page.categoryId) ?? null;
  const includes = checkIncludes(page.includes);
  const missing =
    cat?.layout === "featured"
      ? featuredMissing({
          image_url: image,
          description: form.description,
          includes: includes.ok ? (includes.value ?? []) : [],
          price: form.price.trim() === "" ? null : form.price,
          duration_min: Number(form.duration),
        })
      : [];
  const target = others.find((o) => o.id === page.upgradeId) ?? null;
  const delta = target && target.price != null && form.price.trim() !== "" ? Number(target.price) - Number(form.price) : null;

  const upload = async (file: File | undefined) => {
    if (!file || !serviceId) return;
    setImageError(null);
    setImageBusy(true);
    try {
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("serviceId", serviceId);
      fd.set("image", await downscaleImage(file));
      const r = await uploadServiceImageAction(fd);
      if (r.ok) setImage(r.url ?? null);
      else setImageError(r.error);
    } catch {
      setImageError("No pudimos subir la imagen. Inténtalo de nuevo.");
    } finally {
      setImageBusy(false);
    }
  };
  const remove = async () => {
    if (!serviceId) return;
    setImageBusy(true);
    const r = await removeServiceImageAction(clientId, serviceId);
    setImageBusy(false);
    if (r.ok) setImage(null);
    else setImageError(r.error);
  };

  return (
    <Section id="svc-page" title="Página de reservas" subtitle="Cómo se presenta en la página pública. No cambia la agenda ni el agente." error={error ?? undefined}>
      <CheckRow checked={page.visible} onChange={() => setPage({ ...page, visible: !page.visible })} hint="Si lo ocultas, sigue disponible en la agenda y para el agente.">
        Visible en la página de reservas
      </CheckRow>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field label="Categoría en la página" hint={categories.length === 0 ? "Crea categorías en «Página de reservas · Categorías»." : undefined}>
          <select value={page.categoryId} onChange={(e) => setPage({ ...page, categoryId: e.target.value })} className={INPUT}>
            <option value="">Sin categoría (Otros servicios)</option>
            {categories
              .filter((c) => c.layout !== "contact")
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.visible ? "" : " (oculta)"}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Orden">
          <input inputMode="numeric" value={page.sort} onChange={(e) => setPage({ ...page, sort: e.target.value })} className={INPUT} />
        </Field>
      </div>
      {missing.length > 0 ? (
        <Alert>
          No se mostrará en «{cat?.name}» hasta que tenga: {missing.join(", ")}.
        </Alert>
      ) : null}
      <CheckRow checked={page.recommended} onChange={() => setPage({ ...page, recommended: !page.recommended })} hint="Muestra la etiqueta «Recomendado» en la tarjeta.">
        Recomendado
      </CheckRow>
      <Field label="Qué incluye" optional hint={`Una línea por punto · máximo ${INCLUDES_MAX_ITEMS} líneas de ${INCLUDES_ITEM_MAX} caracteres. Solo contenido aprobado.`}>
        <textarea value={page.includes} onChange={(e) => setPage({ ...page, includes: e.target.value })} rows={4} className={TEXTAREA} />
      </Field>
      <Field
        label="Alternativa superior"
        optional
        hint={
          target
            ? delta != null && delta > 0
              ? `La página dirá: «Pásate a ${target.name} por $${delta.toLocaleString("es-CO")} más».`
              : "No se mostrará: la alternativa debe costar más que este servicio."
            : "Se ofrece al elegir este servicio, con la diferencia real de precio."
        }
      >
        <select value={page.upgradeId} onChange={(e) => setPage({ ...page, upgradeId: e.target.value })} className={INPUT}>
          <option value="">Ninguna</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Imagen" optional hint={serviceId ? "PNG, JPEG o WebP. Se guarda al subirla." : "Guarda el servicio para poder subir su imagen."}>
        <span className="flex flex-wrap items-center gap-3">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded image (R2)
            <img src={image} alt="" className="h-16 w-28 rounded-sch-control border border-line object-cover" />
          ) : null}
          <label className={buttonClass({ className: serviceId && !imageBusy ? "cursor-pointer" : "pointer-events-none opacity-60" })}>
            {imageBusy ? "Subiendo…" : image ? "Cambiar imagen" : "Subir imagen"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!serviceId || imageBusy}
              className="sr-only"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          {image && serviceId ? (
            <Button size="sm" variant="tertiary" onClick={() => void remove()} disabled={imageBusy}>
              Quitar
            </Button>
          ) : null}
        </span>
      </Field>
      {imageError ? <Alert>{imageError}</Alert> : null}
    </Section>
  );
}
