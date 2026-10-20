"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageShell } from "@/components/ui/PageShell";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { AD_NOTE_MAX, CAMPAIGN_BRIEF_MAX, toDateInputValue } from "@/lib/campaignsValidation";
import {
  assignAdsToCampaignAction,
  createAdAction,
  createCampaignAction,
  endCampaignAction,
  removeAdCoverAction,
  updateAdAction,
  updateCampaignAction,
  uploadAdCoverAction,
} from "@/lib/campaignsActions";
import { downscaleImage } from "@/components/scheduling/staff/StaffPhotoControl";

/**
 * Per-client CAMPAÑAS manager (AT-2). Mirrors the catalog/scheduling visual language so it reads
 * as native. Two tabs: ANUNCIOS (detected ads + assign to a campaign) and CAMPAÑAS (create/edit/end
 * a campaign with a bot brief). `canManage` (agency/owner) gates every write control; the server
 * actions re-enforce each tier, so a Setter who reaches this page sees it READ-ONLY. Test ads
 * (is_test) are hidden behind a toggle everywhere. ctwa_clid is never passed to this component.
 */

export interface AdItem {
  id: string;
  external_id: string;
  source_type: "ad" | "post";
  name: string | null;
  bot_note: string | null;
  headline: string | null;
  body: string | null;
  media_type: string | null;
  source_url: string | null;
  /** AT-2c: public URL of the stored cover image (built from the key), or null. */
  cover_url: string | null;
  /** AT-2c: a facebook.com story link to open the creative (video ads), or null. */
  video_url: string | null;
  is_test: boolean;
  campaign_id: string | null;
  campaign_name: string | null;
  leads: number;
  touches: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface CampaignItem {
  id: string;
  name: string;
  status: "active" | "paused" | "ended";
  start_date: string | null;
  end_date: string | null;
  external_campaign_id: string | null;
  target_service_id: string | null;
  promotion_id: string | null;
  bot_brief: string | null;
  ad_count: number;
}

interface Option {
  id: string;
  name: string;
}

const INPUT =
  "h-[44px] lg:h-[36px] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle disabled:text-faint";
const BTN =
  "inline-flex h-[44px] lg:h-[36px] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[44px] lg:h-[34px] items-center justify-center rounded-lg border border-line px-3 lg:px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground";

type Result = { ok: boolean; error?: string };
type Run = (fn: () => Promise<Result>) => void;
type Tab = "ads" | "campaigns";

const STATUS_LABEL: Record<CampaignItem["status"], string> = {
  active: "Activa",
  paused: "En pausa",
  ended: "Finalizada",
};

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export function CampaignsPanel({
  clientId,
  clientName,
  canManage,
  isAgency,
  ads,
  campaigns,
  services,
  promotions,
}: {
  clientId: string;
  clientName: string;
  canManage: boolean;
  /** Agency (owner/admin) — the only tier that may reach the agency-only settings page. */
  isAgency: boolean;
  ads: AdItem[];
  campaigns: CampaignItem[];
  services: Option[];
  promotions: Option[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("ads");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run: Run = (fn) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };

  // Modal saves surface their OWN failure inside the modal (see CampaignModal/AdModal), not in the
  // page-level banner above — which the modal overlay would hide. On success they close + refresh.
  const refresh = useCallback(() => router.refresh(), [router]);

  const unconfigured = ads.filter((a) => !a.is_test && !a.campaign_id).length;

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      <PageShell grow={false} clip={false}>
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-2.5">
              <h1 className="truncate text-xl font-semibold tracking-[-0.025em] text-foreground">Campañas</h1>
              <span className="truncate text-xs text-muted">{clientName}</span>
            </div>
            <p className="mt-0.5 hidden text-xs text-muted sm:block">
              Los anuncios que detectamos de Meta, agrupados en campañas que el asistente entiende.
            </p>
          </div>
          {isAgency ? (
            <Link href={`/clients/${clientId}/campaigns/settings`} className={GHOST}>
              Configuración
            </Link>
          ) : null}
        </div>
        <nav aria-label="Secciones" className="flex items-center gap-1 overflow-x-auto border-t border-line px-2 sm:px-3">
          <TabButton active={tab === "ads"} onClick={() => setTab("ads")} label="Anuncios" count={unconfigured || undefined} countTitle="Sin configurar" />
          <TabButton active={tab === "campaigns"} onClick={() => setTab("campaigns")} label="Campañas" count={campaigns.length || undefined} />
        </nav>
      </PageShell>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {tab === "ads" ? (
        <AdsTab clientId={clientId} canManage={canManage} ads={ads} campaigns={campaigns} run={run} pending={pending} refresh={refresh} />
      ) : (
        <CampaignsTab
          clientId={clientId}
          canManage={canManage}
          campaigns={campaigns}
          services={services}
          promotions={promotions}
          run={run}
          pending={pending}
          refresh={refresh}
        />
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  countTitle,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  countTitle?: string;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`relative flex h-[44px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-xs font-medium transition lg:h-[40px] lg:px-2.5 ${
        active ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      {label}
      {count != null ? (
        <span title={countTitle} className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">
          {count}
        </span>
      ) : null}
    </button>
  );
}

// ── Ads tab ─────────────────────────────────────────────────────────────────────
function AdsTab({
  clientId,
  canManage,
  ads,
  campaigns,
  run,
  pending,
  refresh,
}: {
  clientId: string;
  canManage: boolean;
  ads: AdItem[];
  campaigns: CampaignItem[];
  run: Run;
  pending: boolean;
  refresh: () => void;
}) {
  const [showTest, setShowTest] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdItem | null>(null);
  const hasTest = ads.some((a) => a.is_test);
  const assignable = campaigns.filter((c) => c.status !== "ended");
  const q = search.trim().toLocaleLowerCase("es");
  const visible = ads.filter(
    (a) =>
      (showTest || !a.is_test) &&
      (q === "" ||
        (a.name ?? "").toLocaleLowerCase("es").includes(q) ||
        (a.headline ?? "").toLocaleLowerCase("es").includes(q) ||
        a.external_id.includes(q)),
  );
  const noRealAds = ads.filter((a) => !a.is_test).length === 0;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulkAssign = (campaignId: string | null) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    run(async () => {
      const r = await assignAdsToCampaignAction(clientId, ids, campaignId);
      if (r.ok) setSelected(new Set());
      return r;
    });
  };

  return (
    <PageShell className="overflow-y-auto" ariaLabel="Anuncios detectados">
      <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
        {noRealAds && !showTest ? (
          <div className="flex min-h-72 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface px-4 py-12 text-center">
            <p className="text-sm font-semibold text-foreground">Aún no detectamos anuncios</p>
            <p className="mt-1 max-w-sm text-xs text-muted">
              Cuando alguien escriba desde un anuncio de Meta, aparecerá aquí. O agrégalo por su id para configurarlo
              desde ya.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {canManage ? (
                <button type="button" className={BTN} onClick={() => setCreating(true)}>
                  + Agregar anuncio
                </button>
              ) : null}
              {hasTest ? (
                <button type="button" className={GHOST} onClick={() => setShowTest(true)}>
                  Mostrar anuncios de prueba
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
              {canManage && selected.size > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="u-mono text-xs text-muted">{selected.size} seleccionado{selected.size === 1 ? "" : "s"}</span>
                  <select
                    aria-label="Asignar seleccionados a una campaña"
                    disabled={pending}
                    className={INPUT}
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value;
                      e.target.value = "";
                      if (v === "") return;
                      bulkAssign(v === "__none__" ? null : v);
                    }}
                  >
                    <option value="" disabled>
                      Asignar a…
                    </option>
                    {assignable.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                    <option value="__none__">Quitar de la campaña</option>
                  </select>
                </div>
              ) : (
                <span className="shrink-0 text-xs text-muted">
                  {visible.length} anuncio{visible.length === 1 ? "" : "s"}
                </span>
              )}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nombre, titular o id…"
                aria-label="Buscar anuncio"
                className={`${INPUT} min-w-0 flex-1 bg-subtle/60 sm:max-w-xs`}
              />
              {canManage ? (
                <button type="button" className={BTN} onClick={() => setCreating(true)}>
                  + Agregar anuncio
                </button>
              ) : null}
              {hasTest ? (
                <label className="inline-flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />
                  Prueba
                </label>
              ) : null}
            </div>

            {visible.map((ad) => (
              <AdRow
                key={ad.id}
                clientId={clientId}
                ad={ad}
                campaigns={assignable}
                canManage={canManage}
                run={run}
                pending={pending}
                selected={selected.has(ad.id)}
                onToggle={() => toggle(ad.id)}
                onEdit={() => setEditing(ad)}
              />
            ))}
            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
                <p className="text-xs text-muted">Ningún anuncio coincide con la búsqueda.</p>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {creating ? (
        <AdModal
          mode="create"
          clientId={clientId}
          campaigns={assignable}
          onClose={() => setCreating(false)}
          onSubmit={async (values, coverFile) => {
            const r = await createAdAction({ clientId, ...values });
            // Create first, then attach the staged cover to the new ad id. A cover failure never
            // undoes the created ad (the person can add the cover later from the edit modal).
            if (r.ok && r.id && coverFile) {
              const fd = new FormData();
              fd.set("clientId", clientId);
              fd.set("adId", r.id);
              fd.set("image", coverFile);
              await uploadAdCoverAction(fd);
            }
            if (r.ok) {
              setCreating(false);
              refresh();
            }
            return r;
          }}
        />
      ) : null}

      {editing ? (
        <AdModal
          mode="edit"
          clientId={clientId}
          initial={editing}
          campaigns={assignable}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const r = await updateAdAction(clientId, editing.id, { name: values.name, botNote: values.botNote });
            if (r.ok) {
              setEditing(null);
              refresh();
            }
            return r;
          }}
        />
      ) : null}
    </PageShell>
  );
}

function AdRow({
  clientId,
  ad,
  campaigns,
  canManage,
  run,
  pending,
  selected,
  onToggle,
  onEdit,
}: {
  clientId: string;
  ad: AdItem;
  campaigns: CampaignItem[];
  canManage: boolean;
  run: Run;
  pending: boolean;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  // Name is the main label when present (the Ads Manager name); the creative headline drops to the
  // body line so both stay visible. A pre-registered ad with no touches reads "Sin leads todavía".
  const label = ad.name || ad.headline || "(sin titular)";
  return (
    <article className="flex flex-wrap items-start gap-3 overflow-hidden rounded-xl border border-line bg-surface px-4 py-3.5">
      {canManage ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Seleccionar anuncio ${ad.external_id}`}
          className="mt-1 size-4 shrink-0"
        />
      ) : null}
      {ad.cover_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- the ad's own cover (R2 public bucket)
        <img src={ad.cover_url} alt="" className="size-12 shrink-0 rounded-lg border border-line object-cover" />
      ) : (
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-muted">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-foreground">{label}</h3>
          <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted">
            {ad.source_type === "post" ? "Publicación" : "Anuncio"}
          </span>
          {ad.is_test ? (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">Prueba</span>
          ) : null}
          {ad.campaign_name ? (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.625rem] font-medium text-accent">{ad.campaign_name}</span>
          ) : (
            <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">Sin configurar</span>
          )}
          {ad.bot_note ? (
            <span className="rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-muted" title={ad.bot_note}>
              nota
            </span>
          ) : null}
          <AdId externalId={ad.external_id} />
        </div>
        {ad.name && ad.headline ? <p className="mt-1 truncate text-xs text-muted">{ad.headline}</p> : null}
        {ad.body ? <p className="mt-1 line-clamp-2 text-xs text-muted">{ad.body}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-faint">
          {ad.touches === 0 ? (
            <span>Sin leads todavía</span>
          ) : (
            <>
              <span className="u-mono">{ad.leads} lead{ad.leads === 1 ? "" : "s"}</span>
              <span className="u-mono">{ad.touches} contacto{ad.touches === 1 ? "" : "s"}</span>
            </>
          )}
          {ad.media_type ? <span>{ad.media_type}</span> : null}
          <span>Visto {fmtDate(ad.first_seen_at)} → {fmtDate(ad.last_seen_at)}</span>
          {ad.video_url || ad.source_url ? (
            <a href={(ad.video_url ?? ad.source_url) as string} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
              Ver anuncio ↗
            </a>
          ) : null}
        </div>
      </div>

      {canManage ? (
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" className={GHOST} onClick={onEdit} aria-haspopup="dialog">
            Editar
          </button>
          <label>
            <span className="sr-only">Campaña del anuncio {ad.external_id}</span>
            <select
              aria-label={`Campaña del anuncio ${ad.external_id}`}
              disabled={pending}
              value={ad.campaign_id ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                run(() => assignAdsToCampaignAction(clientId, [ad.id], v === "" ? null : v));
              }}
              className={`${INPUT} max-w-[11rem]`}
            >
              <option value="">Sin campaña</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
    </article>
  );
}

interface AdValues {
  externalId: string;
  name: string | null;
  botNote: string | null;
  campaignId: string | null;
}

/** Create ("Agregar anuncio", by Meta id) or edit (name + note) an ad. */
function AdModal({
  mode,
  clientId,
  initial,
  campaigns,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  clientId: string;
  initial?: AdItem;
  campaigns: CampaignItem[];
  onClose: () => void;
  onSubmit: (values: AdValues, coverFile: File | null) => Promise<Result>;
}) {
  const [externalId, setExternalId] = useState(initial?.external_id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [note, setNote] = useState(initial?.bot_note ?? "");
  const [campaignId, setCampaignId] = useState(initial?.campaign_id ?? "");
  // AT-2c: create stages the cover (uploaded after the ad is created); edit uploads immediately.
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });

  const title = mode === "create" ? "Agregar anuncio" : initial?.name || initial?.headline || "Editar anuncio";
  const idOk = mode === "edit" || /^\d+$/.test(externalId.trim());

  // Every failure is shown INSIDE the modal; on success the parent unmounts it.
  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const r = await onSubmit(
        {
          externalId: externalId.trim(),
          name: name.trim() === "" ? null : name.trim(),
          botNote: note.trim() === "" ? null : note,
          campaignId: campaignId === "" ? null : campaignId,
        },
        coverFile,
      );
      if (!r.ok) setError(r.error ?? "No se pudo guardar. Revisa los datos e inténtalo de nuevo.");
    } catch {
      setError("No se pudo guardar. Inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${title}`} className={OVERLAY_SCRIM} onClick={close} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-50 flex max-h-[min(760px,calc(100dvh-2rem))] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:max-w-xl sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              {mode === "create"
                ? "Pre-regístralo por su id de Meta para configurarlo antes del primer lead."
                : "Nombre y nota de este anuncio."}
            </p>
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
          <div className="grid gap-3">
            {mode === "create" ? (
              <Field label="Id del anuncio de Meta" hint="Solo dígitos, como aparece en Ads Manager.">
                <input
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  inputMode="numeric"
                  placeholder="Ej. 120210000000000"
                  className={`${INPUT} w-full`}
                />
              </Field>
            ) : (
              <Field label="Id del anuncio de Meta">
                <input value={externalId} disabled className={`${INPUT} w-full`} />
              </Field>
            )}
            <Field label="Nombre" hint="El nombre del anuncio en Ads Manager (opcional). Ej. «Factos Falla».">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Opcional" className={`${INPUT} w-full`} />
            </Field>
            {mode === "create" ? (
              <Field label="Campaña" hint="Opcional.">
                <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={`${INPUT} w-full`}>
                  <option value="">Sin campaña</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          <div className="mt-4">
            <label className="mb-1.5 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Nota del anuncio <span className="font-normal text-faint">(opcional)</span>
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={AD_NOTE_MAX}
                placeholder="Lo específico de ESTE anuncio. Ej. «Presenta a Falla; si lo mencionan, ofrece primero su disponibilidad»."
                className="min-h-[4.5rem] w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none transition focus:border-foreground"
              />
            </label>
            <div className="flex items-center justify-between">
              <p className="text-[0.6875rem] text-faint">El asistente lo lee junto con el brief de la campaña.</p>
              <p className="shrink-0 pl-3 text-[0.6875rem] text-faint">
                {note.length}/{AD_NOTE_MAX}
              </p>
            </div>
          </div>

          <div className="mt-4">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Portada <span className="font-normal text-faint">(opcional)</span>
            </span>
            <AdCoverControl
              clientId={clientId}
              adId={mode === "edit" ? initial?.id ?? null : null}
              coverUrl={initial?.cover_url ?? null}
              onStage={mode === "create" ? setCoverFile : undefined}
            />
            <p className="mt-1.5 text-[0.6875rem] text-faint">
              JPG, PNG o WebP. Si no subes una, usamos la imagen del anuncio cuando llega el primer lead.
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card/50 px-4 py-3 sm:px-5">
          {error ? (
            <p role="alert" className="mr-auto min-w-0 flex-1 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={close}
            className="inline-flex h-[44px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle lg:h-[36px]"
          >
            Cancelar
          </button>
          <button className={BTN} disabled={submitting || !idOk} onClick={submit}>
            {submitting ? "Guardando…" : mode === "create" ? "Agregar anuncio" : "Guardar cambios"}
          </button>
        </footer>
      </section>
    </div>
  );
}

/**
 * AT-2c: the ad's COVER uploader. Edit mode (adId present) uploads immediately like the staff photo;
 * create mode (adId null) STAGES the downscaled file (local preview) for the parent to upload right
 * after the ad is created. Same validation/storage as staff photos (downscaled in the browser first).
 */
function AdCoverControl({
  clientId,
  adId,
  coverUrl,
  onStage,
}: {
  clientId: string;
  adId: string | null;
  coverUrl: string | null;
  onStage?: (file: File | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(coverUrl);
  const [staged, setStaged] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (file: File) =>
    start(async () => {
      setError(null);
      let small: File;
      try {
        small = await downscaleImage(file);
      } catch {
        setError("No pudimos leer esa imagen. Prueba con un JPG o PNG.");
        return;
      }
      if (adId) {
        const fd = new FormData();
        fd.set("clientId", clientId);
        fd.set("adId", adId);
        fd.set("image", small);
        const r = await uploadAdCoverAction(fd);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setPreview(r.url ?? null);
      } else {
        onStage?.(small);
        setStaged(true);
        setPreview(URL.createObjectURL(small));
      }
    });

  const remove = () =>
    start(async () => {
      setError(null);
      if (adId && !staged) {
        const r = await removeAdCoverAction(clientId, adId);
        if (!r.ok) {
          setError(r.error);
          return;
        }
      }
      onStage?.(null);
      setStaged(false);
      setPreview(null);
    });

  return (
    <div className="flex items-start gap-3">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- the business's own cover (R2 / local preview)
        <img src={preview} alt="" className="size-16 shrink-0 rounded-xl border border-line object-cover" />
      ) : (
        <span aria-hidden className="flex size-16 shrink-0 items-center justify-center rounded-xl border border-line bg-subtle text-muted">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
          </svg>
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => input.current?.click()}
            className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] border border-line-strong bg-surface px-3.5 text-sm text-foreground disabled:opacity-60 md:min-h-[36px]"
          >
            {pending ? "Guardando…" : preview ? "Cambiar portada" : "Subir portada"}
          </button>
          {preview ? (
            <button
              type="button"
              disabled={pending}
              onClick={remove}
              className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] px-3 text-sm text-muted underline underline-offset-2 disabled:opacity-60 md:min-h-[36px]"
            >
              Quitar
            </button>
          ) : null}
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) pick(f);
          }}
        />
        {error ? (
          <span role="alert" className="text-xs text-danger">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Short Meta ad id (last 6) to tell same-headline ads apart; full id on hover + click-to-copy. */
function AdId({ externalId }: { externalId: string }) {
  const [copied, setCopied] = useState(false);
  const short = externalId.length > 6 ? `…${externalId.slice(-6)}` : externalId;
  return (
    <button
      type="button"
      title={`${externalId} — clic para copiar`}
      onClick={() => {
        void navigator.clipboard?.writeText(externalId).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
      className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint transition hover:text-foreground"
    >
      {copied ? "copiado" : `id ${short}`}
    </button>
  );
}

// ── Campaigns tab ─────────────────────────────────────────────────────────────────
function CampaignsTab({
  clientId,
  canManage,
  campaigns,
  services,
  promotions,
  run,
  pending,
  refresh,
}: {
  clientId: string;
  canManage: boolean;
  campaigns: CampaignItem[];
  services: Option[];
  promotions: Option[];
  run: Run;
  pending: boolean;
  refresh: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CampaignItem | null>(null);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const promoName = useMemo(() => new Map(promotions.map((p) => [p.id, p.name])), [promotions]);

  return (
    <PageShell className="overflow-y-auto" ariaLabel="Campañas">
      <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">
            {campaigns.length} campaña{campaigns.length === 1 ? "" : "s"}
          </span>
          {canManage ? (
            <button type="button" className={BTN} onClick={() => setCreating(true)}>
              + Nueva campaña
            </button>
          ) : null}
        </div>

        {campaigns.length === 0 ? (
          <div className="flex min-h-60 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-line bg-surface px-4 py-12 text-center">
            <p className="text-sm font-semibold text-foreground">Aún no hay campañas</p>
            <p className="mt-1 max-w-sm text-xs text-muted">
              Crea una campaña, escribe un brief para el asistente y asígnale los anuncios que la representan.
            </p>
            {canManage ? (
              <button type="button" className={`${BTN} mt-4`} onClick={() => setCreating(true)}>
                + Nueva campaña
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {campaigns.map((c) => (
              <article key={c.id} className="flex flex-wrap items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-semibold text-foreground">{c.name}</h3>
                    <StatusChip status={c.status} />
                    <span className="u-mono rounded bg-chip px-1.5 py-0.5 text-[0.625rem] text-faint">
                      {c.ad_count} anuncio{c.ad_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-faint">
                    {c.start_date || c.end_date ? (
                      <span>
                        {fmtDate(c.start_date)} → {fmtDate(c.end_date)}
                      </span>
                    ) : null}
                    {c.target_service_id && serviceName.get(c.target_service_id) ? (
                      <span>Servicio: {serviceName.get(c.target_service_id)}</span>
                    ) : null}
                    {c.promotion_id && promoName.get(c.promotion_id) ? (
                      <span>Promoción: {promoName.get(c.promotion_id)}</span>
                    ) : null}
                    {c.external_campaign_id ? <span className="u-mono">Meta {c.external_campaign_id}</span> : null}
                  </div>
                  {c.bot_brief ? <p className="mt-1.5 line-clamp-2 text-xs text-muted">{c.bot_brief}</p> : null}
                </div>
                {canManage ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button type="button" className={GHOST} onClick={() => setEditing(c)} aria-haspopup="dialog">
                      Editar
                    </button>
                    {c.status !== "ended" ? <EndButton clientId={clientId} campaign={c} run={run} pending={pending} /> : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>

      {creating ? (
        <CampaignModal
          title="Nueva campaña"
          services={services}
          promotions={promotions}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const r = await createCampaignAction({ clientId, ...values });
            if (r.ok) {
              setCreating(false);
              refresh();
            }
            return r;
          }}
        />
      ) : null}

      {editing ? (
        <CampaignModal
          title={editing.name}
          services={services}
          promotions={promotions}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            const r = await updateCampaignAction(clientId, editing.id, values);
            if (r.ok) {
              setEditing(null);
              refresh();
            }
            return r;
          }}
        />
      ) : null}
    </PageShell>
  );
}

function StatusChip({ status }: { status: CampaignItem["status"] }) {
  const cls =
    status === "active"
      ? "bg-success/10 text-success"
      : status === "paused"
        ? "bg-warn-soft text-warn"
        : "bg-chip text-muted";
  return <span className={`rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${cls}`}>{STATUS_LABEL[status]}</span>;
}

function EndButton({ clientId, campaign, run, pending }: { clientId: string; campaign: CampaignItem; run: Run; pending: boolean }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className={GHOST} disabled={pending} onClick={() => setConfirming(true)}>
        Finalizar
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-warn">¿Finalizar la campaña?</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setConfirming(false);
          run(() => endCampaignAction(clientId, campaign.id));
        }}
        className="rounded border border-warn/40 px-2 py-0.5 text-[11px] text-warn transition-colors hover:bg-warn-soft disabled:opacity-50"
      >
        Finalizar
      </button>
      <button type="button" onClick={() => setConfirming(false)} className="rounded border border-line px-2 py-0.5 text-[11px] transition-colors hover:bg-subtle">
        Cancelar
      </button>
    </div>
  );
}

interface CampaignValues {
  name: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  externalCampaignId: string | null;
  targetServiceId: string | null;
  promotionId: string | null;
  botBrief: string | null;
}

function CampaignModal({
  title,
  services,
  promotions,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  services: Option[];
  promotions: Option[];
  initial?: CampaignItem;
  onClose: () => void;
  onSubmit: (values: CampaignValues) => Promise<Result>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [status, setStatus] = useState<string>(initial?.status ?? "active");
  // Accept whatever shape the stored date arrives in (YYYY-MM-DD, full ISO, or a Date) → the
  // YYYY-MM-DD an <input type="date"> binds to. Without this, a Date leaked `.trim is not a function`.
  const [startDate, setStartDate] = useState(() => toDateInputValue(initial?.start_date));
  const [endDate, setEndDate] = useState(() => toDateInputValue(initial?.end_date));
  const [externalId, setExternalId] = useState(initial?.external_campaign_id ?? "");
  const [serviceId, setServiceId] = useState(initial?.target_service_id ?? "");
  const [promotionId, setPromotionId] = useState(initial?.promotion_id ?? "");
  const [brief, setBrief] = useState(initial?.bot_brief ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });

  // Every failure is shown INSIDE the modal; on success the parent unmounts it.
  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const r = await onSubmit({
        name: name.trim(),
        status,
        startDate: startDate.trim() === "" ? null : startDate.trim(),
        endDate: endDate.trim() === "" ? null : endDate.trim(),
        externalCampaignId: externalId.trim() === "" ? null : externalId.trim(),
        targetServiceId: serviceId === "" ? null : serviceId,
        promotionId: promotionId === "" ? null : promotionId,
        botBrief: brief.trim() === "" ? null : brief,
      });
      if (!r.ok) setError(r.error ?? "No se pudo guardar. Revisa los datos e inténtalo de nuevo.");
    } catch {
      setError("No se pudo guardar. Inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${title}`} className={OVERLAY_SCRIM} onClick={close} />
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative z-50 flex max-h-[min(820px,calc(100dvh-2rem))] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:max-w-2xl sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-xs text-muted">Nombre, estado, fechas, objetivo y el brief para el asistente.</p>
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
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Asesoría gratis — octubre" className={`${INPUT} w-full`} />
            </Field>
            <Field label="Estado">
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${INPUT} w-full`}>
                <option value="active">Activa</option>
                <option value="paused">En pausa</option>
                <option value="ended">Finalizada</option>
              </select>
            </Field>
            <Field label="Inicio" hint="Opcional.">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
            <Field label="Fin" hint="Opcional.">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={`${INPUT} w-full`} />
            </Field>
            <Field label="Servicio objetivo" hint="Opcional.">
              <select value={serviceId} onChange={(e) => setServiceId(e.target.value)} className={`${INPUT} w-full`}>
                <option value="">Ninguno</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Promoción" hint="Opcional.">
              <select value={promotionId} onChange={(e) => setPromotionId(e.target.value)} className={`${INPUT} w-full`}>
                <option value="">Ninguna</option>
                {promotions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Id de campaña de Meta" hint="Opcional. En Ads Manager → Campañas, agrega la columna «ID de la campaña».">
              <input value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="Opcional" className={`${INPUT} w-full`} />
            </Field>
          </div>

          <div className="mt-4">
            <label className="mb-1.5 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">
                Brief para el asistente <span className="font-normal text-faint">(opcional)</span>
              </span>
              <textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={4}
                maxLength={CAMPAIGN_BRIEF_MAX}
                placeholder="Qué promete el anuncio, a quién va dirigido, condiciones…"
                className="min-h-[5.5rem] w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none transition focus:border-foreground"
              />
            </label>
            <div className="flex items-center justify-between">
              <p className="text-[0.6875rem] text-faint">
                Lo que escribas aquí lo lee el asistente cuando alguien escribe desde un anuncio de esta campaña.
              </p>
              <p className="shrink-0 pl-3 text-[0.6875rem] text-faint">
                {brief.length}/{CAMPAIGN_BRIEF_MAX}
              </p>
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line bg-card/50 px-4 py-3 sm:px-5">
          {error ? (
            <p role="alert" className="mr-auto min-w-0 flex-1 text-sm text-danger">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={close}
            className="inline-flex h-[44px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle lg:h-[36px]"
          >
            Cancelar
          </button>
          <button className={BTN} disabled={submitting || !name.trim()} onClick={submit}>
            {submitting ? "Guardando…" : initial ? "Guardar cambios" : "Crear campaña"}
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
