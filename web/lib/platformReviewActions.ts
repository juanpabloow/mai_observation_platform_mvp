"use server";

import { createHash } from "node:crypto";
import { isUuid } from "./clientModuleValidation";
import { requirePlatformAdmin } from "./platformAdmin";
import {
  IMPORT_MAX_BYTES,
  planExternalImport,
  readImportRows,
  type ImportMapping,
  type ImportPlan,
} from "./externalReviewImport";
import {
  getSiteScope,
  importCatalog,
  importExternalReviewBatch,
  listExternalReviewKeys,
  listExternalReviewsForPlatform,
  redactExternalComment,
  resolveExternalReviewRequest,
  reviewProvenance,
  searchSites,
  setExternalPublication,
  type PlatformExternalReviewRow,
} from "@worker/db/repositories/scheduling/externalReviews.js";

/**
 * PLATFORM REVIEW ACTIONS — import and moderation of EXTERNAL (Fresha) reviews. Only a
 * PLATFORM administrator (web/lib/platformAdmin.ts, deny-by-default) may call them; the
 * check runs here, on the server, at the start of EVERY action — a business user calling
 * these directly gets the same generic refusal as anyone else.
 *
 * Every action names the SITE it works on; the repository resolves its (tenant, client)
 * and only touches rows of that site. Files are read in memory and never stored (only
 * their SHA-256); no URL in a file is ever fetched; logs carry no file, phone or e-mail.
 */

const DENIED = "No disponible.";
type Fail = { ok: false; error: string };

async function siteFor(siteId: string) {
  if (!isUuid(siteId)) return null;
  return getSiteScope(siteId);
}

export async function searchSitesAction(q: string): Promise<{ ok: true; sites: Array<{ id: string; name: string; slug: string; client_name: string }> } | Fail> {
  if (!(await requirePlatformAdmin())) return { ok: false, error: DENIED };
  const t = q.trim().slice(0, 80);
  if (t.length < 2) return { ok: true, sites: [] };
  return { ok: true, sites: await searchSites(t) };
}

async function readUpload(formData: FormData): Promise<{ text: string; sha256: string; name: string | null } | Fail> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Elige un archivo CSV." };
  if (file.size === 0) return { ok: false, error: "El archivo está vacío." };
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: `El archivo supera ${Math.round(IMPORT_MAX_BYTES / 1024)} KB.` };
  const bytes = Buffer.from(await file.arrayBuffer());
  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) return { ok: false, error: "El archivo no es un CSV de texto." };
  return { text, sha256: createHash("sha256").update(bytes).digest("hex"), name: (file.name || "").slice(0, 200) || null };
}

function readMapping(raw: FormDataEntryValue | null): ImportMapping | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const m = JSON.parse(raw) as ImportMapping;
    if (!m || typeof m.site !== "string" || typeof m.staff !== "object" || typeof m.services !== "object") return null;
    return m;
  } catch {
    return null;
  }
}

export interface PlanView {
  site: { id: string; name: string; slug: string; clientName: string };
  catalog: { staff: Array<{ id: string; name: string }>; services: Array<{ id: string; name: string }> };
  plan: ImportPlan;
  sha256: string;
}

/** THE dry-run: reads the file, proposes equivalences, validates every row — writes nothing. */
export async function planImportAction(siteId: string, formData: FormData): Promise<({ ok: true } & PlanView) | Fail> {
  if (!(await requirePlatformAdmin())) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  const up = await readUpload(formData);
  if ("ok" in up) return up;
  const { rows, errors } = readImportRows(up.text);
  const catalog = await importCatalog(site);
  const plan = planExternalImport({
    rows,
    catalog: { siteId: site.siteId, siteSlug: site.slug, timezone: site.timezone, staff: catalog.staff, services: catalog.services },
    mapping: readMapping(formData.get("mapping")),
    existingKeys: await listExternalReviewKeys(site),
    now: new Date(),
  });
  if (errors.length) plan.errors.unshift(...errors);
  return { ok: true, site: { id: site.siteId, name: site.siteName, slug: site.slug, clientName: site.clientName }, catalog, plan, sha256: up.sha256 };
}

/**
 * Apply — only what a fresh dry-run of THE SAME FILE says can be applied (a complete,
 * confirmed mapping and no invalid row). The client's `expectSha256` must match: the
 * file confirmed is the file imported.
 */
