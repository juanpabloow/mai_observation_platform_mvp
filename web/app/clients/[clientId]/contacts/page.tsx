import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import {
  listContacts,
  summarizeContacts,
  UNASSIGNED_OWNER,
  type ContactStage,
  type ContactTaskFilter,
} from "@worker/db/repositories/contacts.js";
import { listOpenCandidates } from "@worker/db/repositories/contactIdentities.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { DuplicateCandidates } from "@/components/contacts/DuplicateCandidates";
import {
  ContactsColumnsMenu,
  ContactsExportLink,
  ContactsFilterMenu,
  ContactsSearch,
  ContactsSortMenu,
} from "@/components/contacts/ContactsToolbar";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { parseColumns } from "@/lib/contactColumns";
import { EmptyState, GHOST_ACTION_CLS, Pagination } from "@/components/ui/primitives";
import { PAGE_SIZE } from "@/lib/contactColumns";
import { PageShell } from "@/components/ui/PageShell";
import { loadContactEditPayload, loadContactPanel } from "@/lib/contactPanel";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { ContactSidePanel } from "@/components/contacts/ContactSidePanel";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { NewContactButton } from "@/components/contacts/form/NewContactButton";

const STAGES = new Set<string>(["new", "active", "customer", "archived"]);
const TASK_FILTERS = new Set<string>(["open", "overdue"]);

/**
 * Client-scoped Contacts (Phase 3A — the canonical CRM list), in the final visual
 * language. Gated by the central resolver: session + canAccessClient + real
 * non-default client of the tenant + `crm` module enabled — any failure is a 404.
 * Every query passes the VALIDATED clientId explicitly (also for owner/admin), so
 * the list, the facets and the summary can only ever see this client's people.
 * `from` (the origin workflow) is preserved on every control and detail link.
 *
 * The redesign added the Owner + Tasks facets and the summary strip. Both are
 * SERVER-SIDE and bounded: the facets are predicates on the same client-scoped
 * query, the open-task counts come from ONE grouped aggregate on the list query,
 * and the strip is ONE extra grouped query — never a per-row lookup.
 */
