/**
 * PERMISSION CATALOG — the one list of what a login may DO inside a business (client).
 *
 * PURE on purpose (no React, no next/*, no DB): the scope resolver, every server gate, the
 * navigation, the role editor and the tests all read this same list, so a permission key is
 * never string-duplicated across layers.
 *
 * The model (docs/proposals/roles-permisos-v1.md):
 *
 *     effective access = module enabled  ∧  role permission  ∧  membership scope
 *
 *  - A ROLE is a set of keys from this catalog. Nothing ever branches on a role's NAME:
 *    renaming «Recepción» to «Front desk» changes nothing it can do.
 *  - The SCOPE (which business, and for a professional login: which site + which agenda
 *    column) lives on the membership, never on the role, and always comes from the session.
 *  - DENY BY DEFAULT. A key stored in the DB that is not in this catalog is ignored. A key
 *    added here later is NEVER granted to an existing custom role; only a deliberate edit of
 *    SYSTEM_ROLE_PERMISSIONS below (reviewed code) gives it to a system role.
 *
 * What is NOT here, on purpose: the agency tier (modules, clients, connections, webhooks,
 * handoff tokens, workflow plumbing — tenant owner/admin only) and the platform tier
 * (importing and validating external reviews — PLATFORM_ADMIN_USER_IDS only). A business can
 * never be handed those as a checkbox.
 */

import type { ClientModuleKey } from "@worker/modules/registry.js";

export type PermissionArea =
  | "inbox"
  | "contacts"
  | "agenda"
  | "team"
  | "catalog"
  | "presence"
  | "results"
  | "settings"
  | "access"
  | "automations"
  | "meetings";

export interface PermissionDef {
  key: string;
  area: PermissionArea;
  /** Short label for the role editor. */
  label: string;
  /** One sentence: what someone with it can do. */
  help: string;
  /** The contracted module this permission works inside (null = not module-bound). Without
   *  the module the permission is inert, whatever the role says. */
  module: ClientModuleKey | null;
  /** Permissions this one needs to make sense (editing needs seeing). Enforced when a role
   *  is saved, so a stored role is always dependency-closed. */
  requires: readonly string[];
  /** Granting it (or taking it away from a role with people on it) asks for confirmation. */
  sensitive?: boolean;
  /** false = never assignable to a business role, even by the agency, because the server
   *  side that enforces it is still tier-based (agency only). Hidden from the editor. */
  businessGrantable?: false;
}

export const PERMISSION_AREAS: ReadonlyArray<{ id: PermissionArea; label: string; help: string }> = [
  { id: "inbox", label: "Inbox", help: "Conversaciones que el bot pasa a una persona." },
  { id: "contacts", label: "Contactos", help: "Fichas de clientes, notas, tareas, etiquetas y pipeline." },
  { id: "agenda", label: "Agenda", help: "Citas del negocio." },
  { id: "team", label: "Equipo, horarios y ausencias", help: "Profesionales y cuándo atiende cada sede." },
  { id: "catalog", label: "Servicios, productos y promociones", help: "Lo que vende el negocio." },
  { id: "presence", label: "Página de reservas, reseñas y campañas", help: "Lo que ve el público y de dónde llegan los clientes." },
  { id: "results", label: "Dashboard de valor y analíticas", help: "Resultados del negocio." },
  { id: "settings", label: "Configuración", help: "Sedes y reglas de reserva." },
  { id: "access", label: "Usuarios y accesos", help: "Quién entra a M_AI y con qué rol." },
  { id: "automations", label: "Automatizaciones", help: "Workflows y ejecuciones del negocio." },
  { id: "meetings", label: "Reuniones", help: "Grabaciones y análisis de reuniones." },
];

