# Roles y permisos escalables — propuesta v1

Estado: **aprobado e implementado en local** (rama `feature/roles-permissions-v1`). Sin migrar en ningún entorno compartido.
Rama: `feature/roles-permissions-v1` (desde `origin/main` 31a2e7b). El trabajo de Agenda
(`feature/mobile-scheduling-access-v1`) está intacto, publicado y ya contenido en `main`.

## 1. Mapa actual

### Niveles de identidad

| Nivel | Dónde vive | Quién | Qué alcanza |
|---|---|---|---|
| Administrador de plataforma M_AI | `PLATFORM_ADMIN_USER_IDS` (variable de entorno, `web/lib/platformAdmin.ts`) | Operadores de M_AI | `/platform/reviews`: importar y validar procedencia de reseñas externas. No es un rol de tenant. |
| Agencia (tenant) | `tenant_members.role` = `owner` \| `admin` | Dueño de la cuenta y sus admins | Todos los negocios (`clients`) del tenant; superficies de agencia (módulos, clientes, conexiones, webhooks, tokens, workflows). `owner` es inmutable; solo él gestiona admins. |
| Negocio | `tenant_members.role = 'member'` + `member_client_id` + `client_role` | Personas que trabajan en un negocio | Exactamente **un** negocio. |
| Sede / profesional | `scheduling_site_id` + `scheduling_staff_id` (solo `client_role = 'staff'`) | Profesional con login | Ve la agenda de su sede; escribe solo en su columna; oculta identidad de clientes. |

- Una persona = una membresía efectiva (la más antigua; `UNIQUE (tenant_id, user_id)`). No hay varios roles por persona.
- Roles de negocio actuales (código ⇄ interfaz): `owner` = **Dueño**, `setter` = **Recepción**, `staff` = **Profesional**.
- Módulos contratados: `client_modules` (`crm`, `scheduling`, `inbox`, `meetings`, `catalog`, `campaigns`). Gate central `resolveClientModuleForScope` (UUID → acceso al negocio → negocio del tenant → no «Unassigned» → módulo activo).
- **No hay ámbito por sede** salvo para Profesional. Dueño y Recepción ven el negocio entero.
- **No hay caché de autorización entre solicitudes**: `getAccessScope` relee la membresía en cada request (`React.cache` solo dentro de la misma request). Un cambio ya se aplica en la siguiente solicitud.
- **No hay auditoría** de cambios de membresía, roles ni invitaciones.

### Cómo se decide hoy

Predicados con nombre de rol en `web/lib/access.ts` (`canAccessClient`, `canManageClient`,
`canSeeWorkflowInsights`, `canReadCatalog`, `canManageCatalog`, `canReadCampaigns`, …) y
`web/lib/crmPermissions.ts`. Fuera del núcleo hay ~80 comparaciones directas de nombre
(`clientRole === "setter"`, `role === "owner"`) en: `memberActions`, `inviteActions`,
`TeamMembers`, `ClientAccessScreen`, `AppSidebar`, `sectionNav`, `landing`, páginas de
Reuniones y `clientModuleAccess`.

`canManageClient` (Agencia o Dueño) es un «todo o nada» que hoy cubre a la vez: equipo,
horarios, servicios, promociones, página de reservas, reseñas, sedes, reglas, campos
personalizados, usuarios y origen manual de contactos.

### Discrepancias y hallazgos

Ninguna página, ruta o acción con sesión lee datos sin gate. Hallazgos concretos:

**La interfaz ofrece algo que el servidor rechaza** (se corrige ocultándolo; no se amplía nada)
- Columnas de ejecuciones: `workflows/.../executions/page.tsx:323` muestra `ColumnsMenu` al
  Dueño; `columnActions.ts` es solo agencia → selector vacío y error al guardar.
- Mapeo de roles de conversación: `conversations/settings/page.tsx:116` muestra el editor al
  Dueño; `conversationActions.ts` es solo agencia → error al guardar.
