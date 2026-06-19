import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFullAccessOrLand } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { InviteForm } from "@/components/InviteForm";
import { TeamMembers, type TeamMemberView } from "@/components/TeamMembers";
import { TeamInvitations, type TeamInviteView } from "@/components/TeamInvitations";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Per-client Team (CLIENT level — the first non-workflow route under a client).
 * Owner/admin only (requireFullAccessOrLand sends a member to their own client);
 * the clientId is resolved tenant-scoped via getClientForTenant, so a foreign/bogus
 * client 404s and the URL is never trusted. Manages THIS client's MEMBERS — the
 * client is implied by the route (no picker): invite a member here and they're
 * auto-scoped to this client; reassign moves them to another client; remove revokes.
 * Reuses the proven RBAC-3 components/actions.
 */
export default async function ClientTeamPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const scope = await requireFullAccessOrLand(); // owner/admin only
  const { clientId } = await params;
  const client = await getClientForTenant(clientId); // tenant-scoped; foreign → null
  if (!client) notFound();
  const clientLabel = client.is_default ? "Unassigned" : client.name;

  const [clients, members, invites] = await Promise.all([
    listClientsForTenant(scope.tenantId),
    listMembersForTenant(scope.tenantId),
    listInvitationsForTenant(scope.tenantId),
  ]);

  // All clients — for the per-row "move to another client" picker in TeamMembers.
  const clientOptions = clients.map((c) => ({ id: c.id, name: c.is_default ? "Unassigned" : c.name }));

  // THIS client's members.
  const memberViews: TeamMemberView[] = members
    .filter((m) => m.role === "member" && m.member_client_id === clientId)
    .map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: "member",
      clientId: m.member_client_id,
      clientName: m.client_name,
      isYou: m.user_id === scope.userId,
    }));

  // THIS client's invitations.
  const now = Date.now();
  const inviteViews: TeamInviteView[] = invites
    .filter((inv) => inv.role === "member" && inv.member_client_id === clientId)
    .map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      clientName: inv.client_name,
      status: inv.status,
      sentLabel: fmtDate(inv.created_at),
      expiryLabel: fmtDate(inv.expires_at),
      invitedByEmail: inv.invited_by_email,
      isExpired: inv.status === "pending" && inv.expires_at.getTime() <= now,
    }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="space-y-1">
        <Link
          href={`/clients/${clientId}/workflows/all/analytics`}
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          &larr; {clientLabel}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{clientLabel} · Team</h1>
        <p className="text-sm text-muted">
          Members of <span className="text-foreground">{clientLabel}</span> can see only this
          client&rsquo;s data. Admins (full access) are managed at the Hub.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Members</h2>
        {memberViews.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            No members assigned to this client yet.
          </p>
        ) : (
          <TeamMembers members={memberViews} clients={clientOptions} viewerRole={scope.role as "owner" | "admin"} />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invite a member</h2>
        <InviteForm mode="member" clientId={clientId} clientName={clientLabel} />
      </section>

      {inviteViews.length > 0 ? <TeamInvitations invites={inviteViews} /> : null}
    </main>
  );
}