export const PERMISSIONS = [
  // ── Inbox ──────────────────────────────────────────────────────────────────────
  { key: "inbox.view", area: "inbox", module: "inbox", requires: [], label: "Ver conversaciones", help: "Ver la bandeja y el contador de pendientes." },
  { key: "inbox.reply", area: "inbox", module: "inbox", requires: ["inbox.view"], label: "Atender conversaciones", help: "Tomar una conversación, responder, devolverla al bot, descartarla y vincular el contacto." },
  { key: "inbox.supervise", area: "inbox", module: "inbox", requires: ["inbox.reply"], sensitive: true, label: "Supervisar conversaciones de otros", help: "Devolver al bot una conversación que atiende otra persona." },
  // ── Contactos ──────────────────────────────────────────────────────────────────
  { key: "contacts.view", area: "contacts", module: "crm", requires: [], label: "Ver contactos", help: "Ver la lista, la ficha y el historial de cada contacto." },
  { key: "contacts.edit", area: "contacts", module: "crm", requires: ["contacts.view"], label: "Crear y editar contactos", help: "Crear y editar contactos, escribir notas, crear tareas propias y poner o quitar etiquetas." },
  { key: "contacts.manage_others", area: "contacts", module: "crm", requires: ["contacts.edit"], label: "Gestionar el trabajo de otros", help: "Editar notas y tareas de otras personas y asignar tareas a cualquiera." },
  { key: "contacts.tags", area: "contacts", module: "crm", requires: ["contacts.edit"], label: "Administrar etiquetas", help: "Crear y renombrar las etiquetas del negocio." },
  { key: "contacts.export", area: "contacts", module: "crm", requires: ["contacts.view"], sensitive: true, label: "Exportar contactos", help: "Descargar la lista de contactos en CSV, con sus datos de contacto." },
  { key: "contacts.delete", area: "contacts", module: "crm", requires: ["contacts.edit"], sensitive: true, label: "Eliminar y fusionar contactos", help: "Eliminar contactos, fusionar duplicados y descartar sugerencias de duplicado." },
  { key: "contacts.fields", area: "contacts", module: "crm", requires: ["contacts.view"], label: "Campos personalizados", help: "Crear y editar los campos propios de la ficha de contacto." },
  { key: "pipeline.view", area: "contacts", module: "crm", requires: ["contacts.view"], label: "Ver pipeline", help: "Ver las oportunidades y la cola de sin respuesta." },
  { key: "pipeline.edit", area: "contacts", module: "crm", requires: ["pipeline.view"], label: "Mover oportunidades", help: "Calificar, marcar como perdida y reabrir oportunidades." },
  // ── Agenda ─────────────────────────────────────────────────────────────────────
  { key: "agenda.view", area: "agenda", module: "scheduling", requires: [], label: "Ver agenda", help: "Ver las citas. Una cuenta de profesional solo ve su sede." },
  { key: "agenda.book", area: "agenda", module: "scheduling", requires: ["agenda.view"], label: "Gestionar citas", help: "Reservar, reprogramar, confirmar, cancelar, completar y marcar inasistencias. Una cuenta de profesional solo en su propia columna." },
  { key: "agenda.block", area: "agenda", module: "scheduling", requires: ["agenda.view"], label: "Bloquear tiempo de profesionales", help: "Crear, editar y quitar ausencias de cualquier profesional desde la agenda." },
  // ── Equipo, horarios y ausencias ───────────────────────────────────────────────
  { key: "team.manage", area: "team", module: "scheduling", requires: [], label: "Gestionar profesionales", help: "Dar de alta y editar profesionales: foto, certificaciones, servicios que ofrecen y baja." },
  { key: "hours.manage", area: "team", module: "scheduling", requires: [], label: "Horarios y cierres de sede", help: "Cambiar el horario de cada sede y programar cierres y excepciones." },
  // ── Servicios, productos y promociones ─────────────────────────────────────────
  { key: "services.manage", area: "catalog", module: "scheduling", requires: [], label: "Gestionar servicios", help: "Crear y editar servicios, precios, duración, fotos y en qué sedes se ofrecen." },
  { key: "products.view", area: "catalog", module: "catalog", requires: [], label: "Ver productos", help: "Ver el catálogo de productos." },
  { key: "products.stock", area: "catalog", module: "catalog", requires: ["products.view"], label: "Marcar disponibilidad", help: "Marcar un producto como disponible o agotado." },
  { key: "products.manage", area: "catalog", module: "catalog", requires: ["products.view"], label: "Gestionar productos", help: "Crear productos, cambiar nombre y precio, archivar y restaurar." },
  { key: "promotions.manage", area: "catalog", module: "scheduling", requires: [], label: "Gestionar promociones", help: "Crear, editar, publicar, pausar y duplicar promociones." },
  // ── Página de reservas, reseñas y campañas ─────────────────────────────────────
  { key: "booking_page.manage", area: "presence", module: "scheduling", requires: [], sensitive: true, label: "Página de reservas", help: "Editar y publicar la página pública donde los clientes reservan." },
  { key: "reviews.moderate", area: "presence", module: "scheduling", requires: [], label: "Moderar reseñas", help: "Publicar u ocultar reseñas y pedir la revisión o el retiro de una reseña externa." },
  { key: "campaigns.view", area: "presence", module: "campaigns", requires: [], label: "Ver campañas", help: "Ver anuncios detectados, campañas, lo que promete cada anuncio y el origen de los contactos." },
  { key: "campaigns.manage", area: "presence", module: "campaigns", requires: ["campaigns.view"], label: "Gestionar campañas", help: "Crear, editar y terminar campañas, asignar anuncios y corregir el origen de un contacto." },
  // ── Dashboard de valor y analíticas ────────────────────────────────────────────
  { key: "analytics.view", area: "results", module: null, requires: [], label: "Ver resultados", help: "Ver el Dashboard de valor y las analíticas técnicas." },
  { key: "analytics.assumptions", area: "results", module: null, requires: ["analytics.view"], label: "Proponer supuestos de valor", help: "Proponer el ticket medio y demás supuestos con los que se calcula el valor." },
  { key: "analytics.assumptions.confirm", area: "results", module: null, requires: ["analytics.view"], sensitive: true, label: "Confirmar supuestos de valor", help: "Confirmar en nombre del negocio los supuestos con los que se calcula el valor." },
  // ── Configuración ──────────────────────────────────────────────────────────────
  { key: "settings.sites", area: "settings", module: "scheduling", requires: [], label: "Sedes", help: "Crear, editar, activar y desactivar sedes." },
  { key: "settings.rules", area: "settings", module: "scheduling", requires: [], label: "Reglas de reserva", help: "Antelación mínima, ventana de reserva y demás reglas de la agenda." },
  // ── Usuarios y accesos ─────────────────────────────────────────────────────────
  { key: "access.users.view", area: "access", module: null, requires: [], label: "Ver usuarios", help: "Ver quién tiene acceso a este negocio y con qué rol." },
  { key: "access.users.manage", area: "access", module: null, requires: ["access.users.view"], sensitive: true, label: "Gestionar usuarios", help: "Invitar, cambiar el rol y quitar el acceso, solo con roles que no superen los suyos." },
  { key: "access.roles.manage", area: "access", module: null, requires: ["access.users.view"], sensitive: true, label: "Gestionar roles", help: "Crear, editar y eliminar roles personalizados, solo con permisos que la persona ya tiene." },
  // ── Automatizaciones ───────────────────────────────────────────────────────────
  { key: "automations.view", area: "automations", module: null, requires: [], label: "Ver workflows", help: "Ver los workflows del negocio y sus ejecuciones." },
  // ── Reuniones ──────────────────────────────────────────────────────────────────
  { key: "meetings.view", area: "meetings", module: "meetings", requires: [], label: "Usar Reuniones", help: "Ver, subir y analizar reuniones y descargar sus informes." },
  { key: "meetings.manage", area: "meetings", module: "meetings", requires: ["meetings.view"], sensitive: true, businessGrantable: false, label: "Administrar Reuniones", help: "Eliminar reuniones y editar plantillas de informe. Solo la agencia." },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(PERMISSIONS.map((p) => [p.key, p as PermissionDef]));

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && BY_KEY.has(value);
}

