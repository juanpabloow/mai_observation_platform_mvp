import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { canManageClient, getAccessScope, hasFullAccess } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import {
  listMembersForTenant,
  listSchedulingResourcesForClient,
} from "@worker/db/repositories/tenantMembers.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { InviteForm } from "@/components/InviteForm";
import { TeamMembers, type TeamMemberView } from "@/components/TeamMembers";
import { TeamInvitations, type TeamInviteView } from "@/components/TeamInvitations";
import { ModuleHeader } from "@/components/ui/ModuleHeader";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * USERS & ACCESS for one client (CLIENT level). Reachable by the AGENCY (owner/admin) OR
 * this client's OWNER — anyone else 404s (canManageClient; the URL is never trusted).
 * This screen answers one question: WHO CAN LOG IN to this client and with what role
 * (Owner / Editor / Staff).
 *
 * A CLIENT OWNER manages Editors/Staff of their own client only, and can never mint
 * another Owner or reach any agency surface — the server actions enforce all of that; the
 * UI here just hides the controls the viewer can't use (no all-clients picker, no admin
 * tier, no "Owner" option in the role select).
 *
 * The barber ROSTER is not here — a barber is not a platform login. It lives in
 * SCHEDULING → Staff; this page loads no PII staff row.
 */
export default async function ClientTeamPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const { clientId } = await params;
  const client = await getClientForTenant(clientId); // tenant-scoped; foreign → null
  if (!client) notFound();
  // Agency, or this client's Owner. Editors/Staff/other-client logins are indistinguishably 404'd.
  if (!canManageClient(scope, clientId)) notFound();
  const agency = hasFullAccess(scope);
  const clientLabel = client.is_default ? "Unassigned" : client.name;

  const [members, invites, sites, staff, allClients] = await Promise.all([
    listMembersForTenant(scope.tenantId),
    listInvitationsForTenant(scope.tenantId),
    listSites(scope.tenantId, { clientId }),
    listSchedulingResourcesForClient(scope.tenantId, clientId),
    // The all-clients picker is an AGENCY feature (reassign a member's client); a Client
    // Owner never sees other clients, so don't even load them for them.
    agency ? listClientsForTenant(scope.tenantId) : Promise.resolve([]),
  ]);

  const clientOptions = allClients.map((c) => ({ id: c.id, name: c.is_default ? "Unassigned" : c.name }));
  const siteOptions = sites.map((site) => ({
    id: site.id,
    name: site.name,
    staff: staff
      .filter((person) => person.site_id === site.id)
      .map((person) => ({ id: person.id, name: person.name })),
  }));

  // THIS client's members only (other clients' rows are never rendered).
  const memberViews: TeamMemberView[] = members
    .filter((m) => m.role === "member" && m.member_client_id === clientId)
    .map((m) => ({
      userId: m.user_id,
      email: m.email,
      role: "member",
      clientId: m.member_client_id,
      clientName: m.client_name,
      clientRole: m.client_role,
      schedulingSiteId: m.scheduling_site_id,
      schedulingSiteName: m.scheduling_site_name,
      schedulingStaffId: m.scheduling_staff_id,
      schedulingStaffName: m.scheduling_staff_name,
      isYou: m.user_id === scope.userId,
    }));

  // THIS client's invitations only.
  // eslint-disable-next-line react-hooks/purity -- dynamic Server Component; connection() disables prerendering.
  const now = Date.now();
  const inviteViews: TeamInviteView[] = invites
    .filter((inv) => inv.role === "member" && inv.member_client_id === clientId)
    .map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      clientName: inv.client_name,
      clientRole: inv.client_role,
      schedulingSiteName: inv.scheduling_site_name,
      schedulingStaffName: inv.scheduling_staff_name,
      status: inv.status,
      sentLabel: fmtDate(inv.created_at),
      expiryLabel: fmtDate(inv.expires_at),
      invitedByEmail: inv.invited_by_email,
      isExpired: inv.status === "pending" && inv.expires_at.getTime() <= now,
    }));

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-12">
      <ModuleHeader
        title="Users & access"
        status={clientLabel}
        center={<p className="truncate text-sm text-muted">Invite people and set their role at this business.</p>}
      />

      <p className="text-sm text-muted">
        People who work at <span className="text-foreground">{clientLabel}</span>. An{" "}
        <span className="text-foreground">Owner</span> runs the business, a{" "}
        <span className="text-foreground">Setter</span> works the chats, contacts and agenda, and{" "}
        <span className="text-foreground">Staff</span> see only their own agenda. Looking for barbers? They live in{" "}
        <Link href={`/clients/${clientId}/scheduling/staff`} className="text-accent hover:underline">
          Scheduling &rarr; Staff
        </Link>
        .
      </p>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">People</h2>
        {memberViews.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-8 text-center text-sm text-faint">
            No one has been added to this business yet.
          </p>
        ) : (
          <TeamMembers
            members={memberViews}
            clients={clientOptions}
            sites={siteOptions}
            viewer={{ agency, isOwner: scope.role === "owner", canManageMembers: true, canAssignOwner: agency }}
          />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted">Invite someone</h2>
        <InviteForm mode="member" clientId={clientId} clientName={clientLabel} sites={siteOptions} canInviteOwner={agency} />
      </section>

      {inviteViews.length > 0 ? <TeamInvitations invites={inviteViews} /> : null}
    </main>
  );
}
