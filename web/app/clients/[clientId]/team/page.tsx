import { connection } from "next/server";
import { notFound } from "next/navigation";
import { can, getAccessScope, hasFullAccess } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import {
  listMembersForTenant,
  listSchedulingResourcesForClient,
} from "@worker/db/repositories/tenantMembers.js";
import { listInvitationsForTenant } from "@worker/db/repositories/invitations.js";
import { listAccessAuditEvents, listAccessRoles, listSystemRoleOverrides, type AccessAuditRow } from "@worker/db/repositories/accessRoles.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listClientModules } from "@worker/db/repositories/clientModules.js";
import {
  SYSTEM_ROLE_HELP,
  SYSTEM_ROLE_LABEL,
  SYSTEM_ROLE_PERMISSIONS,
  permissionDef,
  sanitizeBusinessPermissions,
  type PermissionKey,
  type SystemRoleKey,
} from "@/lib/permissions/catalog";
import { canEditRole, canEditSystemRole, canGrantRole, canManageMember, grantableBy, roleRefOf, type RoleRef } from "@/lib/permissions/delegation";
import type { TeamMemberView } from "@/components/TeamMembers";
import type { TeamInviteView } from "@/components/TeamInvitations";
import type { AccessViewer, AuditView, RoleChoice, RoleView, SystemRoleView } from "@/components/team/accessTypes";
import { ClientAccessScreen } from "@/components/team/ClientAccessScreen";

