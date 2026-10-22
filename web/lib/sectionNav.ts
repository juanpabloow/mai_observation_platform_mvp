/**
 * THE client navigation model behind the sidebar (proposal "Mismo sidebar, tres bloques",
 * approved 2026-10-20). PURE — no next/*, no DB — so the rail and its tests share ONE
 * definition of what each person sees.
 *
 *   Operación     Inbox · Contactos · Agenda (Calendario, Equipo, Horarios y ausencias)
 *   Negocio       Catálogo (Servicios, Productos, Promociones)
 *                 Presencia y marketing (Página de reservas, Reseñas, Campañas)
 *                 Dashboard de valor
 *   Herramientas  Configuración (Sedes, Reglas de reserva, Campos personalizados,
 *                 Usuarios y accesos) · Automatizaciones (Workflows, Analíticas técnicas,
 *                 Reuniones)
 *   Agencia       Módulos — apart, agency only.
 *
 * A section with ONE visible page is a direct link (recepción sees «Productos», never a
 * «Catálogo» with one child); a section with none is not rendered. There is no second
 * navigation on the page: the sidebar is the only menu.
 *
 * THIS IS NOT THE GATE. Visibility mirrors each page's server check so nobody is shown a
 * link that 404s, but every page still enforces its own gate (requireClientModulePage +
 * the page's permission). Every page reads the PERMISSION its gate checks
 * (web/lib/permissions/catalog.ts), never a role name — so a custom role sees exactly the
 * pages it was given:
 *   p(key)     — the login holds `key` on THIS client (a member: only its own client)
 *   sched(key) — p(key) + the scheduling module + not the default client
 *   agency     — agency only, never on the default client       (Módulos)
 */

export type SectionId = "inbox" | "contacts" | "agenda" | "catalog" | "presence" | "results" | "settings" | "automations" | "agency";
export type PageId =
  | "inbox"
  | "contacts"
  | "pipeline"
  | "calendar"
  | "team"
  | "hours"
  | "services"
  | "products"
  | "promotions"
  | "booking-page"
  | "reviews"
  | "campaigns"
  | "value"
  | "sites"
  | "rules"
  | "fields"
  | "users"
  | "workflows"
  | "tech-analytics"
  | "meetings"
  | "modules";

export interface NavContext {
  clientId: string;
  /** Enabled module keys of THIS client (none for the default client). */
  modules: readonly string[];
  /** owner/admin of the tenant (memberClientId === null). */
  isAgency: boolean;
  /** The login's permission keys (web/lib/permissions/catalog.ts) — on memberClientId for
   *  a member, on every client for the agency. The rail never reads a role's name. */
  permissions: readonly string[];
  /** A professional login (bound to one staff resource): only its own agenda. */
  staffBound: boolean;
  /** The member's own client (null for the agency). */
  memberClientId: string | null;
  /** The tenant's default/"Unassigned" client id, when known. */
  defaultClientId: string | null;
  /** The workflow scope for the Automatizaciones pages ("all" = every workflow). */
  workflowScope?: string | "all";
}

export interface NavPage {
  id: PageId;
  label: string;
  href: string;
}
export interface NavSection {
  id: SectionId;
  /** The rail label: the section's name, or the page's when it is the only one left. */
  label: string;
  /** 1 = Operación, 2 = Negocio, 3 = Herramientas; 4 = agency tools (kept apart). */
  block: 1 | 2 | 3 | 4;
  /** Where the section's own row goes: its lone page, or (a group with a home) that home. */
  href: string;
  pages: NavPage[];
  /** `group` = 2+ pages that unfold under the row; `link` = a direct link (one page). */
  kind: "group" | "link";
  /** A group whose row ALSO navigates (Agenda → Calendario); its chevron unfolds it. */
  homeHref: string | null;
}

const SECTION_LABEL: Record<SectionId, string> = {
  inbox: "Inbox",
  contacts: "Contactos",
  agenda: "Agenda",
  catalog: "Catálogo",
  presence: "Presencia y marketing",
  results: "Dashboard de valor",
  settings: "Configuración",
  automations: "Automatizaciones",
  agency: "Módulos",
};
const BLOCK: Record<SectionId, NavSection["block"]> = {
  inbox: 1, contacts: 1, agenda: 1, catalog: 2, presence: 2, results: 2, settings: 3, automations: 3, agency: 4,
};
/** The page a section is named after: when it is the only visible one, the rail keeps
 *  the section's name («Agenda»); any other lone page lends its own («Productos»). */
