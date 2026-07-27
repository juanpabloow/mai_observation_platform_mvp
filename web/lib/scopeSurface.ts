/**
 * PURE, ISOMORPHIC parser for the workflow-SCOPE surfaces (Phase W-1) — the pages
 * where the header's workflow switcher is shown and where the URL can dictate the
 * current scope. Dependency-free (no next/*, no DB) so it's shared by the server seed
 * (ScopeProviderServer), the client sync (ScopeSync), the header, and the sidebar,
 * and unit-testable.
 *
 * The scope-bearing surfaces, and what the URL says about scope:
 *   /clients/<c>/workflows                     → Executions, "all" (the list = all)
 *   /clients/<c>/workflows/<w>/analytics        → Analytics, that workflow (w="all" ⇒ aggregate)
 *   /clients/<c>/workflows/<w>/executions|…      → Executions, that workflow
 *   /clients/<c>/inbox        [?workflow=<w>]   → Inbox; scope from ?workflow= (W-2) else null
 * Everything else (Contacts, Agenda, Scheduling settings, Team, Modules, non-client
 * routes) returns null: the switcher is HIDDEN and the remembered scope is untouched.
 *
 * `urlWorkflow`: the scope the URL itself asserts — a workflow id, "all", or null when
 * the URL doesn't determine scope (Inbox WITHOUT ?workflow= → use the remembered cookie).
 * The Inbox expresses its scope in a query param (?workflow=) rather than a path segment,
 * so callers pass the request's search string alongside the pathname.
 */

export type ScopeSection = "executions" | "analytics" | "inbox";

export interface ScopeSurface {
  clientId: string;
  section: ScopeSection;
  urlWorkflow: string | "all" | null;
}

const RE_LIST = /^\/clients\/([^/]+)\/workflows\/?$/;
const RE_ANALYTICS = /^\/clients\/([^/]+)\/workflows\/([^/]+)\/analytics(?:\/|$)/;
const RE_WORKFLOW = /^\/clients\/([^/]+)\/workflows\/([^/]+)(?:\/|$)/;
const RE_INBOX = /^\/clients\/([^/]+)\/inbox(?:\/|$)/;

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The scope segment identity of a workflow URL slot ("all" ⇒ the aggregate). */
function slot(seg: string): string | "all" {
  const w = dec(seg);
  return w === "all" ? "all" : w;
}

/** The `?workflow=` value from a request search string / params (W-2 inbox scope). A
 * specific workflow id ⇒ that id; absent or "all" ⇒ null (fall back to the cookie). */
function inboxWorkflowParam(search: string | URLSearchParams | null | undefined): string | null {
  if (!search) return null;
  const params =
    typeof search === "string" ? new URLSearchParams(search.replace(/^\?/, "")) : search;
  const wf = params.get("workflow");
  return wf && wf !== "all" ? wf : null;
}

/** The scope surface for a pathname (+ optional search for the inbox's ?workflow=), or
 * null when scope is not applicable. */
export function parseScopeSurface(
  pathname: string,
  search?: string | URLSearchParams | null,
): ScopeSurface | null {
  let m = pathname.match(RE_LIST);
  if (m) return { clientId: dec(m[1]), section: "executions", urlWorkflow: "all" };
  m = pathname.match(RE_ANALYTICS);
  if (m) return { clientId: dec(m[1]), section: "analytics", urlWorkflow: slot(m[2]) };
  m = pathname.match(RE_WORKFLOW);
  if (m) return { clientId: dec(m[1]), section: "executions", urlWorkflow: slot(m[2]) };
  m = pathname.match(RE_INBOX);
  if (m) return { clientId: dec(m[1]), section: "inbox", urlWorkflow: inboxWorkflowParam(search) };
  return null;
}

/**
 * The canonical route for a (client, section, scope). The single source of truth for
 * every scope-aware href (sidebar items + the switcher's selection), so they can never
 * drift apart:
 *   executions + all → the workflow LIST route (which server-resolves + may redirect)
 *   executions + X   → X's executions
 *   analytics  + all → the aggregate analytics
 *   analytics  + X   → X's analytics
 *   inbox      + X   → the client inbox with ?workflow=X (all ⇒ no param)
 */
export function scopeHref(clientId: string, section: ScopeSection, scope: "all" | string): string {
  const c = `/clients/${encodeURIComponent(clientId)}`;
  if (section === "inbox") {
    return scope === "all" ? `${c}/inbox` : `${c}/inbox?workflow=${encodeURIComponent(scope)}`;
  }
  if (section === "analytics") {
    return scope === "all"
      ? `${c}/workflows/all/analytics`
      : `${c}/workflows/${encodeURIComponent(scope)}/analytics`;
  }
  return scope === "all" ? `${c}/workflows` : `${c}/workflows/${encodeURIComponent(scope)}/executions`;
}
