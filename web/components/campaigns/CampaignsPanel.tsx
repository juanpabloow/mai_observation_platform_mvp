"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { OVERLAY_SCRIM, useTrappedPanel } from "@/components/ui/Overlay";
import { AD_NOTE_MAX, CAMPAIGN_BRIEF_MAX, toDateInputValue } from "@/lib/campaignsValidation";
import {
  assignAdsToCampaignAction,
  createAdAction,
  createCampaignAction,
  endCampaignAction,
  listAdLeadsAction,
  removeAdCoverAction,
  updateAdAction,
  updateCampaignAction,
  uploadAdCoverAction,
} from "@/lib/campaignsActions";
import { downscaleImage } from "@/components/scheduling/staff/StaffPhotoControl";
import { type AdGroup, groupAdsByCampaign, hasCover, shareOfGroup, tileLabel } from "@/lib/adsGallery";
import { relativeAgeShort } from "@/lib/format";
import { Alert, Button, Field as UiField, INPUT as UI_INPUT, TEXTAREA as UI_TEXTAREA, buttonClass, segmentClass, segmentShell } from "@/components/ui/controls";
import { Menu as ActionMenu, MenuButton } from "@/components/scheduling/ui/Menu";
import { ModuleSurface, RailToggle, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterRail, FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults, ReadOnlyBanner } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, ErrorSummary, MetaChip, SaveBar, countChanges, type SummaryError } from "@/components/ui/module/Editor";
import { ConfirmLayer, DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { safeAction } from "@/components/ui/module/safeAction";

/**
 * Per-client CAMPAÑAS manager (AT-2), in the module surface. Two VIEWS of the same module
 * (not sidebar destinations): ANUNCIOS (detected ads + assign to a campaign — the cover-first
 * gallery, unchanged) and CAMPAÑAS (create / edit / end a campaign with a bot brief, filtered by
 * its real state: active / paused / ended). Nothing here sends or schedules a message: campaigns
 * are attribution, and the assistant only READS the brief. `canManage` (agency/owner) gates every write control; the server
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
  /** AT-UI: when this ad last brought a lead (relative "Último lead hace…"), or null. */
  last_lead_at: string | null;
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
  "h-[44px] lg:h-[2.25rem] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle disabled:text-faint";
const BTN =
  "inline-flex h-[44px] lg:h-[2.25rem] items-center justify-center rounded-lg bg-foreground px-3.5 text-sm font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[44px] lg:h-[2.125rem] items-center justify-center rounded-lg border border-line px-3 lg:px-2.5 text-xs text-muted transition hover:bg-subtle hover:text-foreground";

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
  const [view, setView] = useUrlState("vista", "anuncios");
  const tab: Tab = view === "campanas" ? "campaigns" : "ads";
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<CampaignItem | "new" | null>(null);

  const run: Run = (fn) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? "No se pudo guardar el cambio.");
      else router.refresh();
    });
  };

  // Modal saves surface their OWN failure inside the modal (see AdModal) and the campaign
  // editor inside the editor, not in the page-level banner. On success they close + refresh.
  const refresh = useCallback(() => router.refresh(), [router]);

  const unconfigured = ads.filter((a) => !a.is_test && !a.campaign_id).length;

  if (editing) {
    return (
      <ModuleSurface label="Campañas">
        <CampaignEditor
          key={editing === "new" ? "new" : editing.id}
          clientId={clientId}
          clientName={clientName}
          initial={editing === "new" ? null : editing}
          services={services}
          promotions={promotions}
          onClose={(saved) => {
            const key = editing === "new" ? "new" : editing.id;
            setEditing(null);
            if (saved) refresh();
            returnFocus(key);
          }}
        />
      </ModuleSurface>
    );
  }

  return (
    <ModuleSurface label="Campañas">
      <SurfaceTop
        title="Campañas"
        summary="Los anuncios de Meta que detectamos, agrupados en campañas que el asistente entiende. Desde aquí no se envía ningún mensaje."
        actions={
          isAgency ? (
            <Link href={`/clients/${clientId}/campaigns/settings`} className={buttonClass()}>
              Configuración
            </Link>
          ) : null
        }
        primary={
          canManage && tab === "campaigns" ? (
            <Button variant="primary" data-open-key="new" onClick={() => setEditing("new")}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Nueva campaña
            </Button>
          ) : null
        }
      >
        <div role="group" aria-label="Vista" className={segmentShell()}>
          <button type="button" aria-pressed={tab === "ads"} onClick={() => setView("anuncios")} className={segmentClass(tab === "ads")}>
            Anuncios
            {unconfigured ? (
              <span title="Sin configurar" className="ml-1.5 rounded bg-warn-soft px-1.5 text-[0.6875rem] text-warn">
                {unconfigured}
              </span>
            ) : null}
          </button>
          <button type="button" aria-pressed={tab === "campaigns"} onClick={() => setView("campanas")} className={segmentClass(tab === "campaigns")}>
            Campañas · {campaigns.length}
          </button>
        </div>
      </SurfaceTop>

      {!canManage ? <ReadOnlyBanner>Puedes ver los anuncios y las campañas. Crearlos, editarlos o asignarlos lo hace la persona responsable del negocio.</ReadOnlyBanner> : null}
      {error ? (
        <div className="px-4 pt-3 sm:px-6">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {tab === "ads" ? (
        <AdsTab clientId={clientId} canManage={canManage} ads={ads} campaigns={campaigns} run={run} pending={pending} refresh={refresh} />
      ) : (
        <CampaignsTab clientId={clientId} canManage={canManage} campaigns={campaigns} services={services} promotions={promotions} run={run} pending={pending} onEdit={setEditing} />
      )}
    </ModuleSurface>
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
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdItem | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
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
  const groups = useMemo(() => groupAdsByCampaign(visible), [visible]);
  const noRealAds = ads.filter((a) => !a.is_test).length === 0;
  // The panel reads the ad from the live list by id, so a refresh (edit / assign / cover) flows in.
  const detailAd = detailId ? ads.find((a) => a.id === detailId) ?? null : null;

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };

  const bulkAssign = (campaignId: string | null) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    run(async () => {
      const r = await safeAction(() => assignAdsToCampaignAction(clientId, ids, campaignId));
      if (r.ok) exitSelect();
      return r;
    });
  };

  return (
    <div aria-label="Anuncios detectados" className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full w-full flex-col gap-2.5 p-3 sm:p-4">
        {noRealAds && !showTest ? (
          <div className="flex min-h-72 flex-1 flex-col items-center justify-center px-4 py-12 text-center">
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
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="shrink-0 text-xs text-muted">
                {visible.length} anuncio{visible.length === 1 ? "" : "s"}
              </span>
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

            {selectMode && canManage ? (
              <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
                <span className="u-mono text-xs text-muted">
                  {selected.size} seleccionado{selected.size === 1 ? "" : "s"}
                </span>
                <select
                  aria-label="Asignar seleccionados a una campaña"
                  disabled={pending || selected.size === 0}
                  className={INPUT}
                  defaultValue=""
                  onChange={(e) => {
                    const v = e.target.value;
                    e.target.value = "";
                    if (v === "") return;
                    bulkAssign(v === "__none__" ? null : v);
                  }}
                >
                  <option value="" disabled>Asignar a…</option>
                  {assignable.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                  <option value="__none__">Quitar de la campaña</option>
                </select>
                <button type="button" className={`${GHOST} ml-auto`} onClick={exitSelect}>
                  Cancelar
                </button>
              </div>
            ) : null}

            {groups.map((group) => (
              <AdGroupSection
                key={group.key ?? "__none__"}
                group={group}
                canManage={canManage}
                selectMode={selectMode}
                selected={selected}
                onToggleSelect={toggle}
                onEnterSelect={() => setSelectMode(true)}
                onExitSelect={exitSelect}
                onOpenDetail={setDetailId}
              />
            ))}
            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
                <p className="text-xs text-muted">Ningún anuncio coincide con la búsqueda.</p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {creating ? (
        <AdModal
          mode="create"
          clientId={clientId}
          campaigns={assignable}
          onClose={() => setCreating(false)}
          onSubmit={async (values, coverFile) => {
            const r = await safeAction(() => createAdAction({ clientId, ...values }));
            // Create first, then attach the staged cover to the new ad id. A cover failure never
            // undoes the created ad (the person can add the cover later from the edit modal).
            if (r.ok && r.id && coverFile) {
              const fd = new FormData();
              fd.set("clientId", clientId);
              fd.set("adId", r.id);
              fd.set("image", coverFile);
              await safeAction(() => uploadAdCoverAction(fd));
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
            const r = await safeAction(() => updateAdAction(clientId, editing.id, { name: values.name, botNote: values.botNote }));
            if (r.ok) {
              setEditing(null);
              refresh();
            }
            return r;
          }}
        />
      ) : null}

      {detailAd ? (
        <AdDetailPanel
          key={detailAd.id}
          ad={detailAd}
          clientId={clientId}
          canManage={canManage}
          campaigns={assignable}
          run={run}
          pending={pending}
          refresh={refresh}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            const a = detailAd;
            setDetailId(null);
            setEditing(a);
          }}
        />
      ) : null}
    </div>
  );
}

// A campaign group: header (name + totals + Seleccionar toggle; a prompt for the unassigned group)
// and a responsive grid of cover-first tiles.
function AdGroupSection({
  group,
  canManage,
  selectMode,
  selected,
  onToggleSelect,
  onEnterSelect,
  onExitSelect,
  onOpenDetail,
}: {
  group: AdGroup<AdItem>;
  canManage: boolean;
  selectMode: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onEnterSelect: () => void;
  onExitSelect: () => void;
  onOpenDetail: (id: string) => void;
}) {
  const title = group.isUnassigned ? "Sin campaña" : group.name ?? "Campaña";
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-3 py-2 ${group.isUnassigned ? "bg-warn-soft" : "bg-subtle/60"}`}>
        <h2 className={`text-sm font-semibold ${group.isUnassigned ? "text-warn" : "text-foreground"}`}>{title}</h2>
        <span className="u-mono text-[0.6875rem] text-faint">
          {group.totalLeads} lead{group.totalLeads === 1 ? "" : "s"} · {group.adCount} anuncio{group.adCount === 1 ? "" : "s"}
        </span>
        {canManage ? (
          <button type="button" aria-pressed={selectMode} onClick={() => (selectMode ? onExitSelect() : onEnterSelect())} className={`${GHOST} ml-auto`}>
            {selectMode ? "Listo" : "Seleccionar"}
          </button>
        ) : null}
        {group.isUnassigned ? (
          <p className="basis-full text-xs text-muted">Asigna estos anuncios a una campaña para que el asistente los reconozca.</p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:[grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
        {group.ads.map((ad) => (
          <AdTile
            key={ad.id}
            ad={ad}
            groupLeads={group.totalLeads}
            groupIsUnassigned={group.isUnassigned}
            canManage={canManage}
            selectMode={selectMode}
            selected={selected.has(ad.id)}
            onToggleSelect={() => onToggleSelect(ad.id)}
            onOpenDetail={() => onOpenDetail(ad.id)}
          />
        ))}
      </div>
    </section>
  );
}

// The tile: the creative cover is the dominant element (opens the creative); the body below opens
// the detail panel. Both are reachable by keyboard and touch (no hover-only affordances).
function AdTile({
  ad,
  groupLeads,
  groupIsUnassigned,
  canManage,
  selectMode,
  selected,
  onToggleSelect,
  onOpenDetail,
}: {
  ad: AdItem;
  groupLeads: number;
  groupIsUnassigned: boolean;
  canManage: boolean;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpenDetail: () => void;
}) {
  const label = tileLabel(ad);
  const creativeHref = ad.video_url ?? ad.source_url;
  const isVideo = !!ad.video_url;
  const withCover = hasCover(ad);
  const sharePct = Math.round(shareOfGroup(ad.leads, groupLeads) * 100);
  const shareWhat = groupIsUnassigned ? "los anuncios sin campaña" : "la campaña";
  return (
    <article className="relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface">
      {selectMode && canManage ? (
        <label className="absolute left-2 top-2 z-20 flex items-center justify-center rounded-md border border-line-strong bg-surface/90 p-1 shadow-sm">
          <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Seleccionar ${label}`} className="size-4" />
        </label>
      ) : null}

      <div className="relative aspect-[4/5] w-full bg-subtle">
        {withCover ? (
          creativeHref ? (
            <a href={creativeHref} target="_blank" rel="noreferrer noopener" aria-label={`Ver el anuncio ${label} en Facebook`} className="u-focus block size-full">
              {/* eslint-disable-next-line @next/next/no-img-element -- the ad's own cover (R2 public bucket) */}
              <img src={ad.cover_url!} alt={label} loading="lazy" className="size-full object-cover" />
            </a>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- the ad's own cover (R2 public bucket)
            <img src={ad.cover_url!} alt={label} loading="lazy" className="size-full object-cover" />
          )
        ) : (
          <button type="button" onClick={onOpenDetail} className="u-focus flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
            <span className="line-clamp-4 text-sm font-medium text-foreground">{ad.headline || label}</span>
            {canManage ? <span className="text-xs text-accent underline underline-offset-2">Subir portada</span> : null}
          </button>
        )}

        {withCover && isVideo ? (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white">
              <svg viewBox="0 0 24 24" className="size-5" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            </span>
          </span>
        ) : null}

        {ad.source_type === "post" ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-surface/90 px-2 py-0.5 text-[0.625rem] font-medium text-muted">Publicación</span>
        ) : null}
        {ad.is_test ? (
          <span className="absolute bottom-2 right-2 rounded-full bg-warn-soft px-2 py-0.5 text-[0.625rem] font-medium text-warn">Prueba</span>
        ) : null}
        {ad.bot_note ? (
          <span title="Tiene una nota para el asistente" aria-label="Tiene una nota para el asistente" className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-surface/90 text-muted">
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </span>
        ) : null}
      </div>

      <button type="button" onClick={onOpenDetail} aria-label={`Ver detalle de ${label}`} className="u-focus flex flex-1 flex-col items-start gap-1.5 p-2.5 text-left transition-colors hover:bg-subtle/40">
        <span className="line-clamp-1 w-full text-sm font-medium text-foreground">{label}</span>
        <span className="text-lg font-semibold leading-none tabular-nums text-foreground">
          {ad.leads}
          <span className="ml-1 text-xs font-normal text-muted">lead{ad.leads === 1 ? "" : "s"}</span>
        </span>
        <span role="img" aria-label={`${sharePct}% de los leads de ${shareWhat}`} className="block h-1.5 w-full overflow-hidden rounded-full bg-chip">
          <span className="block h-full rounded-full bg-accent" style={{ width: `${sharePct}%` }} />
        </span>
        {ad.last_lead_at ? (
          <time dateTime={ad.last_lead_at} title={fmtDate(ad.last_lead_at)} className="text-[0.6875rem] text-faint">Último lead {relativeAgeShort(ad.last_lead_at)}</time>
        ) : (
          <span className="text-[0.6875rem] text-faint">Sin leads todavía</span>
        )}
      </button>
    </article>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <p className="whitespace-pre-wrap text-sm text-muted">{children}</p>
    </div>
  );
}

