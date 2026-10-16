import { createHash } from "node:crypto";
import { matchByName, normalizeName } from "@worker/scheduling/nameMatch.js";
import { zonedPartsToUtc } from "@worker/scheduling/timezone.js";
import { authorDisplay, REVIEW_COMMENT_MAX } from "./publicReviews";

/**
 * EXTERNAL REVIEW IMPORT — the PLAN for bringing a business's Fresha reviews into the
 * review table (migration 1807). Pure: no database, no network. A PLATFORM administrator
 * (web/lib/platformAdmin.ts) uploads a file in the platform review screen; the server
 * builds this plan (the mandatory dry-run), the administrator confirms the equivalences,
 * and only then does the server write — re-planning from the same file first.
 *
 * Rules:
 *  - The data comes from a FILE a person prepared (Fresha export or a hand-made sheet) —
 *    never scraped, and no URL in it is ever downloaded. A valid file proves NOTHING about
 *    authenticity: every imported review enters PENDING with provenance PENDING, and a
 *    platform administrator must review its provenance before it can be published.
 *  - EQUIVALENCES ARE CONFIRMED BY A PERSON. Exact (accent/case-insensitive) name matches
 *    are only suggestions; nothing is imported until every artist text and every service
 *    text in the file has an explicit answer — an id, or "sin atribuir" (null). A review
 *    without a confirmed artist / service counts for NO artist / service (only for the
 *    business). Nothing is assigned by guessing.
 *  - Every row must be valid: stars 1–5, a real past date, a comment within the limit, no
 *    control characters and no cell that a spreadsheet would run as a formula. Any
 *    invalid row blocks the import — a person fixes the file.
 *  - Contact data or links inside a comment are REDACTED in the public text ("[dato
 *    oculto]") — never silently: the original text is kept for audit and the redaction is
 *    recorded. The stars and the rest of the words are never changed.
 *  - Idempotent: each row gets a stable external key (the source id, else a hash of its
 *    content); keys already imported, or repeated in the file, are skipped.
 */

export const EXTERNAL_SOURCE = "fresha" as const;
export const IMPORT_MAX_ROWS = 2000;
/** The upload limit (the file is never stored — only its SHA-256). */
export const IMPORT_MAX_BYTES = 1024 * 1024;
const ORIGINAL_MAX = 4000;

export interface CatalogRow {
  id: string;
  name: string;
}

export interface ImportCatalog {
  siteId: string;
  siteSlug: string;
  timezone: string;
  /** Professionals of THIS site (active or not — a former artist keeps their reviews). */
  staff: CatalogRow[];
  /** Services of THIS client. */
  services: CatalogRow[];
}

/** Confirmed by a person. Keys are the texts exactly as they appear in the file. */
export interface ImportMapping {
  site: string;
  /** uuid = confirmed; null = "sin atribuir" (counts for no artist). */
  staff: Record<string, string | null>;
  /** uuid = confirmed equivalence; null = "we don't know which service" (counts for none). */
  services: Record<string, string | null>;
}

export interface ImportRow {
  line: number;
  externalId: string | null;
  date: string;
  author: string;
  rating: string;
  comment: string;
  artist: string;
  service: string;
  /** Where it can be checked (the Fresha link or a reference) — never fetched. */
  evidence: string;
}

export interface PlannedReview {
  line: number;
  externalKey: string;
  /** null = not attributed to an artist (a review of the business). */
  staffId: string | null;
  staffName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  rating: number;
  /** What the page may show (contact data / links redacted). */
  comment: string | null;
  /** The text exactly as imported — internal, for audit. */
  originalComment: string | null;
  /** True when `comment` differs from the original (the redaction is recorded). */
  redacted: boolean;
  authorDisplay: string;
  originalReviewedAt: string;
  evidenceRef: string | null;
  /** Only an https fresha.com link — the one a visitor may follow. */
  publicSourceUrl: string | null;
}

export interface ImportPlan {
  source: typeof EXTERNAL_SOURCE;
  site: string;
  totalRows: number;
  /** Would be inserted now. */
  ready: PlannedReview[];
  /** Already imported earlier, or repeated inside the file. */
  duplicates: Array<{ line: number; externalKey: string; reason: "already_imported" | "repeated_in_file" }>;
  /** Invalid rows — each blocks the import until the file is fixed. */
  rejected: Array<{ line: number; reason: string }>;
  /** Suggestions for the mapping file — exact (accent/case-insensitive) name matches only. */
  proposedMapping: ImportMapping;
  /** Names in the file the mapping does not (validly) cover. */
  unmapped: { staff: string[]; services: string[] };
  /** File-level problems (headers, mapping for another site, unknown ids…). */
  errors: string[];
  /** Only true with a complete, valid mapping and no rejected row. */
  canApply: boolean;
}

