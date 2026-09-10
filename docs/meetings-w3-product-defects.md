# Defectos de producto encontrados durante W-3

Cosas que W-3 destapó y que **no son de W-3**. Se registran aquí y **no se
arreglan en esta fase**: tocar el resolutor de ámbito de la sesión afecta a
todos los módulos, y W-3 existe para validar Reuniones, no para reformar el
control de acceso.

---

## D-1 · `getAccessScope` no soporta múltiples membresías

**Encontrado:** 2026-09-09, paso 10.1 de W-3. Síntoma: `POST
/api/meetings/v1/meetings` devolvía `404 not_found` con un `clientId` que
existía, en un tenant real, con el módulo habilitado y con el usuario como
`owner` de ese tenant.

### Qué pasa

`src/db/repositories/tenantMembers.ts:41`:

```sql
SELECT tenant_id, role, member_client_id FROM tenant_members
 WHERE user_id = $1
 ORDER BY created_at ASC
 LIMIT 1
```

Y `getTenantIdForUser` (línea 17) hace lo mismo. `getAccessScope` construye el
ámbito con **esa única fila**, así que:

> **Si un usuario pertenece a dos tenants, el más antiguo gana para siempre y el
> resto es inalcanzable** — por la UI y por toda la API de sesión.

No hay mecanismo de selección ni de cambio de tenant. No es que falte
activarlo: no existe.

### Por qué el síntoma es engañoso

El fallo aparece en la condición 3 de `resolveAppScope`
(`web/lib/meetingsAppScope.ts:66`):

```ts
const client = await getClientById({ tenantId: scope.tenantId, clientId });
if (!client || client.is_default) throw notFound();
```

El cliente **existe**, pero se busca dentro del tenant equivocado, así que
`getClientById` no lo encuentra y sale el mismo `404` que un uuid inventado.
Las cuatro condiciones de `resolveAppScope` devuelven `not_found`
indistinguible **a propósito** —para no revelar qué existe en otro tenant— y
esa decisión, que es correcta, convierte este defecto en un 404 sin
diagnóstico.

El caso concreto:

| membresía | tenant | creada | efecto |
|---|---|---|---|
| 1 | `vanegas.mora23's workspace` | 21:03:55 | **la que la sesión usa** |
| 2 | `W3` | 21:12:07 | inalcanzable |

El registro por Better Auth creó la primera; el seed de W-3 añadió la segunda
nueve minutos después. Todo el contenido de la segunda era correcto y
completamente inútil.

### Alcance

No es sólo de Reuniones. Cualquier superficie que pase por `getAccessScope`
—CRM, Inbox, Scheduling, Staff— tiene el mismo techo. Hoy no se nota porque en
la práctica cada usuario tiene una membresía; se nota en cuanto alguien es
invitado a un segundo tenant, y entonces **pierde el acceso al segundo sin que
nada lo diga**.

### Qué haría falta (fuera de W-3)

1. Un tenant **activo** por sesión, elegible: cookie o columna en `session`, con
   un selector en la UI.
2. `getAccessScope` leyendo ese tenant activo y validando que el usuario tiene
   membresía en él, en vez de `LIMIT 1`.
3. Un fallo **explícito** cuando el `clientId` pedido pertenece a un tenant en
   el que el usuario sí tiene membresía pero que no es el activo. Tiene que ser
   distinguible de «no existe» sin filtrar nada: la información ya la tiene el
   propio usuario.
4. Migración: nada que cambiar en el esquema — `tenant_members` ya admite
   varias filas por usuario. El defecto está en la lectura.

### Mitigación aplicada dentro de W-3

Ninguna al producto. Sólo al script de siembra: `meetingsStagingSeed` acepta
`--tenant-id`, exige que el usuario tenga una membresía **válida** en él, y
**aborta** si ese tenant no es el que la sesión resuelve de verdad. Es decir:
el script sabe del defecto y se niega a producir datos inalcanzables, pero el
defecto sigue ahí.

---

## D-2 · `meetings:preflight` puede quedarse mudo

**Encontrado:** 2026-09-09, paso 4 de W-3.

`src/scripts/meetingsPreflight.ts` informa con `logger.info`, y el logger usa
`config.LOG_LEVEL`. Con `LOG_LEVEL=warn` —que es lo que tenía el `.env` del
worktree— el preflight **salió con código 0 y sin imprimir una sola línea**.

El código de salida sí es fiable (un fallo pone `exitCode = 1`), pero «silencio
y 0» y «silencio porque no llegó a correr» se parecen demasiado para un
go/no-go que decide si se aplican migraciones.

**Arreglo (una línea, fuera de W-3):** que el preflight escriba su veredicto en
stdout directamente, o que fuerce su propio nivel, en vez de heredar
`LOG_LEVEL`.

---

## D-3 · `tsconfig.tsbuildinfo` está versionado

**Encontrado:** 2026-09-09, escaneo de secretos del repositorio del worker.

Es un artefacto de compilación de TypeScript. Aparece en diez blobs del
historial y sus `"fileInfos":[{"version":"<hex de 64>"}]` disparan cualquier
detector de secretos por entropía — ruido permanente en toda auditoría futura.

**Arreglo:** `.gitignore` y `git rm --cached`. No urgente, no es una fuga.