export function permissionDef(key: PermissionKey): PermissionDef {
  return BY_KEY.get(key) as PermissionDef;
}

/** Keys a BUSINESS role may ever hold (everything but the agency-enforced ones). */
export const BUSINESS_GRANTABLE_KEYS: readonly PermissionKey[] = PERMISSIONS.filter(
  (p) => (p as PermissionDef).businessGrantable !== false,
).map((p) => p.key);

/** Keep only catalog keys a business role may hold — unknown / retired / agency-only keys
 *  stored in the DB are dropped (deny by default). */
export function sanitizeBusinessPermissions(raw: Iterable<unknown>): Set<PermissionKey> {
  const grantable = new Set<string>(BUSINESS_GRANTABLE_KEYS);
  const out = new Set<PermissionKey>();
  for (const k of raw) if (isPermissionKey(k) && grantable.has(k)) out.add(k);
  return out;
}

/** Every permission `key` transitively requires (not including itself). */
export function requiredBy(key: PermissionKey): PermissionKey[] {
  const out = new Set<PermissionKey>();
  const walk = (k: PermissionKey) => {
    for (const r of permissionDef(k).requires as readonly PermissionKey[]) {
      if (!out.has(r)) {
        out.add(r);
        walk(r);
      }
    }
  };
  walk(key);
  return [...out];
}