export async function applyImportAction(siteId: string, formData: FormData): Promise<{ ok: true; inserted: number; skipped: number } | Fail> {
  const admin = await requirePlatformAdmin();
  if (!admin) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  const up = await readUpload(formData);
  if ("ok" in up) return up;
  if (formData.get("expectSha256") !== up.sha256) return { ok: false, error: "El archivo cambió desde la revisión. Vuelve a revisarlo." };
  const mapping = readMapping(formData.get("mapping"));
  if (!mapping) return { ok: false, error: "Confirma las equivalencias antes de importar." };
  const { rows, errors } = readImportRows(up.text);
  if (errors.length) return { ok: false, error: errors[0] };
  const catalog = await importCatalog(site);
  const plan = planExternalImport({
    rows,
    catalog: { siteId: site.siteId, siteSlug: site.slug, timezone: site.timezone, staff: catalog.staff, services: catalog.services },
    mapping,
    existingKeys: await listExternalReviewKeys(site),
    now: new Date(),
  });
  if (!plan.canApply) return { ok: false, error: "La revisión todavía tiene filas rechazadas o equivalencias sin confirmar." };
  // Re-importing the same file: nothing new — no empty batch, nothing written.
  if (plan.ready.length === 0) return { ok: true, inserted: 0, skipped: plan.duplicates.length };
  const res = await importExternalReviewBatch({
    ...site,
    fileName: up.name,
    fileSha256: up.sha256,
    totals: { rows: plan.totalRows, duplicates: plan.duplicates.length, rejected: plan.rejected.length },
    mapping: { site: mapping.site, staff: mapping.staff, services: mapping.services },
    actor: admin.userId,
    rows: plan.ready.map((r) => ({ ...r, originalReviewedAt: new Date(r.originalReviewedAt) })),
  });
  return { ok: true, inserted: res.inserted, skipped: res.skipped };
}

export async function listPlatformReviewsAction(siteId: string): Promise<{ ok: true; reviews: PlatformExternalReviewRow[] } | Fail> {
  if (!(await requirePlatformAdmin())) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  return { ok: true, reviews: await listExternalReviewsForPlatform(site) };
}

const result = (r: { ok: true } | { ok: false; error: string }): { ok: true } | Fail =>
  r.ok
    ? r
    : { ok: false, error: r.error === "needs_provenance" ? "Primero revisa la procedencia de esta reseña." : r.error === "invalid" ? "Revisa el texto (1 a 600 caracteres)." : "Esta reseña ya no está disponible." };

const cleanNote = (raw: string | null | undefined, max: number): string | null => {
  const t = (raw ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
  return t ? t.slice(0, max) : null;
};

/** Provenance review — "reviewed" means a platform administrator checked the evidence;
 *  it is never automatic and never a promise of authenticity. */
export async function reviewProvenanceAction(siteId: string, reviewId: string, decision: "reviewed" | "rejected", notes: string): Promise<{ ok: true } | Fail> {
  const admin = await requirePlatformAdmin();
  if (!admin || !isUuid(reviewId) || (decision !== "reviewed" && decision !== "rejected")) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  return result(await reviewProvenance(site, reviewId, decision, cleanNote(notes, 1000), admin.userId));
}

export async function setPublicationAction(siteId: string, reviewId: string, status: "approved" | "hidden"): Promise<{ ok: true } | Fail> {
  const admin = await requirePlatformAdmin();
  if (!admin || !isUuid(reviewId) || (status !== "approved" && status !== "hidden")) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  return result(await setExternalPublication(site, reviewId, status, admin.userId));
}

export async function redactCommentAction(siteId: string, reviewId: string, publicText: string, reason: string): Promise<{ ok: true } | Fail> {
  const admin = await requirePlatformAdmin();
  if (!admin || !isUuid(reviewId)) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  const why = cleanNote(reason, 200);
  if (!why) return { ok: false, error: "Escribe el motivo de la redacción." };
  return result(await redactExternalComment(site, reviewId, cleanNote(publicText, 600), why, admin.userId));
}

export async function resolveRequestAction(siteId: string, requestId: string, resolution: "kept" | "withdrawn" | "corrected"): Promise<{ ok: true } | Fail> {
  const admin = await requirePlatformAdmin();
  if (!admin || !isUuid(requestId) || !["kept", "withdrawn", "corrected"].includes(resolution)) return { ok: false, error: DENIED };
  const site = await siteFor(siteId);
  if (!site) return { ok: false, error: DENIED };
  return result(await resolveExternalReviewRequest(site, requestId, resolution, admin.userId));
}