export default async function ClientContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{
    q?: string;
    from?: string;
    /** 1-based page number — the redesign's numbered pagination (§2.4). */
    page?: string;
    stage?: string;
    owner?: string;
    tasks?: string;
    cols?: string;
    /** The contact whose panel is open, mirroring the inbox's `?c=`. */
    c?: string;
    /** `1` opens that panel with the edit dialog already up — what the row's
     *  "+ Agregar email" / "+ Agregar número" placeholders link to. */
    edit?: string;
  }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { q, from, page: pageRaw, stage, owner, tasks, cols, c: selectedId, edit } = await searchParams;

  // Validate every facet before it reaches SQL — an unknown value is simply no
  // filter (never an error page, never an unfiltered tenant-wide read).
  const stageFilter = stage && STAGES.has(stage) ? (stage as ContactStage) : undefined;
  const taskFilter = tasks && TASK_FILTERS.has(tasks) ? (tasks as ContactTaskFilter) : undefined;
  const search = q?.trim() || undefined;

  // Owner names: ONE members query + an in-memory map (never a per-row lookup).
  const members = await listMembersForTenant(scope.tenantId);
  const ownerName = new Map(members.map((m) => [m.user_id, m.name ?? m.email]));
  // Only a real member of this tenant (or the "unassigned" sentinel) is a valid owner.
  const ownerFilter =
    owner === UNASSIGNED_OWNER ? UNASSIGNED_OWNER : owner && ownerName.has(owner) ? owner : undefined;

  const filters = {
    search,
    stage: stageFilter,
    owner: ownerFilter,
    tasks: taskFilter,
    clientId: client.id, // ALWAYS the validated client — the list stays inside it
  };

  // PAGE NUMBER. Clamped to >= 1 here; the upper bound needs the total, which arrives
  // with the query below, so an out-of-range page is corrected AFTER the read rather
  // than guessed at before it.
  const requestedPage = Math.max(1, Math.trunc(Number(pageRaw)) || 1);

  // Duplicate merge + custom-field management are owner/admin only (server-gated too).
  const isFullAccess = hasFullAccess(scope);
  const [{ items: contacts, total: matched }, summary, candidates, formFieldDefs] = await Promise.all([
    listContacts(scope.tenantId, {
      ...filters,
      limit: PAGE_SIZE,
      offset: (requestedPage - 1) * PAGE_SIZE,
      withTotal: true,
    }),
    summarizeContacts(scope.tenantId, filters),
    isFullAccess ? listOpenCandidates(scope.tenantId, client.id) : Promise.resolve([]),
    // The create drawer's "configured by the business" block. Loaded with the list (one
    // small bounded query) rather than on open, so the form has no loading state.
    listFieldDefinitions(scope.tenantId, client.id, { enabledOnly: true }),
  ]);

  // Who this user may assign a contact to — the SAME rule the record page applies:
  // owner/admin may pick anyone with access to this client, a member only themselves.
  // The server action re-checks it; this only shapes the picker.
  const assignableOwners = members
    .filter((m) => (isFullAccess ? m.member_client_id === null || m.member_client_id === client.id : m.user_id === scope.userId))
    .map((m) => ({ userId: m.user_id, label: m.name ?? m.email }));

  // The SELECTED contact's panel. Loaded server-side alongside the list — the panel
  // is `?c=`, so a selection is a normal navigation and its data arrives with the
  // page instead of a second client round-trip. An id from another client resolves to
  // null (loadContactPanel re-scopes it), so a forged `?c=` opens nothing.
  const panelId = selectedId && isUuid(selectedId) ? selectedId : null;
  // NO TIMELINE QUERY. The panel used to open an `Actividad` tab, so this page fetched a
  // page of the unified timeline on every selection. That tab is gone (three tabs now,
  // matching the artboard), and with it the query — the timeline is the record's centre
  // column, one click away, and paying for it here on every row click bought nothing.
  const [panel, schedulingEnabled, panelEdit] = panelId
    ? await Promise.all([
        loadContactPanel(scope.tenantId, client.id, panelId),
        isClientModuleEnabled(scope.tenantId, client.id, "scheduling"),
        // The whole-contact edit payload, from the SAME loader the record header uses,
        // so the two doors into editing cannot disagree. Client-scoped: a `?c=` from
        // another client resolves to null and no Edit button is offered.
        loadContactEditPayload(scope.tenantId, client.id, panelId, {
          userId: scope.userId,
          isFullAccess,
        }),
      ])
    : ([null, false, null] as const);

  // `matched` is the count for THESE filters; summary.total is the client's whole book.
  // The footer and the pager both read `matched`, so "Mostrando 1–15 de 312" and the
  // number of pages can never describe two different sets.
  const total = matched ?? contacts.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const firstShown = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + contacts.length;

  const visibleColumns = parseColumns(cols);
  const base = `/clients/${client.id}/contacts`;
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";
  const filtered = Boolean(search || stageFilter || ownerFilter || taskFilter);

  /** Any page link keeps the whole facet set (and `from`) intact. */
  const hrefWith = (patch: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q,
      from,
      stage,
      owner,
      tasks,
      cols,
      // Page 1 is the default and stays out of the URL, so a fresh list has a clean
      // link and `?page=1` never shows up in someone's address bar.
      page: page > 1 ? String(page) : undefined,
      c: selectedId,
      ...patch,
    };
    // `edit` is a one-shot: it must never ride along on the next link the user clicks.
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const now = new Date();
  const ownerOptions = members
    .filter((m) => m.member_client_id === null || m.member_client_id === client.id)
    .map((m) => ({ userId: m.user_id, label: m.name ?? m.email }));

  return (
    // The GUTTER comes from the shell's scroll container (see app/layout.tsx), so
    // this page only owns the rhythm BETWEEN its own blocks.
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      {isFullAccess ? <DuplicateCandidates clientId={client.id} candidates={candidates} /> : null}

      {/* THREE CARDS on the canvas: title+filters, table, and the detail panel. They
          are siblings, so each keeps its own four corners and they share a top edge —
          which is also what stopped the title band from being cut short of the right
          edge back when the panel lived inside it. */}
      <div className="flex min-h-0 flex-1 gap-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {/* THE TOOLBAR (design, image 16): title + count, search, the filter/sort/columns
          controls + export/custom-fields, and the primary — ONE row on the table card's
          top edge, then the table and the pager. The separate title card and the facet-pill
          row it used to carry are folded into here to match the design; stage/owner filtering
          now lives in the Filtrar menu. `clip={false}` so the Filtrar / Orden / Columnas
          popovers are not clipped by the card's `overflow-hidden`. */}
      <PageShell clip={false}>
        <div className="flex flex-none flex-wrap items-center gap-2.5 border-b border-line-row px-3 py-2.5">
          <div className="flex shrink-0 items-baseline gap-2">
            <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">Contactos</h1>
            <span className="u-mono text-[0.71875rem] text-faint">{summary.total}</span>
          </div>
          <ContactsSearch />
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <ContactsFilterMenu owners={ownerOptions} />
            <ContactsSortMenu />
            <ContactsColumnsMenu visibleColumns={visibleColumns} />
            <ContactsExportLink clientId={client.id} />
            {isFullAccess ? (
              <Link href={`${base}/fields`} className={`${GHOST_ACTION_CLS} hidden lg:flex`}>
                Campos del negocio
              </Link>
            ) : null}
            <NewContactButton
              clientId={client.id}
              owners={assignableOwners}
              fieldDefs={formFieldDefs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options }))}
              defaultOwnerId={assignableOwners.some((o) => o.userId === scope.userId) ? scope.userId : null}
            />
          </span>
        </div>

        {contacts.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? "Ningún contacto coincide con estos filtros." : "Todavía no hay contactos."}
              hint={
                filtered ? (
                  <Link
                    href={hrefWith({ q: undefined, stage: undefined, owner: undefined, tasks: undefined, page: undefined })}
                    className="text-accent hover:underline"
                  >
                    Quitar los filtros
                  </Link>
                ) : (
                  "Las personas aparecen aquí en cuanto un flujo, una reserva o un agente las crea."
                )
              }
            />
          </div>
        ) : (
          <>
            {/* flex-1 so the white surface continues below the last row instead of
                stopping at the table and exposing the canvas. */}
            <div className="min-h-0 flex-1 overflow-auto">
              <ContactsTable
                contacts={contacts}
                selectedId={panelId}
                ownerName={ownerName}
                optionalColumns={visibleColumns}
                hrefWith={hrefWith}
                now={now}
              />
            </div>

            {/* ── The pager (§2.4) ── */}
            <div className="flex shrink-0 items-center gap-3 border-t border-line-row px-4 py-2.5">
              <span className="text-[0.71875rem] text-faint">
                Mostrando {firstShown}–{lastShown} de {total}
                {total === 1 ? " contacto" : " contactos"}
              </span>
              <span className="ml-auto">
                <Pagination
                  page={page}
                  pageCount={pageCount}
                  hrefForPage={(n) => hrefWith({ page: n > 1 ? String(n) : undefined })}
                />
              </span>
            </div>
          </>
        )}
      </PageShell>
      </div>

        {panel && panelId ? (
          // flex-col (not block) so the panel can stretch to the row's height: as a
          // block child it sized to its own content, which is why every tab left the
          // panel a different height and the page jumped on each switch.
          <ContactSidePanel
            key={panelId}
            clientId={client.id}
            contactId={panelId}
            data={panel}
            viewerUserId={scope.userId}
            viewerIsFullAccess={isFullAccess}
            schedulingEnabled={schedulingEnabled}
            openEdit={edit === "1"}
            closeHref={hrefWith({ c: undefined, edit: undefined })}
            recordHref={`${base}/${panelId}${fromQS}`}
            edit={panelEdit}
          />
        ) : null}
      </div>
    </main>
  );
}
