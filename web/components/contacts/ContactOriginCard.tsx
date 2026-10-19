"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { OriginKind } from "@worker/db/repositories/attribution.js";
import { originGroupLabel, originGroupOf, originGroupTone, originKindLabel } from "@/lib/originDisplay";
import { setContactOriginManualAction } from "@/lib/attributionActions";

/**
 * The contact record's "Origen" card (AT-2). Shows the lead origin as a FACT — its display
 * group, the campaign + ad it came from, when it was set, and the list of touches. A captured
 * origin (an ad/post, organic, booking) is immutable; only an UNSET/unknown/import origin can
 * be set by hand, and only by someone who canManage (the server action re-enforces both). The
 * manual form offers a CAMPAIGN or a free-text NOTE, because some known pre-capture ads never
 * reached the ads table. ctwa_clid is never shown.
 */

export interface ContactOriginView {
  originKind: OriginKind | null;
  originSetAt: string | null;
  originSetBy: string | null;
  ad: { externalId: string; sourceType: "ad" | "post"; headline: string | null } | null;
  campaign: { id: string; name: string } | null;
  touches: Array<{ occurredAt: string; adExternalId: string; adHeadline: string | null; sourceType: "ad" | "post" }>;
}

const SELECT =
  "h-[40px] rounded-lg border border-line-strong bg-surface px-3 text-sm text-foreground outline-none transition focus:border-foreground disabled:bg-subtle";
const TEXTAREA =
  "min-h-[3.5rem] w-full resize-y rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm text-foreground outline-none transition focus:border-foreground";
const BTN =
  "inline-flex h-[36px] items-center justify-center rounded-lg bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50";
const GHOST =
  "inline-flex h-[36px] items-center justify-center rounded-lg border border-line px-3 text-xs text-muted transition hover:bg-subtle hover:text-foreground";

const fmt = (iso: string | null): string | null =>
  iso ? new Date(iso).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : null;
const short = (id: string): string => (id.length > 6 ? `…${id.slice(-6)}` : id);

export function ContactOriginCard({
  clientId,
  contactId,
  origin,
  canManage,
  campaigns,
}: {
  clientId: string;
  contactId: string;
  origin: ContactOriginView;
  canManage: boolean;
  campaigns: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [campaignId, setCampaignId] = useState("");
  const [note, setNote] = useState("");

  const kind = origin.originKind;
  const group = originGroupOf(kind);
  // The action only sets an unset/unknown/import origin; mirror that here so a captured
  // origin never even offers the control.
  const assignable = canManage && (kind === null || kind === "unknown" || kind === "import");
  const bySystem = origin.originSetBy === "system" || origin.originSetBy === null;
  const whenLabel = fmt(origin.originSetAt);

  const save = () => {
    setError(null);
    startTransition(async () => {
      const r = await setContactOriginManualAction(clientId, contactId, {
        campaignId: campaignId || null,
        note: note.trim() || null,
      });
      if (!r.ok) setError(r.error ?? "No se pudo guardar el origen.");
      else {
        setAssigning(false);
        router.refresh();
      }
    });
  };

  return (
    <section aria-label="Origen" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <h2 className="text-[0.6875rem] font-semibold tracking-[0.06em] text-faint">ORIGEN</h2>

      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${originGroupTone(group)}`}>
          {originGroupLabel(group)}
        </span>
        <span className="text-sm text-foreground">{originKindLabel(kind)}</span>
      </div>

      {origin.campaign ? (
        <p className="text-xs text-muted">
          Campaña: <span className="text-foreground">{origin.campaign.name}</span>
        </p>
      ) : null}
      {origin.ad ? (
        <p className="text-xs text-muted">
          Anuncio: <span className="text-foreground">{origin.ad.headline || "(sin titular)"}</span>{" "}
          <span className="u-mono text-faint" title={origin.ad.externalId}>
            id {short(origin.ad.externalId)}
          </span>
        </p>
      ) : null}
      {whenLabel ? (
        <p className="text-[0.6875rem] text-faint">
          {bySystem ? "Detectado" : "Asignado"} el {whenLabel}
        </p>
      ) : null}

      {origin.touches.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-line-row pt-2">
          <p className="text-[0.6875rem] font-semibold text-faint">
            Toques ({origin.touches.length})
          </p>
          {origin.touches.map((t, i) => (
            <p key={`${t.adExternalId}-${i}`} className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted">
              <span className="truncate">{t.adHeadline || `id …${t.adExternalId.slice(-6)}`}</span>
              <span className="shrink-0 text-faint">{fmt(t.occurredAt)}</span>
            </p>
          ))}
        </div>
      ) : null}

      {assignable ? (
        assigning ? (
          <div className="flex flex-col gap-2 border-t border-line-row pt-2">
            {campaigns.length > 0 ? (
              <label className="flex flex-col gap-1">
                <span className="text-[0.6875rem] font-medium text-foreground">Campaña</span>
                <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} className={SELECT}>
                  <option value="">Sin campaña</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-medium text-foreground">Nota</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Para un origen fuera de los anuncios detectados: volante, recomendación…"
                className={TEXTAREA}
              />
            </label>
            {error ? <p role="alert" className="text-[0.6875rem] text-danger">{error}</p> : null}
            <div className="flex items-center gap-2">
              <button type="button" disabled={pending || (campaignId === "" && note.trim() === "")} onClick={save} className={BTN}>
                Guardar origen
              </button>
              <button
                type="button"
                onClick={() => {
                  setAssigning(false);
                  setError(null);
                }}
                className={GHOST}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAssigning(true)} className={`${GHOST} self-start`}>
            Asignar origen manual
          </button>
        )
      ) : null}
    </section>
  );
}