const HOME_PAGE: Partial<Record<SectionId, PageId>> = {
  inbox: "inbox", contacts: "contacts", agenda: "calendar", results: "value", agency: "modules",
};
/** Groups whose row is ALSO a link to that page (pressing «Agenda» opens the calendar). */
const ROW_NAVIGATES: Partial<Record<SectionId, PageId>> = { agenda: "calendar" };

export function workflowScopeHrefs(clientId: string, scope: string | "all" = "all") {
  const c = `/clients/${clientId}/workflows`;
  return scope === "all"
    ? { executions: c, analytics: `${c}/all/analytics` }
    : { executions: `${c}/${encodeURIComponent(scope)}/executions`, analytics: `${c}/${encodeURIComponent(scope)}/analytics` };
}

export function buildSections(ctx: NavContext): NavSection[] {
  const { clientId, modules, isAgency, permissions, staffBound, memberClientId, defaultClientId } = ctx;
  const c = (p: string) => `/clients/${clientId}${p}`;
  const has = (m: string) => modules.includes(m);
  const forOwnClient = isAgency || (memberClientId !== null && clientId === memberClientId);
  const isDefault = defaultClientId !== null && clientId === defaultClientId;
  /** May this login use `key` on the client in view? (A member, only on its own.) */
  const p = (key: string) => forOwnClient && permissions.includes(key);

  // A PROFESSIONAL login: their own agenda and nothing else (unchanged).
  if (staffBound) {
    return forOwnClient && has("scheduling") && p("agenda.view")
      ? [{ id: "agenda", label: "Mi agenda", block: 1, href: c("/scheduling/agenda"), kind: "link", homeHref: null, pages: [{ id: "calendar", label: "Mi agenda", href: c("/scheduling/agenda") }] }]
      : [];
  }

  // A scheduling settings page exists only with the module on, never on the default client.
  const sched = (key: string) => p(key) && has("scheduling") && !isDefault;
  const wf = workflowScopeHrefs(clientId, ctx.workflowScope ?? "all");

  const pages: Record<SectionId, Array<NavPage | false>> = {
    // Each page is shown exactly when its own server gate would admit the login: the
    // module (when it has one) + the permission that page checks.
    inbox: [p("inbox.view") && has("inbox") && { id: "inbox", label: "Inbox", href: c("/inbox") }],
    contacts: [
      p("contacts.view") && has("crm") && { id: "contacts", label: "Contactos", href: c("/contacts") },
      p("pipeline.view") && has("crm") && { id: "pipeline", label: "Pipeline", href: c("/pipeline") },
    ],
    agenda: [
      p("agenda.view") && has("scheduling") && { id: "calendar", label: "Calendario", href: c("/scheduling/agenda") },
      sched("team.manage") && { id: "team", label: "Equipo", href: c("/scheduling/staff") },
      sched("hours.manage") && { id: "hours", label: "Horarios y ausencias", href: c("/scheduling/hours") },
    ],
    catalog: [
      sched("services.manage") && { id: "services", label: "Servicios", href: c("/scheduling/services") },
      p("products.view") && has("catalog") && { id: "products", label: "Productos", href: c("/catalog") },
      sched("promotions.manage") && { id: "promotions", label: "Promociones", href: c("/scheduling/promotions") },
    ],
    presence: [
      sched("booking_page.manage") && { id: "booking-page", label: "Página de reservas", href: c("/scheduling/booking-page") },
      sched("reviews.moderate") && { id: "reviews", label: "Reseñas", href: c("/scheduling/reviews") },
      p("campaigns.view") && has("campaigns") && { id: "campaigns", label: "Campañas", href: c("/campaigns") },
    ],
    results: [p("analytics.view") && { id: "value", label: "Dashboard de valor", href: c("/analytics") }],
    settings: [
      sched("settings.sites") && { id: "sites", label: "Sedes", href: c("/scheduling/sites") },
      sched("settings.rules") && { id: "rules", label: "Reglas de reserva", href: c("/scheduling/rules") },
      p("contacts.fields") && has("crm") && { id: "fields", label: "Campos personalizados", href: c("/contacts/fields") },
      p("access.users.view") && { id: "users", label: "Usuarios y accesos", href: c("/team") },
    ],
    automations: [
      // Workflows = the scope's executions (the production rail item, list + per-workflow
      // pages); there is no separate all-workflows execution screen to duplicate it with.
      p("automations.view") && { id: "workflows", label: "Workflows", href: wf.executions },
      p("analytics.view") && { id: "tech-analytics", label: "Analíticas técnicas", href: wf.analytics },
      p("meetings.view") && has("meetings") && { id: "meetings", label: "Reuniones", href: c("/reuniones") },
    ],
    agency: [isAgency && !isDefault && { id: "modules", label: "Módulos", href: c("/modules") }],
  };

  return (Object.keys(pages) as SectionId[])
    .map((id) => {
      const visible = pages[id].filter((p): p is NavPage => Boolean(p));
      if (visible.length === 0) return null;
      const lone = visible.length === 1 ? visible[0] : null;
      const label = lone && lone.id !== HOME_PAGE[id] ? lone.label : SECTION_LABEL[id];
      const home = ROW_NAVIGATES[id] ? visible.find((p) => p.id === ROW_NAVIGATES[id]) ?? null : null;
      return {
        id,
        label,
        block: BLOCK[id],
        href: (home ?? visible[0]).href,
        pages: visible,
        kind: lone ? "link" : "group",
        homeHref: !lone && home ? home.href : null,
      } satisfies NavSection;
    })
    .filter((s): s is NavSection => s !== null);
}