- Barra lateral de respaldo (`AppSidebar.tsx:1043-1050`) no muestra Inbox al Dueño aunque
  puede entrar. Solo UX.

**El servidor permite algo que la interfaz oculta**
- Catálogo de etiquetas: el servidor (`crmPermissions.canManageTagCatalog`) lo permite al
  Dueño; la UI lo oculta (`hasFullAccess`). La matriz conserva lo que hace el servidor.
- «Control total del CRM» del Dueño excluye eliminar/fusionar contactos (solo agencia). Se
  conserva tal cual; no se concede por conveniencia.

**Gates más amplios que el modelo documentado** (se conservan, se nombran bien y se señalan)
- Pipeline: calificar/perder/reabrir usa `canReadCampaigns` → Recepción escribe con un gate
  llamado «leer». Pasa a `pipeline.edit` con el mismo público.
- Profesional busca contactos del negocio por nombre al reservar
  (`searchSchedulingContactsAction`), con identidad oculta y **sin** comprobar el módulo CRM.
- Recepción puede crear/editar/borrar ausencias de cualquier profesional desde la Agenda
  (`timeOffActions.ts:68`) aunque «Horarios y ausencias» le está oculto. Intencional
  (bloquear tiempo desde la agenda) → `agenda.block`.

**Faltan comprobaciones de módulo o del negocio «Unassigned»** (se corrigen: solo restringen)
- `setContactOriginManualAction` no comprueba módulo.
- `api/scheduling/internal/events` no comprueba el módulo de agenda.
- `inboxActions` / `sendActions` no rechazan el negocio por defecto como hace el gate central.
- `requireWorkflowInsights` evalúa sin `clientId`; es seguro solo porque cada llamador ata el
  negocio después. Se le pasa el negocio.
- `api/inbox/.../contact` devuelve datos del contacto con solo el gate de Inbox (sin CRM).
  **Decisión pendiente** (ver §8): no se cambia sin aprobación.

**Rutas fuera del RBAC de usuarios**: API de máquina por token (`/api/crm/v1`,
`/api/scheduling/v1`, `/api/catalog/v1`, `/api/handoff/v1`, trabajadores de Reuniones),
reservas públicas y reseñas por token. No cambian.

## 2. Modelo propuesto

```
acceso efectivo = módulo contratado  ∧  permiso del rol  ∧  ámbito de la membresía
```

- **Catálogo central en código** (`web/lib/permissions/catalog.ts`): identificadores estables
  `area.accion`, etiqueta, explicación, módulo requerido, dependencias (`edit ⇒ view`),
  marca de sensible. Es la única lista de permisos; la base de datos solo guarda claves.
  Una clave desconocida en BD se ignora (deniega).
- **Roles = conjuntos de permisos**. Nunca se decide por el nombre del rol.
  - **Roles del sistema (protegidos)**: Dueño, Recepción, Profesional. Su conjunto de
    permisos está definido en código y traduce exactamente el comportamiento actual. No se
    editan ni se borran; se pueden duplicar como punto de partida.
  - **Roles personalizados**: pertenecen a **un negocio**, con nombre y descripción libres.
    Empiezan vacíos o como copia de una plantilla. Un permiso nuevo del catálogo **nunca**
    se añade solo a un rol personalizado.
- **Ámbito** (sobre qué) vive en la membresía, no en el rol:
  - `negocio`: todo el negocio (`member_client_id`).
  - `profesional`: su sede + su columna (`scheduling_site_id` + `scheduling_staff_id`).
  El tenant y el negocio salen siempre de la sesión → membresía; nunca del navegador.
- **Un rol por membresía** (como hoy). Sin uniones ni excepciones por usuario en v1.
- **Agencia** (tenant `owner`/`admin`): mantiene acceso completo a todos los negocios de su
  tenant, sin pasar por roles de negocio; no se edita desde este editor. Excepción que ya
  existe y se conserva: **confirmar supuestos del Dashboard de valor** es solo del negocio.
- **Plataforma**: sigue siendo la lista de entorno. Ninguna clave del catálogo la concede.
  Importar/validar reseñas externas **no** es un permiso del catálogo.

