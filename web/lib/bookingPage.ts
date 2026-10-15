import { checkPublicLine, publicProfileMessage } from "./staffPublicProfile";

/**
 * BOOKING PAGE PRESENTATION (migration 1804) — the pure rules that decide how a
 * business's catalogue and contact appear on /book/{slug}. No I/O, no prices charged:
 * the price that counts is always the server's snapshot on the appointment. Shared by the
 * public projection (server), the page (client) and the admin preview, so all three say
 * the same thing. Unit-tested in test/unit/bookingPage.test.ts.
 */

// ── Contact ───────────────────────────────────────────────────────────────────────

/** E.164 as stored in sites.public_whatsapp ("+573022275653"). */
export const E164_RE = /^\+[1-9][0-9]{7,14}$/;

/**
 * The wa.me link with a first message already written. Returns null for anything that is
 * not a clean E.164 number, so a malformed value never becomes a link on the page.
 */
export function whatsappLink(phone: string | null | undefined, text: string): string | null {
  if (!phone || !E164_RE.test(phone)) return null;
  const q = text.trim() ? `?text=${encodeURIComponent(text.trim())}` : "";
  return `https://wa.me/${phone.slice(1)}${q}`;
}

/** Hosts a "Cómo llegar" link may point to — Google Maps only (no open redirect). */
const MAPS_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com", "google.com"]);

/** A business-provided Maps link, accepted only when it is https and really Google Maps. */
export function safeMapsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" || !MAPS_HOSTS.has(u.hostname)) return null;
    if ((u.hostname === "www.google.com" || u.hostname === "google.com") && !u.pathname.startsWith("/maps")) return null;
    if (u.hostname === "goo.gl" && !u.pathname.startsWith("/maps")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** "Cómo llegar": the business's own Maps link, else a Maps search for the address. */
export function directionsUrl(site: { name: string; address: string | null; public_maps_url?: string | null }): string | null {
  const own = safeMapsUrl(site.public_maps_url ?? null);
  if (own) return own;
  if (!site.address?.trim()) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.name}, ${site.address.trim()}`)}`;
}

// ── Opening hours ───────────────────────────────────────────────────────────────────

type Ranges = Array<{ start: string; end: string }>;
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_NAME: Record<(typeof WEEK)[number], string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

const cap = (t: string) => t.charAt(0).toLocaleUpperCase("es") + t.slice(1);

/**
 * The site's weekly hours (sites.opening_hours) as a few readable lines, consecutive days
 * with the same hours merged: [{ days: "Lunes a sábado", hours: "10:00–20:00" },
 * { days: "Domingo", hours: "Cerrado" }]. Empty when the site has no hours configured —
 * the page then says nothing rather than inventing a schedule.
 */
export function hoursLines(openingHours: unknown): Array<{ days: string; hours: string }> {
  const h = (openingHours && typeof openingHours === "object" ? openingHours : {}) as Partial<Record<string, Ranges>>;
  const valid = (r: unknown): Ranges =>
    Array.isArray(r) ? r.filter((x): x is { start: string; end: string } => !!x && typeof x.start === "string" && typeof x.end === "string") : [];
  if (!WEEK.some((d) => valid(h[d]).length > 0)) return [];
  const label = (d: (typeof WEEK)[number]) => {
    const r = valid(h[d]);
    return r.length === 0 ? "Cerrado" : r.map((x) => `${x.start}–${x.end}`).join(" · ");
  };
  const out: Array<{ days: string; hours: string }> = [];
  let i = 0;
  while (i < WEEK.length) {
    let j = i;
    while (j + 1 < WEEK.length && label(WEEK[j + 1]) === label(WEEK[i])) j++;
    const days = i === j ? cap(DAY_NAME[WEEK[i]]) : j === i + 1 ? `${cap(DAY_NAME[WEEK[i]])} y ${DAY_NAME[WEEK[j]]}` : `${cap(DAY_NAME[WEEK[i]])} a ${DAY_NAME[WEEK[j]]}`;
    out.push({ days, hours: label(WEEK[i]) });
    i = j + 1;
  }
  return out;
}

// ── Catalogue groups ────────────────────────────────────────────────────────────────

export type CategoryLayout = "list" | "featured" | "contact";

export interface PageCategory {
  id: string;
  name: string;
  tagline: string | null;
  layout: CategoryLayout;
}

export interface PageService {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null;
  category_id: string | null;
  recommended: boolean;
  image_url: string | null;
  includes: string[];
  upgrade_to: string | null;
}

/**
 * A featured card ("Entre Nubes") needs everything it shows: an image, a description,
 * what it includes, a duration and a price. Anything missing and the service is NOT
 * shown there — a half-filled experience is never offered for booking.
 */
export function featuredMissing(s: Pick<PageService, "image_url" | "description" | "includes" | "price" | "duration_min">): string[] {
  const miss: string[] = [];
  if (!s.image_url) miss.push("imagen");
  if (!s.description?.trim()) miss.push("descripción");
  if (s.includes.length === 0) miss.push("qué incluye");
  if (!(s.duration_min > 0)) miss.push("duración");
  if (s.price == null) miss.push("precio");
  return miss;
}

