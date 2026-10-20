/**
 * PURE parser for CLIENT-LEVEL (non-workflow) surfaces under /clients/[id]/… —
 * each renders as "Client / <Label>" in the header breadcrumb. Kept dependency-
 * free so it is unit-testable and shared. Workflow routes
 * (/clients/[id]/workflows/…) are NOT client surfaces and return null here.
 *
 * TWO SEGMENTS, not three. The trail used to read "Client / CRM / Contacts": a module
 * GROUP sat between the client and the page. It is gone, and the group field with it.
 * The rail already groups these pages under WORKSPACE / CRM / SCHEDULING /
 * ADMINISTRATION headings 200px to the left, so the breadcrumb repeating "CRM" spent a
 * segment restating what the reader can see — and a three-segment trail implies a
 * navigable hierarchy that does not exist (there is no "/clients/x/crm" page to click).
 *
 * Labels are in SPANISH, like the surfaces they name.
 */

const CLIENT_SURFACE_LABELS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  // The bare Workflows LIST page only (…/workflows exactly) — a specific workflow
  // (…/workflows/<id>/…) is a workflow route, handled by parseWorkflowRoute, not here.
  { pattern: /^\/clients\/([^/]+)\/workflows$/, label: "Flujos" },
  { pattern: /^\/clients\/([^/]+)\/inbox(?:\/|$)/, label: "Inbox" },
  // The client's Analytics: the value dashboard (workflow analytics live under Workflows).
  { pattern: /^\/clients\/([^/]+)\/analytics(?:\/|$)/, label: "Dashboard de valor" },
  // The route stays /team; only the label a person reads is "Usuarios y accesos".
  { pattern: /^\/clients\/([^/]+)\/team(?:\/|$)/, label: "Usuarios y accesos" },
  { pattern: /^\/clients\/([^/]+)\/modules(?:\/|$)/, label: "Módulos" },
  // Before «Contactos»: the first match wins, and /contacts/fields is its own page.
  { pattern: /^\/clients\/([^/]+)\/contacts\/fields(?:\/|$)/, label: "Campos personalizados" },
  { pattern: /^\/clients\/([^/]+)\/contacts(?:\/|$)/, label: "Contactos" },
  // Reuniones, incluida la ficha de UNA reunión (…/reuniones/<meetingId>). Faltaba, y
  // por eso el selector de cliente decía «Elige un cliente» dentro de una reunión que
  // ya pertenece a uno: sin patrón que reconociera la ruta, `parseClientSurface`
  // devolvía null y la cabecera se quedaba sin cliente que mostrar.
  //
  // Es PRESENTACIÓN y nada más: lee el clientId que ya está en la URL —el que el
  // servidor validó al renderizar la página— y busca su nombre en la lista de clientes
  // que la cabecera ya tiene, que es la de los que este usuario puede ver. No cambia
  // la asociación de la reunión ni afloja ningún permiso.
  { pattern: /^\/clients\/([^/]+)\/reuniones(?:\/|$)/, label: "Reuniones" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/agenda(?:\/|$)/, label: "Agenda" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/staff(?:\/|$)/, label: "Equipo" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/admin(?:\/|$)/, label: "Configuración de agenda" },
  // The scheduling settings pages that replaced «Configuración de agenda» (schedulingNav.ts).
  { pattern: /^\/clients\/([^/]+)\/scheduling\/hours(?:\/|$)/, label: "Horarios y ausencias" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/services(?:\/|$)/, label: "Servicios" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/promotions(?:\/|$)/, label: "Promociones" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/booking-page(?:\/|$)/, label: "Página de reservas" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/sites(?:\/|$)/, label: "Sedes" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/rules(?:\/|$)/, label: "Reglas de reserva" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/reviews(?:\/|$)/, label: "Reseñas" },
  { pattern: /^\/clients\/([^/]+)\/campaigns(?:\/|$)/, label: "Campañas" },
  { pattern: /^\/clients\/([^/]+)\/catalog(?:\/|$)/, label: "Productos" },
];

export interface ClientSurface {
  clientId: string;
  label: string;
}

/** The client surface for a pathname, or null (workflow routes, non-client paths). */
export function parseClientSurface(pathname: string): ClientSurface | null {
  for (const { pattern, label } of CLIENT_SURFACE_LABELS) {
    const m = pathname.match(pattern);
    if (m) return { clientId: decodeURIComponent(m[1]), label };
  }
  return null;
}