### Reglas de delegación (servidor)

1. Solo quien tiene `access.roles.manage` crea/edita/borra roles, y solo en su negocio.
2. **Subconjunto**: no se puede crear ni editar un rol con permisos que el propio actor no
   tiene, ni asignar un rol cuyos permisos excedan los del actor (la agencia los tiene todos).
3. Nadie edita **el rol que tiene asignado** ni cambia **su propio rol** (autoescalada /
   autobloqueo), salvo la agencia.
4. Asignar o quitar **Dueño** sigue siendo exclusivo de la agencia (como hoy).
5. Nunca se puede degradar ni quitar al **último Dueño** del negocio (como hoy).
6. Un rol con usuarios o invitaciones pendientes no se borra: primero se reasignan.
7. Cada acción revalida en servidor: sesión → membresía → negocio del tenant → módulo →
   permiso → ámbito → registro. Si el permiso se perdió con la pantalla abierta, la acción
   responde «Ya no tienes permiso para …» y no cambia nada.

## 3. Matriz de permisos (v1 — 37 claves)

A = Agencia (tenant owner/admin) · D = Dueño · R = Recepción · P = Profesional.
✓ = hoy lo tiene y se conserva · — = no lo tiene · (propio) = limitado por ámbito.
★ = sensible (pide confirmación al concederlo).

| Área | Clave | Qué permite | A | D | R | P |
|---|---|---|---|---|---|---|
| Inbox | `inbox.view` | Ver conversaciones y contador de pendientes | ✓ | ✓ | ✓ | — |
| | `inbox.reply` | Tomar, responder, devolver al bot, descartar, vincular contacto (requiere ver) | ✓ | ✓ | ✓ | — |
| | `inbox.supervise` ★ | Actuar sobre conversaciones asignadas a otra persona | ✓ | — | — | — |
| Contactos | `contacts.view` | Ver contactos, ficha e historial | ✓ | ✓ | ✓ | — |
| | `contacts.edit` | Crear y editar contactos, notas y tareas propias, poner/quitar etiquetas | ✓ | ✓ | ✓ | — |
| | `contacts.manage_others` | Editar notas/tareas de otros y asignar tareas a otros | ✓ | ✓ | — | — |
| | `contacts.tags` | Crear y renombrar etiquetas | ✓ | ✓ | — | — |
| | `contacts.export` ★ | Exportar contactos a CSV | ✓ | ✓ | ✓ | — |
| | `contacts.delete` ★ | Eliminar, fusionar y descartar duplicados | ✓ | — | — | — |
| | `contacts.fields` | Campos personalizados | ✓ | ✓ | — | — |
| | `pipeline.view` / `pipeline.edit` | Ver pipeline; calificar, perder, reabrir oportunidades | ✓ | ✓ | ✓ | — |
| Agenda | `agenda.view` | Ver la agenda | ✓ | ✓ | ✓ | (propio: su sede) |
| | `agenda.book` | Crear, reprogramar, confirmar, cancelar, completar, no-show | ✓ | ✓ | ✓ | (propio: su columna) |
| | `agenda.block` | Bloquear tiempo de un profesional | ✓ | ✓ | ✓ | — |
| Equipo, horarios y ausencias | `team.manage` | Profesionales: alta, edición, foto, certificaciones, servicios, baja | ✓ | ✓ | — | — |
| | `hours.manage` | Horarios de sede, cierres y excepciones | ✓ | ✓ | — | — |
| Servicios, productos, promociones | `services.manage` | Servicios y su presentación | ✓ | ✓ | — | — |
| | `products.view` | Ver productos | ✓ | ✓ | ✓ | — |
| | `products.stock` | Marcar disponible / agotado | ✓ | ✓ | ✓ | — |
| | `products.manage` | Crear, editar nombre/precio, archivar | ✓ | ✓ | — | — |
| | `promotions.manage` | Crear, editar, publicar y pausar promociones | ✓ | ✓ | — | — |
| Página de reservas, reseñas, campañas | `booking_page.manage` ★ | Editar y publicar la página pública de reservas | ✓ | ✓ | — | — |
| | `reviews.moderate` | Moderar reseñas; pedir revisión/retiro de una reseña externa | ✓ | ✓ | — | — |
| | `campaigns.view` | Ver anuncios, campañas y origen de contactos | ✓ | ✓ | ✓ | — |
| | `campaigns.manage` | Crear/editar/terminar campañas, anuncios y origen manual | ✓ | ✓ | — | — |
| Dashboard y analíticas | `analytics.view` | Dashboard de valor y analíticas técnicas | ✓ | ✓ | — | — |
| | `analytics.assumptions` | Proponer supuestos de valor | ✓ | ✓ | — | — |
| | `analytics.assumptions.confirm` ★ | Confirmar supuestos (solo el negocio) | — | ✓ | — | — |
| Configuración | `settings.sites` | Sedes | ✓ | ✓ | — | — |
| | `settings.rules` | Reglas de reserva | ✓ | ✓ | — | — |
| Usuarios y accesos | `access.users.view` | Ver quién tiene acceso | ✓ | ✓ | — | — |
| | `access.users.manage` ★ | Invitar, cambiar rol y quitar acceso (dentro de su autoridad) | ✓ | ✓ | — | — |
| | `access.roles.manage` ★ | Crear, editar y eliminar roles personalizados | ✓ | ✓ | — | — |
| Automatizaciones | `automations.view` | Workflows y ejecuciones del negocio | ✓ | ✓ | — | — |
| Reuniones | `meetings.view` | Ver, subir y analizar reuniones | ✓ | ✓ | — | — |
| | `meetings.manage` ★ | Eliminar reuniones y editar plantillas de informe | ✓ | — | — | — |