/**
 * Which section/page a pathname belongs to — so the rail marks the section and the tabs
 * mark the page even when the person arrived through a direct link. First match wins.
 */
const ROUTES: Array<{ re: RegExp; section: SectionId; page: PageId }> = [
  { re: /^\/inbox(?:\/|$)/, section: "inbox", page: "inbox" },
  { re: /^\/contacts\/fields(?:\/|$)/, section: "settings", page: "fields" },
  { re: /^\/pipeline(?:\/|$)/, section: "contacts", page: "pipeline" },
  { re: /^\/contacts(?:\/|$)/, section: "contacts", page: "contacts" },
  { re: /^\/scheduling\/agenda(?:\/|$)/, section: "agenda", page: "calendar" },
  { re: /^\/scheduling\/staff(?:\/|$)/, section: "agenda", page: "team" },
  { re: /^\/scheduling\/(?:hours|exceptions|availability)(?:\/|$)/, section: "agenda", page: "hours" },
  { re: /^\/scheduling\/services(?:\/|$)/, section: "catalog", page: "services" },
  { re: /^\/catalog(?:\/|$)/, section: "catalog", page: "products" },
  { re: /^\/scheduling\/promotions(?:\/|$)/, section: "catalog", page: "promotions" },
  { re: /^\/scheduling\/booking-page(?:\/|$)/, section: "presence", page: "booking-page" },
  { re: /^\/scheduling\/reviews(?:\/|$)/, section: "presence", page: "reviews" },
  { re: /^\/campaigns(?:\/|$)/, section: "presence", page: "campaigns" },
  { re: /^\/analytics(?:\/|$)/, section: "results", page: "value" },
  { re: /^\/scheduling\/(?:sites|admin)(?:\/|$)/, section: "settings", page: "sites" },
  { re: /^\/scheduling\/rules(?:\/|$)/, section: "settings", page: "rules" },
  { re: /^\/team(?:\/|$)/, section: "settings", page: "users" },
  { re: /^\/workflows\/[^/]+\/analytics(?:\/|$)/, section: "automations", page: "tech-analytics" },
  { re: /^\/workflows(?:\/|$)/, section: "automations", page: "workflows" },
  { re: /^\/reuniones(?:\/|$)/, section: "automations", page: "meetings" },
  { re: /^\/modules(?:\/|$)/, section: "agency", page: "modules" },
];

export function locate(clientId: string, pathname: string): { section: SectionId; page: PageId } | null {
  const prefix = `/clients/${clientId}`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length) || "/";
  const hit = ROUTES.find((r) => r.re.test(rest));
  return hit ? { section: hit.section, page: hit.page } : null;
}
