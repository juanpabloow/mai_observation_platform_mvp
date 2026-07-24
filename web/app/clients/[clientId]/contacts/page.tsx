import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { listContacts } from "@worker/db/repositories/contacts.js";
import { AutoRefresh } from "@/components/AutoRefresh";

/**
 * Client-scoped Contacts (Phase 3A — the canonical CRM list). Gated by the
 * central resolver: session + canAccessClient + real non-default client of the
 * tenant + `crm` module enabled — any failure is a 404. Every query passes the
 * VALIDATED clientId explicitly (also for owner/admin), so the list and search
 * can only ever see this client's people. `from` (the origin workflow) is
 * preserved on the search form and detail links.
 */
export default async function ClientContactsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ q?: string; from?: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "crm");
  const { q, from } = await searchParams;

  const contacts = await listContacts(scope.tenantId, {
    search: q?.trim() || undefined,
    clientId: client.id, // ALWAYS the validated client — search stays inside it
  });

  const base = `/clients/${client.id}/contacts`;
  const fromQS = from ? `?from=${encodeURIComponent(from)}` : "";
  const fmtDate = (d: Date | null): string =>
    d ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "—";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
        <AutoRefresh intervalSeconds={30} />
      </header>

      {/* Canonical client-scoped form action; `from` survives the search round-trip. */}
      <form className="flex gap-2" action={base}>
        {from ? <input type="hidden" name="from" value={from} /> : null}
        <input
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search name, phone, email, id…"
          className="w-full rounded-lg border border-line-strong bg-transparent px-3 py-1.5 text-sm"
        />
        <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle">Search</button>
      </form>

      {contacts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-sm text-muted">No contacts yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-subtle text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Channel</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Last conversation</th>
                <th className="px-3 py-2 font-medium">Next appointment</th>
                <th className="px-3 py-2 font-medium">Visits</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-subtle">
                  <td className="px-3 py-2">
                    <Link href={`${base}/${c.id}${fromQS}`} className="font-medium text-accent hover:underline">
                      {c.name ?? c.channel_user_id}
                    </Link>
                    {c.is_customer ? <span className="ml-2 rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">customer</span> : null}
                  </td>
                  <td className="px-3 py-2 text-muted">{c.channel}</td>
                  <td className="px-3 py-2 text-muted">{c.stage}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(c.last_conversation_at)}</td>
                  <td className="px-3 py-2 text-muted">{fmtDate(c.next_appointment_at)}</td>
                  <td className="px-3 py-2 text-muted">{c.visit_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
