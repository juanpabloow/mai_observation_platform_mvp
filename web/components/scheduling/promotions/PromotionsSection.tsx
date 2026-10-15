"use client";

import { useState, useTransition } from "react";
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
import { Alert, Button, CARD, CheckRow, Field, INPUT, TEXTAREA, buttonClass } from "../ui/system";

/**
 * PROMOCIONES — create, edit, duplicate, publish, pause and archive the business's
 * promotions, with a live preview (the very card the page renders) and the checks that
 * block publishing shown BEFORE trying. The rules come from src/scheduling/promotions.ts —
 * the same functions the server applies on every write and the booking POST applies on
 * every booking — so the editor can never promise something the server will refuse.
 *
 * Two windows, kept apart on screen as in the model:
 *   A. "Vigencia" — when customers can BOOK it (shown on the page only inside it);
 *   B. "Cuándo deben ser las citas" — weekdays / dates / hours of the APPOINTMENT, in the
 *      site's timezone.
 *
 * Concurrency: every edit sends the version it opened; if someone else saved in between,
 * the server refuses and the editor says so (nothing is overwritten).
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
  paused: "bg-warning/15 text-warning",
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
  const [editing, setEditing] = useState<{ row: PromotionAdminRow | null; form: PromotionForm } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [history, setHistory] = useState<{ id: string; events: Array<{ type: string; actor: string | null; at: string }> } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<PromotionAdminRow | null>(null);
  const [image, setImage] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const svcName = new Map(services.map((s) => [s.id, s.name]));
  const visible = promotions.filter((p) => p.status !== "archived");
  const archived = promotions.filter((p) => p.status === "archived");

  const rulesFrom = (f: PromotionForm, status: PromotionStatus) => ({
    status,
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
  });
  const view = (f: PromotionForm, imageUrl: string | null) => ({
    name: f.name || "Nombre de la promoción",
    description: f.description || null,
    conditions: f.conditions || null,
    image_url: imageUrl,
    benefit_label: BENEFIT_LABEL.two_for_one,
    rule_text: appointmentRuleText({ appointment_weekdays: f.weekdays.length ? f.weekdays : null, appointment_time_from: f.timeFrom || null, appointment_time_until: f.timeUntil || null }),
    services: f.serviceIds.map((id) => svcName.get(id) ?? "").filter(Boolean),
  });

  const open = (p: PromotionAdminRow | null) => {
    setError(null);
    setStale(false);
    setImage({ busy: false, error: null });
    setEditing(p ? { row: p, form: { ...p.form } } : { row: null, form: { ...BLANK } });
  };

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

  const save = () => {
    if (!editing) return;
    const { row, form } = editing;
    act(() => savePromotionAction(clientId, row?.id ?? null, row?.version ?? null, form), () => setEditing(null));
  };
  const move = (p: PromotionAdminRow, to: PromotionStatus) => act(() => setPromotionStatusAction(clientId, p.id, p.version, to), () => setConfirmArchive(null));
  const openHistory = (p: PromotionAdminRow) =>
    start(async () => {
      if (history?.id === p.id) return setHistory(null);
      const r = await listPromotionHistoryAction(clientId, p.id);
      if (r.ok) setHistory({ id: p.id, events: r.events });
      else setError(r.error);
    });
  const upload = async (file: File | undefined) => {
    const id = editing?.row?.id;
    if (!file || !id) return;
    setImage({ busy: true, error: null });
    try {
      const fd = new FormData();
      fd.set("clientId", clientId);
      fd.set("promotionId", id);
      fd.set("image", await downscaleImage(file));
      const r = await uploadPromotionImageAction(fd);
      setImage({ busy: false, error: r.ok ? null : r.error });
      if (r.ok) router.refresh();
    } catch {
      setImage({ busy: false, error: "No pudimos subir la imagen. Inténtalo de nuevo." });
    }
  };

  const f = editing?.form;
  const set = (patch: Partial<PromotionForm>) => setEditing((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));
  // Functional updates: two quick taps never read a stale list.
  const toggleIn = <K extends "serviceIds" | "staffIds" | "weekdays">(k: K, v: PromotionForm[K][number]) =>
    setEditing((e) => {
      if (!e) return e;
      const list = e.form[k] as Array<typeof v>;
      const next = list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
      return { ...e, form: { ...e.form, [k]: k === "weekdays" ? (next as number[]).sort((a, b) => a - b) : next } };
    });
  const toggle = (k: "serviceIds" | "staffIds", id: string) => toggleIn(k, id);
  const problems = f ? publishProblems(rulesFrom(f, "draft")) : [];
  const currentImage = editing?.row ? (promotions.find((p) => p.id === editing.row!.id)?.image_url ?? null) : null;

  return (
    <section aria-labelledby="promo-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 sm:flex-1">
          <h2 id="promo-title" className="text-xl font-semibold tracking-[-0.01em]">
            Promociones
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            Aparecen en la página de reservas, en «Promociones», solo mientras están publicadas y vigentes. Nunca cambian el precio base de un servicio.
          </p>
        </div>
        <Button variant="primary" onClick={() => open(null)} disabled={pending}>
          Nueva promoción
        </Button>
      </div>

      {error && !editing ? (
        <Alert>
          {error}
          {stale ? (
            <button type="button" className="ml-2 underline" onClick={() => router.refresh()}>
              Recargar
            </button>
          ) : null}
        </Alert>
      ) : null}

      {visible.length === 0 && !editing ? <p className={`p-4 text-sm text-muted ${CARD}`}>Todavía no hay promociones.</p> : null}

      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {[...visible, ...archived].map((p) => {
          const rule = appointmentRuleText({ appointment_weekdays: p.form.weekdays.length ? p.form.weekdays : null, appointment_time_from: p.form.timeFrom || null, appointment_time_until: p.form.timeUntil || null });
          return (
            <li key={p.id} className={`p-4 ${CARD} ${p.status === "archived" ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{p.form.name}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${STATUS_TONE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                    <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">{BENEFIT_LABEL.two_for_one}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {[rule, p.form.serviceIds.map((id) => svcName.get(id)).filter(Boolean).join(", ") || "Sin servicios", p.booked_count ? `${p.booked_count} reservas` : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {p.status !== "archived" ? (
                  <Button size="sm" onClick={() => open(p)} disabled={pending}>
                    Editar
                  </Button>
                ) : null}
                <Button size="sm" onClick={() => act(() => duplicatePromotionAction(clientId, p.id))} disabled={pending}>
                  Duplicar
                </Button>
                {canMove(p.status, "published") ? (
                  <Button size="sm" variant="primary" onClick={() => move(p, "published")} disabled={pending}>
                    {p.status === "paused" ? "Reanudar" : "Publicar"}
                  </Button>
                ) : null}
                {canMove(p.status, "paused") ? (
                  <Button size="sm" onClick={() => move(p, "paused")} disabled={pending}>
                    Pausar
                  </Button>
                ) : null}
                {canMove(p.status, "archived") ? (
                  <Button size="sm" variant="tertiary" onClick={() => setConfirmArchive(p)} disabled={pending}>
                    Archivar
                  </Button>
                ) : null}
                <Button size="sm" variant="tertiary" onClick={() => openHistory(p)} aria-expanded={history?.id === p.id}>
                  Historial
                </Button>
              </div>
              {confirmArchive?.id === p.id ? (
                <div role="alertdialog" aria-labelledby={`arch-${p.id}`} className="mt-3 rounded-sch-control border border-line bg-subtle p-3">
                  <p id={`arch-${p.id}`} className="text-sm">
                    ¿Archivar «{p.form.name}»? Deja de mostrarse y no se puede volver a publicar. Las reservas ya hechas no cambian.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => setConfirmArchive(null)}>
                      Cancelar
                    </Button>
                    <Button size="sm" variant="primary" onClick={() => move(p, "archived")} loading={pending} loadingLabel="Archivando…">
                      Archivar
                    </Button>
                  </div>
                </div>
              ) : null}
              {history?.id === p.id ? (
                <ol className="mt-3 flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
                  {history.events.map((e, i) => (
                    <li key={i}>
                      {EVENT_LABEL[e.type] ?? e.type} · {e.actor ?? "Alguien del equipo"} · {new Date(e.at).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          );
        })}
      </ul>

      {editing && f ? (
        <div className={`grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_340px] ${CARD}`}>
          <div className="flex min-w-0 flex-col gap-4">
            <h3 className="text-[15px] font-semibold">{editing.row ? "Editar promoción" : "Nueva promoción"}</h3>
            {error ? (
              <Alert>
                {error}
                {stale ? (
                  <button type="button" className="ml-2 underline" onClick={() => router.refresh()}>
                    Recargar
                  </button>
                ) : null}
              </Alert>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <Field label="Nombre">
                <input value={f.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="2×1 universitario" className={INPUT} />
              </Field>
              <Field label="Beneficio" hint={benefitPending("two_for_one", {}).length ? "Reglas por definir" : undefined}>
                <select value={f.benefitType} onChange={(e) => set({ benefitType: e.target.value })} className={INPUT}>
                  <option value="two_for_one">2×1</option>
                </select>
              </Field>
            </div>
            <Field label="Descripción" optional>
              <textarea value={f.description} maxLength={600} rows={3} onChange={(e) => set({ description: e.target.value })} className={TEXTAREA} />
            </Field>
            <Field label="Condiciones" optional hint="Solo contenido aprobado. Se muestra bajo «Condiciones».">
              <textarea value={f.conditions} maxLength={600} rows={3} onChange={(e) => set({ conditions: e.target.value })} className={TEXTAREA} />
            </Field>

            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-medium">Servicios incluidos</legend>
              <div className="grid gap-0.5 sm:grid-cols-2">
                {services.map((s) => (
                  <CheckRow key={s.id} checked={f.serviceIds.includes(s.id)} onChange={() => toggle("serviceIds", s.id)}>
                    {s.name}
                  </CheckRow>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Sede">
                <select value={f.siteId} onChange={(e) => set({ siteId: e.target.value, staffIds: [] })} className={INPUT}>
                  <option value="">Todas las sedes</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Orden">
                <input inputMode="numeric" value={f.sortOrder} onChange={(e) => set({ sortOrder: e.target.value })} className={INPUT} />
              </Field>
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-xs font-medium">Artistas participantes</legend>
              <p className="text-[0.6875rem] text-faint">Ninguno marcado = cualquier artista que haga el servicio.</p>
              <div className="grid gap-0.5 sm:grid-cols-2">
                {staff
                  .filter((p) => !f.siteId || p.site_id === f.siteId)
                  .map((p) => (
                    <CheckRow key={p.id} checked={f.staffIds.includes(p.id)} onChange={() => toggle("staffIds", p.id)}>
                      {p.name}
                    </CheckRow>
                  ))}
              </div>
            </fieldset>

            <div className="rounded-sch-control border border-line p-3.5">
              <h4 className="text-sm font-semibold">A. Vigencia</h4>
              <p className="mt-0.5 text-xs text-muted">Cuándo se puede reservar. Fuera de estas fechas no se muestra. Hora de la sede.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="Desde" optional>
                  <input type="datetime-local" value={f.bookableFrom} onChange={(e) => set({ bookableFrom: e.target.value })} className={INPUT} />
                </Field>
                <Field label="Hasta" optional>
                  <input type="datetime-local" value={f.bookableUntil} onChange={(e) => set({ bookableUntil: e.target.value })} className={INPUT} />
                </Field>
              </div>
            </div>
            <div className="rounded-sch-control border border-line p-3.5">
              <h4 className="text-sm font-semibold">B. Cuándo deben ser las citas</h4>
              <p className="mt-0.5 text-xs text-muted">La promoción se ve cualquier día; solo las citas en estos días u horas la reciben.</p>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Días de las citas">
                {WEEK.map(([d, label]) => {
                  const on = f.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleIn("weekdays", d)}
                      className={buttonClass({ size: "sm", variant: on ? "primary" : "secondary" })}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-4">
                <Field label="Citas desde" optional>
                  <input type="date" value={f.appointmentFrom} onChange={(e) => set({ appointmentFrom: e.target.value })} className={INPUT} />
                </Field>
                <Field label="Citas hasta" optional>
                  <input type="date" value={f.appointmentUntil} onChange={(e) => set({ appointmentUntil: e.target.value })} className={INPUT} />
                </Field>
                <Field label="Hora desde" optional>
                  <input type="time" value={f.timeFrom} onChange={(e) => set({ timeFrom: e.target.value })} className={INPUT} />
                </Field>
                <Field label="Hora hasta" optional>
                  <input type="time" value={f.timeUntil} onChange={(e) => set({ timeUntil: e.target.value })} className={INPUT} />
                </Field>
              </div>
            </div>

            <Field label="Imagen" optional hint={editing.row ? "PNG, JPEG o WebP. Se guarda al subirla." : "Guarda la promoción para poder subir su imagen."}>
              <span className="flex flex-wrap items-center gap-3">
                <label className={buttonClass({ className: editing.row && !image.busy ? "cursor-pointer" : "pointer-events-none opacity-60" })}>
                  {image.busy ? "Subiendo…" : currentImage ? "Cambiar imagen" : "Subir imagen"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={!editing.row || image.busy}
                    className="sr-only"
                    onChange={(e) => {
                      void upload(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {currentImage && editing.row ? (
                  <Button size="sm" variant="tertiary" onClick={() => act(() => removePromotionImageAction(clientId, editing.row!.id))}>
                    Quitar
                  </Button>
                ) : null}
              </span>
            </Field>
            {image.error ? <Alert>{image.error}</Alert> : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={() => setEditing(null)} disabled={pending}>
                Cancelar
              </Button>
              <Button variant="primary" onClick={save} loading={pending} loadingLabel="Guardando…">
                Guardar borrador
              </Button>
            </div>
          </div>

          <aside aria-label="Vista previa" className="flex flex-col gap-3 self-start lg:sticky lg:top-4">
            <h4 className="text-sm font-semibold">Vista previa en la página</h4>
            <div className="pb3 rounded-2xl p-3">
              <PromotionCard promo={view(f, currentImage)} preview />
            </div>
            <div className={`p-3.5 text-[13px] ${CARD}`}>
              <p className="font-medium">{problems.length ? "Antes de publicar falta:" : "Lista para publicar."}</p>
              {problems.length ? (
                <ul className="mt-1.5 list-disc pl-5 text-muted">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