**Fuera del catálogo (no delegables por un negocio):** módulos contratados, clientes,
conexiones, webhooks, tokens de handoff, asignación de workflows, columnas/roles de
conversación, ajustes de atribución y de pipeline (hoy solo agencia), y todo lo de plataforma
(importar/validar reseñas externas).

## 4. Datos (migración `1816000000000_access-roles`)

- `access_roles`: `id`, `tenant_id`, `client_id`, `name`, `description`, `created_by`,
  `updated_by`, `version`, timestamps. `UNIQUE (client_id, lower(name))`. FK compuesta
  `(client_id, tenant_id) → clients`. Solo roles personalizados (los del sistema viven en código).
- `access_role_permissions`: `(role_id, permission_key)`.
- `tenant_members.access_role_id` e `invitations.access_role_id`: FK `ON DELETE RESTRICT`
  (no se borra un rol asignado). FK compuesta para que el rol sea del mismo negocio.
- `client_role` admite `'custom'` (rol personalizado, ámbito negocio) y el CHECK exige
  `access_role_id` ⇔ `client_role = 'custom'`. Las filas existentes **no cambian**: Dueño,
  Recepción y Profesional siguen exactamente igual.
- `access_audit_events`: `tenant_id`, `client_id`, `actor_user_id`, `action`, `target_type`,
  `target_id`, `changes jsonb` (permisos añadidos/quitados, rol anterior/nuevo, ámbito),
  `created_at`. Sin contenido de conversaciones ni secretos.
- Número: 1816 (el más alto en `main` y en todas las ramas locales/remotas es 1815). Se
  revisa de nuevo contra `main` justo antes del merge.

## 5. Transición sin dos sistemas

1. Este PR: todos los predicados de `access.ts` pasan a resolverse con `can(scope, clave)`
   sobre el catálogo; las comparaciones directas por nombre se eliminan de páginas, acciones,
   navegación y aterrizaje. `client_role` queda solo como etiqueta del rol del sistema y
   marca de ámbito; ningún gate lo lee.
2. Seguimiento: migrar los roles del sistema a filas de BD si hiciera falta editarlos y
   retirar `client_role`.

## 6. Interfaz

