import Link from "next/link";
import { connection } from "next/server";
import { getAccessScope } from "@/lib/access";
import { listContacts } from "@worker/db/repositories/contacts.js";
import { AutoRefresh } from "@/components/AutoRefresh";

/**
 * Contacts — the CRM person list (owner/admin, tenant-scoped). ONE contacts table:
 * a contact is a "customer" (derived) once it has ≥1 completed appointment; no
 * separate leads/clients tables. Columns: name, channel, stage, last conversation,
 * next appointment, and visit count.
 */
export default async function ContactsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await connection();
  const scope = await getAccessScope();
  const { q } = await searchParams;
  const contacts = await listContacts(scope.tenantId, { search: q?.trim() || undefined, clientId: scope.memberClientId });

  const fmtDate = (d: Date | null): string =>
    d ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d)) : "—";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
        <AutoRefresh intervalSeconds={30} />
      </header>

      <form className="flex gap-2" action="/contacts">
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
                    <Link href={`/contacts/${c.id}`} className="font-medium text-accent hover:underline">
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
