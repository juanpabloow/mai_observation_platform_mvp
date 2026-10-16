"use client";

import { useState, useTransition } from "react";
import {
  applyImportAction,
  listPlatformReviewsAction,
  planImportAction,
  redactCommentAction,
  resolveRequestAction,
  reviewProvenanceAction,
  searchSitesAction,
  setPublicationAction,
  type PlanView,
} from "@/lib/platformReviewActions";
import type { ImportMapping } from "@/lib/externalReviewImport";
import type { PlatformExternalReviewRow } from "@worker/db/repositories/scheduling/externalReviews.js";
import { PageShell } from "@/components/ui/PageShell";
import { Alert, Button, CARD, Field, INPUT, TEXTAREA } from "../scheduling/ui/system";

/**
 * PLATFORM — Fresha reviews. Three steps, all server-checked (platformReviewActions.ts):
 *   1. pick the SITE (any tenant — this is the platform);
 *   2. upload the file → DRY-RUN (nothing written): valid / rejected / duplicate rows and
 *      the equivalences to CONFIRM, one by one (an id or "Sin atribuir"); then import —
 *      every row enters pending, provenance pending, invisible to the public;
 *   3. review provenance per review (with notes), then publish or hide; redact the public
 *      text for privacy (recorded); resolve the business's requests.
 *
 * "Procedencia revisada" means an M_AI administrator checked the evidence by hand. It is
 * not a cryptographic proof and the page never calls the review "verificada".
 */

type Choice = "" | "null" | string; // "" = not confirmed yet

const fmt = (d: string | Date) => new Date(d).toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" });

