"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  createServiceAction,
  removeServiceImageAction,
  serviceUpcomingAvailabilityAction,
  setSiteServiceAction,
  setStaffServiceAction,
  updateServiceAction,
  updateServicePresentationAction,
  uploadServiceImageAction,
} from "@/lib/schedulingAdminActions";
import { checkIncludes, INCLUDES_ITEM_MAX, INCLUDES_MAX_ITEMS, servicePageDiagnosis, type FixArea, type PageDiagnosis } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { downscaleImage } from "../staff/StaffPhotoControl";
import { runServiceSave, type PersistedService } from "@/lib/serviceSave";
import { SERVICE_DESCRIPTION_MAX } from "@/lib/serviceDescription";
import type { BookingCategory, Service, Site, Staff } from "../AdminPanel";
import { Alert, Avatar, Button, Field, INPUT, TEXTAREA, buttonClass, segmentClass, segmentShell } from "../ui/system";
import { CATEGORY_CHOICES, categoryDot } from "./categories";
import { EditorFrame, EditorHeader, EditorSection, ErrorSummary, MetaChip, SaveBar, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { AffixInput, CheckItem, CheckList, ChoiceChips, FieldGroup, Notice, ToggleRow } from "@/components/ui/module/FormKit";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { scrollWithin } from "@/components/ui/module/scrollWithin";

/**
 * The SERVICE EDITOR — edited IN the Servicios surface (not a cramped modal, not a side
 * panel), with the section index on the left and persistent Cancelar / Guardar
 * (components/ui/module/Editor). It edits EVERY real field the catalogue stores, and only
 * those: name, category (= the agenda colour), description, featured, duration, price,
 * prep/clean-up buffers, which professionals perform it, and which sites offer it online.
 *
 * Nothing is saved until Guardar. The save itself is lib/serviceSave.runServiceSave: a
 * create is atomic with its initial sites (createServiceWithSites), and if a later step
 * fails (featured, a site toggle, a professional) the next Guardar RESUMES — it updates
 * the service it already created instead of creating it again. Validation shows beside
 * each field after it is touched or on a save attempt, with a linked summary on top.
 * Leaving with unsaved changes — Cancelar, ‹, Escape, Back, a sidebar link — asks first
 * (useEditorGuard).
 *
 * Archiving lives on the card menu (it is the existing deactivate — appointments and
 * history are kept). There is no permanent delete: it would orphan that history.
 */

export type Mode = { kind: "edit"; service: Service } | { kind: "new"; category: string | null };

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

/** The phone editor's presets, shared so both editors offer the same durations. */
const DURATIONS = [15, 30, 45, 60, 75, 90, 120];

export function ServiceEditor({
  clientId,
  mode,
  sites,
  staff,
  siteServiceMap,
  bookingCategories = [],
  allServices = [],
  initialSection,
  backLabel = "Volver",
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
  /** Open scrolled to one section — «Orden y presentación» opens on «Página de reservas». */
  initialSection?: "basic" | "pricing" | "staff" | "sites" | "page";
  /** Accessible name of the ‹ back control ("Volver a Servicios"). */
  backLabel?: string;
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
  // «Precio fijo» vs «A consultar», explicit (as on the phone): an empty price is NOT the
  // same as 0. «A consultar» stores NULL; a fixed price of 0 stores 0 and reads «$0».
  const [priceMode, setPriceMode] = useState<"fijo" | "consultar">(initial.price === "" ? "consultar" : "fijo");
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // What the SERVER holds right now (see runServiceSave).
  const persisted = useRef<PersistedService>({
    id: mode.kind === "edit" ? mode.service.id : null,
    siteIds: initial.siteIds,
    staffIds: initial.staffIds,
  });
  const wrote = useRef(false);
  const savedAll = useRef(false);

  const effective: FormState = { ...form, price: priceMode === "consultar" ? "" : form.price };
  const errors = validate(effective, mode);
  if (priceMode === "fijo" && !form.price.trim()) errors.price = "Escribe el precio o elige «A consultar».";
  const includesCheck = checkIncludes(page.includes);
  const pageError = !includesCheck.ok ? includesCheck.error : !/^\d{1,3}$/.test(page.sort.trim()) ? "El orden debe ser un número entre 0 y 999." : null;
  const show = (k: keyof FormState) => ((attempted || touched[k]) && errors[k]) || "";
  const changes = countChanges(initial, effective) + countChanges(initialPageForm, page);
  const dirty = changes > 0;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const touch = (k: keyof FormState) => () => setTouched((t) => ({ ...t, [k]: true }));
  const toggle = (k: "staffIds" | "siteIds", id: string) =>
    setForm((f) => ({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] }));

  // Leaving after a partial save still refreshes the list, so what was written shows.
  const guard = useEditorGuard({ dirty: dirty && !saving, onLeave: () => (savedAll.current || wrote.current ? onSaved() : onClose()) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0 || pageError) {
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveServiceForm(clientId, persisted.current, effective, sites, staff);
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
      if (pr.ok) {
        savedAll.current = true;
        return guard.leave();
      }
      wrote.current = true;
      setError(`El servicio se guardó, pero no su presentación en la página. ${pr.error} Pulsa Guardar para reintentar.`);
      return;
    }
    setSaving(false);
    if (out.ok) {
      savedAll.current = true;
      return guard.leave();
    }
    if (out.partial) wrote.current = true;
    // Say so when part of it IS saved: Guardar again finishes the rest, it does not repeat it.
    setError(wrote.current ? `Parte de los cambios ya se guardó. ${out.error} Pulsa Guardar para completar el resto.` : out.error);
  };

  const jump = (id: string) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`#${id}`);
    if (el) scrollWithin(el);
  };
  useEffect(() => {
    const target = initialSection ? bodyRef.current?.querySelector<HTMLElement>(`#svc-${initialSection}`) : null;
    if (target) scrollWithin(target, { smooth: false });
    document.getElementById("svc-editor-title")?.focus({ preventScroll: true });
  }, [initialSection]);
  // Would it appear on the booking page with what is on screen now? Same rules as the server.
  const includesNow = checkIncludes(page.includes);
  const diagnosis = servicePageDiagnosis({
    service: {
      active: mode.kind === "edit" ? mode.service.active : true,
      visible: page.visible,
      description: form.description.trim() || null,
      includes: includesNow.ok ? (includesNow.value ?? []) : [],
      imageUrl: image,
      price: effective.price.trim() === "" ? null : effective.price.trim(),
      durationMin: Number(form.duration),
    },
    category: (() => {
      const c = bookingCategories.find((x) => x.id === page.categoryId);
      return c ? { name: c.name, visible: c.visible, layout: c.layout } : null;
    })(),
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      active: site.active,
      enabled: form.siteIds.includes(site.id),
      artists: staff
        .filter((p) => p.site_id === site.id)
        .map((p) => ({ name: p.name, active: p.active, takesBookings: p.takes_bookings !== false, performs: form.staffIds.includes(p.id) })),
    })),
  });
  const title = mode.kind === "edit" ? mode.service.name : "Nuevo servicio";
  const staffBySite = sites.map((site) => ({ site, people: staff.filter((p) => p.site_id === site.id) })).filter((g) => g.people.length > 0);
  const catLabel = CATEGORY_CHOICES.find((c) => c.value === form.category)?.label ?? "Sin categoría";
  const priceText = priceMode === "consultar" ? "A consultar" : (form.price.trim() && priceLabelCOP(form.price.trim())) || "Sin precio";
  const archived = mode.kind === "edit" && !mode.service.active;

  // Which sections hold changes / errors — the index marks them.
  const differs = (keys: (keyof FormState)[]) => keys.some((k) => JSON.stringify(initial[k]) !== JSON.stringify(effective[k]));
  const errIn = (keys: (keyof FormState)[]) => (attempted ? keys.filter((k) => errors[k]).length : 0);
  const sectionMeta = [
    { id: "svc-basic", label: "Información básica", dirty: differs(["name", "category", "description", "featured"]), errors: errIn(["name", "description"]) },
    { id: "svc-pricing", label: "Precio y duración", dirty: differs(["duration", "price", "bBefore", "bAfter"]), errors: errIn(["duration", "price", "bBefore", "bAfter"]) },
    { id: "svc-staff", label: "Profesionales", dirty: differs(["staffIds"]) },
    { id: "svc-sites", label: "Sedes", dirty: differs(["siteIds"]), errors: errIn(["siteIds"]) },
    { id: "svc-page", label: "Página de reservas", dirty: countChanges(initialPageForm, page) > 0, errors: attempted && pageError ? 1 : 0 },
  ];
  const FIELD_TARGET: Partial<Record<keyof FormState, string>> = {
    name: "svc-f-name",
    description: "svc-f-description",
    duration: "svc-f-duration",
    price: "svc-f-price",
    bBefore: "svc-f-bbefore",
    bAfter: "svc-f-bafter",
    siteIds: "svc-sites-h",
  };
  const summary: SummaryError[] = attempted
    ? [
        ...(Object.keys(errors) as (keyof FormState)[]).map((k) => ({ target: FIELD_TARGET[k] ?? "svc-basic-h", message: `${FIELD_NAME[k]}: ${errors[k]}` })),
        ...(pageError ? [{ target: "svc-page-h", message: `Página de reservas: ${pageError}` }] : []),
      ]
    : [];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        if ((e.target as HTMLElement).closest("select, [role=menu]")) return;
        e.preventDefault();
        requestClose();
      }}
    >
      <EditorHeader
        title={title}
        headingId="svc-editor-title"
        eyebrow={mode.kind === "edit" ? (archived ? "Servicio archivado" : "Editar servicio") : "Catálogo · Servicios"}
        chips={
          <>
            <MetaChip dot={categoryDot(form.category)}>{catLabel}</MetaChip>
            <MetaChip>{form.duration.trim() ? `${form.duration.trim()} min` : "Sin duración"}</MetaChip>
            <MetaChip>{priceText}</MetaChip>
            <MetaChip>{`${form.staffIds.length} profesional${form.staffIds.length === 1 ? "" : "es"}`}</MetaChip>
          </>
        }
        backLabel={backLabel}
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={mode.kind === "new" ? "Crear servicio" : "Guardar cambios"}
        saving={saving}
        canSave={mode.kind === "new" ? true : dirty}
      />
      <EditorFrame
        sections={sectionMeta}
        bodyRef={bodyRef}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={mode.kind === "new" ? "Crear" : "Guardar"} canSave={mode.kind === "new" ? true : dirty} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        {archived ? (
          <div className="mb-2">
            <Notice>Este servicio está archivado: no se puede reservar. Puedes editarlo y reactivarlo desde el menú ⋯ del listado.</Notice>
          </div>
        ) : null}

        <EditorSection id="svc-basic" title="Información básica" summary={`${form.name || "Sin nombre"} · ${catLabel}`}>
          <Field label="Nombre" error={show("name")}>
            <input id="svc-f-name" value={form.name} onChange={(e) => set("name", e.target.value)} onBlur={touch("name")} maxLength={160} placeholder="Ej. Corte clásico" aria-invalid={Boolean(show("name"))} className={INPUT} />
          </Field>
          <FieldGroup legend="Categoría" hint="Define el color automático de sus citas en la agenda. No es la agrupación de la página de reservas.">
            <ChoiceChips
              name="svc-category"
              value={form.category}
              options={CATEGORY_CHOICES.map((c) => ({ value: c.value, label: c.label, dot: categoryDot(c.value) }))}
              onChange={(v) => set("category", v)}
            />
          </FieldGroup>
          <Field label="Descripción" optional hint="Se muestra en la reserva en línea." error={show("description")}>
            <textarea
              id="svc-f-description"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              onBlur={touch("description")}
              rows={3}
              maxLength={SERVICE_DESCRIPTION_MAX}
              aria-invalid={Boolean(show("description"))}
              className={TEXTAREA}
            />
          </Field>
          <ToggleRow checked={form.featured} onChange={(v) => set("featured", v)} label="Destacado" hint="Se ofrece primero cuando el cliente no especifica un servicio." />
        </EditorSection>

        <EditorSection id="svc-pricing" title="Precio y duración" summary={`${form.duration || "—"} min · ${priceText}`}>
          <FieldGroup legend="Duración" error={show("duration")}>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={form.duration === String(m)}
                  onClick={() => set("duration", String(m))}
                  className={`u-focus inline-flex h-[44px] items-center rounded-sch-control border px-3 text-[0.8125rem] font-medium tabular-nums transition-colors lg:h-[2.125rem] ${
                    form.duration === String(m) ? "border-ink bg-ink text-ink-fg" : "border-line-strong bg-surface text-foreground hover:bg-subtle"
                  }`}
                >
                  {m} min
                </button>
              ))}
            </div>
            <label className="mt-1 flex max-w-[16rem] flex-col gap-1">
              <span className="text-xs text-muted">Otra duración</span>
              <AffixInput id="svc-f-duration" inputMode="numeric" value={form.duration} onChange={(e) => set("duration", e.target.value)} onBlur={touch("duration")} aria-invalid={Boolean(show("duration"))} suffix="minutos" />
            </label>
          </FieldGroup>
          <FieldGroup
            legend="Precio"
            error={show("price")}
            hint={priceMode === "consultar" ? "Se muestra «A consultar» en la reserva y en la agenda." : "Un precio de 0 se muestra como $0, no como «A consultar»."}
          >
            <div role="radiogroup" aria-label="Tipo de precio" className={segmentShell()}>
              {(
                [
                  ["fijo", "Precio fijo"],
                  ["consultar", "A consultar"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={priceMode === k} onClick={() => setPriceMode(k)} className={segmentClass(priceMode === k)}>
                  {label}
                </button>
              ))}
            </div>
            {priceMode === "fijo" ? (
              <AffixInput
                id="svc-f-price"
                aria-label="Precio"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
                onBlur={touch("price")}
                aria-invalid={Boolean(show("price"))}
                prefix="$"
                suffix="COP"
                className="mt-1 max-w-[16rem]"
              />
            ) : null}
          </FieldGroup>
          <div className="grid max-w-[34rem] gap-4 sm:grid-cols-2">
            <Field label="Preparación antes" error={show("bBefore")}>
              <AffixInput id="svc-f-bbefore" inputMode="numeric" value={form.bBefore} onChange={(e) => set("bBefore", e.target.value)} onBlur={touch("bBefore")} aria-invalid={Boolean(show("bBefore"))} suffix="min" />
            </Field>
            <Field label="Tiempo después" error={show("bAfter")}>
              <AffixInput id="svc-f-bafter" inputMode="numeric" value={form.bAfter} onChange={(e) => set("bAfter", e.target.value)} onBlur={touch("bAfter")} aria-invalid={Boolean(show("bAfter"))} suffix="min" />
            </Field>
          </div>
          <p className="-mt-2 text-xs text-muted">Ocupan la agenda del profesional antes y después de la cita.</p>
        </EditorSection>

        <EditorSection
          id="svc-staff"
          title="Profesionales"
          description="Solo quienes estén marcados podrán recibir reservas de este servicio."
          summary={`${form.staffIds.length} de ${staff.length} profesional${staff.length === 1 ? "" : "es"}`}
          defaultOpen={false}
        >
          {staffBySite.length === 0 ? (
            <p className="text-sm text-muted">No hay profesionales activos todavía.</p>
          ) : (
            staffBySite.map(({ site, people }) => (
              <div key={site.id} className="flex flex-col gap-1.5">
                {sites.length > 1 ? <p className="text-xs font-medium text-muted">{site.name}</p> : null}
                <CheckList>
                  {people.map((p) => (
                    <CheckItem
                      key={p.id}
                      checked={form.staffIds.includes(p.id)}
                      onChange={() => toggle("staffIds", p.id)}
                      leading={<Avatar name={p.name} size="sm" />}
                      hint={p.takes_bookings === false ? "No recibe reservas en este momento (se cambia en Agenda → Equipo)." : undefined}
                    >
                      {p.name}
                    </CheckItem>
                  ))}
                </CheckList>
              </div>
            ))
          )}
        </EditorSection>

        <EditorSection
          id="svc-sites"
          title="Sedes"
          description="Dónde se puede reservar este servicio (agenda interna, agente y página pública)."
          summary={sites.length === 1 ? (form.siteIds.length ? `Se reserva en ${sites[0].name}` : "No se reserva en ninguna sede") : `${form.siteIds.length} de ${sites.length} sedes`}
          error={show("siteIds")}
          defaultOpen={false}
        >
          {sites.length === 0 ? (
            <p className="text-sm text-muted">No hay sedes activas.</p>
          ) : sites.length === 1 ? (
            <>
              <CheckList>
                <CheckItem checked={form.siteIds.includes(sites[0].id)} onChange={() => toggle("siteIds", sites[0].id)}>
                  Se puede reservar en {sites[0].name}
                </CheckItem>
              </CheckList>
              {!form.siteIds.includes(sites[0].id) && mode.kind === "edit" && initial.siteIds.includes(sites[0].id) ? (
                <Notice tone="warn">Al guardar, dejará de poder reservarse: es la única sede. Sus citas se conservan.</Notice>
              ) : null}
            </>
          ) : (
            <CheckList>
              {sites.map((site) => (
                <CheckItem key={site.id} checked={form.siteIds.includes(site.id)} onChange={() => toggle("siteIds", site.id)}>
                  {site.name}
                </CheckItem>
              ))}
            </CheckList>
          )}
        </EditorSection>

        <PageSection
          diagnosis={diagnosis}
          dirty={dirty}
          onJump={(area) => (area === "categories" || area === "team" ? undefined : jump(AREA_SECTION[area]))}
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
          price={effective.price}
          error={pageError && attempted ? pageError : null}
        />
      </EditorFrame>

      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en este servicio. Si sales ahora, se pierden." /> : null}
    </div>
  );
}

