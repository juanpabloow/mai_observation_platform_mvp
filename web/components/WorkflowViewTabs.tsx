import Link from "next/link";

/**
 * The two views of the WORKFLOWS section: their executions and their (technical) execution
 * analytics, for the current scope — one workflow or "all". The client's Analytics in the
 * rail is the value dashboard (/clients/[id]/analytics); these technical numbers live here,
 * inside Workflows.
 *
 * Server-safe (no hooks, no client helpers): rendered by server pages. The classes mirror
 * the tertiary/sm button of components/ui/controls.
 */
const TAB =
  "u-focus inline-flex h-[44px] shrink-0 items-center justify-center whitespace-nowrap rounded-sch-control px-3.5 text-sm font-medium transition-colors lg:h-[36px] lg:text-[13px]";
const IDLE = `${TAB} text-muted hover:bg-subtle hover:text-foreground`;
const ACTIVE = `${TAB} bg-subtle text-foreground`;

export function workflowViewHrefs(clientId: string, scope: string | "all") {
  const c = `/clients/${clientId}/workflows`;
  return scope === "all"
    ? { executions: c, analytics: `${c}/all/analytics` }
    : { executions: `${c}/${encodeURIComponent(scope)}/executions`, analytics: `${c}/${encodeURIComponent(scope)}/analytics` };
}

export function WorkflowViewTabs({
  clientId,
  scope,
  current,
  query = "",
}: {
  clientId: string;
  scope: string | "all";
  current: "executions" | "analytics";
  /** Extra query to carry (e.g. "?from=W" on the aggregate). */
  query?: string;
}) {
  const h = workflowViewHrefs(clientId, scope);
  return (
    <nav aria-label="Vistas de Workflows" className="flex shrink-0 gap-1">
      {current === "executions" ? (
        <span aria-current="page" className={ACTIVE}>
          Ejecuciones
        </span>
      ) : (
        <Link href={h.executions} className={IDLE}>
          Ejecuciones
        </Link>
      )}
      {current === "analytics" ? (
        <span aria-current="page" className={ACTIVE}>
          Analíticas técnicas
        </span>
      ) : (
        <Link href={`${h.analytics}${query}`} className={IDLE}>
          Analíticas técnicas
        </Link>
      )}
    </nav>
  );
}
