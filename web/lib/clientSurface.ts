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
  // The route stays /team; only the label a person reads is "Usuarios y accesos".
  { pattern: /^\/clients\/([^/]+)\/team(?:\/|$)/, label: "Usuarios y accesos" },
  { pattern: /^\/clients\/([^/]+)\/modules(?:\/|$)/, label: "Módulos" },
  { pattern: /^\/clients\/([^/]+)\/contacts(?:\/|$)/, label: "Contactos" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/agenda(?:\/|$)/, label: "Agenda" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/staff(?:\/|$)/, label: "Equipo" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/admin(?:\/|$)/, label: "Configuración de agenda" },
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
