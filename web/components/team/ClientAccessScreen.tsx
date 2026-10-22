"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeClientRoleAction, changeMemberRoleAction, reassignMemberClientAction, removeMemberAction } from "@/lib/memberActions";
import { createInvitationAction, revokeInvitationAction } from "@/lib/inviteActions";
import { safeAction } from "@/components/ui/module/safeAction";
import { canActOnMember, type TeamClientOption, type TeamMemberView, type TeamSiteOption } from "@/components/TeamMembers";
import type { TeamInviteView } from "@/components/TeamInvitations";
import { Alert, Button, Field, INPUT, Segmented, buttonClass } from "@/components/ui/controls";
import { SYSTEM_ROLE_PERMISSIONS, permissionDef, type PermissionKey, type SystemRoleKey } from "@/lib/permissions/catalog";
import { RolesPanel } from "./RolesPanel";
import { roleChoiceValue, type AccessViewer, type AuditView, type RoleChoice, type RoleView, type SystemRoleView } from "./accessTypes";
import { Menu as ActionMenu, MenuButton } from "@/components/scheduling/ui/Menu";
import { Avatar } from "@/components/scheduling/ui/system";
import { ModuleSurface, SearchField, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { FilterSelect, type FilterGroup } from "@/components/ui/module/FilterRail";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { EditorFrame, EditorHeader, EditorSection, MetaChip, SaveBar, countChanges } from "@/components/ui/module/Editor";
import { ChoiceChips, FieldGroup, Notice } from "@/components/ui/module/FormKit";
import { ConfirmLayer, DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";

/**
 * «Usuarios y accesos» for ONE client — the ACCOUNTS that log in to M_AI for this
 * business and their client role. Not the professionals who attend customers (those live
 * in Agenda → Equipo): a professional only appears here when a login is explicitly LINKED
 * to its staff profile (role «Profesional»).
 *
 * Roles: the three protected system roles (Dueño, Recepción, Profesional) and the
 * business's own custom roles (tab «Roles y permisos», RolesPanel). What the viewer may do
 * is computed on the SERVER with the delegation rules and arrives as flags and option
 * lists (member.canManage, invite.canRevoke, viewer.assignable); the member and invite
 * actions re-check every call:
 *   - nobody gives a role wider than their own permissions, or acts on a wider one;
 *   - only the agency gives, changes or removes a Dueño, moves a login to another client,
 *     and — only the tenant owner — makes it an admin;
 *   - nobody changes their own access.
 * There is no per-site access and no «last access» in the model, so neither is shown.
 */

/** One tone per system role — none of them the green of «Activo» or the amber of «pendiente».
 *  A custom role reads neutral: its name says what it is, not a colour. */
const ROLE_TONE: Record<string, string> = {
  owner: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  setter: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  staff: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  custom: "bg-chip text-foreground",
};
const INVITES = "invitaciones";
const ROLES_TAB = "roles";

/** The permissions a role choice carries (system: code; custom: the business's role). */
function permissionsOfChoice(value: string, roles: RoleView[]): Set<PermissionKey> {
  if (value.startsWith("sys:")) return new Set(SYSTEM_ROLE_PERMISSIONS[value.slice(4) as SystemRoleKey] ?? []);
  const r = roles.find((x) => `custom:${x.id}` === value);
  return new Set((r?.permissions ?? []) as PermissionKey[]);
}

type Row = { kind: "member"; m: TeamMemberView } | { kind: "invite"; i: TeamInviteView };
const inviteState = (i: TeamInviteView) => (i.status === "pending" && i.isExpired ? "expired" : i.status);
const INVITE_LABEL: Record<string, string> = { pending: "Invitación pendiente", accepted: "Aceptada", revoked: "Revocada", expired: "Caducada" };
const INVITE_TONE: Record<string, string> = { pending: "bg-warn-soft text-warn", accepted: "bg-success/15 text-success", revoked: "bg-chip text-muted", expired: "bg-chip text-muted" };

const COLUMNS: ListColumn[] = [
  { key: "who", label: "Usuario" },
  { key: "role", label: "Rol", className: "w-[7.5rem]" },
  { key: "link", label: "Vínculo con el equipo", className: "hidden w-[24%] lg:table-cell" },
  { key: "state", label: "Estado", className: "w-[10rem]" },
];

export function ClientAccessScreen({
  clientId,
  clientLabel,
  members,
  invites,
  sites,
  clients,
  viewer,
  roles,
  systemRoles,
  audit,
  modules,
}: {
  clientId: string;
  clientLabel: string;
  members: TeamMemberView[];
  invites: TeamInviteView[];
  sites: TeamSiteOption[];
  clients: TeamClientOption[];
  viewer: AccessViewer;
  roles: RoleView[];
  systemRoles: SystemRoleView[];
  audit: AuditView[];
  modules: string[];
}) {
  const router = useRouter();
  const [tab, setTab] = useUrlState("vista", "");
  const [pending, start] = useTransition();
  const [filter, setFilter] = useUrlState("rol", "");
  const [query, setQuery] = useUrlState("q", "");
  const [menu, setMenu] = useState<string | null>(null);
  const [open, setOpen] = useState<TeamMemberView | "invite" | null>(null);
  const [revoking, setRevoking] = useState<TeamInviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef("invite");

  const pendingInvites = invites.filter((i) => inviteState(i) === "pending");
  const choiceOf = (m: TeamMemberView) => roleChoiceValue(m.clientRole, m.accessRoleId ?? null);
  const roleFilters = [
    ...systemRoles.map((r) => ({ value: `sys:${r.key}`, label: r.label })),
    ...roles.map((r) => ({ value: `custom:${r.id}`, label: r.name })),
  ];
  const view = filter === INVITES || roleFilters.some((r) => r.value === filter) ? filter : "";
  const q = query.trim().toLocaleLowerCase("es");
  const rows: Row[] =
    view === INVITES
      ? invites.map((i) => ({ kind: "invite", i }))
      : [
          ...members.filter((m) => !view || choiceOf(m) === view).map((m): Row => ({ kind: "member", m })),
          ...(view ? [] : pendingInvites.map((i): Row => ({ kind: "invite", i }))),
        ];
  const shown = rows.filter((r) => !q || (r.kind === "member" ? r.m.email : r.i.email).toLocaleLowerCase("es").includes(q));
  const groups: FilterGroup[] = [
    {
      label: "Rol",
      options: [
        { value: "", label: "Todos los roles", count: members.length + pendingInvites.length },
        ...roleFilters.map((r) => ({ ...r, count: members.filter((m) => choiceOf(m) === r.value).length })),
      ],
    },
    { label: "Otros", options: [{ value: INVITES, label: "Todas las invitaciones", count: invites.length }] },
  ];
  const tabs = (
    <Segmented
      label="Vista"
      value={tab === ROLES_TAB ? ROLES_TAB : ""}
      options={[
        { value: "", label: "Usuarios" },
        { value: ROLES_TAB, label: "Roles y permisos" },
      ]}
      onChange={setTab}
    />
  );

  const go = (target: TeamMemberView | "invite") => {
    setMenu(null);
    opener.current = target === "invite" ? "invite" : target.userId;
    setOpen(target);
  };
  const close = (saved: boolean) => {
    setOpen(null);
    if (saved) router.refresh();
    returnFocus(opener.current);
  };

  if (open === "invite") {
    return (
      <ModuleSurface label="Usuarios y accesos">
        <InviteEditor clientId={clientId} clientLabel={clientLabel} sites={sites} viewer={viewer} roles={roles} onClose={close} />
      </ModuleSurface>
    );
  }
  if (open) {
    return (
      <ModuleSurface label="Usuarios y accesos">
        <MemberEditor key={open.userId} member={open} sites={sites} clients={clients} viewer={viewer} roles={roles} onClose={close} />
      </ModuleSurface>
    );
  }
  if (tab === ROLES_TAB) {
    return <RolesPanel clientId={clientId} roles={roles} systemRoles={systemRoles} viewer={viewer} audit={audit} modules={modules} tabs={tabs} />;
  }

  const roleChip = (r: string | null, name: string | null | undefined) => (
    <span className={`rounded-full px-2 py-0.5 text-[0.75rem] font-medium ${r ? (ROLE_TONE[r] ?? ROLE_TONE.custom) : "bg-chip text-muted"}`}>{name ?? "—"}</span>
  );
  const stateChip = (row: Row) =>
    row.kind === "member" ? (
      <span className="rounded-full bg-success/15 px-2 py-0.5 text-[0.7188rem] font-medium text-success">Activo</span>
    ) : (
      <span className={`rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${INVITE_TONE[inviteState(row.i)]}`}>{INVITE_LABEL[inviteState(row.i)]}</span>
    );
  const link = (row: Row) =>
    row.kind === "member"
      ? row.m.clientRole === "staff"
        ? `${row.m.schedulingStaffName ?? "—"} · ${row.m.schedulingSiteName ?? "—"}`
        : "—"
      : row.i.clientRole === "staff"
        ? `${row.i.schedulingStaffName ?? "—"} · ${row.i.schedulingSiteName ?? "—"}`
        : "—";
  const keyOf = (row: Row) => (row.kind === "member" ? row.m.userId : `inv:${row.i.id}`);
  const inviteMenu = (i: TeamInviteView, at: "t" | "m") =>
    inviteState(i) === "pending" && i.canRevoke !== false ? (
      <ActionMenu label={`Acciones de la invitación a ${i.email}`} open={menu === `${at}:${i.id}`} onToggle={() => setMenu(menu === `${at}:${i.id}` ? null : `${at}:${i.id}`)} onClose={() => setMenu(null)}>
        <MenuButton
          disabled={pending}
          onClick={() => {
            setMenu(null);
            setRevoking(i);
          }}
        >
          Revocar invitación
        </MenuButton>
      </ActionMenu>
    ) : null;

  return (
    <ModuleSurface label="Usuarios y accesos">
      <SurfaceTop
        title="Usuarios y accesos"
        summary={`Cuentas que entran a M_AI en ${clientLabel} · ${members.length} con acceso${pendingInvites.length ? ` · ${pendingInvites.length} invitación${pendingInvites.length === 1 ? "" : "es"} pendiente${pendingInvites.length === 1 ? "" : "s"}` : ""}`}
        actions={
          <Link href={`/clients/${clientId}/scheduling/staff`} className={buttonClass()}>
            Profesionales del equipo
          </Link>
        }
        primary={
          viewer.canManageMembers && viewer.assignable.length > 0 ? (
            <Button variant="primary" data-open-key="invite" onClick={() => go("invite")}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Invitar usuario
            </Button>
          ) : undefined
        }
      >
        {tabs}
        <SearchField value={query} onChange={setQuery} label="Buscar por correo" />
        <FilterSelect groups={groups} value={view} onChange={setFilter} label="Rol" always className="w-full sm:w-auto sm:min-w-[12rem]" />
      </SurfaceTop>
      {/* Few accounts, few roles: no side menu — the role picker sits by the search. */}
      <SurfaceBody>
        {error ? (
          <div className="px-4 pt-3 sm:px-6">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <div className="px-4 pt-4 sm:px-6">
          <Notice>
            Son cuentas de acceso, no profesionales: quien atiende a los clientes se gestiona en{" "}
            <Link href={`/clients/${clientId}/scheduling/staff`} className="underline underline-offset-2">
              Agenda → Equipo
            </Link>
            . Una cuenta «Profesional» está vinculada a un perfil del equipo y solo ve su agenda.
          </Notice>
        </div>
        {members.length === 0 && invites.length === 0 ? (
          <EmptyState title="Nadie más tiene acceso todavía" body="Invita a quien trabaja en el negocio y elige su rol.">
            {viewer.canManageMembers && viewer.assignable.length > 0 ? (
              <Button variant="primary" onClick={() => go("invite")}>
                Invitar usuario
              </Button>
            ) : null}
          </EmptyState>
        ) : shown.length === 0 ? (
          <NoResults>
            {q ? <Button onClick={() => setQuery("")}>Borrar búsqueda</Button> : null}
            {view ? <Button onClick={() => setFilter("")}>Ver todos</Button> : null}
          </NoResults>
        ) : (
          <>
            <ListTable label="Usuarios y accesos" columns={COLUMNS}>
              <ListGroup span={COLUMNS.length + 1}>
                {shown.map((row) => (
                  <ListRow
                    key={keyOf(row)}
                    columns={COLUMNS}
                    name={row.kind === "member" ? row.m.email : row.i.email}
                    openKey={keyOf(row)}
                    onOpen={row.kind === "member" ? () => go(row.m) : undefined}
                    openLabel="Abrir"
                    raised={row.kind === "invite" && menu === `t:${row.i.id}`}
                    dimmed={row.kind === "invite" && inviteState(row.i) !== "pending"}
                    menu={row.kind === "invite" ? inviteMenu(row.i, "t") : null}
                    cells={[
                      <span key="w" className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={(row.kind === "member" ? row.m.email : row.i.email).split("@")[0]} size="sm" />
                        <span className="truncate">{row.kind === "member" ? row.m.email : row.i.email}</span>
                        {row.kind === "member" && row.m.isYou ? <span className="shrink-0 rounded bg-chip px-1.5 text-[0.6875rem] font-normal text-muted">Tú</span> : null}
                      </span>,
                      roleChip(row.kind === "member" ? row.m.clientRole : row.i.clientRole, row.kind === "member" ? row.m.roleLabel : row.i.roleLabel),
                      <span key="l" className="text-muted">{link(row)}</span>,
                      stateChip(row),
                    ]}
                  />
                ))}
              </ListGroup>
            </ListTable>
            <MobileList>
              <MobileGroup>
                {shown.map((row) => (
                  <MobileRow
                    key={keyOf(row)}
                    title={row.kind === "member" ? row.m.email : row.i.email}
                    openKey={keyOf(row)}
                    subtitle={`${(row.kind === "member" ? row.m.roleLabel : row.i.roleLabel) ?? "—"}${link(row) !== "—" ? ` · ${link(row)}` : ""}`}
                    badges={stateChip(row)}
                    onOpen={row.kind === "member" ? () => go(row.m) : undefined}
                    openLabel="Abrir"
                    menu={row.kind === "invite" ? inviteMenu(row.i, "m") : null}
                  />
                ))}
              </MobileGroup>
            </MobileList>
            <ListFoot>{view === INVITES ? "Las invitaciones caducan a los 7 días." : "Las invitaciones pendientes aparecen al final; las demás, eligiendo «Todas las invitaciones» en el selector de rol."}</ListFoot>
          </>
        )}
      </SurfaceBody>
      {revoking ? (
        <ConfirmLayer
          id="invite-revoke"
          title={`¿Revocar la invitación a ${revoking.email}?`}
          body="El enlace deja de funcionar. Puedes volver a invitar a esa persona cuando quieras."
          confirmLabel="Revocar"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const id = revoking.id;
            setRevoking(null);
            setError(null);
            start(async () => {
              const r = await safeAction(() => revokeInvitationAction(id));
              if (!r.ok) setError("No se pudo revocar la invitación.");
              else router.refresh();
            });
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

/** One login of this client: its role (and staff link), and what the viewer may change. */
function MemberEditor({
  member,
  sites,
  clients,
  viewer,
  roles,
  onClose,
}: {
  member: TeamMemberView;
  sites: TeamSiteOption[];
  clients: TeamClientOption[];
  viewer: AccessViewer;
  roles: RoleView[];
  onClose: (saved: boolean) => void;
}) {
  const manageable = canActOnMember(member, viewer);
  const initial = useMemo(() => {
    const siteId = member.schedulingSiteId ?? sites[0]?.id ?? "";
    return { role: roleChoiceValue(member.clientRole, member.accessRoleId ?? null), siteId, staffId: member.schedulingStaffId ?? sites.find((s) => s.id === siteId)?.staff[0]?.id ?? "" };
  }, [member, sites]);
  const [f, setF] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRole, setConfirmRole] = useState(false);
  const [busy, start] = useTransition();
  const saved = useRef(false);
  const changes = manageable ? countChanges(initial, f) : 0;
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => onClose(saved.current) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };
  const site = sites.find((s) => s.id === f.siteId);
  // The roles this viewer may give — server-computed (delegation rules), plus the current
  // one so the selection always shows what the person has today.
  const choices: RoleChoice[] = viewer.assignable.some((c) => c.value === initial.role)
    ? viewer.assignable
    : [{ value: initial.role, label: member.roleLabel ?? "—", hint: "", clientRole: (member.clientRole ?? "setter") as RoleChoice["clientRole"], accessRoleId: member.accessRoleId ?? null }, ...viewer.assignable];
  const choice = choices.find((c) => c.value === f.role);
  const roleOptions = choices.map((c) => ({ value: c.value, label: c.label }));
  const isStaff = f.role === "sys:staff";
  const staffMissing = isStaff && (!f.siteId || !f.staffId);
  // What changes for the person — the confirmation summary when access is taken away or
  // something sensitive is given.
  const before = permissionsOfChoice(initial.role, roles);
  const after = permissionsOfChoice(f.role, roles);
  const gained = [...after].filter((k) => !before.has(k));
  const lost = [...before].filter((k) => !after.has(k));
  const gainedSensitive = gained.filter((k) => permissionDef(k).sensitive);

  const save = async () => {
    if (!member.clientId || staffMissing) return;
    if (f.role !== initial.role && !confirmRole && (lost.length > 0 || gainedSensitive.length > 0)) {
      setConfirmRole(true);
      return;
    }
    setConfirmRole(false);
    setSaving(true);
    setError(null);
    try {
      const r = await changeClientRoleAction({
        targetUserId: member.userId,
        clientId: member.clientId,
        clientRole: choice?.clientRole ?? "setter",
        accessRoleId: choice?.accessRoleId ?? null,
        siteId: isStaff ? f.siteId : null,
        staffId: isStaff ? f.staffId : null,
      });
      setSaving(false);
      if (!r.ok) {
        setError(r.error ?? "No se pudo cambiar el rol.");
        return;
      }
      saved.current = true;
      guard.leave();
    } catch {
      setSaving(false);
      setError("No se pudo cambiar el rol. Inténtalo de nuevo.");
    }
  };
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      try {
        const r = await fn();
        if (!r.ok) return setError(r.error ?? "No se pudo completar la acción.");
        saved.current = true;
        guard.leave();
      } catch {
        setError("No se pudo completar la acción.");
      }
    });

  const readOnlyWhy =
    member.isYou && member.clientRole === "owner" && !viewer.agency
      ? "Es tu propia cuenta de dueño: nadie del negocio puede cambiarla; solo la agencia."
      : member.clientRole === "owner" && !viewer.agency
        ? "Solo la agencia puede cambiar o quitar el acceso de un dueño."
        : member.isYou
          ? "Es tu propia cuenta: nadie puede cambiar su propio acceso."
          : viewer.canManageMembers
            ? "Esta cuenta tiene permisos que tú no tienes, así que no puedes cambiarla."
            : "No tienes permiso para cambiar esta cuenta.";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("select, [role=menu]")) return;
        e.preventDefault();
        requestClose();
      }}
    >
      <EditorHeader
        title={member.email}
        headingId="member-editor-title"
        eyebrow={member.isYou ? "Tu cuenta" : "Cuenta de acceso"}
        chips={member.clientRole ? <span className={`rounded-full px-2 py-0.5 text-[0.75rem] font-medium ${ROLE_TONE[member.clientRole] ?? ROLE_TONE.custom}`}>{member.roleLabel ?? "—"}</span> : <MetaChip>—</MetaChip>}
        backLabel="Volver a Usuarios y accesos"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel="Guardar rol"
        saving={saving}
        canSave={changes > 0 && !staffMissing}
        readOnly={!manageable}
      />
      <EditorFrame
        layout="rows"
        sections={[
          { id: "mem-role", label: "Rol y acceso", dirty: changes > 0 },
          ...(manageable ? [{ id: "mem-remove", label: "Quitar acceso" }] : []),
          ...(manageable && viewer.agency ? [{ id: "mem-agency", label: "Opciones de agencia" }] : []),
        ]}
        saveBar={manageable ? <SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel="Guardar" canSave={changes > 0 && !staffMissing} /> : undefined}
      >
        {error ? (
          <div className="mb-2">
            <Alert>{error}</Alert>
          </div>
        ) : null}
        <EditorSection id="mem-role" title="Rol y acceso" summary={choice?.label ?? "—"}>
          {!manageable ? (
            <>
              <Notice>{readOnlyWhy}</Notice>
              <p className="text-[0.8438rem]">
                Rol: <strong className="font-semibold">{member.roleLabel ?? "—"}</strong>
                {member.clientRole === "staff" ? ` · ${member.schedulingStaffName ?? "—"} (${member.schedulingSiteName ?? "—"})` : ""}
              </p>
            </>
          ) : (
            <>
              <FieldGroup legend="Rol" hint={choice?.hint}>
                <ChoiceChips name="member-role" value={f.role} options={roleOptions} onChange={(v) => setF((x) => ({ ...x, role: v }))} />
              </FieldGroup>
              {isStaff ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Sede">
                    <select
                      value={f.siteId}
                      onChange={(e) => {
                        const next = e.target.value;
                        setF((x) => ({ ...x, siteId: next, staffId: sites.find((s) => s.id === next)?.staff[0]?.id ?? "" }));
                      }}
                      className={INPUT}
                    >
                      {sites.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Perfil del equipo" hint="El profesional cuya agenda verá esta cuenta. Solo perfiles activos que reciben reservas.">
                    <select value={f.staffId} onChange={(e) => setF((x) => ({ ...x, staffId: e.target.value }))} className={INPUT}>
                      {(site?.staff ?? []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
              {staffMissing ? <Notice tone="warn">Elige la sede y el perfil del equipo para el rol «Profesional».</Notice> : null}
            </>
          )}
        </EditorSection>
        {manageable ? (
          <EditorSection id="mem-remove" title="Quitar acceso" description="La persona deja de poder entrar a este negocio. Las conversaciones que tuviera asignadas se liberan." defaultOpen={false}>
            <Button variant="destructive" className="w-fit" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Quitar acceso
            </Button>
          </EditorSection>
        ) : null}
        {manageable && viewer.agency ? (
          <EditorSection id="mem-agency" title="Opciones de agencia" description="Solo para la agencia: mover la cuenta a otro negocio o darle acceso de administrador." defaultOpen={false}>
            {clients.length > 0 ? (
              <Field label="Negocio" hint="Al moverla, pierde el acceso a este negocio.">
                <select
                  value={member.clientId ?? ""}
                  disabled={busy}
                  onChange={(e) => act(() => reassignMemberClientAction({ targetUserId: member.userId, clientId: e.target.value }))}
                  className={INPUT}
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {viewer.isOwner ? (
              <Button className="w-fit" disabled={busy} onClick={() => act(() => changeMemberRoleAction({ targetUserId: member.userId, newRole: "admin" }))}>
                Hacer administrador de la agencia
              </Button>
            ) : null}
          </EditorSection>
        ) : null}
      </EditorFrame>
      {confirmRole ? (
        <ConfirmLayer
          id="member-role-confirm"
          title={`¿Cambiar el rol de ${member.email} a «${choice?.label ?? "—"}»?`}
          tone="primary"
          confirmLabel="Cambiar rol"
          pending={saving}
          onCancel={() => setConfirmRole(false)}
          onConfirm={() => void save()}
          body={
            <div className="flex flex-col gap-2 text-[0.8438rem]">
              {lost.length ? (
                <p>
                  <strong className="font-semibold">Pierde:</strong> {lost.map((k) => permissionDef(k).label).join(", ")}.
                </p>
              ) : null}
              {gainedSensitive.length ? (
                <p>
                  <strong className="font-semibold">Gana capacidades sensibles:</strong> {gainedSensitive.map((k) => permissionDef(k).label).join(", ")}.
                </p>
              ) : null}
              <p>Se aplica en su siguiente acción, sin cerrar sesión.</p>
            </div>
          }
        />
      ) : null}
      {confirmRemove ? (
        <ConfirmLayer
          id="member-remove"
          title={`¿Quitar el acceso de ${member.email}?`}
          body="Deja de poder entrar a este negocio. Puedes volver a invitarla cuando quieras."
          confirmLabel="Quitar acceso"
          pending={busy}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            act(() => removeMemberAction({ targetUserId: member.userId }));
          }}
        />
      ) : null}
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="El cambio de rol no se ha guardado. Si sales ahora, se pierde." /> : null}
    </div>
  );
}

/** Invite a person to THIS client with a client role (the server re-checks who may grant what). */
function InviteEditor({
  clientId,
  clientLabel,
  sites,
  viewer,
  roles,
  onClose,
}: {
  clientId: string;
  clientLabel: string;
  sites: TeamSiteOption[];
  viewer: AccessViewer;
  roles: RoleView[];
  onClose: (saved: boolean) => void;
}) {
  const canInviteOwner = viewer.canAssignOwner;
  const choices = viewer.assignable;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(choices.find((c) => c.value === "sys:setter")?.value ?? choices[0]?.value ?? "");
  const choice = choices.find((c) => c.value === role);
  const sensitive = [...permissionsOfChoice(role, roles)].filter((k) => permissionDef(k).sensitive);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [staffId, setStaffId] = useState(sites[0]?.staff[0]?.id ?? "");
  const [attempted, setAttempted] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string } | null>(null);
  const sent = useRef(false);
  const dirty = Boolean(email.trim()) && !result?.ok;
  const guard = useEditorGuard({ dirty: dirty && !sending, onLeave: () => onClose(sent.current) });
  const requestClose = () => {
    if (!sending) guard.requestLeave();
  };
  const site = sites.find((s) => s.id === siteId);
  const emailError = attempted && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "Escribe un correo válido." : "";
  const isStaff = role === "sys:staff";
  const staffMissing = isStaff && (!siteId || !staffId);
  const roleOptions = choices.map((c) => ({ value: c.value, label: c.label }));

  const send = async () => {
    setAttempted(true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || staffMissing || !choice) return;
    setSending(true);
    setResult(null);
    try {
      const r = await createInvitationAction({
        email: email.trim(),
        role: "member",
        memberClientId: clientId,
        clientRole: choice.clientRole,
        accessRoleId: choice.accessRoleId,
        schedulingSiteId: isStaff ? siteId : null,
        schedulingStaffId: isStaff ? staffId : null,
      });
      setResult(r);
      if (r.ok) sent.current = true;
    } catch {
      setResult({ ok: false, error: "No se pudo crear la invitación. Inténtalo de nuevo." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement).closest("select, [role=menu]")) return;
        e.preventDefault();
        requestClose();
      }}
    >
      <EditorHeader
        title="Invitar usuario"
        headingId="invite-editor-title"
        eyebrow={`Acceso a ${clientLabel}`}
        chips={<MetaChip>{choice?.label ?? "—"}</MetaChip>}
        backLabel="Volver a Usuarios y accesos"
        onBack={requestClose}
        changes={dirty ? 1 : 0}
        onCancel={requestClose}
        onSave={send}
        saveLabel="Enviar invitación"
        saving={sending}
        canSave={!result?.ok}
      />
      <EditorFrame
        layout="rows"
        sections={[
          { id: "inv-who", label: "Persona", errors: emailError ? 1 : 0 },
          { id: "inv-role", label: "Rol" },
        ]}
        saveBar={<SaveBar changes={dirty ? 1 : 0} onCancel={requestClose} onSave={send} saving={sending} saveLabel="Enviar" canSave={!result?.ok} />}
      >
        {result ? (
          result.ok ? (
            <div role="status" className="mb-2 flex flex-col gap-2 rounded-sch-card border border-line bg-subtle px-4 py-3 text-[0.8438rem]">
              <p className="font-semibold">{result.emailSent ? "Invitación enviada." : "Invitación creada, pero el correo no se pudo enviar."}</p>
              {!result.emailSent && result.error ? <p className="text-muted">{result.error}</p> : null}
              {result.acceptUrl ? (
                <p className="text-muted">
                  Enlace para compartir (caduca en 7 días): <span className="u-mono break-all text-foreground">{result.acceptUrl}</span>
                </p>
              ) : null}
              <Button className="w-fit" onClick={() => guard.leave()}>
                Volver a la lista
              </Button>
            </div>
          ) : (
            <div className="mb-2">
              <Alert>{result.error ?? "No se pudo crear la invitación."} Lo que escribiste se conserva.</Alert>
            </div>
          )
        ) : null}
        <EditorSection id="inv-who" title="Persona" summary={email || "Sin correo"}>
          <Field label="Correo" hint="Recibe un enlace para crear su acceso. Debe entrar con este mismo correo." error={emailError}>
            <input id="inv-f-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@negocio.com" aria-invalid={Boolean(emailError)} className={INPUT} autoComplete="off" />
          </Field>
        </EditorSection>
        <EditorSection id="inv-role" title="Rol" summary={choice?.label ?? "—"}>
          <FieldGroup legend="Rol" hint={choice?.hint}>
            <ChoiceChips name="invite-role" value={role} options={roleOptions} onChange={setRole} />
          </FieldGroup>
          {sensitive.length ? <Notice tone="warn">Este rol incluye capacidades sensibles: {sensitive.map((k) => permissionDef(k).label).join(", ")}.</Notice> : null}
          {isStaff ? (
            sites.length === 0 ? (
              <Notice tone="warn">No hay sedes con profesionales activos que reciban reservas: crea uno en Agenda → Equipo.</Notice>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Sede">
                  <select
                    value={siteId}
                    onChange={(e) => {
                      setSiteId(e.target.value);
                      setStaffId(sites.find((s) => s.id === e.target.value)?.staff[0]?.id ?? "");
                    }}
                    className={INPUT}
                  >
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Perfil del equipo" hint="Esta cuenta verá solo la agenda de este profesional.">
                  <select value={staffId} onChange={(e) => setStaffId(e.target.value)} className={INPUT}>
                    {(site?.staff ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )
          ) : null}
          {!canInviteOwner ? <p className="text-xs text-muted">Solo la agencia puede invitar a otro dueño.</p> : null}
        </EditorSection>
      </EditorFrame>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="La invitación no se ha enviado. Si sales ahora, se pierde." /> : null}
    </div>
  );
}