// ── CSV ─────────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields, doubled quotes, CRLF/LF, a BOM; "," or ";" (auto-detected). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const HEADERS: Record<keyof Omit<ImportRow, "line">, string[]> = {
  externalId: ["id", "external_id", "external id", "review_id", "review id", "id_resena", "id reseña", "id de reseña"],
  date: ["fecha", "date", "review_date", "fecha_resena", "fecha reseña"],
  author: ["cliente", "customer", "client", "autor", "author", "nombre", "name"],
  rating: ["estrellas", "rating", "calificacion", "calificación", "stars"],
  comment: ["comentario", "comment", "review", "resena", "reseña", "texto", "text"],
  artist: ["artista", "profesional", "staff", "team member", "team_member", "barbero", "empleado"],
  service: ["servicio", "service", "services", "servicios"],
  evidence: ["evidencia", "evidence", "url", "enlace", "link", "referencia", "reference", "source_url", "fuente"],
};
// The artist is optional: a review of the business in general has none.
const REQUIRED: Array<keyof typeof HEADERS> = ["date", "author", "rating"];

export function readImportRows(text: string): { rows: ImportRow[]; errors: string[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], errors: ["El archivo está vacío."] };
  const header = table[0].map((h) => normalizeName(h));
  const col = {} as Record<keyof typeof HEADERS, number>;
  for (const key of Object.keys(HEADERS) as Array<keyof typeof HEADERS>) {
    col[key] = header.findIndex((h) => HEADERS[key].some((alias) => normalizeName(alias) === h));
  }
  const missing = REQUIRED.filter((k) => col[k] < 0);
  if (missing.length) {
    return { rows: [], errors: [`Faltan columnas: ${missing.map((k) => HEADERS[k][0]).join(", ")}. Encabezados leídos: ${table[0].join(" | ")}`] };
  }
  if (table.length - 1 > IMPORT_MAX_ROWS) return { rows: [], errors: [`Máximo ${IMPORT_MAX_ROWS} filas por archivo.`] };
  const cell = (r: string[], k: keyof typeof HEADERS) => (col[k] >= 0 ? (r[col[k]] ?? "").trim() : "");
  return {
    rows: table.slice(1).map((r, i) => ({
      line: i + 2,
      externalId: cell(r, "externalId") || null,
      date: cell(r, "date"),
      author: cell(r, "author"),
      rating: cell(r, "rating"),
      comment: col.comment >= 0 ? (r[col.comment] ?? "") : "",
      artist: cell(r, "artist"),
      service: cell(r, "service"),
      evidence: cell(r, "evidence"),
    })),
    errors: [],
  };
}

// ── Field rules ─────────────────────────────────────────────────────────────────

/** "5", "4.0", "4,0" → 5 / 4; anything else (½ stars, 0, 6, text) → null. */
export function parseStars(raw: string): number | null {
  const m = /^([1-5])(?:[.,]0+)?$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The review's original date. Accepts ISO (2026-03-14, 2026-03-14 18:30, a full ISO
 * instant) and day-first 14/03/2026 (Colombian convention). A date without a time is
 * noon in the site's zone, so it never shifts a day. Future or unreadable → null.
 */
export function parseReviewDate(raw: string, timeZone: string, now: Date): Date | null {
  const t = raw.trim();
  let d: Date | null = null;
  let m: RegExpExecArray | null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) d = new Date(t);
  else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(t))) d = local(+m[1], +m[2], +m[3], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0);
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) d = local(+m[3], +m[2], +m[1], 12, 0);
  if (!d || Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return null;
  return d;

  function local(y: number, mo: number, day: number, h: number, mi: number): Date | null {
    if (mo < 1 || mo > 12 || day < 1 || day > 31 || h > 23 || mi > 59) return null;
    const probe = new Date(Date.UTC(y, mo - 1, day));
    if (probe.getUTCMonth() !== mo - 1) return null; // 31/02 and friends
    return zonedPartsToUtc(y, mo, day, h, mi, timeZone);
  }
}