export interface PageSection<S> {
  key: string;
  name: string;
  tagline: string | null;
  layout: "list" | "featured";
  items: S[];
}

/**
 * The page's sections, in the business's order: listing groups with at least one service
 * (featured ones keep only COMPLETE services), then the ungrouped services under
 * "Otros servicios". `contact` groups never list services; they come back separately as
 * links, and only when the business has a WhatsApp to send them to.
 *
 * With NO categories configured, returns null: the page keeps its previous grouping, so
 * a business that never set this up sees no change.
 */
export function pageSections<S extends PageService>(
  services: S[],
  categories: PageCategory[],
  opts: { hasWhatsapp: boolean },
): { sections: PageSection<S>[]; contacts: PageCategory[] } | null {
  if (categories.length === 0) return null;
  const known = new Set(categories.map((c) => c.id));
  const sections: PageSection<S>[] = [];
  for (const c of categories) {
    if (c.layout === "contact") continue;
    const items = services.filter((s) => s.category_id === c.id && (c.layout !== "featured" || featuredMissing(s).length === 0));
    if (items.length) sections.push({ key: c.id, name: c.name, tagline: c.tagline, layout: c.layout, items });
  }
  const rest = services.filter((s) => !s.category_id || !known.has(s.category_id));
  if (rest.length) sections.push({ key: "other", name: "Otros servicios", tagline: null, layout: "list", items: rest });
  const contacts = opts.hasWhatsapp ? categories.filter((c) => c.layout === "contact" && (c.tagline ?? "").trim() !== "") : [];
  return { sections, contacts };
}

// ── Upgrade ("Pásate a …") ──────────────────────────────────────────────────────────

/** COP amounts as integers (prices are numeric(10,2) strings; COP has no cents shown). */
function pesos(price: string | null): number | null {
  if (price == null) return null;
  const n = Number(price);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * The explicit better alternative of `from`, with the REAL difference between the two
 * prices shown on the page. Null when there is none, when the target is not offered on
 * the page, or when either price is unknown or the target is not more expensive — the
 * page never says "por $X más" with a made-up or negative X.
 */
export function upgradeOffer<S extends Pick<PageService, "id" | "price" | "upgrade_to">>(from: S, services: S[]): { target: S; delta: number } | null {
  if (!from.upgrade_to || from.upgrade_to === from.id) return null;
  const target = services.find((s) => s.id === from.upgrade_to);
  if (!target) return null;
  const a = pesos(from.price);
  const b = pesos(target.price);
  if (a == null || b == null || b <= a) return null;
  return { target, delta: b - a };
}

// ── Admin validation (shared by the editor and the server actions) ──────────────────

export const CATEGORY_NAME_MAX = 40;
export const CATEGORY_TAGLINE_MAX = 80;
export const INCLUDES_MAX_ITEMS = 8;
export const INCLUDES_ITEM_MAX = 80;
const LAYOUTS: readonly CategoryLayout[] = ["list", "featured", "contact"];

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

/** A booking category as typed in the editor → what may be stored, or the first problem. */
export function checkCategoryInput(input: { name: string; tagline: string; layout: string; sortOrder: number | string; visible: boolean }): Checked<{
  name: string;
  tagline: string | null;
  layout: CategoryLayout;
  sortOrder: number;
  visible: boolean;
}> {
  const name = checkPublicLine(input.name, CATEGORY_NAME_MAX);
  if (!name.ok) return { ok: false, error: publicProfileMessage(name.error, "Nombre", name.max) };
  if (!name.value) return { ok: false, error: "Escribe el nombre de la categoría." };
  const tagline = checkPublicLine(input.tagline, CATEGORY_TAGLINE_MAX);
  if (!tagline.ok) return { ok: false, error: publicProfileMessage(tagline.error, "Frase", tagline.max) };
  if (!LAYOUTS.includes(input.layout as CategoryLayout)) return { ok: false, error: "Elige cómo se muestra la categoría." };
  if (input.layout === "contact" && !tagline.value) return { ok: false, error: "Una categoría por WhatsApp necesita la frase del enlace, por ejemplo «¿Buscas color?»." };
  const sort = Number(input.sortOrder);
  if (!Number.isInteger(sort) || sort < 0 || sort > 999) return { ok: false, error: "El orden debe ser un número entre 0 y 999." };
  return { ok: true, value: { name: name.value, tagline: tagline.value, layout: input.layout as CategoryLayout, sortOrder: sort, visible: Boolean(input.visible) } };
}

/** "Qué incluye" as typed (one item per line) → the stored list (null when empty). */
export function checkIncludes(raw: string): Checked<string[] | null> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-•·*]\s*/, ""))
    .filter((l) => l.trim() !== "");
  if (lines.length > INCLUDES_MAX_ITEMS) return { ok: false, error: `«Qué incluye»: máximo ${INCLUDES_MAX_ITEMS} líneas.` };
  const out: string[] = [];
  for (const l of lines) {
    const c = checkPublicLine(l, INCLUDES_ITEM_MAX);
    if (!c.ok) return { ok: false, error: publicProfileMessage(c.error, "«Qué incluye»", c.max) };
    if (c.value) out.push(c.value);
  }
  return { ok: true, value: out.length ? out : null };
}
