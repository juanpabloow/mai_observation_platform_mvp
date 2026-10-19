import type { OriginKind } from "@worker/db/repositories/attribution.js";

/**
 * PURE display vocabulary for a contact's lead ORIGIN (AT-2). The origin_kind set is a FACT
 * (set by capture, the booking path, a merge or a person); this maps each kind to the Spanish
 * DISPLAY GROUP the UI shows and filters by, and to a human label. Dependency-free so the
 * contacts filter, the origin card and any badge share ONE mapping and can't drift.
 *
 * Groups (the filter options, in order):
 *   Anuncio               — meta_ad, meta_post            (an ad/post brought them)
 *   Orgánico              — organic_whatsapp, booking_page, booked_by_contact
 *   Desconocido           — import, unknown               (we can't attribute it)
 *   Asignado manualmente  — manual                        (a person decided)
 */

export type OriginGroupKey = "anuncio" | "organico" | "desconocido" | "manual";

export interface OriginGroup {
  key: OriginGroupKey;
  label: string;
  kinds: OriginKind[];
}

export const ORIGIN_GROUPS: OriginGroup[] = [
  { key: "anuncio", label: "Anuncio", kinds: ["meta_ad", "meta_post"] },
  { key: "organico", label: "Orgánico", kinds: ["organic_whatsapp", "booking_page", "booked_by_contact"] },
  { key: "desconocido", label: "Desconocido", kinds: ["import", "unknown"] },
  { key: "manual", label: "Asignado manualmente", kinds: ["manual"] },
];

const KIND_LABEL: Record<OriginKind, string> = {
  meta_ad: "Anuncio de Meta",
  meta_post: "Publicación de Meta",
  organic_whatsapp: "WhatsApp orgánico",
  booking_page: "Página de reservas",
  booked_by_contact: "Agendado por otro contacto",
  import: "Importado",
  manual: "Asignado manualmente",
  unknown: "Desconocido",
};

const GROUP_OF: Record<OriginKind, OriginGroupKey> = {
  meta_ad: "anuncio",
  meta_post: "anuncio",
  organic_whatsapp: "organico",
  booking_page: "organico",
  booked_by_contact: "organico",
  import: "desconocido",
  unknown: "desconocido",
  manual: "manual",
};

export function isOriginGroupKey(v: string | null | undefined): v is OriginGroupKey {
  return v === "anuncio" || v === "organico" || v === "desconocido" || v === "manual";
}

/** The kinds a group filter expands to. A null/unknown contact (origin never set) is shown
 *  under "Desconocido", so that group also includes the NULL case — the caller handles null
 *  separately (it filters by origin_kind IN (...), which never matches NULL), see the page. */
export function kindsForGroup(group: OriginGroupKey): OriginKind[] {
  return ORIGIN_GROUPS.find((g) => g.key === group)?.kinds ?? [];
}

export function originGroupLabel(group: OriginGroupKey): string {
  return ORIGIN_GROUPS.find((g) => g.key === group)?.label ?? "Desconocido";
}

/** The display group of a kind (or null origin → "desconocido"). */
export function originGroupOf(kind: OriginKind | null): OriginGroupKey {
  return kind ? GROUP_OF[kind] : "desconocido";
}

export function originKindLabel(kind: OriginKind | null): string {
  return kind ? KIND_LABEL[kind] : "Desconocido";
}

/** Chip tone per group — reuses the token palette (see globals.css). */
export function originGroupTone(group: OriginGroupKey): string {
  switch (group) {
    case "anuncio":
      return "bg-accent/10 text-accent";
    case "organico":
      return "bg-success/10 text-success";
    case "manual":
      return "bg-chip text-muted";
    default:
      return "bg-warn-soft text-warn";
  }
}
