/**
 * PURE parser for CLIENT-LEVEL (non-workflow) surfaces under /clients/[id]/… —
 * each renders as "Client / <Label>" in the header breadcrumb. Kept dependency-
 * free so it is unit-testable and shared. Workflow routes
 * (/clients/[id]/workflows/…) are NOT client surfaces and return null here.
 */

const CLIENT_SURFACE_LABELS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/clients\/([^/]+)\/team(?:\/|$)/, label: "Team" },
  { pattern: /^\/clients\/([^/]+)\/modules(?:\/|$)/, label: "Modules" },
  { pattern: /^\/clients\/([^/]+)\/contacts(?:\/|$)/, label: "Contacts" },
  { pattern: /^\/clients\/([^/]+)\/scheduling\/agenda(?:\/|$)/, label: "Agenda" },
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