function fmtDate(d: Date): string {
  return d.toLocaleDateString("es-CO", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(d: Date): string {
  return d.toLocaleString("es-CO", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SYSTEM_KEYS: SystemRoleKey[] = ["owner", "setter", "staff"];

/** One audit row in plain words (no message content, no secrets — just who/what/when). */
function auditText(e: AccessAuditRow): string {
  const c = e.changes as Record<string, unknown>;
  const label = (k: unknown) => (typeof k === "string" ? (permissionDef(k as PermissionKey)?.label ?? k) : String(k));
  const list = (v: unknown) => (Array.isArray(v) && v.length ? v.map(label).join(", ") : null);
  const roleName = (r: unknown) => (r && typeof r === "object" && "label" in r ? String((r as { label: unknown }).label ?? "—") : "—");
  switch (e.action) {
    case "role.created":
      return `Creó el rol «${e.target_label ?? ""}»${list(c.permissions) ? ` con: ${list(c.permissions)}` : " sin permisos"}.`;
    case "role.updated": {
      if (typeof c.system === "string" && c.reset) return `Restableció «${e.target_label ?? ""}» a sus permisos predeterminados en este negocio.`;
      const parts = [
        list(c.added) ? `añadió ${list(c.added)}` : null,
        list(c.removed) ? `quitó ${list(c.removed)}` : null,
        c.name && typeof c.name === "object" ? `lo renombró a «${String((c.name as { to?: unknown }).to ?? "")}»` : null,
        c.descriptionChanged ? "cambió la descripción" : null,
      ].filter(Boolean);
      return `${typeof c.system === "string" ? "Ajustó para este negocio" : "Editó"} el rol «${e.target_label ?? ""}»${parts.length ? `: ${parts.join("; ")}` : ""}.`;
    }
    case "role.deleted":
      return `Eliminó el rol «${e.target_label ?? ""}».`;
    case "member.role_changed":
      return `Cambió el rol de ${e.target_label ?? "una cuenta"}: ${roleName(c.from)} → ${roleName(c.to)}.`;
    case "member.removed":
      return `Quitó el acceso de ${e.target_label ?? "una cuenta"}.`;
    case "member.client_changed":
      return `Movió ${e.target_label ?? "una cuenta"} a otro negocio.`;
    case "member.tenant_role_changed":
      return `Cambió el nivel de agencia de ${e.target_label ?? "una cuenta"}.`;
    case "invitation.created":
      return `Invitó a ${e.target_label ?? "alguien"} como ${typeof c.label === "string" ? c.label : "miembro"}.`;
    case "invitation.revoked":
      return `Revocó la invitación de ${e.target_label ?? "alguien"}.`;
    default:
      return e.action;
  }
}

/**
 * USERS & ACCESS for one client (CLIENT level): who can log in to this business, with
 * which role — and (tab «Roles y permisos») what each role can do. Reachable with
 * access.users.view (the agency, the Dueño, or a custom role given it); anyone else 404s.
 *
 * Every control the screen offers is decided HERE with the delegation rules
 * (lib/permissions/delegation.ts) — who may manage which row, which roles may be given,
 * which permissions may be put in a role — so the screen never offers what the server
 * actions would refuse. The actions re-check all of it on every call.
 *
 * The barber ROSTER is not here — a barber is not a platform login. It lives in
 * Agenda → Equipo; this page loads no PII staff row.
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
  if (!can(scope, "access.users.view", clientId)) notFound();
  const agency = hasFullAccess(scope);
  const clientLabel = client.is_default ? "Unassigned" : client.name;

  const [members, invites, sites, staff, allClients, roleRows, auditRows, moduleRows, overrideRows] = await Promise.all([
    listMembersForTenant(scope.tenantId),
    listInvitationsForTenant(scope.tenantId),
    listSites(scope.tenantId, { clientId }),
    listSchedulingResourcesForClient(scope.tenantId, clientId),
    // The all-clients picker is an AGENCY feature (reassign a member's client); a business
    // login never sees other clients, so don't even load them for it.
    agency ? listClientsForTenant(scope.tenantId) : Promise.resolve([]),
    listAccessRoles(scope.tenantId, clientId),
    listAccessAuditEvents(scope.tenantId, clientId, 30),
    listClientModules(scope.tenantId, clientId),
    listSystemRoleOverrides(scope.tenantId, clientId),
  ]);
  const overrides = new Map(overrideRows.map((o) => [o.system_key, o]));

  const rolesById = new Map(roleRows.map((r) => [r.id, r]));
  // Roles as THIS business has them: custom ones from their rows, system ones with the
  // agency's adjustment for this business when there is one.
  const refOf = (clientRole: string | null, accessRoleId: string | null): RoleRef | null =>
    roleRefOf({
      client_role: clientRole,
      access_role_id: accessRoleId,
      role_permissions: accessRoleId ? (rolesById.get(accessRoleId)?.permissions ?? null) : null,
      system_override: clientRole ? (overrides.get(clientRole as SystemRoleKey)?.permissions ?? null) : null,
    });
  const labelOf = (clientRole: string | null, accessRoleId: string | null): string =>
    clientRole === "custom" ? (accessRoleId ? (rolesById.get(accessRoleId)?.name ?? "Rol eliminado") : "—") : clientRole ? (SYSTEM_ROLE_LABEL[clientRole as SystemRoleKey] ?? "—") : "—";

  const siteOptions = sites.map((site) => ({
    id: site.id,
    name: site.name,
    staff: staff
      .filter((person) => person.site_id === site.id)
      .map((person) => ({ id: person.id, name: person.name })),
  }));
  const clientOptions = allClients.map((c) => ({ id: c.id, name: c.is_default ? "Unassigned" : c.name }));

  // THIS client's members only (other clients' rows are never rendered).
  const clientMembers = members.filter((m) => m.role === "member" && m.member_client_id === clientId);
  const memberViews: TeamMemberView[] = clientMembers.map((m) => {
    const ref = refOf(m.client_role, m.access_role_id);
    return {
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
      accessRoleId: m.access_role_id,
      roleLabel: labelOf(m.client_role, m.access_role_id),
      canManage: ref ? canManageMember(scope, clientId, { userId: m.user_id, role: ref }).ok : false,
    };
  });

  // THIS client's invitations only.
  // eslint-disable-next-line react-hooks/purity -- dynamic Server Component; connection() disables prerendering.
  const now = Date.now();
  const inviteViews: TeamInviteView[] = invites
    .filter((inv) => inv.role === "member" && inv.member_client_id === clientId)
    .map((inv) => {
      const ref = refOf(inv.client_role, inv.access_role_id);
      return {
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
        accessRoleId: inv.access_role_id,
        roleLabel: labelOf(inv.client_role, inv.access_role_id),
        canRevoke: agency || (ref ? canGrantRole(scope, clientId, ref).ok : false),
      };
    });

  // Roles this viewer may give (system + this business's custom roles).
  const assignable: RoleChoice[] = [
    ...SYSTEM_KEYS.filter((k) => canGrantRole(scope, clientId, refOf(k, null) as RoleRef).ok).map(
      (k): RoleChoice => ({ value: `sys:${k}`, label: SYSTEM_ROLE_LABEL[k], hint: SYSTEM_ROLE_HELP[k], clientRole: k, accessRoleId: null }),
    ),
    ...roleRows
      .filter((r) => canGrantRole(scope, clientId, { kind: "custom", id: r.id, permissions: sanitizeBusinessPermissions(r.permissions) }).ok)
      .map(
        (r): RoleChoice => ({
          value: `custom:${r.id}`,
          label: r.name,
          hint: r.description || `${r.permissions.length} permiso${r.permissions.length === 1 ? "" : "s"}.`,
          clientRole: "custom",
          accessRoleId: r.id,
        }),
      ),
  ];

  const roleViews: RoleView[] = roleRows.map((r) => {
    const perms = sanitizeBusinessPermissions(r.permissions);
    const d = canEditRole(scope, clientId, r.id, perms, perms);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      permissions: [...perms],
      version: r.version,
      memberCount: r.member_count,
      pendingInviteCount: r.pending_invite_count,
      holders: clientMembers.filter((m) => m.access_role_id === r.id).map((m) => m.email),
      updatedLabel: fmtDateTime(r.updated_at),
      updatedByEmail: r.updated_by_email,
      editable: d.ok,
      lockedWhy: d.ok ? null : d.error,
    };
  });
  const systemRoles: SystemRoleView[] = SYSTEM_KEYS.map((k) => {
    const o = overrides.get(k);
    const perms = o ? [...sanitizeBusinessPermissions(o.permissions)] : [...SYSTEM_ROLE_PERMISSIONS[k]];
    return {
      key: k,
      label: SYSTEM_ROLE_LABEL[k],
      help: SYSTEM_ROLE_HELP[k],
      permissions: perms,
      memberCount: clientMembers.filter((m) => m.client_role === k).length,
      overridden: Boolean(o),
      version: o?.version ?? null,
      editable: canEditSystemRole(scope, clientId, perms as PermissionKey[]).ok,
      holders: clientMembers.filter((m) => m.client_role === k).map((m) => m.email),
      updatedLabel: o ? fmtDateTime(o.updated_at) : null,
      updatedByEmail: o?.updated_by_email ?? null,
    };
  });
  const audit: AuditView[] = auditRows.map((e) => ({
    id: e.id,
    when: fmtDateTime(e.created_at),
    actor: e.actor_email ?? "Alguien",
    text: auditText(e),
  }));

  const viewer: AccessViewer = {
    agency,
    isOwner: scope.role === "owner",
    canManageMembers: can(scope, "access.users.manage", clientId),
    canManageRoles: can(scope, "access.roles.manage", clientId),
    canAssignOwner: agency,
    grantable: [...grantableBy(scope, clientId)],
    assignable,
  };

  return (
    <ClientAccessScreen
      clientId={clientId}
      clientLabel={clientLabel}
      members={memberViews}
      invites={inviteViews}
      sites={siteOptions}
      clients={clientOptions}
      viewer={viewer}
      roles={roleViews}
      systemRoles={systemRoles}
      audit={audit}
      modules={client.is_default ? [] : moduleRows.filter((m) => m.enabled).map((m) => m.module_key)}
    />
  );
}