«Usuarios y accesos» (estética actual) con dos pestañas: **Usuarios** · **Roles y permisos**.
Editor de rol: nombre, descripción, permisos agrupados por área con explicación, casilla de
grupo con estado parcial, dependencias explícitas, resumen de usuarios afectados, guardado
explícito y confirmación con resumen al conceder ★ o retirar accesos. Roles del sistema en
solo lectura con «Duplicar». Solo se muestran casillas que el actor puede conceder.

## 7. Pruebas previstas

Integración contra PostgreSQL local con datos sintéticos (acciones reales, sesión simulada):
roles actuales y personalizados; renombrar no cambia permisos; llamadas directas sin
permiso; aislamiento tenant/negocio; Profesional limitado; módulo no contratado; autoescalada
y delegación; último Dueño; importación de reseñas inaccesible; revocación con sesión
abierta; borrado de rol asignado; auditoría y compatibilidad tras migrar.

## 8. Decisiones (aprobadas 2026-10-22: las siete recomendadas)

1. **Ámbito por sede.** Hoy solo el Profesional está atado a una sede; contactos, inbox y
   catálogo no tienen sede. **v1: ámbitos «todo el negocio» y «profesional vinculado»; un
   «Encargado de sede» vería todo el negocio.** Alternativa: limitar por sede solo Agenda,
   Equipo y Horarios (los contactos seguirían siendo de todo el negocio).
2. **Roles personalizados para logins de profesional.** **v1: no; un rol personalizado
   siempre tiene ámbito de negocio y «Profesional» sigue siendo el rol del sistema.**
3. **Delegar la administración.** **El Dueño puede crear roles con `access.users.manage` /
   `access.roles.manage`, acotados por la regla de subconjunto, sin poder asignar Dueño ni
   tocar Dueños, y con confirmación de capacidad sensible.** Alternativa: esas dos claves
   quedan reservadas a Agencia y Dueño (no asignables a roles personalizados).
4. **Permisos sensibles que Recepción ya tiene** (exportar contactos, escribir en pipeline,
   bloquear agenda de cualquier profesional). **Se conservan en el rol del sistema
   (compatibilidad) y quedan desmarcados por defecto en roles nuevos.** Alternativa: retirar
   la exportación a Recepción ahora.
5. **Correcciones de discrepancias en este PR** (todas restringen o alinean la UI con el
   servidor; ninguna amplía acceso): ocultar columnas y mapeo de conversación al Dueño,
   mostrar el catálogo de etiquetas al Dueño, añadir los checks de módulo y de negocio por
   defecto listados en §1, exigir el módulo CRM a la búsqueda de contactos del Profesional.
   **Recomendado: sí.**
6. **Panel de contacto del Inbox con CRM desactivado.** **Sin cambios en este PR** (cambiarlo
   rompería Inbox en negocios sin CRM); se documenta.
7. ~~Roles del sistema inmutables~~ → sustituido por §8 bis: la agencia los ajusta por negocio.

## 8 bis. Ajuste posterior (2026-10-22)

- **Roles protegidos editables por la agencia, por negocio.** La agencia (dueño/admins del
  tenant) ajusta los permisos de Dueño, Recepción o Profesional **solo para ese negocio**:
  el nombre no cambia, los demás negocios mantienen el predeterminado y «Restablecer»
  lo devuelve. Se guarda como fila de `access_roles` con `system_key` (una por negocio y rol)
  y se aplica en la siguiente petición de cada persona. Auditado.
- **El Dueño** sigue creando, editando y eliminando sus roles personalizados (eliminar
  solo cuando nadie lo tiene) y gestionando usuarios, siempre dentro de sus permisos; no
  ajusta los protegidos.
- **Módulos**: solo la agencia (sin cambios).
- Un permiso nuevo del catálogo no se añade solo a un rol protegido ya ajustado: el ajuste
  queda fijo hasta que la agencia lo cambie o lo restablezca.

## 9. Implementación

