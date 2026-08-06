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
import { AutoRefresh } from "@/components/AutoRefresh";
import { DuplicateCandidates } from "@/components/contacts/DuplicateCandidates";
import { ContactsColumnsMenu, ContactsToolbar } from "@/components/contacts/ContactsToolbar";
import { parseColumns } from "@/lib/contactColumns";
import { Chip, EmptyState, Meta, StageChip, Td, Th } from "@/components/ui/primitives";
import { formatAgeShort, formatStampFull, formatStampShort } from "@/lib/format";

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
    cursor?: string;
    stage?: string;
    owner?: string;
    tasks?: string;
    cols?: string;
  }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { q, from, cursor, stage, owner, tasks, cols } = await searchParams;

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

  // Duplicate merge + custom-field management are owner/admin only (server-gated too).
  const isFullAccess = hasFullAccess(scope);
  const [{ items: contacts, nextCursor }, summary, candidates] = await Promise.all([
    listContacts(scope.tenantId, { ...filters, cursor: cursor || undefined, limit: 50 }),
    summarizeContacts(scope.tenantId, filters),
    isFullAccess ? listOpenCandidates(scope.tenantId, client.id) : Promise.resolve([]),
  ]);

  const visibleColumns = parseColumns(cols);
  const base = `/clients/${client.id}/contacts`;
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";
  const filtered = Boolean(search || stageFilter || ownerFilter || taskFilter);

  /** Any page link keeps the whole facet set (and `from`) intact. */
  const hrefWith = (patch: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q, from, stage, owner, tasks, cols, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };
  const nextHref = nextCursor ? hrefWith({ cursor: nextCursor }) : null;

  const now = new Date();
  const ownerOptions = members
    .filter((m) => m.member_client_id === null || m.member_client_id === client.id)
    .map((m) => ({ userId: m.user_id, label: m.name ?? m.email }));

  return (
    // The GUTTER comes from the shell's scroll container (see app/layout.tsx), so
    // this page only owns the rhythm BETWEEN its own blocks.
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      {isFullAccess ? <DuplicateCandidates clientId={client.id} candidates={candidates} /> : null}

      {/* THE FLOATING PANEL — one white card with a 1px border and a 6px radius,
          holding the toolbar, the stats row, the table and the end-of-list marker.
          It grows to the bottom of the viewport so the area under the last row is
          panel, never canvas. */}
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        {/* Toolbar row: search + facets, then the primary action on the right. The
            client selector and the CRM / Contacts trail live in the HEADER (the
            single scope bar) — never duplicated here. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-[var(--panel-pad)] py-2.5">
          <div className="min-w-0 flex-1">
            <ContactsToolbar owners={ownerOptions} />
          </div>
          <NewContactButton />
        </div>

        {/* Stats row — whole-filtered-set counters from ONE grouped query, with the
            column picker parked on the right (it belongs to the table, not to the
            search). `Custom fields` and the refresh indicator moved here too, so
            the search bar carries nothing but search. */}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-[var(--panel-pad)] py-2">
          <h1 className="text-sm font-semibold text-foreground">
            {summary.total} {summary.total === 1 ? "person" : "people"}
          </h1>
          <SummaryBit label="new" value={summary.new} />
          <SummaryBit label="active" value={summary.active} />
          <SummaryBit label="customer" value={summary.customer} />
          <SummaryBit
            label={summary.overdueTasks === 1 ? "task overdue" : "tasks overdue"}
            value={summary.overdueTasks}
            urgent
          />
          <SummaryBit label="unassigned" value={summary.unassigned} />
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <ContactsColumnsMenu visibleColumns={visibleColumns} />
            {isFullAccess ? (
              <Link
                href={`${base}/fields`}
                className="u-th hidden rounded-md transition-colors hover:text-foreground sm:inline-flex"
              >
                Custom fields
              </Link>
            ) : null}
            <AutoRefresh intervalSeconds={30} />
          </div>
        </div>

        {contacts.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? "No contacts match these filters." : "No contacts yet."}
              hint={
                filtered ? (
                  <Link
                    href={hrefWith({ q: undefined, stage: undefined, owner: undefined, tasks: undefined, cursor: undefined })}
                    className="text-accent hover:underline"
                  >
                    Clear filters
                  </Link>
                ) : (
                  "People appear here as soon as a workflow, a booking or an agent creates them."
                )
              }
            />
          </div>
        ) : (
          // flex-1 so the white surface continues below the last row instead of
          // stopping at the table and exposing the canvas.
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr className="border-b border-line">
                  <Th className="min-w-[200px]">Name</Th>
                  <Th>Channel</Th>
                  <Th>Stage</Th>
                  {visibleColumns.includes("owner") ? <Th>Owner</Th> : null}
                  <Th className="min-w-[210px]">
                    Last activity <span aria-label="sorted descending">↓</span>
                  </Th>
                  <Th className="min-w-[180px]">Next appt</Th>
                  {visibleColumns.includes("visits") ? <Th align="right">Visits</Th> : null}
                  {visibleColumns.includes("consent") ? <Th>Consent</Th> : null}
                  {visibleColumns.includes("created") ? <Th>Created</Th> : null}
                  <Th align="right">Open tasks</Th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => {
                  const overdue = c.overdue_task_count > 0;
                  const named = Boolean(c.name?.trim());
                  return (
                    <tr
                      key={c.id}
                      // `relative` + the stretched link in the Name cell makes the WHOLE
                      // row clickable while keeping exactly one real link per row (no
                      // duplicated tab stops, no JS row handler).
                      className={`relative h-[var(--row-h)] border-b border-line/70 transition-colors last:border-0 hover:bg-subtle ${
                        overdue ? "u-row-danger" : ""
                      }`}
                    >
                      <Td>
                        <span className="flex items-center gap-2">
                          <Link
                            href={`${base}/${c.id}${fromQS}`}
                            className="font-semibold text-foreground no-underline after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline"
                          >
                            <span className={named ? "" : "u-mono"}>{c.name?.trim() || c.channel_user_id}</span>
                          </Link>
                          {named ? null : <Meta>no name</Meta>}
                          {c.is_customer ? <Chip tone="muted">customer</Chip> : null}
                        </span>
                      </Td>
                      <Td className="text-muted">{c.channel}</Td>
                      <Td>
                        <StageChip stage={c.stage} />
                      </Td>
                      {visibleColumns.includes("owner") ? (
                        <Td className="text-muted">{c.assigned_to ? ownerName.get(c.assigned_to) ?? "—" : "—"}</Td>
                      ) : null}
                      <Td>
                        <Stamp date={c.last_contact_at} now={now} />
                      </Td>
                      <Td>
                        <Stamp date={c.next_appointment_at} now={now} future emphasize />
                      </Td>
                      {visibleColumns.includes("visits") ? (
                        <Td align="right" className="u-mono text-muted">
                          {c.visit_count}
                        </Td>
                      ) : null}
                      {visibleColumns.includes("consent") ? (
                        <Td className="text-muted">{c.messaging_consent.replace("_", " ")}</Td>
                      ) : null}
                      {visibleColumns.includes("created") ? (
                        <Td>
                          <Stamp date={c.created_at} now={now} />
                        </Td>
                      ) : null}
                      <Td align="right">
                        <span className="inline-flex items-center justify-end gap-2">
                          <span className={`u-mono ${c.open_task_count > 0 ? "text-foreground" : "text-faint"}`}>
                            {c.open_task_count}
                          </span>
                          {overdue ? (
                            <Chip tone="danger" mono title={`${c.overdue_task_count} overdue`}>
                              OVERDUE
                            </Chip>
                          ) : null}
                        </span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset pagination — unchanged semantics, restyled. */}
        {contacts.length > 0 ? (
          <div className="flex shrink-0 flex-col items-center gap-2 border-t border-line px-3 py-3">
            {nextHref ? (
              <>
                <Meta>
                  SHOWING {contacts.length} OF {summary.total}
                </Meta>
                <Link
                  href={nextHref}
                  scroll={false}
                  className="inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-4 text-sm text-foreground transition-colors hover:bg-subtle"
                >
                  Next page →
                </Link>
              </>
            ) : (
              <Meta>
                END OF LIST · {contacts.length} OF {summary.total}
              </Meta>
            )}
            {cursor ? (
              <Link href={hrefWith({ cursor: undefined })} scroll={false} className="text-xs text-muted hover:text-foreground">
                ← Back to first page
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

/**
 * "New contact" — rendered in the reference's position (right of the filters) so the
 * toolbar geometry matches, but DISABLED: this build has no UI creation flow, and
 * every contact must enter through C-2's identity chokepoint (`contacts/upsert`,
 * booking, or handoff) or it would create duplicate identities. This round was
 * explicitly scoped to visuals ("no cambies lógica de datos/fetching"), so wiring a
 * real create form is out of scope here rather than forgotten.
 * TODO(crm): enable once a create flow that goes through resolveContactIdentity exists.
 */
function NewContactButton() {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      title="Contact creation isn't available yet — contacts are created by a workflow, a booking, or the CRM API."
      className="inline-flex h-[var(--control-h)] shrink-0 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
    >
      New contact
    </button>
  );
}

/** One "· 4 new" fragment of the summary line. Urgent counts turn brand-red. */
function SummaryBit({ label, value, urgent = false }: { label: string; value: number; urgent?: boolean }) {
  const hot = urgent && value > 0;
  return (
    <>
      <span aria-hidden className="text-faint">
        ·
      </span>
      <span className={`text-sm ${hot ? "font-medium text-brand" : "text-muted"}`}>
        <span className="u-mono">{value}</span> {label}
      </span>
    </>
  );
}

/**
 * A timestamp cell: the ABSOLUTE stamp (mono) plus the RELATIVE feel in gray, with
 * the full unambiguous stamp on hover. `future` flips the relative wording, and
 * `emphasize` bolds an imminent appointment the way the reference does.
 */
function Stamp({
  date,
  now,
  future = false,
  emphasize = false,
}: {
  date: Date | string | null;
  now: Date;
  future?: boolean;
  emphasize?: boolean;
}) {
  if (!date) return <span className="text-faint">—</span>;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return <span className="text-faint">—</span>;
  const rel = future ? `in ${formatAgeShort(now, d)}` : `${formatAgeShort(d, now)} ago`;
  const soon = future && d.getTime() - now.getTime() < 24 * 60 * 60 * 1000;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5" title={formatStampFull(d)}>
      <span className={`u-mono text-[0.75rem] ${emphasize && soon ? "font-semibold text-foreground" : "text-foreground"}`}>
        {formatStampShort(d)}
      </span>
      <Meta className="truncate text-faintest">· {rel}</Meta>
    </span>
  );
}