// Contact data and links — the same families the public-text rules refuse.
const LINK_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|co|net|org|io|app|me|link|ly)(\/\S*)?\b)/gi;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const PHONE_RE = /(?:\+?\d[\s().-]*){7,}/g;
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/;
/** A cell a spreadsheet would run as a formula (=, +, @, a tab/CR, or "-" glued to text).
 * Rejected, not "fixed": nothing here is ever exported, but the text must stay safe to
 * paste anywhere, and changing it would change what the customer wrote. */
const FORMULA_RE = /^(?:[=+@\t\r]|-[^\s\d])/;

/**
 * The comment as it may be SHOWN: e-mails, phone numbers and links replaced by "[dato
 * oculto]". Everything else is kept word for word (the meaning and the stars never
 * change). `changed` says whether anything was replaced — the caller records it.
 */
export function redactForPublic(raw: string): { text: string | null; changed: boolean } {
  const t = raw.replace(/\r\n?/g, "\n").trim();
  if (!t) return { text: null, changed: false };
  const out = t
    .replace(EMAIL_RE, "[dato oculto]")
    .replace(LINK_RE, "[dato oculto]")
    // A phone match may swallow the space after it — give it back.
    .replace(PHONE_RE, (m) => `[dato oculto]${/\s$/.test(m) ? " " : ""}`)
    .trim();
  return { text: out, changed: out !== t };
}

/** An https fresha.com page, or null — a reference that is not one stays internal only. */
export function freshaUrlOrNull(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && (h === "fresha.com" || h.endsWith(".fresha.com")) && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Stable per row: the source id when there is one, else a hash of what was written. */
export function externalKeyFor(row: ImportRow, siteId: string): string {
  if (row.externalId) return `id:${row.externalId.slice(0, 180)}`;
  const parts = [siteId, row.date.trim(), normalizeName(row.author), row.rating.trim(), normalizeName(row.comment), normalizeName(row.artist)];
  return `h:${createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 40)}`;
}

// ── Plan ────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function propose(names: string[], rows: CatalogRow[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const n of names) {
    const m = matchByName(rows, n);
    out[n] = m.status === "ok" ? m.id : null;
  }
  return out;
}

