import { serviceCategory } from "./agendaCategory";
import { CATEGORY_GROUPS } from "@/components/scheduling/services/categories";

/**
 * The counts on Configuración de agenda → Resumen (desktop) and its phone twin. Pure, so
 * they are unit-tested on their own (test/unit/schedulingOverview.test.ts).
 *
 * TWO DIFFERENT THINGS share the word "categoría" in the product, and these helpers keep
 * them apart:
 *   - the STORED category — `services.category`, chosen by the operator, NULL when unset.
 *     Catálogo → Servicios groups by it ("Sin categoría" for NULL), so the Resumen,
 *     which summarises that configuration, counts it too.
 *   - the VISUAL family — `serviceCategory(name, category)`: the stored one, or for an
 *     uncategorised service one INFERRED from its name. The agenda's colour key, Nueva
 *     cita's chips and the booking page's groups show this. It is never written back.
 * The sandbox (seedAgendaDev) has 7 uncategorised services in 4 visual families: the
 * Resumen once said "1 categoría" (NULL counted as a category), then — counting families —
 * "4", which the Servicios tab (7 under "Sin categoría") contradicted.
 */

type Svc = { name: string; category: string | null };

/** The stored values Servicios groups under a named category; anything else is "Sin categoría". */
const NAMED = new Set<string>(CATEGORY_GROUPS.map((g) => g.value).filter(Boolean));
const storedOf = (s: Svc): string | null => (s.category && NAMED.has(s.category) ? s.category : null);

/** Distinct STORED categories in use — the non-empty groups of Catálogo → Servicios. */
export function assignedCategoryCount(services: Svc[]): number {
  return new Set(services.map(storedOf).filter((c): c is string => c !== null)).size;
}

/** Services with no stored category — the "Sin categoría" group of Servicios. */
export function uncategorisedCount(services: Svc[]): number {
  return services.filter((s) => storedOf(s) === null).length;
}

/** Distinct VISUAL families (stored or inferred from the name) — the agenda's colour key. */
export function visualFamilyCount(services: Svc[]): number {
  return new Set(services.map((s) => serviceCategory(s.name, s.category))).size;
}

/**
 * FEATURED is the service's own "Destacado" flag (`services.featured`, the ★ in the
 * menus) — NOT the "Tratamiento destacado" category, which is a colour family.
 */
export function featuredCount(services: { featured: boolean }[]): number {
  return services.filter((s) => s.featured).length;
}

/** "2 categorías" · "2 categorías · 3 sin categoría" · "Sin categorías asignadas". */
export function categoriesPhrase(services: Svc[]): string {
  const assigned = assignedCategoryCount(services);
  const none = uncategorisedCount(services);
  if (assigned === 0) return services.length === 0 ? "Sin categorías" : "Sin categorías asignadas";
  const head = `${assigned} categoría${assigned === 1 ? "" : "s"}`;
  return none > 0 ? `${head} · ${none} sin categoría` : head;
}

/** The services card's helper line: stored categories, then the ★ flag. */
export function servicesSummaryHelper(services: (Svc & { featured: boolean })[]): string {
  const featured = featuredCount(services);
  return `${categoriesPhrase(services)} · ★ ${featured} destacado${featured === 1 ? "" : "s"}`;
}

/** The same card's tooltip — where the stored/visual distinction is spelled out. */
export function servicesSummaryTitle(services: Svc[]): string {
  const none = uncategorisedCount(services);
  const families = visualFamilyCount(services);
  const parts = ["Categorías guardadas en los servicios, como en Servicios."];
  if (none > 0) {
    parts.push(
      `${none} servicio${none === 1 ? "" : "s"} sin categoría: en la agenda y en la reserva toma${none === 1 ? "" : "n"} un color según su nombre.`,
    );
  }
  if (services.length > 0) parts.push(`Colores en la agenda: ${families}.`);
  parts.push("★ Destacado es la opción del servicio, no la categoría «Tratamiento destacado».");
  return parts.join(" ");
}

/** The checklist badge: completed rows over the rows actually listed. */
export function checksProgress(rows: { state: "ok" | "todo" | "warn" }[]): { done: number; total: number } {
  return { done: rows.filter((r) => r.state === "ok").length, total: rows.length };
}