| Pieza | Dónde |
|---|---|
| Catálogo, roles del sistema, agencia | `web/lib/permissions/catalog.ts` |
| Reglas de delegación (puras, compartidas UI/servidor) | `web/lib/permissions/delegation.ts` |
| Lógica del editor (dependencias, grupo parcial) | `web/lib/permissions/editorModel.ts` |
| Resolución del scope con permisos | `web/lib/access.ts` (`buildScope`, `can`, `canAny`, `inClientScope`) |
| Gate central de módulos: exige permiso en cada llamada | `web/lib/clientModuleAccess.ts` |
| Acciones de roles | `web/lib/roleActions.ts` |
| Miembros e invitaciones con delegación + auditoría | `web/lib/memberActions.ts`, `web/lib/inviteActions.ts` |
| Repositorio de roles y auditoría | `src/db/repositories/accessRoles.ts` |
| Migración | `migrations/1816000000000_access-roles.ts` |
| Interfaz | `web/components/team/RolesPanel.tsx`, `ClientAccessScreen.tsx`, `app/clients/[clientId]/team/page.tsx` |
| Página sin accesos | `web/app/no-access/page.tsx` |

Se eliminaron `canAccessClient`, `canManageClient`, `canSeeWorkflowInsights`,
`canAccessMeetings`, `canRead/ManageCatalog`, `canRead/ManageCampaigns` y
`canOperateScheduling`: cada página, acción y API nombra ahora su permiso. Ningún gate de
capacidad compara nombres de rol; quedan solo los niveles protegidos (agencia, Dueño,
vínculo de profesional).

Correcciones incluidas (todas restringen o alinean UI con servidor):
- Columnas de ejecuciones y mapeo de conversación: ocultos para quien no es agencia.
- Catálogo de etiquetas visible para el Dueño (el servidor ya lo permitía).
- Checks de módulo/negocio por defecto en origen manual, `api/scheduling/internal/events`,
  Inbox y envío; `requireWorkflowInsights` atado al negocio de la URL.
- Búsqueda de contactos del Profesional exige el módulo CRM.
- La ruta antigua `/scheduling/admin` solo redirige a una página que el rol puede abrir
  (detectado por la matriz navegación ⇔ servidor con un rol personalizado).
- Contactos: «Nuevo contacto», «Agregar número/email», «Editar» y «Exportar CSV» solo se
  ofrecen con su permiso.

## 10. Verificación

- Unitarias (entorno del CI): 1375/1375.
- Integración (PostgreSQL local, datos sintéticos): 688/703; los 15 fallos son idénticos a
  `main` (scripts de Reuniones/staging, ad cover, conexiones, ingestión).
- Nuevas: `test/unit/accessPermissions.test.ts` (11) y
  `test/integration/accessRoles.test.ts` (10); `navigationGates` ahora incluye un rol
  personalizado en la matriz «visible ⇔ el servidor abre».
- Manual en local (`:3720`, base aislada): creación de rol con dependencias y confirmación
  sensible, asignación con resumen de pérdidas, aterrizaje y navegación del rol
  personalizado, 404 en páginas/APIs no concedidas, revocación aplicada en la siguiente
  petición, Recepción sin cambios, historial de auditoría.

## 11. Limitaciones conocidas

- Sin ámbito por sede (decisión 1); «Encargado de sede» ve todo el negocio.
- Los roles personalizados no se asignan a logins de profesional (decisión 2).
- Inbox: el panel lateral aún usa la bandera de agencia para mostrar «devolver al bot» de
  otros y editar notas ajenas; el servidor ya decide por `inbox.supervise` /
  `contacts.manage_others`, así que un rol personalizado con esos permisos los ejerce por
  servidor pero no ve el botón en ese panel.
- `meetings.manage` sigue reservado a la agencia (el borrado se aplica en el worker por
  nivel), por eso no se ofrece a roles de negocio.
- La auditoría no registra cambios hechos directamente en la base de datos.
- `client_role` se mantiene como etiqueta del rol del sistema y marca de ámbito; retirarlo
  es un seguimiento (§5).
- La migración no se ha ejecutado en staging ni producción.