export function planExternalImport(input: {
  rows: ImportRow[];
  catalog: ImportCatalog;
  mapping: ImportMapping | null;
  existingKeys: Set<string>;
  now: Date;
}): ImportPlan {
  const { rows, catalog, mapping, existingKeys, now } = input;
  const errors: string[] = [];
  const rejected: ImportPlan["rejected"] = [];
  const duplicates: ImportPlan["duplicates"] = [];
  const ready: PlannedReview[] = [];

  const artistNames = [...new Set(rows.map((r) => r.artist).filter(Boolean))].sort();
  const serviceNames = [...new Set(rows.map((r) => r.service).filter(Boolean))].sort();
  const proposedStaff = propose(artistNames, catalog.staff);
  const proposedMapping: ImportMapping = {
    site: catalog.siteSlug,
    // Suggestions only (exact name). No match → null: the person must still CONFIRM it.
    staff: proposedStaff,
    services: propose(serviceNames, catalog.services),
  };

  const staffById = new Map(catalog.staff.map((s) => [s.id.toLowerCase(), s]));
  const serviceById = new Map(catalog.services.map((s) => [s.id.toLowerCase(), s]));
  const unmapped = { staff: [] as string[], services: [] as string[] };
  if (!mapping) {
    unmapped.staff = artistNames;
    unmapped.services = serviceNames;
  } else {
    if (mapping.site !== catalog.siteSlug) errors.push(`El archivo de equivalencias es de la sede «${mapping.site}», no de «${catalog.siteSlug}».`);
    for (const n of artistNames) {
      if (!mapping.staff || !(n in mapping.staff)) {
        unmapped.staff.push(n);
        continue;
      }
      const id = mapping.staff[n];
      if (id !== null && (!UUID_RE.test(id) || !staffById.has(id.toLowerCase()))) errors.push(`Artista «${n}»: ${id} no es un profesional de esta sede.`);
    }
    for (const n of serviceNames) {
      if (!mapping.services || !(n in mapping.services)) unmapped.services.push(n);
      else {
        const id = mapping.services[n];
        if (id !== null && (!UUID_RE.test(id) || !serviceById.has(id.toLowerCase()))) errors.push(`Servicio «${n}»: ${id} no es un servicio de este cliente.`);
      }
    }
  }

  const seen = new Set<string>();
  for (const r of rows) {
    const reasons: string[] = [];
    const stars = parseStars(r.rating);
    if (stars === null) reasons.push(`estrellas «${r.rating}» (debe ser un entero de 1 a 5)`);
    const when = parseReviewDate(r.date, catalog.timezone, now);
    if (!when) reasons.push(`fecha «${r.date}» (AAAA-MM-DD o DD/MM/AAAA, no futura)`);
    const original = r.comment.replace(/\r\n?/g, "\n").trim();
    if (CONTROL_RE.test(original.replace(/[\n\t]/g, ""))) reasons.push("el comentario tiene caracteres no válidos");
    if (original.length > ORIGINAL_MAX) reasons.push(`comentario de más de ${ORIGINAL_MAX} caracteres`);
    const shown = redactForPublic(original);
    if ((shown.text?.length ?? 0) > REVIEW_COMMENT_MAX) reasons.push(`comentario de más de ${REVIEW_COMMENT_MAX} caracteres (no se recorta: cambiaría su sentido)`);
    if (r.evidence.length > 500) reasons.push("referencia de más de 500 caracteres");
    const formula = (["externalId", "author", "comment", "artist", "service", "evidence"] as const).filter((k) => FORMULA_RE.test(String(r[k] ?? "").trimStart()));
    if (formula.length) reasons.push(`celda que empieza como fórmula de hoja de cálculo (${formula.join(", ")})`);
    if (r.author.length > 200 || r.artist.length > 200 || r.service.length > 200 || (r.externalId?.length ?? 0) > 180) reasons.push("texto de más de 200 caracteres en autor, artista o servicio");
    if (reasons.length) {
      rejected.push({ line: r.line, reason: reasons.join("; ") });
      continue;
    }
    const key = externalKeyFor(r, catalog.siteId);
    if (seen.has(key)) {
      duplicates.push({ line: r.line, externalKey: key, reason: "repeated_in_file" });
      continue;
    }
    seen.add(key);
    if (existingKeys.has(key)) {
      duplicates.push({ line: r.line, externalKey: key, reason: "already_imported" });
      continue;
    }
    let staff: CatalogRow | undefined;
    if (r.artist) {
      if (!mapping?.staff || !(r.artist in mapping.staff)) continue; // unmapped: reported
      const sid = mapping.staff[r.artist];
      staff = sid ? staffById.get(sid.toLowerCase()) : undefined;
      if (sid && !staff) continue; // reported in errors
    }
    let serviceId: string | null = null;
    if (r.service) {
      if (!mapping?.services || !(r.service in mapping.services)) continue; // unmapped
      const sid = mapping.services[r.service];
      serviceId = sid ? (serviceById.get(sid.toLowerCase())?.id ?? null) : null;
      if (sid && !serviceId) continue; // reported in errors
    }
    ready.push({
      line: r.line,
      externalKey: key,
      staffId: staff?.id ?? null,
      staffName: staff?.name ?? null,
      serviceId,
      // The text the source showed (what the customer had) — the M_AI name only when confirmed.
      serviceName: serviceId ? serviceById.get(serviceId.toLowerCase())!.name : r.service ? r.service.slice(0, 200) : null,
      rating: stars!,
      comment: shown.text,
      originalComment: original || null,
      redacted: shown.changed,
      authorDisplay: authorDisplay(r.author),
      originalReviewedAt: when!.toISOString(),
      evidenceRef: r.evidence ? r.evidence.slice(0, 500) : null,
      publicSourceUrl: r.evidence ? freshaUrlOrNull(r.evidence) : null,
    });
  }

  const canApply = mapping !== null && errors.length === 0 && rejected.length === 0 && unmapped.staff.length === 0 && unmapped.services.length === 0;
  return {
    source: EXTERNAL_SOURCE,
    site: catalog.siteSlug,
    totalRows: rows.length,
    // What WOULD be inserted with the current mapping — shown in the dry-run even when
    // canApply is false, so a person can check it before confirming the rest.
    ready,
    duplicates,
    rejected,
    proposedMapping,
    unmapped,
    errors,
    canApply,
  };
}
