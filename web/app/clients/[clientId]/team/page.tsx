import { connection } from "next/server";
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
import type { TeamMemberView } from "@/components/TeamMembers";
import type { TeamInviteView } from "@/components/TeamInvitations";
import { ClientAccessScreen } from "@/components/team/ClientAccessScreen";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("es-CO", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * USERS & ACCESS for one client (CLIENT level). Reachable by the AGENCY (owner/admin) OR
 * this client's OWNER — anyone else 404s (canManageClient; the URL is never trusted).
 * This screen answers one question: WHO CAN LOG IN to this client and with what role
 * (Owner / Setter / Staff).
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
    <ClientAccessScreen
      clientId={clientId}
      clientLabel={clientLabel}
      members={memberViews}
      invites={inviteViews}
      sites={siteOptions}
      clients={clientOptions}
      viewer={{ agency, isOwner: scope.role === "owner", canManageMembers: true, canAssignOwner: agency }}
    />
  );
}
