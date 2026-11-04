/**
 * The browser tab's title for an internal screen: «Pantalla · Negocio · M_AI»
 * (auditoría 2026-11-03, F18). Every internal page said «Observability Platform», so
 * several open tabs — or several businesses — could not be told apart.
 *
 * PURE: the header (HeaderBar) passes what it already resolved for the breadcrumb — the
 * page label and the business name — and this only joins them. Public pages (/book,
 * /resena) keep their own metadata titles; they never render the header.
 */
import { parseClientSurface } from "./clientSurface";
import { parseScopeSurface, type ScopeSection } from "./scopeSurface";

export const BRAND_TITLE = "M_AI";

const SCOPE_LABELS: Record<ScopeSection, string> = {
  executions: "Ejecuciones",
  analytics: "Analítica",
  settings: "Ajustes del flujo",
  inbox: "Inbox",
};

// Tenant-level screens (outside /clients/<id>): the label the rail and the page use.
const TENANT_PAGES: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/(?:clients)?$/, label: "Inicio" },
  { pattern: /^\/costos-ia(?:\/|$)/, label: "Costos de IA" },
  { pattern: /^\/settings\/security\/sessions(?:\/|$)/, label: "Sesiones" },
  { pattern: /^\/settings\/security(?:\/|$)/, label: "Cuenta" },
  { pattern: /^\/settings\/connections(?:\/|$)/, label: "Conexiones" },
  { pattern: /^\/settings\/team(?:\/|$)/, label: "Equipo de la agencia" },
];

/** The page label and the client id it belongs to, or nulls when the path names neither. */
export function pageForTitle(pathname: string): { label: string | null; clientId: string | null } {
  const surface = parseClientSurface(pathname);
  if (surface) return { label: surface.label, clientId: surface.clientId };
  const scope = parseScopeSurface(pathname);
  if (scope) return { label: SCOPE_LABELS[scope.section], clientId: scope.clientId };
  const tenant = TENANT_PAGES.find((p) => p.pattern.test(pathname));
  return { label: tenant?.label ?? null, clientId: null };
}

export function buildDocumentTitle(page: string | null, business: string | null): string {
  return [page, business, BRAND_TITLE].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}
