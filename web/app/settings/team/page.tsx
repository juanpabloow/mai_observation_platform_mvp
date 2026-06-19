import { connection } from "next/server";
import Link from "next/link";
import { requireFullAccessOrLand } from "@/lib/access";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { InviteForm } from "@/components/InviteForm";
import { TeamMembers, type MemberRole, type TeamMemberView } from "@/components/TeamMembers";
import { TeamInvitations, type TeamInviteView } from "@/components/TeamInvitations";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Team management (RBAC-3) — owner/admin only (requireFullAccessOrLand sends a
 * member to their own client). Members list with per-row management, pending
 * invitations with revoke, and the invite form. The viewer's role gates what the
 * UI offers; every mutation is also enforced server-side in the actions.
 */
export default async function TeamSettingsPage() {
  await connection();
  const scope = await requireFullAccessOrLand();
  const [clients, members, invites] = await Promise.all([
    listClientsForTenant(scope.tenantId),
    listMembersForTenant(scope.tenantId),
    listInvitationsForTenant(scope.tenantId),
  ]);

  const clientOptions = clients.map((c) => ({ id: c.id, name: c.is_default ? "Unassigned" : c.name }));

  const memberViews: TeamMemberView[] = members.map((m) => ({
    userId: m.user_id,
    email: m.email,
    role: m.role as MemberRole,
    clientId: m.member_client_id,
    clientName: m.client_name,
    isYou: m.user_id === scope.userId,
  }));

  const now = Date.now();
  const inviteViews: TeamInviteView[] = invites.map((inv) => ({
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
        <Link href="/" className="text-sm text-muted transition-colors hover:text-foreground">
          &larr; Hub
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted">
          Manage who can access this workspace. Admins have full access; members are scoped to one client.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Members</h2>
        <TeamMembers members={memberViews} clients={clientOptions} viewerRole={scope.role as "owner" | "admin"} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invite a teammate</h2>
        <InviteForm clients={clientOptions} viewerRole={scope.role as "owner" | "admin"} />
      </section>

      <TeamInvitations invites={inviteViews} />
    </main>
  );
}
