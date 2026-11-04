"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { scopeHref } from "@/lib/scopeSurface";
import { SearchField } from "@/components/ui/module/ModuleSurface";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { Button } from "@/components/ui/controls";

export interface ClientWorkflowRow {
  /** n8n workflow id — the URL segment + the mono id shown on the row. */
  n8nWorkflowId: string;
  name: string | null;
  active: boolean | null;
}

/**
 * The client's WORKFLOWS list (final-design page at /clients/<c>/workflows). A
 * searchable list of the workflows assigned to this client: status dot, name,
 * active/inactive label, and the mono workflow id. The whole row links to that
 * workflow's `section` (Executions by default; Settings for the 'all' Settings picker
 * — same list, same behavior, just a different target). Search filters client-side
 * over name + id; an empty client and a no-match search each get their own empty state.
 */
export function ClientWorkflowsList({
  clientId,
  workflows,
  section = "executions",
}: {
  clientId: string;
  workflows: ClientWorkflowRow[];
  /** Where a row leads — that workflow's Executions (default) or its Settings page. */
  section?: "executions" | "settings";
}) {
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return workflows;
    return workflows.filter(
      (w) =>
        (w.name ?? "").toLowerCase().includes(needle) ||
        w.n8nWorkflowId.toLowerCase().includes(needle),
    );
  }, [workflows, search]);

  const href = (w: ClientWorkflowRow): string => scopeHref(clientId, section, w.n8nWorkflowId);

  // Empty client (nothing assigned) — distinct from a no-match search below.
  if (workflows.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-surface">
        <EmptyState title="Todavía no hay flujos" body="Los flujos asignados a este negocio aparecen aquí. Se asignan desde Inicio, en la fila del negocio." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The shared search (Servicios, Productos…): same field, label and clear button. */}
      <SearchField value={search} onChange={setSearch} label="Buscar flujos" placeholder="Buscar por nombre o ID…" className="max-w-sm" />

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface">
          <NoResults body={`Ningún flujo coincide con «${search.trim()}».`}>
            <Button onClick={() => setSearch("")}>Borrar búsqueda</Button>
          </NoResults>
        </div>
      ) : (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-2xl border border-black/10 dark:divide-white/5 dark:border-line">
          {visible.map((w) => (
            <li key={w.n8nWorkflowId}>
              <Link
                href={href(w)}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-black/[0.03] dark:hover:bg-card"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      w.active ? "bg-green-400" : "bg-neutral-500"
                    }`}
                    title={w.active ? "Activo" : "Inactivo"}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {w.name ?? w.n8nWorkflowId}
                    </span>
                    <span className="block truncate font-mono text-xs text-neutral-500">
                      {w.n8nWorkflowId}
                    </span>
                  </span>
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                    w.active
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                      : "bg-subtle text-faint"
                  }`}
                >
                  {w.active ? "Activo" : "Inactivo"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
