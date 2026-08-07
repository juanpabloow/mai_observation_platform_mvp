/**
 * PURE parser for CLIENT-LEVEL (non-workflow) surfaces under /clients/[id]/… —
 * each renders as "Client / <Label>" in the header breadcrumb. Kept dependency-
 * free so it is unit-testable and shared. Workflow routes
 * (/clients/[id]/workflows/…) are NOT client surfaces and return null here.
 */

const CLIENT_SURFACE_LABELS: ReadonlyArray<{ pattern: RegExp; label: string; group?: string }> = [
  // The bare Workflows LIST page only (…/workflows exactly) — a specific workflow
  // (…/workflows/<id>/…) is a workflow route, handled by parseWorkflowRoute, not here.
  { pattern: /^\/clients\/([^/]+)\/workflows$/, label: "Workflows" },
  { pattern: /^\/clients\/([^/]+)\/inbox(?:\/|$)/, label: "Inbox" },
  // The route stays /team; only the label a person reads is "Users & access".
  { pattern: /^\/clients\/([^/]+)\/team(?:\/|$)/, label: "Users & access" },
  { pattern: /^\/clients\/([^/]+)\/modules(?:\/|$)/, label: "Modules" },
  // Contacts belongs to CRM — NOT to Scheduling. The reference mock shows it under
  // "Scheduling", which is an inconsistency in the design, not the information
  // architecture: the route is `crm`-module gated, so the trail says CRM / Contacts.
  { pattern: /^\/clients\/([^/]+)\/contacts(?:\/|$)/, label: "Contacts", group: "CRM" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/agenda(?:\/|$)/, label: "Agenda", group: "Scheduling" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/staff(?:\/|$)/, label: "Staff", group: "Scheduling" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/admin(?:\/|$)/, label: "Scheduling settings", group: "Scheduling" },
];

export interface ClientSurface {
  clientId: string;
  label: string;
  /** The owning module group rendered before the label ("CRM" / "Scheduling"), or
   *  undefined for the surfaces that hang directly off the client (Inbox, /team, …). */
  group?: string;
}

/** The client surface for a pathname, or null (workflow routes, non-client paths). */
export function parseClientSurface(pathname: string): ClientSurface | null {
  for (const { pattern, label, group } of CLIENT_SURFACE_LABELS) {
    const m = pathname.match(pattern);
    if (m) return { clientId: decodeURIComponent(m[1]), label, ...(group ? { group } : {}) };
  }
  return null;
}