export function PlatformReviews() {
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  const [sites, setSites] = useState<Array<{ id: string; name: string; slug: string; client_name: string }>>([]);
  const [site, setSite] = useState<{ id: string; name: string; slug: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [staffMap, setStaffMap] = useState<Record<string, Choice>>({});
  const [serviceMap, setServiceMap] = useState<Record<string, Choice>>({});
  /** Equivalences changed since the last dry-run: importing needs a fresh review first. */
  const [dirty, setDirty] = useState(false);
  const [reviews, setReviews] = useState<PlatformExternalReviewRow[] | null>(null);

  const search = () =>
    start(async () => {
      setError(null);
      const r = await searchSitesAction(q);
      if (r.ok) setSites(r.sites);
      else setError(r.error);
    });
  const loadReviews = (siteId: string) =>
    start(async () => {
      const r = await listPlatformReviewsAction(siteId);
      if (r.ok) setReviews(r.reviews);
      else setError(r.error);
    });
  const pick = (s: { id: string; name: string; slug: string }) => {
    setSite(s);
    setPlan(null);
    setFile(null);
    setNotice(null);
    loadReviews(s.id);
  };

  const mappingFrom = (p: PlanView): ImportMapping => {
    const conv = (m: Record<string, Choice>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== "").map(([k, v]) => [k, v === "null" ? null : v]));
    return { site: p.site.slug, staff: conv(staffMap), services: conv(serviceMap) };
  };
  const formData = (withMapping: PlanView | null) => {
    const fd = new FormData();
    if (file) fd.set("file", file);
    if (withMapping) fd.set("mapping", JSON.stringify(mappingFrom(withMapping)));
    return fd;
  };
  const review = (withMapping: PlanView | null) =>
    start(async () => {
      if (!site || !file) return;
      setError(null);
      setNotice(null);
      const r = await planImportAction(site.id, formData(withMapping));
      if (!r.ok) return setError(r.error);
      setPlan(r);
      setDirty(false);
      if (!withMapping) {
        // NOTHING is pre-selected: every artist and service starts unconfirmed. Exact-name
        // suggestions are shown next to each one and applied only by an explicit click.
        setStaffMap(Object.fromEntries(Object.keys(r.plan.proposedMapping.staff).map((k) => [k, ""])));
        setServiceMap(Object.fromEntries(Object.keys(r.plan.proposedMapping.services).map((k) => [k, ""])));
      }
    });
  const apply = () =>
    start(async () => {
      if (!site || !file || !plan) return;
      const fd = formData(plan);
      fd.set("expectSha256", plan.sha256);
      const r = await applyImportAction(site.id, fd);
      if (!r.ok) return setError(r.error);
      setNotice(`Importadas ${r.inserted} reseñas como pendientes (no públicas). Omitidas por repetidas: ${r.skipped}.`);
      setPlan(null);
      setFile(null);
      loadReviews(site.id);
    });
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "No se pudo completar.");
      if (site) loadReviews(site.id);
    });

  const suggested = plan
    ? {
        staff: Object.fromEntries(Object.entries(plan.plan.proposedMapping.staff).filter(([, v]) => v)) as Record<string, string>,
        services: Object.fromEntries(Object.entries(plan.plan.proposedMapping.services).filter(([, v]) => v)) as Record<string, string>,
      }
    : { staff: {}, services: {} };
  const nameOf = (id: string) => plan?.catalog.staff.find((x) => x.id === id)?.name ?? plan?.catalog.services.find((x) => x.id === id)?.name ?? id;
  const suggestionCount = Object.keys(suggested.staff).length + Object.keys(suggested.services).length;
  const useSuggestions = () => {
    setStaffMap((m) => ({ ...m, ...suggested.staff }));
    setServiceMap((m) => ({ ...m, ...suggested.services }));
    setDirty(true);
  };
  const unconfirmed = Object.values(staffMap).filter((v) => v === "").length + Object.values(serviceMap).filter((v) => v === "").length;

  return (
    <PageShell as="main" ariaLabel="Reseñas externas">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 sm:p-6">
        <header>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Plataforma M_AI · solo administradores globales</p>
          <h1 className="mt-1 text-xl font-semibold">Reseñas importadas de Fresha</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Un archivo válido no prueba que una reseña sea auténtica. Todo entra pendiente y no público; publicar exige revisar antes la procedencia de cada reseña. «Procedencia revisada» significa que una persona de M_AI revisó la evidencia, no que la reseña esté verificada.
          </p>
        </header>
        {error ? <Alert>{error}</Alert> : null}
        {notice ? <p role="status" className={`p-3 text-sm ${CARD}`}>{notice}</p> : null}

        <section aria-labelledby="pf-site" className={`p-4 ${CARD}`}>
          <h2 id="pf-site" className="text-[15px] font-semibold">1. Sede</h2>
          {site ? (
            <p className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">{site.name}</span>
              <span className="text-muted">/{site.slug}</span>
              <Button size="sm" variant="tertiary" onClick={() => setSite(null)}>
                Cambiar
              </Button>
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <Field label="Buscar por sede, slug o negocio">
                <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} className={INPUT} />
              </Field>
              <Button onClick={search} loading={pending} loadingLabel="Buscando…">
                Buscar
              </Button>
              {sites.length ? (
                <ul className="mt-2 flex w-full flex-col gap-1">
                  {sites.map((s) => (
                    <li key={s.id}>
                      <button type="button" onClick={() => pick(s)} className="min-h-11 w-full rounded-sch-control px-3 text-left text-sm hover:bg-subtle">
                        <span className="font-medium">{s.name}</span> <span className="text-muted">· {s.client_name} · /{s.slug}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </section>

        {site ? (
          <section aria-labelledby="pf-import" className={`p-4 ${CARD}`}>
            <h2 id="pf-import" className="text-[15px] font-semibold">2. Importar archivo (revisión previa obligatoria)</h2>
            <p className="mt-1 text-[13px] text-muted">CSV exportado de Fresha o preparado por una persona: fecha, cliente, estrellas, comentario, artista, servicio, id y evidencia (opcionales). Máximo 1 MB y 2.000 filas. El archivo no se guarda; ningún enlace se descarga.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Archivo CSV"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setPlan(null);
                }}
                className="text-sm"
              />
              <Button onClick={() => review(null)} disabled={!file} loading={pending && !plan} loadingLabel="Revisando…">
                Revisar archivo
              </Button>
            </div>

            {plan ? (
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-sm">
                  {plan.plan.totalRows} filas · <strong>{plan.plan.ready.length} listas</strong> · {plan.plan.duplicates.length} repetidas · {plan.plan.rejected.length} rechazadas
                </p>
                {plan.plan.errors.map((e) => (
                  <Alert key={e}>{e}</Alert>
                ))}
                {plan.plan.rejected.length ? (
                  <details open>
                    <summary className="min-h-11 cursor-pointer content-center text-sm font-medium">Filas rechazadas (corrige el archivo)</summary>
                    <ul className="flex flex-col gap-1 text-[13px] text-muted">
                      {plan.plan.rejected.map((r) => (
                        <li key={r.line}>
                          Línea {r.line}: {r.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {plan.plan.duplicates.length ? (
                  <p className="text-[13px] text-muted">
                    Repetidas (no se importan otra vez): líneas {plan.plan.duplicates.map((d) => d.line).join(", ")}.
                  </p>
                ) : null}

                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">Equivalencias — confirma cada una</legend>
                  <p className="text-[12.5px] text-muted">
                    Nada viene elegido. Las sugerencias solo coinciden por nombre exacto (sin mayúsculas ni tildes) y se aplican solo si las aceptas. «Sin atribuir» = la reseña cuenta para el negocio, no para un artista o servicio.
                  </p>
                  {suggestionCount > 0 ? (
                    <div>
                      <Button size="sm" variant="tertiary" onClick={useSuggestions}>
                        Usar las {suggestionCount} sugerencias por nombre exacto
                      </Button>
                    </div>
                  ) : null}
                  {Object.keys(staffMap).map((name) => (
                    <Choose
                      key={`a-${name}`}
                      label={`Artista «${name}»`}
                      hint={suggested.staff[name] ? `Sugerencia: ${nameOf(suggested.staff[name])}` : "Sin sugerencia"}
                      value={staffMap[name]}
                      options={plan.catalog.staff}
                      onChange={(v) => {
                        setStaffMap((m) => ({ ...m, [name]: v }));
                        setDirty(true);
                      }}
                    />
                  ))}
                  {Object.keys(serviceMap).map((name) => (
                    <Choose
                      key={`s-${name}`}
                      label={`Servicio «${name}»`}
                      hint={suggested.services[name] ? `Sugerencia: ${nameOf(suggested.services[name])}` : "Sin sugerencia"}
                      value={serviceMap[name]}
                      options={plan.catalog.services}
                      onChange={(v) => {
                        setServiceMap((m) => ({ ...m, [name]: v }));
                        setDirty(true);
                      }}
                    />
                  ))}
                </fieldset>

                {plan.plan.ready.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-left text-[13px]">
                      <caption className="mb-1 text-left text-sm font-medium">Vista previa (primeras 20 filas listas)</caption>
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-2 font-medium">Línea</th>
                          <th className="py-1 pr-2 font-medium">Fecha</th>
                          <th className="py-1 pr-2 font-medium">Autor</th>
                          <th className="py-1 pr-2 font-medium">★</th>
                          <th className="py-1 pr-2 font-medium">Artista</th>
                          <th className="py-1 pr-2 font-medium">Comentario público</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.plan.ready.slice(0, 20).map((r) => (
                          <tr key={r.line} className="border-t border-line align-top">
                            <td className="py-1 pr-2">{r.line}</td>
                            <td className="py-1 pr-2">{fmt(r.originalReviewedAt)}</td>
                            <td className="py-1 pr-2">{r.authorDisplay}</td>
                            <td className="py-1 pr-2">{r.rating}</td>
                            <td className="py-1 pr-2">{r.staffName ?? "Sin atribuir"}</td>
                            <td className="py-1 pr-2">
                              {r.comment ?? "—"}
                              {r.redacted ? <span className="ml-1 text-warning">(datos de contacto ocultos; el original se guarda)</span> : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => review(plan)} loading={pending} loadingLabel="Revisando…">
                    Volver a revisar con estas equivalencias
                  </Button>
                  <Button variant="primary" onClick={apply} disabled={!plan.plan.canApply || unconfirmed > 0 || dirty} loading={pending} loadingLabel="Importando…">
                    Importar {plan.plan.ready.length} como pendientes
                  </Button>
                  {!plan.plan.canApply || unconfirmed > 0 || dirty ? (
                    <span className="text-[12.5px] text-muted">
                      {dirty ? "Cambiaste equivalencias: vuelve a revisar para ver exactamente qué se importará." : "Se habilita sin filas rechazadas y con todas las equivalencias confirmadas y revisadas."}
                    </span>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {site && reviews ? (
          <section aria-labelledby="pf-list" className="flex flex-col gap-2.5">
            <h2 id="pf-list" className="text-[15px] font-semibold">3. Revisión de procedencia y publicación ({reviews.length})</h2>
            {reviews.length === 0 ? <p className={`p-4 text-sm text-muted ${CARD}`}>Esta sede no tiene reseñas importadas.</p> : null}
            {reviews.map((r) => (
              <ReviewCard key={r.id} r={r} siteId={site.id} pending={pending} act={act} />
            ))}
          </section>
        ) : null}
      </div>
    </PageShell>
  );
}

function Choose({ label, hint, value, options, onChange }: { label: string; hint: string; value: Choice; options: Array<{ id: string; name: string }>; onChange: (v: Choice) => void }) {
  return (
    <label className="grid gap-1 text-sm sm:grid-cols-[1fr_18rem] sm:items-center">
      <span className="flex flex-col">
        {label}
        <span className="text-[12px] text-muted">{hint}</span>
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={value === ""} className={INPUT}>
        <option value="">— Confirma la equivalencia —</option>
        <option value="null">Sin atribuir</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

const PROV: Record<string, string> = { pending: "Procedencia pendiente", reviewed: "Procedencia revisada", rejected: "Procedencia rechazada" };
const PUB: Record<string, string> = { pending: "No pública", approved: "Publicada", hidden: "Oculta" };

function ReviewCard({ r, siteId, pending, act }: { r: PlatformExternalReviewRow; siteId: string; pending: boolean; act: (fn: () => Promise<{ ok: boolean; error?: string }>) => void }) {
  const [notes, setNotes] = useState(r.provenance_notes ?? "");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.comment ?? "");
  const [reason, setReason] = useState("");
  return (
    <article className={`flex flex-col gap-2 p-4 text-sm ${CARD}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{"★".repeat(r.rating)}</span>
        <span>{r.author_display}</span>
        <span className="text-muted">· escrita el {fmt(r.original_reviewed_at)}</span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem]">{PROV[r.provenance_status]}</span>
        <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem]">{PUB[r.status] ?? r.status}</span>
      </div>
      <p className="text-muted">
        {r.staff_name ?? "Sin atribuir a un artista"} · {r.service_name ?? "Servicio no indicado"}
        {r.service_name && !r.service_counted ? " (no cuenta para ningún servicio)" : ""}
      </p>
      <p className="whitespace-pre-line">{r.comment ?? "Sin comentario."}</p>
      {r.original_comment && r.original_comment !== r.comment ? (
        <details>
          <summary className="min-h-11 cursor-pointer content-center text-[13px] text-muted">Texto original (interno) y redacciones ({r.redactions.length})</summary>
          <p className="whitespace-pre-line text-[13px]">{r.original_comment}</p>
          <ul className="text-[12.5px] text-muted">
            {r.redactions.map((x, i) => (
              <li key={i}>
                {fmt(x.at)} · {x.step === "import" ? "al importar" : "manual"} · {x.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-[12.5px] text-muted">
        Evidencia (interna, no se abre ni se descarga): <span className="select-all break-all font-mono">{r.evidence_ref ?? "ninguna aportada"}</span>
        {r.public_source_url ? " · enlace público de Fresha disponible" : ""}
      </p>
      <p className="text-[12.5px] text-muted">
        Importada el {fmt(r.imported_at)} por {r.importer ?? "—"}
        {r.batch_file ? ` · archivo «${r.batch_file}»` : ""}
        {r.provenance_reviewed_at ? ` · procedencia revisada por ${r.provenance_reviewer ?? "—"} el ${fmt(r.provenance_reviewed_at)}` : ""}
      </p>
      {r.open_requests.map((q) => (
        <div key={q.id} className="rounded-sch-control border border-warning/50 bg-warning/5 p-2.5 text-[13px]">
          El negocio pide {q.kind === "withdraw" ? "retirarla" : "revisarla"}
          {q.note ? `: «${q.note}»` : "."}
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => act(() => resolveRequestAction(siteId, q.id, "kept"))} disabled={pending}>
              Mantener
            </Button>
            <Button size="sm" onClick={() => act(() => resolveRequestAction(siteId, q.id, "withdrawn"))} disabled={pending}>
              Retirar
            </Button>
            <Button size="sm" onClick={() => act(() => resolveRequestAction(siteId, q.id, "corrected"))} disabled={pending}>
              Marcar corregida
            </Button>
          </span>
        </div>
      ))}
      <Field label="Observaciones internas de procedencia" optional>
        <textarea value={notes} maxLength={1000} rows={2} onChange={(e) => setNotes(e.target.value)} className={TEXTAREA} />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={() => act(() => reviewProvenanceAction(siteId, r.id, "reviewed", notes))} disabled={pending}>
          Procedencia revisada
        </Button>
        <Button size="sm" onClick={() => act(() => reviewProvenanceAction(siteId, r.id, "rejected", notes))} disabled={pending}>
          No se pudo comprobar
        </Button>
        <Button size="sm" variant="primary" onClick={() => act(() => setPublicationAction(siteId, r.id, "approved"))} disabled={pending || r.provenance_status !== "reviewed" || r.status === "approved"}>
          Publicar
        </Button>
        <Button size="sm" onClick={() => act(() => setPublicationAction(siteId, r.id, "hidden"))} disabled={pending || r.status === "hidden"}>
          Ocultar
        </Button>
        <Button size="sm" variant="tertiary" onClick={() => setEditing((x) => !x)} aria-expanded={editing}>
          Redactar texto público
        </Button>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2 rounded-sch-control border border-line p-3">
          <p className="text-[12.5px] text-muted">Solo para ocultar datos personales. No cambies el sentido; las estrellas y el original no se tocan y el cambio queda registrado.</p>
          <textarea value={text} maxLength={600} rows={3} onChange={(e) => setText(e.target.value)} className={TEXTAREA} aria-label="Texto público" />
          <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" className={INPUT} aria-label="Motivo de la redacción" />
          <Button size="sm" onClick={() => act(() => redactCommentAction(siteId, r.id, text, reason))} disabled={pending || !reason.trim()}>
            Guardar redacción
          </Button>
        </div>
      ) : null}
    </article>
  );
}
