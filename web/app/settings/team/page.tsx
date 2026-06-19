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
 * Hub Team (tenant level) — ADMINS ONLY (RBAC split). Owner/admin only
 * (requireFullAccessOrLand sends a member to their own client). Lists the owner +
 * admins, invites/manages ADMINS within the owner-vs-admin boundary. MEMBER
 * management now lives on each client's Team page (/clients/[id]/team). `clients`
 * is still passed to TeamMembers for the owner's "demote admin → member" client pick.
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

  // ADMINS ONLY: the owner + admins (members are managed per-client).
  const adminViews: TeamMemberView[] = members
    .filter((m) => m.role !== "member")
    .map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: m.role as MemberRole,
      clientId: m.member_client_id,
      clientName: m.client_name,
      isYou: m.user_id === scope.userId,
    }));

  const now = Date.now();
  const adminInvites: TeamInviteView[] = invites
    .filter((inv) => inv.role === "admin")
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

  const isOwner = scope.role === "owner";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <div className="space-y-1">
        <Link href="/" className="text-sm text-muted transition-colors hover:text-foreground">
          &larr; Hub
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Admins</h1>
        <p className="text-sm text-muted">
          Admins have full access to the workspace. Members are scoped to one client and managed on
          each client&rsquo;s Team page.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Owner &amp; admins</h2>
        <TeamMembers members={adminViews} clients={clientOptions} viewerRole={scope.role as "owner" | "admin"} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invite an admin</h2>
        {isOwner ? (
          <InviteForm mode="admin" />
        ) : (
          <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-sm text-faint">
            Only the workspace owner can invite or change admins.
          </p>
        )}
      </section>

      {adminInvites.length > 0 ? <TeamInvitations invites={adminInvites} /> : null}
    </main>
  );
}