const FIELD_NAME: Record<keyof FormState, string> = {
  name: "Nombre",
  category: "Categoría",
  description: "Descripción",
  featured: "Destacado",
  duration: "Duración",
  price: "Precio",
  bBefore: "Preparación antes",
  bAfter: "Tiempo después",
  staffIds: "Profesionales",
  siteIds: "Sedes",
};

function Section({ id, title, subtitle, error, defaultOpen = false, children }: { id: string; title: string; subtitle?: string; error?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <EditorSection id={id} title={title} description={subtitle} error={error} defaultOpen={defaultOpen}>
      {children}
    </EditorSection>
  );
}

const AREA_SECTION: Record<Exclude<FixArea, "categories" | "team">, string> = {
  basic: "svc-basic",
  pricing: "svc-pricing",
  page: "svc-page",
  staff: "svc-staff",
  sites: "svc-sites",
};
const AREA_LABEL: Record<FixArea, string> = {
  basic: "Ir a Información básica",
  pricing: "Ir a Precio y duración",
  page: "Ir a la sección",
  staff: "Ir a Profesionales",
  sites: "Ir a Sedes",
  categories: "Se cambia en Página de reservas → «Categorías»",
  team: "Se cambia en Agenda → Equipo («Recibe reservas»)",
};

/** "¿Aparece en la página?" — the server's rules applied to what is on screen. Separately,
 *  "¿Tiene horarios?" asks the real engine (no free time is not a configuration error). */
