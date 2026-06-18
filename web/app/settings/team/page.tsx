import { connection } from "next/server";
import Link from "next/link";
import { requireFullAccessOrLand } from "@/lib/access";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { InviteForm } from "@/components/InviteForm";

/**
 * INTERIM team/invitations page (RBAC-2). Owner/admin only (requireFullAccessOrLand
 * sends a member to their own client). RBAC-3 will replace this with the real
 * team-management UI (and wire revoke); for now it lets an owner/admin send invites
 * and see what's pending. The actions (create/list/revoke) are already built.
 */
export default async function TeamSettingsPage() {
  await connection();
  const { tenantId } = await requireFullAccessOrLand();
  const [clients, invites] = await Promise.all([
    listClientsForTenant(tenantId),
    listInvitationsForTenant(tenantId),
  ]);
  const clientOptions = clients.map((c) => ({
    id: c.id,
    name: c.is_default ? "Unassigned" : c.name,
  }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="space-y-1">
        <Link href="/" className="text-sm text-muted transition-colors hover:text-foreground">
          &larr; Hub
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted">
          Invite teammates as an admin (full access) or a member (scoped to one client).
          <span className="text-faint"> Interim — full team management lands in RBAC-3.</span>
        </p>
      </div>

      <InviteForm clients={clientOptions} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invitations</h2>
        {invites.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            No invitations yet.
          </p>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {invites.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className="truncate font-medium">{inv.email}</span>
                  <span className="ml-2 text-xs text-faint">
                    {inv.role === "member" ? `member · ${inv.client_name ?? "—"}` : "admin"}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                    inv.status === "pending"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : inv.status === "accepted"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        : "bg-subtle text-muted"
                  }`}
                >
                  {inv.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
