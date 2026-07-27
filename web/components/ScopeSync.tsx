"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { parseScopeSurface } from "@/lib/scopeSurface";
import { useScope } from "./ScopeProvider";

/**
 * URL WINS across CLIENT-SIDE navigation (Phase W-1). A single instance mounted in the
 * root layout: it reads the pathname (so it re-runs on every client-side transition)
 * and, whenever the URL itself dictates a scope — a specific workflow's Executions/
 * Analytics, or an explicit all-workflows page — pushes that scope into the provider
 * (context + cookie). This guarantees the header/sidebar never display a scope that
 * differs from the content the URL is showing, even when you reach a workflow via a
 * link that isn't the switcher (e.g. a workflow-list row).
 *
 * Inbox and the module pages don't dictate scope (urlWorkflow === null), so they leave
 * the remembered scope untouched — visiting them never clears or alters it.
 */
export function ScopeSync() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { setScope } = useScope();

  // The inbox expresses scope via ?workflow=, so the query participates in URL-wins.
  const surface = parseScopeSurface(pathname, searchParams.toString());
  const clientId = surface?.clientId ?? null;
  const urlWorkflow = surface && surface.urlWorkflow !== null ? surface.urlWorkflow : null;

  useEffect(() => {
    if (clientId && urlWorkflow !== null) setScope(clientId, urlWorkflow);
  }, [clientId, urlWorkflow, setScope]);

  return null;
}