function PageDiagnosisBox({ clientId, serviceId, diagnosis: d, dirty, onJump }: { clientId: string; serviceId: string | null; diagnosis: PageDiagnosis; dirty: boolean; onJump: (area: FixArea) => void }) {
  const [upcoming, setUpcoming] = useState<{ state: "idle" | "loading" | "done" | "error"; sites: Array<{ name: string; firstDay: string | null }> }>({ state: "idle", sites: [] });
  const check = async () => {
    if (!serviceId) return;
    setUpcoming({ state: "loading", sites: [] });
    const r = await serviceUpcomingAvailabilityAction(clientId, serviceId);
    setUpcoming(r.ok ? { state: "done", sites: r.sites } : { state: "error", sites: [] });
  };
  const head =
    d.status === "visible"
      ? `Aparece en la página de reservas${d.sites.filter((x) => x.listed).length ? ` de ${d.sites.filter((x) => x.listed).map((x) => x.name).join(", ")}` : ""}.`
      : d.status === "hidden"
        ? "No aparece en la página: está oculto por configuración."
        : "No aparece en la página: falta un requisito.";
  const tone = d.status === "visible" ? "border-success/40 bg-success/5" : d.status === "hidden" ? "border-line bg-subtle" : "border-warn-rule bg-warn-soft";
  return (
    <div role="status" aria-live="polite" className={`rounded-sch-control border p-3.5 text-[0.8125rem] ${tone}`}>
      <p className="font-semibold text-foreground">{head}</p>
      {dirty ? <p className="mt-0.5 text-muted">Según lo que ves en pantalla; se aplica al guardar.</p> : null}
      {d.problems.length ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {d.problems.map((p) => (
            <li key={p.code + p.message} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-foreground">{p.message}</span>
              {p.fix === "categories" || p.fix === "team" ? (
                <span className="text-muted">{AREA_LABEL[p.fix]}</span>
              ) : (
                <button type="button" onClick={() => onJump(p.fix)} className={buttonClass({ size: "sm", variant: "tertiary" })}>
                  {AREA_LABEL[p.fix]}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-2.5 border-t border-line pt-2.5 text-muted">
        <p>Aparecer en la página no es lo mismo que tener horarios: los cupos dependen del horario, los bloqueos y las citas del equipo.</p>
        {serviceId ? (
          upcoming.state === "done" ? (
            <ul className="mt-1.5 flex flex-col gap-0.5 text-foreground">
              <li className="text-muted">Con la configuración guardada:</li>
              {upcoming.sites.length === 0 ? <li>No está habilitado en ninguna sede activa.</li> : null}
              {upcoming.sites.map((x) => (
                <li key={x.name}>
                  {x.name}: {x.firstDay ? `próximo día con cupos ${new Date(`${x.firstDay}T12:00:00`).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" })}` : "sin cupos en los próximos 14 días"}
                </li>
              ))}
            </ul>
          ) : (
            <button type="button" onClick={() => void check()} disabled={upcoming.state === "loading"} className={`${buttonClass({ size: "sm" })} mt-1.5`}>
              {upcoming.state === "loading" ? "Consultando…" : upcoming.state === "error" ? "Reintentar consulta de cupos" : "Consultar próximos cupos"}
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/** "Página de reservas": group, visibility, order, badge, image, "Qué incluye" and the
 *  explicit better alternative. The image uploads at once (existing services only); the
 *  rest is saved with Guardar. */
function PageSection({
  diagnosis,
  dirty,
  onJump,
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
  price,
  error,
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
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
  /** The price on screen ("" = a consultar), for the upgrade's price difference. */
  price: string;
  error: string | null;
  diagnosis: PageDiagnosis;
  dirty: boolean;
  onJump: (area: FixArea) => void;
}) {
  const target = others.find((o) => o.id === page.upgradeId) ?? null;
  const delta = target && target.price != null && price.trim() !== "" ? Number(target.price) - Number(price) : null;

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
    <Section id="svc-page" title="Página de reservas" subtitle="Cómo se presenta en la página pública. No cambia la agenda ni el agente." error={error ?? undefined} defaultOpen={defaultOpen}>
      <PageDiagnosisBox clientId={clientId} serviceId={serviceId} diagnosis={diagnosis} dirty={dirty} onJump={onJump} />
      <ToggleRow checked={page.visible} onChange={(v) => setPage({ ...page, visible: v })} label="Visible en la página de reservas" hint="Si lo ocultas, sigue disponible en la agenda y para el agente." />
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field label="Categoría en la página" hint={categories.length === 0 ? "Crea categorías en Página de reservas → Categorías." : undefined}>
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
      <ToggleRow checked={page.recommended} onChange={(v) => setPage({ ...page, recommended: v })} label="Recomendado" hint="Muestra la etiqueta «Recomendado» en la tarjeta." />
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

/**
 * The PRESENTATION editor used by «Página de reservas»: only how a service is shown on
 * the public page (visibility, public category, order, «Recomendado», «Qué incluye», the
 * better alternative, the image). Name, price, duration, professionals and sites are
 * shown read-only with a link to Servicios — the booking page never becomes a second
 * place to edit them. Saved by updateServicePresentationAction alone; the image still
 * uploads on its own, at once, as in the full editor.
 */
export function ServicePresentationEditor({
  clientId,
  service,
  sites,
  staff,
  siteServiceMap,
  bookingCategories,
  allServices,
  servicesHref,
  onClose,
  onSaved,
}: {
  clientId: string;
  service: Service;
  sites: Site[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  bookingCategories: BookingCategory[];
  allServices: Service[];
  /** Where name, price, duration and professionals are edited. */
  servicesHref: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mode: Mode = useMemo(() => ({ kind: "edit", service }), [service]);
  const initialPageForm = useMemo(() => initialPage(mode), [mode]);
  const stored = useMemo(() => initialForm(mode, sites, staff, siteServiceMap), [mode, sites, staff, siteServiceMap]);
  const [page, setPage] = useState<PageForm>(initialPageForm);
  const [image, setImage] = useState<string | null>(service.public_image_url ?? null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  const imageChanged = useRef(false);

  const includesCheck = checkIncludes(page.includes);
  const pageError = !includesCheck.ok ? includesCheck.error : !/^\d{1,3}$/.test(page.sort.trim()) ? "El orden debe ser un número entre 0 y 999." : null;
  const changes = countChanges(initialPageForm, page);
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => (saved.current || imageChanged.current ? onSaved() : onClose()) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };
  useEffect(() => {
    document.getElementById("svc-pres-title")?.focus({ preventScroll: true });
  }, []);

  const save = async () => {
    setAttempted(true);
    if (pageError) return;
    setSaving(true);
    setError(null);
    const r = await updateServicePresentationAction(clientId, service.id, {
      categoryId: page.categoryId || null,
      visible: page.visible,
      sort: page.sort.trim(),
      recommended: page.recommended,
      includes: page.includes,
      upgradeServiceId: page.upgradeId || null,
    });
    setSaving(false);
    if (!r.ok) {
      setError(`${r.error} Lo que escribiste se conserva.`);
      return;
    }
    saved.current = true;
    guard.leave();
  };

  const includesNow = checkIncludes(page.includes);
  const diagnosis = servicePageDiagnosis({
    service: {
      active: service.active,
      visible: page.visible,
      description: stored.description.trim() || null,
      includes: includesNow.ok ? (includesNow.value ?? []) : [],
      imageUrl: image,
      price: service.price,
      durationMin: service.duration_min,
    },
    category: (() => {
      const c = bookingCategories.find((x) => x.id === page.categoryId);
      return c ? { name: c.name, visible: c.visible, layout: c.layout } : null;
    })(),
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      active: site.active,
      enabled: stored.siteIds.includes(site.id),
      artists: staff
        .filter((p) => p.site_id === site.id)
        .map((p) => ({ name: p.name, active: p.active, takesBookings: p.takes_bookings !== false, performs: stored.staffIds.includes(p.id) })),
    })),
  });
  const price = priceLabelCOP(service.price) ?? "A consultar";

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
        title={service.name}
        headingId="svc-pres-title"
        eyebrow="Presentación en la página de reservas"
        chips={
          <>
            <MetaChip>{`${service.duration_min} min`}</MetaChip>
            <MetaChip>{price}</MetaChip>
          </>
        }
        backLabel="Volver a Página de reservas"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saving={saving}
      />
      <EditorFrame
        sections={[
          { id: "svc-pres-data", label: "Datos del servicio" },
          { id: "svc-page", label: "Presentación", dirty: changes > 0, errors: attempted && pageError ? 1 : 0 },
        ]}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} />}
      >
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <EditorSection id="svc-pres-data" title="Datos del servicio" description="Vienen de Servicios y se editan allí: aquí solo cambia cómo se presentan." summary={`${service.duration_min} min · ${price}`}>
          <dl className="grid gap-3 rounded-sch-card border border-line p-4 text-[0.8438rem] sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted">Duración</dt>
              <dd className="mt-0.5 font-medium">{service.duration_min} min</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">Precio</dt>
              <dd className="mt-0.5 font-medium">{price}</dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-xs text-muted">Descripción</dt>
              <dd className="mt-0.5 whitespace-pre-line">{service.description || "Sin descripción"}</dd>
            </div>
          </dl>
          <Link href={servicesHref} className={buttonClass({ className: "w-fit" })}>
            Editar en Servicios
          </Link>
        </EditorSection>
        <PageSection
          diagnosis={diagnosis}
          dirty={changes > 0}
          onJump={() => undefined}
          clientId={clientId}
          serviceId={service.id}
          page={page}
          setPage={setPage}
          categories={bookingCategories}
          others={allServices.filter((x) => x.id !== service.id)}
          image={image}
          setImage={(url) => {
            imageChanged.current = true;
            setImage(url);
          }}
          imageBusy={imageBusy}
          setImageBusy={setImageBusy}
          imageError={imageError}
          setImageError={setImageError}
          price={service.price == null ? "" : String(Number(service.price))}
          error={pageError && attempted ? pageError : null}
          defaultOpen
        />
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en la presentación de este servicio. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