/** Every permission that (transitively) depends on `key` — removing `key` removes these. */
export function dependentsOf(key: PermissionKey): PermissionKey[] {
  return ALL_PERMISSION_KEYS.filter((k) => k !== key && requiredBy(k).includes(key));
}

/** The keys in `set` whose requirements are not all in `set` (empty = dependency-closed). */
export function missingRequirements(set: ReadonlySet<PermissionKey>): Array<{ key: PermissionKey; missing: PermissionKey[] }> {
  const out: Array<{ key: PermissionKey; missing: PermissionKey[] }> = [];
  for (const k of set) {
    const missing = requiredBy(k).filter((r) => !set.has(r));
    if (missing.length) out.push({ key: k, missing });
  }
  return out;
}

// ── System roles ─────────────────────────────────────────────────────────────────

/** The protected roles every business has. Stored on the membership as `client_role`.
 *  Their DEFAULT permissions are below; the agency may adjust them for ONE business (an
 *  override row in access_roles with system_key) — the other businesses keep the default. */
export type SystemRoleKey = "owner" | "setter" | "staff";

export const SYSTEM_ROLE_LABEL: Record<SystemRoleKey, string> = { owner: "Dueño", setter: "Recepción", staff: "Profesional" };

export const SYSTEM_ROLE_HELP: Record<SystemRoleKey, string> = {
  owner: "Control total de este negocio: personas, roles, configuración y resultados.",
  setter: "Conversaciones, contactos, pipeline y agenda. No ve resultados, reuniones ni configuración.",
  staff: "Solo su propia agenda, vinculada a su perfil de profesional.",
};

const OWNER_EXCLUDES: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  // Agency-only today; never granted to a Dueño "by convenience".
  "inbox.supervise",
  "contacts.delete",
  "meetings.manage",
]);

/**
 * The exact translation of the pre-catalog behaviour (web/lib/access.ts before v1):
 *  - Dueño     = canManageClient + canSeeWorkflowInsights + full CRM control of their client
 *                (incl. its own custom roles; adjusting a SYSTEM role is the agency's);
 *  - Recepción = canAccessClient: inbox, contacts (incl. export, pipeline writes), agenda
 *                incl. blocking staff time, products read + stock, campaigns read;
 *  - Profesional = canOperateScheduling only (own site; own column on writes).
 * Changing these sets changes what existing logins can do — treat as a security change.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, ReadonlySet<PermissionKey>> = {
  owner: new Set(BUSINESS_GRANTABLE_KEYS.filter((k) => !OWNER_EXCLUDES.has(k))),
  setter: new Set<PermissionKey>([
    "inbox.view",
    "inbox.reply",
    "contacts.view",
    "contacts.edit",
    "contacts.export",
    "pipeline.view",
    "pipeline.edit",
    "agenda.view",
    "agenda.book",
    "agenda.block",
    "products.view",
    "products.stock",
    "campaigns.view",
  ]),
  staff: new Set<PermissionKey>(["agenda.view", "agenda.book"]),
};

/**
 * The AGENCY (tenant owner/admin) on any business of its tenant: everything, except what
 * only the business itself may do — confirming the value-dashboard assumptions
 * (web/lib/valueAssumptionActions.ts: «the agency can never confirm on the business's
 * behalf»).
 */
export const AGENCY_PERMISSIONS: ReadonlySet<PermissionKey> = new Set(
  ALL_PERMISSION_KEYS.filter((k) => k !== "analytics.assumptions.confirm"),
);

export function isSystemRoleKey(value: unknown): value is SystemRoleKey {
  return value === "owner" || value === "setter" || value === "staff";
}

/** Does `held` cover every key of `wanted`? The delegation rule: nobody hands out, edits or
 *  assigns a set of permissions wider than their own. */
export function isSubset(wanted: Iterable<PermissionKey>, held: ReadonlySet<PermissionKey>): boolean {
  for (const k of wanted) if (!held.has(k)) return false;
  return true;
}