// The detail panel: large (uncropped) cover, full copy + note, campaign, Meta id (copy), lead/touch
// explanation, the ad's leads linking to each contact, and — for editors — edit / assign / cover.
function AdDetailPanel({
  ad,
  clientId,
  canManage,
  campaigns,
  run,
  pending,
  refresh,
  onClose,
  onEdit,
}: {
  ad: AdItem;
  clientId: string;
  canManage: boolean;
  campaigns: CampaignItem[];
  run: Run;
  pending: boolean;
  refresh: () => void;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [leads, setLeads] = useState<Array<{ id: string; name: string | null; occurredAt: string }> | null>(null);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  const close = useCallback(() => closeRef.current(), []);
  const panelRef = useTrappedPanel({ active: true, onClose: close });

  // The panel is keyed by ad id, so state starts fresh per ad; the effect only fetches (no
  // synchronous setState in the effect body — see the set-state-in-effect lint rule).
  useEffect(() => {
    let alive = true;
    listAdLeadsAction(clientId, ad.id)
      .then((r) => { if (!alive) return; if (r.ok) setLeads(r.leads); else setLeadsError(r.error); })
      .catch(() => { if (alive) setLeadsError("No se pudieron cargar los leads."); });
    return () => { alive = false; };
  }, [clientId, ad.id]);

  const label = tileLabel(ad);
  const creativeHref = ad.video_url ?? ad.source_url;
  const firstLead = leads && leads.length ? leads[leads.length - 1].occurredAt : null;
  const lastLead = leads && leads.length ? leads[0].occurredAt : ad.last_lead_at ?? null;
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(ad.external_id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the id is shown in full beside the button */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-5">
      <button type="button" aria-label={`Cerrar ${label}`} className={OVERLAY_SCRIM} onClick={close} />
      <section ref={panelRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className="relative z-50 flex max-h-[min(900px,calc(100dvh-2rem))] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface sm:max-w-3xl sm:rounded-2xl">
        <header className="flex shrink-0 items-start gap-4 border-b border-line px-4 py-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-foreground">{label}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>{ad.source_type === "post" ? "Publicación" : "Anuncio"}</span>
              {ad.campaign_name ? <span>· {ad.campaign_name}</span> : <span className="text-warn">· Sin campaña</span>}
              {ad.is_test ? <span className="text-warn">· Prueba</span> : null}
            </p>
          </div>
          <button type="button" onClick={close} aria-label="Cerrar" className="flex size-9 shrink-0 items-center justify-center rounded-lg text-lg text-muted transition hover:bg-subtle hover:text-foreground">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-5 sm:grid-cols-[minmax(0,260px)_1fr]">
            <div className="flex flex-col gap-3">
              <div className="overflow-hidden rounded-xl border border-line bg-subtle">
                {hasCover(ad) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- the ad's own cover (R2 public bucket)
                  <img src={ad.cover_url!} alt={label} className="max-h-[50vh] w-full object-contain" />
                ) : (
                  <div className="flex aspect-[4/5] w-full items-center justify-center p-4 text-center">
                    <span className="text-sm font-medium text-foreground">{ad.headline || label}</span>
                  </div>
                )}
              </div>
              {creativeHref ? (
                <a href={creativeHref} target="_blank" rel="noreferrer noopener" className="u-focus inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
                  Ver anuncio ↗
                </a>
              ) : null}
              {canManage ? <AdCoverControl clientId={clientId} adId={ad.id} coverUrl={ad.cover_url} onChanged={refresh} /> : null}
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-5">
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-foreground">{ad.leads}</div>
                  <div className="text-xs text-muted">lead{ad.leads === 1 ? "" : "s"}</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold tabular-nums text-foreground">{ad.touches}</div>
                  <div className="text-xs text-muted">contacto{ad.touches === 1 ? "" : "s"}</div>
                </div>
              </div>
              {ad.touches !== ad.leads ? (
                <p className="text-xs text-muted">«Leads» son las personas cuyo primer contacto fue este anuncio; «contactos» cuenta cada vez que alguien escribió desde él (una misma persona puede volver).</p>
              ) : null}

              <div className="flex flex-col gap-1 text-xs text-muted">
                <span>Primer lead: {firstLead ? fmtDate(firstLead) : leads ? "—" : "…"}</span>
                <span>Último lead: {lastLead ? fmtDate(lastLead) : "Sin leads todavía"}</span>
              </div>

              {ad.headline ? <Detail label="Titular">{ad.headline}</Detail> : null}
              {ad.body ? <Detail label="Texto del anuncio">{ad.body}</Detail> : null}
              {ad.bot_note ? <Detail label="Nota para el asistente">{ad.bot_note}</Detail> : null}

              {canManage ? (
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-foreground">Campaña</span>
                  <select value={ad.campaign_id ?? ""} disabled={pending} className={`${INPUT} w-full`} onChange={(e) => { const v = e.target.value; run(() => assignAdsToCampaignAction(clientId, [ad.id], v === "" ? null : v)); }}>
                    <option value="">Sin campaña</option>
                    {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">Id de Meta</span>
                <div className="flex items-center gap-2">
                  <code className="u-mono min-w-0 flex-1 truncate rounded-md bg-chip px-2 py-1 text-xs text-muted">{ad.external_id}</code>
                  <button type="button" onClick={copyId} className={GHOST}>{copied ? "Copiado" : "Copiar"}</button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-foreground">Leads de este anuncio</span>
                {leads === null && !leadsError ? <p className="text-xs text-muted">Cargando…</p> : null}
                {leadsError ? <p role="alert" className="text-xs text-danger">{leadsError}</p> : null}
                {leads && leads.length === 0 ? <p className="text-xs text-muted">Sin leads todavía.</p> : null}
                {leads && leads.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line">
                    {leads.map((l) => (
                      <li key={l.id}>
                        <Link href={`/clients/${clientId}/contacts/${l.id}`} className="u-focus flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-subtle">
                          <span className="truncate text-foreground">{l.name?.trim() || "Contacto sin nombre"}</span>
                          <time dateTime={l.occurredAt} className="shrink-0 text-xs text-faint">{relativeAgeShort(l.occurredAt)}</time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              {canManage ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <button type="button" className={BTN} onClick={onEdit} aria-haspopup="dialog">Editar nombre y nota</button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </div>
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
            className="inline-flex h-[44px] items-center justify-center rounded-lg border border-line-strong px-3.5 text-sm font-medium text-foreground transition hover:bg-subtle lg:h-[2.25rem]"
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
  onChanged,
}: {
  clientId: string;
  adId: string | null;
  coverUrl: string | null;
  onStage?: (file: File | null) => void;
  /** Edit mode only: fired after a successful upload/remove so the opener can refresh the grid. */
  onChanged?: () => void;
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
        const r = await safeAction(() => uploadAdCoverAction(fd));
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setPreview(r.url ?? null);
        onChanged?.();
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
        const r = await safeAction(() => removeAdCoverAction(clientId, adId));
        if (!r.ok) {
          setError(r.error);
          return;
        }
        onChanged?.();
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
            className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] border border-line-strong bg-surface px-3.5 text-sm text-foreground disabled:opacity-60 md:min-h-[2.25rem]"
          >
            {pending ? "Guardando…" : preview ? "Cambiar portada" : "Subir portada"}
          </button>
          {preview ? (
            <button
              type="button"
              disabled={pending}
              onClick={remove}
              className="u-focus inline-flex min-h-[44px] items-center rounded-[12px] px-3 text-sm text-muted underline underline-offset-2 disabled:opacity-60 md:min-h-[2.25rem]"
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

// ── Campaigns tab ─────────────────────────────────────────────────────────────────
const CAMPAIGN_COLUMNS: ListColumn[] = [
  { key: "name", label: "Campaña" },
  { key: "ads", label: "Anuncios", className: "w-[6rem]" },
  { key: "dates", label: "Fechas", className: "hidden w-[22%] lg:table-cell" },
  { key: "target", label: "Objetivo", className: "hidden w-[18%] xl:table-cell" },
  { key: "status", label: "Estado", className: "w-[7rem]" },
];

function CampaignsTab({
  clientId,
  canManage,
  campaigns,
  services,
  promotions,
  run,
  pending,
  onEdit,
}: {
  clientId: string;
  canManage: boolean;
  campaigns: CampaignItem[];
  services: Option[];
  promotions: Option[];
  run: Run;
  pending: boolean;
  onEdit: (c: CampaignItem | "new") => void;
}) {
  const [filter, setFilter] = useUrlState("estado", "");
  const [query, setQuery] = useUrlState("q", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [ending, setEnding] = useState<CampaignItem | null>(null);
  const serviceName = useMemo(() => new Map(services.map((s) => [s.id, s.name])), [services]);
  const promoName = useMemo(() => new Map(promotions.map((p) => [p.id, p.name])), [promotions]);
  const st = filter === "active" || filter === "paused" || filter === "ended" ? filter : "";
  const q = query.trim().toLocaleLowerCase("es");
  const shown = campaigns.filter((c) => (!st || c.status === st) && (!q || c.name.toLocaleLowerCase("es").includes(q)));
  const count = (s: CampaignItem["status"]) => campaigns.filter((c) => c.status === s).length;
  const groups: FilterGroup[] = [
    {
      label: "Estado",
      options: [
        { value: "", label: "Todas", count: campaigns.length },
        { value: "active", label: "Activa", count: count("active") },
        { value: "paused", label: "En pausa", count: count("paused") },
        { value: "ended", label: "Finalizada", count: count("ended") },
      ],
    },
  ];
  const target = (c: CampaignItem) =>
    [c.target_service_id ? serviceName.get(c.target_service_id) : null, c.promotion_id ? promoName.get(c.promotion_id) : null].filter(Boolean).join(" · ") || "Sin objetivo";
  const dates = (c: CampaignItem) => (c.start_date || c.end_date ? `${fmtDate(c.start_date)} → ${fmtDate(c.end_date)}` : "Sin fechas");

  const rowMenu = (c: CampaignItem, at: "t" | "m") =>
    canManage ? (
      <ActionMenu label={`Acciones de ${c.name}`} open={menu === `${at}:${c.id}`} onToggle={() => setMenu(menu === `${at}:${c.id}` ? null : `${at}:${c.id}`)} onClose={() => setMenu(null)}>
        <MenuButton
          onClick={() => {
            setMenu(null);
            onEdit(c);
          }}
        >
          Editar
        </MenuButton>
        {c.status !== "ended" ? (
          <MenuButton
            disabled={pending}
            onClick={() => {
              setMenu(null);
              setEnding(c);
            }}
          >
            Finalizar
          </MenuButton>
        ) : null}
      </ActionMenu>
    ) : null;

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">
        <RailToggle />
        <SearchField value={query} onChange={setQuery} label="Buscar campaña" />
        <FilterSelect groups={groups} value={st} onChange={setFilter} label="Estado" className="w-full sm:w-auto sm:min-w-[12rem]" />
      </div>
      <SurfaceBody rail={<FilterRail groups={groups} value={st} onChange={setFilter} />} railLabel="Estado de las campañas">
        {campaigns.length === 0 ? (
          <EmptyState title="Aún no hay campañas" body="Crea una campaña, escribe un brief para el asistente y asígnale los anuncios que la representan.">
            {canManage ? (
              <Button variant="primary" onClick={() => onEdit("new")}>
                Nueva campaña
              </Button>
            ) : null}
          </EmptyState>
        ) : shown.length === 0 ? (
          <NoResults>
            {q ? <Button onClick={() => setQuery("")}>Borrar búsqueda</Button> : null}
            {st ? <Button onClick={() => setFilter("")}>Ver todas</Button> : null}
          </NoResults>
        ) : (
          <>
            <ListTable label="Campañas" columns={CAMPAIGN_COLUMNS} withMenu={canManage}>
              <ListGroup span={CAMPAIGN_COLUMNS.length + (canManage ? 1 : 0)}>
                {shown.map((c) => (
                  <ListRow
                    key={c.id}
                    columns={CAMPAIGN_COLUMNS}
                    name={c.name}
                    openKey={c.id}
                    onOpen={canManage ? () => onEdit(c) : undefined}
                    openLabel="Editar"
                    raised={menu === `t:${c.id}`}
                    menu={canManage ? rowMenu(c, "t") : undefined}
                    dimmed={c.status === "ended"}
                    cells={[
                      <span key="n" className="flex min-w-0 flex-col py-1.5">
                        <span className="truncate">{c.name}</span>
                        <span className="truncate text-[0.7812rem] font-normal text-muted">{c.bot_brief || "Sin brief para el asistente"}</span>
                      </span>,
                      <span key="a" className="tabular-nums">
                        {c.ad_count} anuncio{c.ad_count === 1 ? "" : "s"}
                      </span>,
                      <span key="d" className="text-muted">{dates(c)}</span>,
                      <span key="t" className="text-muted">{target(c)}</span>,
                      <StatusChip key="s" status={c.status} />,
                    ]}
                  />
                ))}
              </ListGroup>
            </ListTable>
            <MobileList>
              <MobileGroup>
                {shown.map((c) => (
                  <MobileRow
                    key={c.id}
                    title={c.name}
                    openKey={c.id}
                    subtitle={`${c.ad_count} anuncio${c.ad_count === 1 ? "" : "s"} · ${dates(c)}`}
                    badges={<StatusChip status={c.status} />}
                    onOpen={canManage ? () => onEdit(c) : undefined}
                    openLabel="Editar"
                    menu={rowMenu(c, "m")}
                    dimmed={c.status === "ended"}
                  />
                ))}
              </MobileGroup>
            </MobileList>
            <ListFoot>
              Mostrando {shown.length} campaña{shown.length === 1 ? "" : "s"}. El asistente lee el brief cuando alguien escribe desde un anuncio de la campaña.
            </ListFoot>
          </>
        )}
      </SurfaceBody>
      {ending ? (
        <ConfirmLayer
          id="campaign-end"
          title={`¿Finalizar «${ending.name}»?`}
          body="Pasa a «Finalizada» y, si no tenía fecha de fin, se le pone la de hoy. No se envía ningún mensaje ni se borran sus anuncios."
          confirmLabel="Finalizar"
          tone="primary"
          onCancel={() => setEnding(null)}
          onConfirm={() => {
            const id = ending.id;
            setEnding(null);
            run(() => endCampaignAction(clientId, id));
          }}
        />
      ) : null}
    </>
  );
}

function StatusChip({ status }: { status: CampaignItem["status"] }) {
  const cls = status === "active" ? "bg-success/15 text-success" : status === "paused" ? "bg-warn-soft text-warn" : "bg-chip text-muted";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${cls}`}>{STATUS_LABEL[status]}</span>;
}

interface CampaignForm {
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  externalId: string;
  serviceId: string;
  promotionId: string;
  brief: string;
}

/** The in-page campaign editor — the same fields and the same server validation as the
 *  modal it replaces; every failure stays in the editor, with what was typed. */
function CampaignEditor({
  clientId,
  clientName,
  initial,
  services,
  promotions,
  onClose,
}: {
  clientId: string;
  clientName: string;
  initial: CampaignItem | null;
  services: Option[];
  promotions: Option[];
  onClose: (saved: boolean) => void;
}) {
  const start = useMemo<CampaignForm>(
    () => ({
      name: initial?.name ?? "",
      status: initial?.status ?? "active",
      // Accept whatever shape the stored date arrives in (YYYY-MM-DD, full ISO, or a Date) →
      // the YYYY-MM-DD an <input type="date"> binds to.
      startDate: toDateInputValue(initial?.start_date),
      endDate: toDateInputValue(initial?.end_date),
      externalId: initial?.external_campaign_id ?? "",
      serviceId: initial?.target_service_id ?? "",
      promotionId: initial?.promotion_id ?? "",
      brief: initial?.bot_brief ?? "",
    }),
    [initial],
  );
  const [f, setF] = useState<CampaignForm>(start);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);
  const changes = countChanges(start, f);
  const set = <K extends keyof CampaignForm>(k: K, v: CampaignForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => onClose(saved.current) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };
  const nameError = attempted && !f.name.trim() ? "Escribe el nombre de la campaña." : "";
  const datesError = attempted && f.startDate && f.endDate && f.endDate < f.startDate ? "La fecha de fin no puede ser anterior a la de inicio." : "";

  const save = async () => {
    setAttempted(true);
    if (!f.name.trim() || (f.startDate && f.endDate && f.endDate < f.startDate)) return;
    setSaving(true);
    setError(null);
    const values = {
      name: f.name.trim(),
      status: f.status,
      startDate: f.startDate.trim() === "" ? null : f.startDate.trim(),
      endDate: f.endDate.trim() === "" ? null : f.endDate.trim(),
      externalCampaignId: f.externalId.trim() === "" ? null : f.externalId.trim(),
      targetServiceId: f.serviceId === "" ? null : f.serviceId,
      promotionId: f.promotionId === "" ? null : f.promotionId,
      botBrief: f.brief.trim() === "" ? null : f.brief,
    };
    try {
      const r = initial ? await safeAction(() => updateCampaignAction(clientId, initial.id, values)) : await safeAction(() => createCampaignAction({ clientId, ...values }));
      setSaving(false);
      if (!r.ok) {
        setError(`${r.error ?? "No se pudo guardar. Revisa los datos e inténtalo de nuevo."} Lo que escribiste se conserva.`);
        return;
      }
      saved.current = true;
      guard.leave();
    } catch {
      setSaving(false);
      setError("No se pudo guardar. Inténtalo de nuevo; lo que escribiste se conserva.");
    }
  };

  const summary: SummaryError[] = [
    ...(nameError ? [{ target: "cmp-f-name", message: `Nombre: ${nameError}` }] : []),
    ...(datesError ? [{ target: "cmp-f-end", message: `Fechas: ${datesError}` }] : []),
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
        title={initial ? initial.name : "Nueva campaña"}
        headingId="cmp-editor-title"
        status={initial ? <StatusChip status={initial.status} /> : null}
        eyebrow={initial ? "Editar campaña" : `Presencia y marketing · Campañas · ${clientName}`}
        chips={initial ? <MetaChip>{`${initial.ad_count} anuncio${initial.ad_count === 1 ? "" : "s"}`}</MetaChip> : null}
        backLabel="Volver a Campañas"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={initial ? "Guardar cambios" : "Crear campaña"}
        saving={saving}
        canSave={initial ? changes > 0 : true}
      />
      <EditorFrame
        sections={[
          { id: "cmp-basic", label: "Información básica", dirty: start.name !== f.name || start.status !== f.status, errors: nameError ? 1 : 0 },
          { id: "cmp-dates", label: "Fechas", dirty: start.startDate !== f.startDate || start.endDate !== f.endDate, errors: datesError ? 1 : 0 },
          { id: "cmp-target", label: "Objetivo", dirty: start.serviceId !== f.serviceId || start.promotionId !== f.promotionId || start.externalId !== f.externalId },
          { id: "cmp-brief", label: "Brief para el asistente", dirty: start.brief !== f.brief },
        ]}
        saveBar={<SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={initial ? "Guardar" : "Crear"} canSave={initial ? changes > 0 : true} />}
      >
        <ErrorSummary errors={summary} />
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <EditorSection id="cmp-basic" title="Información básica" summary={`${f.name || "Sin nombre"} · ${STATUS_LABEL[f.status as CampaignItem["status"]] ?? f.status}`}>
          <UiField label="Nombre" error={nameError}>
            <input id="cmp-f-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej. Asesoría gratis — octubre" aria-invalid={Boolean(nameError)} className={UI_INPUT} />
          </UiField>
          <UiField label="Estado" hint="Activa, En pausa o Finalizada. Cambiar el estado no envía mensajes.">
            <select value={f.status} onChange={(e) => set("status", e.target.value)} className={UI_INPUT}>
              <option value="active">Activa</option>
              <option value="paused">En pausa</option>
              <option value="ended">Finalizada</option>
            </select>
          </UiField>
        </EditorSection>
        <EditorSection id="cmp-dates" title="Fechas" description="Opcionales: el periodo de la campaña en Meta." summary={f.startDate || f.endDate ? `${fmtDate(f.startDate || null)} → ${fmtDate(f.endDate || null)}` : "Sin fechas"}>
          <div className="grid gap-4 sm:grid-cols-2">
            <UiField label="Inicio" optional>
              <input type="date" value={f.startDate} onChange={(e) => set("startDate", e.target.value)} className={UI_INPUT} />
            </UiField>
            <UiField label="Fin" optional error={datesError}>
              <input id="cmp-f-end" type="date" value={f.endDate} onChange={(e) => set("endDate", e.target.value)} aria-invalid={Boolean(datesError)} className={UI_INPUT} />
            </UiField>
          </div>
        </EditorSection>
        <EditorSection id="cmp-target" title="Objetivo" description="Qué se promociona. Opcional." summary={[services.find((s) => s.id === f.serviceId)?.name, promotions.find((p) => p.id === f.promotionId)?.name].filter(Boolean).join(" · ") || "Sin objetivo"} defaultOpen={false}>
          <div className="grid gap-4 sm:grid-cols-2">
            <UiField label="Servicio objetivo" optional>
              <select value={f.serviceId} onChange={(e) => set("serviceId", e.target.value)} className={UI_INPUT}>
                <option value="">Ninguno</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </UiField>
            <UiField label="Promoción" optional hint="El asistente solo la menciona si está vigente.">
              <select value={f.promotionId} onChange={(e) => set("promotionId", e.target.value)} className={UI_INPUT}>
                <option value="">Ninguna</option>
                {promotions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </UiField>
          </div>
          <UiField label="Id de campaña de Meta" optional hint="En Ads Manager → Campañas, agrega la columna «ID de la campaña».">
            <input value={f.externalId} onChange={(e) => set("externalId", e.target.value)} className={UI_INPUT} />
          </UiField>
        </EditorSection>
        <EditorSection id="cmp-brief" title="Brief para el asistente" description="Lo que escribas aquí lo lee el asistente cuando alguien escribe desde un anuncio de esta campaña." summary={f.brief ? `${f.brief.length} caracteres` : "Sin brief"} defaultOpen={false}>
          <UiField label="Brief" optional hint={`${f.brief.length}/${CAMPAIGN_BRIEF_MAX}`}>
            <textarea value={f.brief} onChange={(e) => set("brief", e.target.value)} rows={5} maxLength={CAMPAIGN_BRIEF_MAX} placeholder="Qué promete el anuncio, a quién va dirigido, condiciones…" className={UI_TEXTAREA} />
          </UiField>
        </EditorSection>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Hay cambios sin guardar en esta campaña. Si sales ahora, se pierden." /> : null}
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
