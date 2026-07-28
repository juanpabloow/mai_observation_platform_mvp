import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { CONTACT_STAGES } from "@/lib/crmValidation";
import { listContacts, type ContactStage } from "@worker/db/repositories/contacts.js";
import { listTags } from "@worker/db/repositories/contactTags.js";
import { openTaskSummaryByContacts } from "@worker/db/repositories/crmTasks.js";
import { tagsByContacts } from "@worker/db/repositories/contactTags.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { AutoRefresh } from "@/components/AutoRefresh";
import { tagChipClass } from "@/components/crm/tagColors";

/**
 * Client-scoped Contacts — the operational CRM list. Gated by the central resolver
 * (session + canAccessClient + real non-default client + `crm` enabled → else 404).
 * Every query passes the VALIDATED client.id, so the list, filters, and batched
 * tag/task lookups can only ever see this client's people. Filters (stage, tag,
 * owner, tasks) + search + offset pagination all round-trip through the querystring;
 * `from` (origin workflow) is preserved on the form and every detail link.
 */
const PAGE_SIZE = 25;

export default async function ClientContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{
    q?: string;
    from?: string;
    stage?: string;
    tag?: string;
    owner?: string;
    tasks?: string;
    page?: string;
  }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const sp = await searchParams;
  const { q, from } = sp;

  const stage = (CONTACT_STAGES as readonly string[]).includes(sp.stage ?? "") ? (sp.stage as ContactStage) : undefined;
  const taskFilter = sp.tasks === "open" || sp.tasks === "overdue" ? sp.tasks : undefined;
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const [tagCatalog, members] = await Promise.all([
    listTags(scope.tenantId, client.id),
    listMembersForTenant(scope.tenantId),
  ]);
  const tagId = tagCatalog.some((t) => t.id === sp.tag) ? sp.tag : undefined;
  const assignable = members.filter((m) => m.member_client_id === null || m.member_client_id === client.id);
  const owner = assignable.some((m) => m.user_id === sp.owner) ? sp.owner : undefined;

  // Fetch PAGE_SIZE + 1 to detect a next page without a COUNT.
  const rows = await listContacts(scope.tenantId, {
    search: q?.trim() || undefined,
    clientId: client.id,
    stage,
    tagId,
    assignedTo: owner,
    taskFilter,
    limit: PAGE_SIZE + 1,
    offset,
  });
  const hasNext = rows.length > PAGE_SIZE;
  const contacts = rows.slice(0, PAGE_SIZE);

  const ids = contacts.map((c) => c.id);
  const [tagMap, taskMap] = await Promise.all([
    tagsByContacts(scope.tenantId, client.id, ids),
    openTaskSummaryByContacts(scope.tenantId, client.id, ids),
  ]);

  const base = `/clients/${client.id}/contacts`;
  const fmtDate = (d: Date | null): string =>
    d ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "—";

  // Build a querystring preserving all active filters (used for detail links + pager).
  const carry = (over: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    const merged = { q, from, stage: sp.stage, tag: sp.tag, owner: sp.owner, tasks: sp.tasks, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : "";
  };
  const detailQS = carry({ page: undefined });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
        <AutoRefresh intervalSeconds={30} />
      </header>

      {/* All filters submit via GET to the canonical list; page resets to 1. */}
      <form className="flex flex-wrap items-end gap-2" action={base}>
        {from ? <input type="hidden" name="from" value={from} /> : null}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, phone, email, id…"
          className="min-w-56 flex-1 rounded-lg border border-line-strong bg-transparent px-3 py-1.5 text-sm"
        />
        <Select name="stage" defaultValue={sp.stage ?? ""} label="All stages">
          {CONTACT_STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select name="tag" defaultValue={sp.tag ?? ""} label="All tags">
          {tagCatalog.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
        <Select name="owner" defaultValue={sp.owner ?? ""} label="All owners">
          {assignable.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name ?? m.email}
            </option>
          ))}
        </Select>
        <Select name="tasks" defaultValue={sp.tasks ?? ""} label="Any tasks">
          <option value="open">Has open tasks</option>
          <option value="overdue">Has overdue tasks</option>
        </Select>
        <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle">Filter</button>
        <Link href={base + (from ? `?from=${encodeURIComponent(from)}` : "")} className="px-2 py-1.5 text-sm text-muted hover:text-foreground">
          Clear
        </Link>
      </form>

      {contacts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-sm text-muted">No contacts match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-subtle text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Open tasks</th>
                <th className="px-3 py-2 font-medium">Last conversation</th>
                <th className="px-3 py-2 font-medium">Next appointment</th>
                <th className="px-3 py-2 font-medium">Visits</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const tags = tagMap.get(c.id) ?? [];
                const task = taskMap.get(c.id);
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-subtle">
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Link href={`${base}/${c.id}${detailQS}`} className="font-medium text-accent hover:underline">
                          {c.name ?? c.channel_user_id}
                        </Link>
                        {c.is_customer ? <span className="rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">customer</span> : null}
                        {tags.map((t) => (
                          <span key={t.id} className={`rounded-full px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${tagChipClass(t.color)}`}>
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted">{c.assignee_name ?? "—"}</td>
                    <td className="px-3 py-2 text-muted">{c.stage}</td>
                    <td className="px-3 py-2">
                      {task ? (
                        task.overdue_count > 0 ? (
                          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-700 dark:text-red-300">
                            {task.overdue_count} overdue
                          </span>
                        ) : (
                          <span className="text-muted">open</span>
                        )
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{fmtDate(c.last_conversation_at)}</td>
                    <td className="px-3 py-2 text-muted">{fmtDate(c.next_appointment_at)}</td>
                    <td className="px-3 py-2 text-muted">{c.visit_count}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(pageNum > 1 || hasNext) ? (
        <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
          {pageNum > 1 ? (
            <Link href={base + carry({ page: String(pageNum - 1) })} className="rounded-lg border border-line px-3 py-1.5 hover:bg-subtle">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-faint">Page {pageNum}</span>
          {hasNext ? (
            <Link href={base + carry({ page: String(pageNum + 1) })} className="rounded-lg border border-line px-3 py-1.5 hover:bg-subtle">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </main>
  );
}

function Select({
  name,
  defaultValue,
  label,
  children,
}: {
  name: string;
  defaultValue: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <select name={name} defaultValue={defaultValue} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm">
      <option value="">{label}</option>
      {children}
    </select>
  );
}
