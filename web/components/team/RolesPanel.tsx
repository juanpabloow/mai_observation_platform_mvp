"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createRoleAction, deleteRoleAction, updateRoleAction } from "@/lib/roleActions";
import { safeAction } from "@/components/ui/module/safeAction";
import { PERMISSIONS, PERMISSION_AREAS, permissionDef, type PermissionArea, type PermissionKey } from "@/lib/permissions/catalog";
import { areaState, setArea, togglePermission } from "@/lib/permissions/editorModel";
import { Alert, Button, Field, INPUT, TEXTAREA } from "@/components/ui/controls";
import { Menu as ActionMenu, MenuButton } from "@/components/scheduling/ui/Menu";
import { ModuleSurface, SurfaceBody, SurfaceTop } from "@/components/ui/module/ModuleSurface";
import { ListFoot, ListGroup, ListRow, ListTable, MobileGroup, MobileList, MobileRow, returnFocus, type ListColumn } from "@/components/ui/module/ListTable";
import { EditorFrame, EditorHeader, EditorSection, MetaChip, SaveBar } from "@/components/ui/module/Editor";
import { CheckList, Notice } from "@/components/ui/module/FormKit";
import { ConfirmLayer, DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { useEditorGuard } from "@/components/ui/module/useEditorGuard";
import type { AccessViewer, AuditView, RoleView, SystemRoleView } from "./accessTypes";

/**
 * «Usuarios y accesos» → ROLES Y PERMISOS. A role is a name, a description and a set of
 * permissions; the NAME decides nothing. The three system roles (Dueño, Recepción,
 * Profesional) are protected: read-only here, and duplicable as a starting point. A
 * business's own roles are created, edited and deleted here by whoever holds «Gestionar
 * roles» — and only with permissions they hold themselves (the server re-checks it).
 *
 * The editor only ever offers what the viewer may grant (viewer.grantable). Saving is
 * always explicit; granting something sensitive, or taking access away from a role
 * people already hold, asks for confirmation with a summary first.
 */

const MODULE_LABEL: Record<string, string> = {
  inbox: "Inbox",
  crm: "Contactos",
  scheduling: "Agenda",
  catalog: "Productos",
  campaigns: "Campañas",
  meetings: "Reuniones",
};

const COLUMNS: ListColumn[] = [
  { key: "role", label: "Rol" },
  { key: "kind", label: "Tipo", className: "w-[8.5rem]" },
  { key: "people", label: "Usuarios", className: "w-[7rem]" },
  { key: "perms", label: "Permisos", className: "hidden w-[8rem] lg:table-cell" },
];

const label = (k: string) => permissionDef(k as PermissionKey)?.label ?? k;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Open =
  | { kind: "system"; role: SystemRoleView }
  | { kind: "custom"; role: RoleView }
  | { kind: "new"; name: string; description: string; permissions: PermissionKey[]; note: string | null };

export function RolesPanel({
  clientId,
  roles,
  systemRoles,
  viewer,
  audit,
  modules,
  tabs,
}: {
  clientId: string;
  roles: RoleView[];
  systemRoles: SystemRoleView[];
  viewer: AccessViewer;
  audit: AuditView[];
  /** Modules contracted by this business — a permission outside them has no effect. */
  modules: string[];
  /** The Usuarios / Roles switcher, drawn in the toolbar. */
  tabs: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<Open | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const opener = useRef("new-role");
  const grantable = useMemo(() => new Set(viewer.grantable as PermissionKey[]), [viewer.grantable]);

  const go = (o: Open, key: string) => {
    setMenu(null);
    opener.current = key;
    setOpen(o);
  };
  const close = (saved: boolean) => {
    setOpen(null);
    if (saved) router.refresh();
    returnFocus(opener.current);
  };
  /** Start a new role from an existing one — only what the viewer may grant is copied. */
  const duplicate = (name: string, perms: string[], key: string) => {
    const kept = perms.filter((p) => grantable.has(p as PermissionKey)) as PermissionKey[];
    const dropped = perms.length - kept.length;
    go(
      {
        kind: "new",
        name: `${name} (copia)`,
        description: "",
        permissions: kept,
        note: dropped > 0 ? `Se omitieron ${plural(dropped, "permiso", "permisos")} que tú no puedes conceder.` : null,
      },
      key,
    );
  };

  if (open) {
    return (
      <ModuleSurface label="Roles y permisos">
        <RoleEditor
          key={open.kind === "new" ? "new" : open.kind === "custom" ? open.role.id : open.role.key}
          clientId={clientId}
          open={open}
          viewer={viewer}
          grantable={grantable}
          modules={modules}
          onClose={close}
        />
      </ModuleSurface>
    );
  }

  const rowMenu = (id: string, name: string, perms: string[], at: "t" | "m") =>
    viewer.canManageRoles ? (
      <ActionMenu label={`Acciones del rol ${name}`} open={menu === `${at}:${id}`} onToggle={() => setMenu(menu === `${at}:${id}` ? null : `${at}:${id}`)} onClose={() => setMenu(null)}>
        <MenuButton onClick={() => duplicate(name, perms, `role:${id}`)}>Duplicar como rol nuevo</MenuButton>
      </ActionMenu>
    ) : null;
  const kindChip = (system: boolean) =>
    system ? (
      <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[0.7188rem] font-medium text-violet-700 dark:text-violet-300">Protegido</span>
    ) : (
      <span className="rounded-full bg-chip px-2 py-0.5 text-[0.7188rem] font-medium text-muted">Personalizado</span>
    );

  return (
    <ModuleSurface label="Roles y permisos">
      <SurfaceTop
        title="Usuarios y accesos"
        summary={`${plural(systemRoles.length + roles.length, "rol", "roles")} · ${plural(roles.length, "personalizado", "personalizados")}`}
        primary={
          viewer.canManageRoles ? (
            <Button variant="primary" data-open-key="new-role" onClick={() => go({ kind: "new", name: "", description: "", permissions: [], note: null }, "new-role")}>
              <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M8 3v10M3 8h10" />
              </svg>
              Nuevo rol
            </Button>
          ) : undefined
        }
      >
        {tabs}
      </SurfaceTop>
      <SurfaceBody>
        <div className="px-4 pt-4 sm:px-6">
          <Notice>
            Un rol es un conjunto de permisos: lo que cuenta son los permisos marcados, nunca el nombre. Un permiso solo funciona si el negocio tiene contratado su
            módulo, y siempre dentro de este negocio. Los cambios se aplican en la siguiente acción de cada persona, sin cerrar sesión.
          </Notice>
        </div>
        <ListTable label="Roles" columns={COLUMNS}>
          <ListGroup span={COLUMNS.length + 1}>
            {systemRoles.map((r) => (
              <ListRow
                key={r.key}
                columns={COLUMNS}
                name={r.label}
                openKey={`role:${r.key}`}
                onOpen={() => go({ kind: "system", role: r }, `role:${r.key}`)}
                openLabel="Ver"
                raised={menu === `t:${r.key}`}
                menu={rowMenu(r.key, r.label, r.permissions, "t")}
                cells={[
                  <span key="n" className="truncate">{r.label}</span>,
                  kindChip(true),
                  <span key="p" className="text-muted">{plural(r.memberCount, "usuario", "usuarios")}</span>,
                  <span key="k" className="text-muted">{plural(r.permissions.length, "permiso", "permisos")}</span>,
                ]}
              />
            ))}
            {roles.map((r) => (
              <ListRow
                key={r.id}
                columns={COLUMNS}
                name={r.name}
                openKey={`role:${r.id}`}
                onOpen={() => go({ kind: "custom", role: r }, `role:${r.id}`)}
                openLabel="Abrir"
                raised={menu === `t:${r.id}`}
                menu={rowMenu(r.id, r.name, r.permissions, "t")}
                cells={[
                  <span key="n" className="truncate">{r.name}</span>,
                  kindChip(false),
                  <span key="p" className="text-muted">{plural(r.memberCount, "usuario", "usuarios")}</span>,
                  <span key="k" className="text-muted">{plural(r.permissions.length, "permiso", "permisos")}</span>,
                ]}
              />
            ))}
          </ListGroup>
        </ListTable>
        <MobileList>
          <MobileGroup>
            {systemRoles.map((r) => (
              <MobileRow
                key={r.key}
                title={r.label}
                openKey={`role:${r.key}`}
                subtitle={`${plural(r.memberCount, "usuario", "usuarios")} · ${plural(r.permissions.length, "permiso", "permisos")}`}
                badges={kindChip(true)}
                onOpen={() => go({ kind: "system", role: r }, `role:${r.key}`)}
                openLabel="Ver"
                menu={rowMenu(r.key, r.label, r.permissions, "m")}
              />
            ))}
            {roles.map((r) => (
              <MobileRow
                key={r.id}
                title={r.name}
                openKey={`role:${r.id}`}
                subtitle={`${plural(r.memberCount, "usuario", "usuarios")} · ${plural(r.permissions.length, "permiso", "permisos")}`}
                badges={kindChip(false)}
                onOpen={() => go({ kind: "custom", role: r }, `role:${r.id}`)}
                openLabel="Abrir"
                menu={rowMenu(r.id, r.name, r.permissions, "m")}
              />
            ))}
          </MobileGroup>
        </MobileList>
        <ListFoot>
          {roles.length === 0
            ? viewer.canManageRoles
              ? "Aún no hay roles personalizados. Crea uno o duplica un rol protegido como punto de partida."
              : "Aún no hay roles personalizados."
            : "Los roles protegidos no se editan; duplícalos para crear una variante."}
        </ListFoot>
        <section aria-labelledby="access-history-h" className="px-4 pb-8 pt-6 sm:px-6">
          <h2 id="access-history-h" className="text-[0.9375rem] font-semibold text-foreground">
            Historial de accesos
          </h2>
          <p className="mt-0.5 text-[0.8125rem] text-muted">Quién creó o cambió roles, asignaciones e invitaciones en este negocio.</p>
          {audit.length === 0 ? (
            <p className="mt-3 text-[0.8438rem] text-muted">Todavía no hay cambios registrados.</p>
          ) : (
            <ol className="mt-3 flex flex-col divide-y divide-line-soft rounded-sch-card border border-line">
              {audit.map((e) => (
                <li key={e.id} className="flex flex-col gap-0.5 px-3.5 py-2.5 text-[0.8438rem] sm:flex-row sm:items-baseline sm:gap-3">
                  <span className="shrink-0 text-xs text-muted sm:w-[9.5rem]">{e.when}</span>
                  <span className="min-w-0 flex-1 text-foreground">
                    <span className="font-medium">{e.actor}</span> · {e.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </SurfaceBody>
    </ModuleSurface>
  );
}

/** The group checkbox of an area: checked / indeterminate (some) / clear. */
function AreaCheckbox({ state, onChange, disabled, children }: { state: "all" | "some" | "none"; onChange: () => void; disabled?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <label className={`flex min-h-[44px] items-center gap-3 text-sm font-medium ${disabled ? "opacity-60" : "cursor-pointer"}`}>
      <input
        ref={ref}
        type="checkbox"
        checked={state === "all"}
        aria-checked={state === "some" ? "mixed" : state === "all"}
        onChange={onChange}
        disabled={disabled}
        className="u-focus size-4 shrink-0 accent-[var(--ink)]"
      />
      {children}
    </label>
  );
}

function RoleEditor({
  clientId,
  open,
  viewer,
  grantable,
  modules,
  onClose,
}: {
  clientId: string;
  open: Open;
  viewer: AccessViewer;
  grantable: ReadonlySet<PermissionKey>;
  modules: string[];
  onClose: (saved: boolean) => void;
}) {
  const router = useRouter();
  const isNew = open.kind === "new";
  const custom = open.kind === "custom" ? open.role : null;
  const system = open.kind === "system" ? open.role : null;
  const readOnly = !!system || (custom ? !custom.editable : !viewer.canManageRoles);
  const initial = useMemo(
    () => ({
      name: open.kind === "system" ? open.role.label : open.kind === "custom" ? open.role.name : open.name,
      description: open.kind === "system" ? open.role.help : open.kind === "custom" ? open.role.description : open.description,
      permissions: new Set((open.kind === "new" ? open.permissions : open.role.permissions) as PermissionKey[]),
    }),
    [open],
  );
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [perms, setPerms] = useState<Set<PermissionKey>>(initial.permissions);
  const [echo, setEcho] = useState<string | null>(open.kind === "new" ? open.note : null);
  const [error, setError] = useState<{ text: string; stale?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<null | "save" | "delete">(null);
  const [busy, start] = useTransition();
  const saved = useRef(false);

  const added = [...perms].filter((k) => !initial.permissions.has(k));
  const removed = [...initial.permissions].filter((k) => !perms.has(k));
  const changes = readOnly ? 0 : (name.trim() !== initial.name ? 1 : 0) + (description.trim() !== initial.description ? 1 : 0) + added.length + removed.length;
  const canSave = !readOnly && name.trim().length > 0 && (isNew || changes > 0);
  const guard = useEditorGuard({ dirty: changes > 0 && !saving, onLeave: () => onClose(saved.current) });
  const requestClose = () => {
    if (!saving) guard.requestLeave();
  };

  const people = custom ? custom.memberCount : system ? system.memberCount : 0;
  const sensitiveAdded = added.filter((k) => permissionDef(k).sensitive);
  const needsConfirm = sensitiveAdded.length > 0 || (removed.length > 0 && (people > 0 || (custom?.pendingInviteCount ?? 0) > 0));

  const explain = (alsoAdded: PermissionKey[], alsoRemoved: PermissionKey[]) => {
    const parts = [
      alsoAdded.length
        ? `También se marcó ${alsoAdded.map((k) => `«${label(k)}»`).join(", ")}, ${alsoAdded.length === 1 ? "que es necesario" : "que son necesarios"}.`
        : null,
      alsoRemoved.length
        ? `También se desmarcó ${alsoRemoved.map((k) => `«${label(k)}»`).join(", ")}, ${alsoRemoved.length === 1 ? "que dependía de él" : "que dependían de él"}.`
        : null,
    ].filter(Boolean);
    setEcho(parts.length ? parts.join(" ") : null);
  };
  const toggle = (k: PermissionKey) => {
    const r = togglePermission(perms, k, grantable);
    setPerms(r.next);
    explain(r.alsoAdded, r.alsoRemoved);
  };
  const toggleArea = (area: PermissionArea, state: "all" | "some" | "none") => {
    const r = setArea(perms, area, state !== "all", grantable);
    setPerms(r.next);
    explain(r.alsoAdded, r.alsoRemoved);
  };

  const doSave = async () => {
    setConfirm(null);
    setSaving(true);
    setError(null);
    const payload = { clientId, name: name.trim(), description: description.trim(), permissions: [...perms] };
    const r = await safeAction(() =>
      custom ? updateRoleAction({ ...payload, roleId: custom.id, version: custom.version }) : createRoleAction(payload),
    );
    setSaving(false);
    if (!r.ok) {
      setError({ text: r.error ?? "No se pudo guardar el rol.", stale: "stale" in r && r.stale === true });
      return;
    }
    saved.current = true;
    guard.leave();
  };
  const save = () => {
    if (!canSave) return;
    if (needsConfirm) setConfirm("save");
    else void doSave();
  };
  const doDelete = () => {
    if (!custom) return;
    setConfirm(null);
    start(async () => {
      setError(null);
      const r = await safeAction(() => deleteRoleAction({ clientId, roleId: custom.id }));
      if (!r.ok) return setError({ text: r.error ?? "No se pudo eliminar el rol." });
      saved.current = true;
      guard.leave();
    });
  };

  // Areas shown: read-only → those the role touches; editing → those with something to offer.
  const areas = PERMISSION_AREAS.filter((a) =>
    PERMISSIONS.some((p) => p.area === a.id && (readOnly ? perms.has(p.key) : grantable.has(p.key))),
  );
  const inUse = custom ? custom.memberCount + custom.pendingInviteCount : 0;

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
        title={isNew ? name.trim() || "Nuevo rol" : initial.name}
        headingId="role-editor-title"
        eyebrow={system ? "Rol protegido" : isNew ? "Nuevo rol" : "Rol personalizado"}
        chips={
          <>
            <MetaChip>{plural(perms.size, "permiso", "permisos")}</MetaChip>
            {!isNew ? <MetaChip>{plural(people, "usuario", "usuarios")}</MetaChip> : null}
          </>
        }
        backLabel="Volver a Roles y permisos"
        onBack={requestClose}
        changes={changes}
        onCancel={requestClose}
        onSave={save}
        saveLabel={isNew ? "Crear rol" : "Guardar rol"}
        saving={saving}
        canSave={canSave}
        readOnly={readOnly}
      />
      <EditorFrame
        sections={[
          { id: "role-name", label: "Nombre y descripción" },
          ...areas.map((a) => ({ id: `role-area-${a.id}`, label: a.label, dirty: PERMISSIONS.some((p) => p.area === a.id && perms.has(p.key) !== initial.permissions.has(p.key)) })),
          ...(custom ? [{ id: "role-people", label: "Usuarios afectados" }] : []),
          ...(custom && !readOnly ? [{ id: "role-delete", label: "Eliminar rol" }] : []),
        ]}
        saveBar={readOnly ? undefined : <SaveBar changes={changes} onCancel={requestClose} onSave={save} saving={saving} saveLabel={isNew ? "Crear" : "Guardar"} canSave={canSave} />}
      >
        {error ? (
          <div className="mb-2 flex flex-col gap-2">
            <Alert>{error.text}</Alert>
            {error.stale ? (
              <Button
                className="w-fit"
                onClick={() => {
                  saved.current = true;
                  guard.leave();
                  router.refresh();
                }}
              >
                Recargar el rol
              </Button>
            ) : null}
          </div>
        ) : null}
        {readOnly ? (
          <div className="mb-2">
            <Notice>
              {system
                ? "Rol protegido del sistema: sus permisos no se editan. Duplícalo desde la lista para crear una variante."
                : (custom?.lockedWhy ?? "No tienes permiso para editar roles.")}
            </Notice>
          </div>
        ) : null}
        <EditorSection id="role-name" title="Nombre y descripción" summary={name || "Sin nombre"}>
          {readOnly ? (
            <div className="flex flex-col gap-1 text-[0.8438rem]">
              <p className="font-semibold text-foreground">{initial.name}</p>
              {initial.description ? <p className="text-muted">{initial.description}</p> : null}
              {custom?.updatedByEmail ? <p className="text-xs text-muted">Última modificación: {custom.updatedLabel} · {custom.updatedByEmail}</p> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Field label="Nombre" hint="Por ejemplo: Coordinación, Marketing, Encargado de sede. El nombre no da permisos.">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={INPUT} autoComplete="off" />
              </Field>
              <Field label="Descripción (opcional)" hint="Para qué es este rol, en una frase.">
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={280} rows={2} className={TEXTAREA} />
              </Field>
              {custom?.updatedByEmail ? <p className="text-xs text-muted">Última modificación: {custom.updatedLabel} · {custom.updatedByEmail}</p> : null}
            </div>
          )}
        </EditorSection>
        {echo && !readOnly ? (
          <p aria-live="polite" className="mb-1 mt-3 rounded-sch-control bg-subtle px-3.5 py-2 text-[0.8125rem] text-muted">
            {echo}
          </p>
        ) : null}
        {areas.map((a) => {
          const keys = PERMISSIONS.filter((p) => p.area === a.id && (readOnly ? perms.has(p.key) : grantable.has(p.key)));
          const state = areaState(a.id, perms, grantable);
          const on = keys.filter((p) => perms.has(p.key)).length;
          return (
            <EditorSection key={a.id} id={`role-area-${a.id}`} title={a.label} description={a.help} summary={`${on} de ${keys.length}`}>
              {!readOnly ? (
                <AreaCheckbox state={state} onChange={() => toggleArea(a.id, state)}>
                  {state === "all" ? `Todo «${a.label}»` : state === "some" ? `«${a.label}»: ${on} de ${keys.length}` : `Todo «${a.label}»`}
                </AreaCheckbox>
              ) : null}
              <CheckList>
                {keys.map((p) => {
                  const reqs = (p.requires as readonly string[]).map(label);
                  const offModule = p.module !== null && !modules.includes(p.module);
                  return (
                    <label key={p.key} className={`flex min-h-[48px] items-start gap-3 px-3.5 py-2.5 text-sm ${readOnly ? "" : "cursor-pointer hover:bg-subtle/60"}`}>
                      <input
                        type="checkbox"
                        checked={perms.has(p.key)}
                        onChange={() => toggle(p.key)}
                        disabled={readOnly}
                        className="u-focus mt-0.5 size-4 shrink-0 accent-[var(--ink)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 text-foreground">
                          {p.label}
                          {"sensitive" in p && p.sensitive ? (
                            <span className="rounded-full bg-warn-soft px-1.5 py-px text-[0.6875rem] font-medium text-warn">Sensible</span>
                          ) : null}
                        </span>
                        <span className="block text-xs text-muted">{p.help}</span>
                        {reqs.length ? <span className="block text-xs text-muted">Necesita: {reqs.join(", ")}.</span> : null}
                        {offModule ? <span className="block text-xs text-warn">El módulo {MODULE_LABEL[p.module as string] ?? p.module} no está contratado: este permiso no tendrá efecto.</span> : null}
                      </span>
                    </label>
                  );
                })}
              </CheckList>
            </EditorSection>
          );
        })}
        {areas.length === 0 ? (
          <div className="py-6">
            <Notice>{readOnly ? "Este rol no tiene permisos: quien lo tenga no ve nada del negocio." : "No tienes permisos que puedas conceder."}</Notice>
          </div>
        ) : null}
        {custom ? (
          <EditorSection id="role-people" title="Usuarios afectados" description="Quienes tienen este rol reciben cualquier cambio en su siguiente acción." summary={plural(people, "usuario", "usuarios")}>
            {custom.holders.length === 0 && custom.pendingInviteCount === 0 ? (
              <p className="text-[0.8438rem] text-muted">Nadie tiene este rol todavía.</p>
            ) : (
              <div className="flex flex-col gap-2 text-[0.8438rem]">
                {custom.holders.length ? (
                  <ul className="flex flex-col gap-1">
                    {custom.holders.map((h) => (
                      <li key={h} className="truncate text-foreground">
                        {h}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {custom.pendingInviteCount ? <p className="text-muted">{plural(custom.pendingInviteCount, "invitación pendiente", "invitaciones pendientes")} con este rol.</p> : null}
              </div>
            )}
          </EditorSection>
        ) : null}
        {custom && !readOnly ? (
          <EditorSection id="role-delete" title="Eliminar rol" defaultOpen={false} description="Un rol asignado no se elimina: primero cambia el rol de esas personas e invitaciones.">
            {inUse > 0 ? (
              <Notice tone="warn">
                Este rol lo tienen {plural(custom.memberCount, "usuario", "usuarios")}
                {custom.pendingInviteCount ? ` y ${plural(custom.pendingInviteCount, "invitación pendiente", "invitaciones pendientes")}` : ""}. Cámbiales el rol en «Usuarios» para poder eliminarlo.
              </Notice>
            ) : (
              <Button variant="destructive" className="w-fit" disabled={busy} onClick={() => setConfirm("delete")}>
                Eliminar rol
              </Button>
            )}
          </EditorSection>
        ) : null}
      </EditorFrame>
      {confirm === "save" ? (
        <ConfirmLayer
          id="role-save-confirm"
          title={isNew ? `¿Crear el rol «${name.trim()}»?` : `¿Guardar los cambios de «${initial.name}»?`}
          tone="primary"
          confirmLabel={isNew ? "Crear rol" : "Guardar cambios"}
          pending={saving}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doSave()}
          body={
            <div className="flex flex-col gap-2 text-[0.8438rem]">
              {sensitiveAdded.length ? (
                <p>
                  <strong className="font-semibold">Concede capacidades sensibles:</strong> {sensitiveAdded.map(label).join(", ")}.
                </p>
              ) : null}
              {added.length > sensitiveAdded.length ? <p>Además concede: {added.filter((k) => !permissionDef(k).sensitive).map(label).join(", ")}.</p> : null}
              {removed.length ? (
                <p>
                  <strong className="font-semibold">Retira:</strong> {removed.map(label).join(", ")}.
                </p>
              ) : null}
              {!isNew && people > 0 ? <p>Afecta a {plural(people, "usuario", "usuarios")} desde su siguiente acción.</p> : null}
            </div>
          }
        />
      ) : null}
      {confirm === "delete" && custom ? (
        <ConfirmLayer
          id="role-delete-confirm"
          title={`¿Eliminar el rol «${custom.name}»?`}
          body="Nadie lo tiene asignado. El historial de accesos conserva el registro."
          confirmLabel="Eliminar rol"
          pending={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={doDelete}
        />
      ) : null}
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="Los cambios del rol no se han guardado. Si sales ahora, se pierden." /> : null}
    </div>
  );
}
