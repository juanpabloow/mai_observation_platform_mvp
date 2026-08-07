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
import { PageShell } from "@/components/ui/PageShell";
import { avatarColor } from "@/lib/avatarColor";
import { conversationAvatarLabel } from "@/lib/inboxView";
import { loadContactPanel } from "@/lib/contactPanel";
import { getContactTimeline } from "@worker/db/repositories/contactTimeline.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { ContactSidePanel } from "@/components/contacts/ContactSidePanel";
import { getContactById } from "@worker/db/repositories/contacts.js";
import { listFieldDefinitions } from "@worker/db/repositories/clientFieldDefinitions.js";
import { PageTitle } from "@/components/ui/PageTitle";

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
    /** The contact whose panel is open, mirroring the inbox's `?c=`. */
    c?: string;
    /** `1` opens that panel with the edit dialog already up — what the row's
     *  "+ Add email" / "+ Add number" placeholders link to. */
    edit?: string;
  }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { q, from, cursor, stage, owner, tasks, cols, c: selectedId, edit } = await searchParams;

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

  // The SELECTED contact's panel. Loaded server-side alongside the list — the panel
  // is `?c=`, so a selection is a normal navigation and its data arrives with the
  // page instead of a second client round-trip. An id from another client resolves to
  // null (loadContactPanel re-scopes it), so a forged `?c=` opens nothing.
  const panelId = selectedId && isUuid(selectedId) ? selectedId : null;
  const [panel, panelTimeline, schedulingEnabled, panelContact, panelFieldDefs] = panelId
    ? await Promise.all([
        loadContactPanel(scope.tenantId, client.id, panelId),
        getContactTimeline(scope.tenantId, client.id, panelId, {}),
        isClientModuleEnabled(scope.tenantId, client.id, "scheduling"),
        // The raw row + the client's field definitions feed the EDIT dialog. Both are
        // client-scoped reads; a `?c=` from another client resolves to null above and
        // the panel never renders.
        getContactById(scope.tenantId, panelId, client.id),
        listFieldDefinitions(scope.tenantId, client.id, { enabledOnly: true }),
      ])
    : [null, null, false, null, []];

  const visibleColumns = parseColumns(cols);
  const base = `/clients/${client.id}/contacts`;
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";
  const filtered = Boolean(search || stageFilter || ownerFilter || taskFilter);

  /** Any page link keeps the whole facet set (and `from`) intact. */
  const hrefWith = (patch: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q, from, stage, owner, tasks, cols, c: selectedId, ...patch };
    // `edit` is a one-shot: it must never ride along on the next link the user clicks.
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

      {/* ONE white card holds the whole screen (the reference's layout): a title band,
          a toolbar band — both on the surface, separated by hairlines — and then a
          RECESSED body where the table sits as its own bordered card. That inner
          contrast is what stopped the toolbar and the rows reading as one slab; the
          two used to be split into separate floating boxes instead, which is the
          "despegado" the layout had. */}
      <PageShell>
      <div className="flex shrink-0 flex-col gap-3 border-b border-line px-[var(--panel-pad)] py-3">
        <PageTitle title="Customers" count={summary.total} context={client.name}>
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
        </PageTitle>

        {/* Search + facets, then the primary action on the right. The client selector
            and the CRM / Contacts trail live in the HEADER (the single scope bar) —
            never duplicated here. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <ContactsToolbar owners={ownerOptions} />
          </div>
          <NewContactButton />
        </div>
      </div>

      {/* BODY: the table's own card on the recessed ground, with the customer panel as
          its sibling column so the bands above span both. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background p-3">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-strong bg-surface">
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
              <thead className="sticky top-0 z-10 bg-thead-bg">
                <tr className="border-b border-line">
                  <Th className="min-w-[220px]">Client name</Th>
                  <Th className="min-w-[180px]">Email</Th>
                  <Th className="min-w-[150px]">Phone</Th>
                  {visibleColumns.includes("channel") ? <Th>Channel</Th> : null}
                  {visibleColumns.includes("stage") ? <Th>Stage</Th> : null}
                  {visibleColumns.includes("owner") ? <Th>Owner</Th> : null}
                  <Th className="min-w-[170px]">Last visit</Th>
                  <Th className="min-w-[140px]">Usual barber</Th>
                  {visibleColumns.includes("nextAppt") ? <Th className="min-w-[180px]">Next appt</Th> : null}
                  <Th align="right">Appts</Th>
                  {visibleColumns.includes("visits") ? <Th align="right">Visits</Th> : null}
                  {visibleColumns.includes("consent") ? <Th>Consent</Th> : null}
                  {visibleColumns.includes("created") ? <Th>Created</Th> : null}
                  {visibleColumns.includes("openTasks") ? <Th align="right">Open tasks</Th> : null}
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
                      // 46px — the reference's row height. Taller than the dense
                      // --row-h (this table is scanned for a person, not read as a log)
                      // but not the 56px I first tried, which pushed a page of customers
                      // off the fold. The executions table keeps the dense row.
                      className={`relative h-[46px] border-b border-line/70 transition-colors last:border-0 ${
                        c.id === panelId ? "bg-chip" : "hover:bg-subtle"
                      } ${overdue ? "u-row-danger" : ""}`}
                    >
                      <Td>
                        <span className="flex items-center gap-2">
                          <ContactAvatar name={c.name} fallback={c.channel_user_id} />
                          {/* Selecting opens the PANEL (?c=) instead of leaving the
                              list; the panel itself links on to the full record. */}
                          <Link
                            href={hrefWith({ c: c.id })}
                            scroll={false}
                            aria-current={c.id === panelId ? "true" : undefined}
                            className="font-semibold text-foreground no-underline after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline"
                          >
                            <span className={`text-[0.8125rem] tracking-[-0.01em] ${named ? "" : "u-mono"}`}>
                              {c.name?.trim() || c.channel_user_id}
                            </span>
                          </Link>
                          {named ? null : <Meta>no name</Meta>}
                          {/* CONSENT stays on the name, not in an optional column: a
                              contact who opted out must be visible as such wherever
                              someone might decide to message them. */}
                          {c.messaging_consent === "opted_out" ? (
                            <Chip tone="muted" title="This contact has opted out of messaging">
                              opted out
                            </Chip>
                          ) : null}
                          {/* The red row rule must never be the only thing saying why:
                              the count moved into the Columns menu, so the EXCEPTION
                              stays here in words. */}
                          {overdue ? (
                            <Chip tone="danger" mono title={`${c.overdue_task_count} overdue`}>
                              OVERDUE
                            </Chip>
                          ) : null}
                        </span>
                      </Td>
                      {/* Email / phone come off the contact row itself. An empty one is
                          a PROMPT, not a dash — the whole row already links to the
                          record, which is where an identity gets added. */}
                      {/* An empty cell is a PROMPT, and the prompt does the thing: it
                          opens this contact's panel with the edit dialog already up.
                          `relative z-10` lifts it over the row's stretched link so the
                          click lands here and not on plain selection. */}
                      <Td>
                        {c.email ? (
                          <span className="truncate text-[0.8125rem] text-brand">{c.email}</span>
                        ) : (
                          <Link
                            href={hrefWith({ c: c.id, edit: "1" })}
                            scroll={false}
                            className="relative z-10 text-[0.8125rem] text-faint hover:text-foreground hover:underline"
                          >
                            + Add email
                          </Link>
                        )}
                      </Td>
                      <Td>
                        {c.phone_e164 ? (
                          <span className="u-mono text-[0.75rem] text-foreground">{c.phone_e164}</span>
                        ) : (
                          <Link
                            href={hrefWith({ c: c.id, edit: "1" })}
                            scroll={false}
                            className="relative z-10 text-[0.8125rem] text-faint hover:text-foreground hover:underline"
                          >
                            + Add number
                          </Link>
                        )}
                      </Td>
                      {visibleColumns.includes("channel") ? <Td className="text-muted">{c.channel}</Td> : null}
                      {visibleColumns.includes("stage") ? (
                        <Td>
                          <StageChip stage={c.stage} />
                        </Td>
                      ) : null}
                      {visibleColumns.includes("owner") ? (
                        <Td className="text-muted">{c.assigned_to ? ownerName.get(c.assigned_to) ?? "—" : "—"}</Td>
                      ) : null}
                      {/* LAST VISIT is the last completed appointment — not
                          last_contact_at, which a message also bumps. A customer who
                          wrote yesterday but last sat in the chair in March is exactly
                          the case this column exists to make visible. */}
                      <Td>
                        {c.last_visit_at ? (
                          <span className="u-mono text-[0.8125rem] text-foreground" title={formatStampFull(c.last_visit_at)}>
                            {formatVisitDay(c.last_visit_at)}
                          </span>
                        ) : (
                          <span className="text-faint">Never</span>
                        )}
                      </Td>
                      <Td className="truncate text-muted">{c.usual_staff_name ?? "—"}</Td>
                      {visibleColumns.includes("nextAppt") ? (
                        <Td>
                          <Stamp date={c.next_appointment_at} now={now} future emphasize />
                        </Td>
                      ) : null}
                      <Td align="right" className="u-mono text-foreground">
                        {c.appointment_count}
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
                      {visibleColumns.includes("openTasks") ? (
                        <Td align="right">
                          <span className={`u-mono ${c.open_task_count > 0 ? "text-foreground" : "text-faint"}`}>
                            {c.open_task_count}
                          </span>
                        </Td>
                      ) : null}
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
          </div>
        </div>

        {panel && panelId ? (
          <div className="hidden shrink-0 bg-background py-3 pr-3 xl:block">
          <ContactSidePanel
            key={panelId}
            clientId={client.id}
            contactId={panelId}
            data={panel}
            timelineItems={(panelTimeline?.items ?? []).map((it) => ({
              id: it.id,
              kind: it.kind,
              occurred_at: it.occurred_at,
              actor: it.actor,
              summary: it.summary,
              ref: it.ref,
              meta: it.meta,
            }))}
            timelineCursor={panelTimeline?.nextCursor ?? null}
            viewerUserId={scope.userId}
            viewerIsFullAccess={isFullAccess}
            schedulingEnabled={schedulingEnabled}
            openEdit={edit === "1"}
            closeHref={hrefWith({ c: undefined, edit: undefined })}
            recordHref={`${base}/${panelId}${fromQS}`}
            editInitial={{
              name: panelContact?.name ?? null,
              email: panelContact?.email ?? null,
              phone: panelContact?.phone_e164 ?? null,
              customFields: (panelContact?.custom_fields ?? {}) as Record<string, unknown>,
            }}
            fieldDefs={panelFieldDefs.map((d) => ({
              id: d.id,
              key: d.key,
              label: d.label,
              type: d.type,
              options: d.options,
            }))}
          />
          </div>
        ) : null}
      </div>
      </PageShell>
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

/** "Tue 4 Aug" — the day someone last sat in the chair, with no relative suffix:
 *  a visit is a date, and "· 12d ago" beside every row was noise at this density. */
function formatVisitDay(date: Date | string): string {
  const d = new Date(date);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d);
}

/**
 * The row's contact disc: two initials on the contact's own deterministic colour —
 * the SAME helper the inbox queue, the thread and the customer panel use, so a person
 * carries one mark across the whole app. A contact with no name falls back to the two
 * recognisable characters of its channel id.
 */
function ContactAvatar({ name, fallback }: { name: string | null; fallback: string }) {
  const label = conversationAvatarLabel(fallback, name);
  return (
    <span
      aria-hidden
      className={`u-mono flex size-[26px] shrink-0 items-center justify-center rounded-full text-[0.5938rem] font-semibold ${avatarColor(
        name?.trim() ? name : fallback,
      )}`}
    >
      {label}
    </span>
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
