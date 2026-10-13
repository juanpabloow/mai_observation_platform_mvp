# Gallery — incidentes de producción: correcciones de código (oct. 2026)

Estado: **integrado para revisión** en `fix/gallery-incidents-integration`, sobre `main`
`75df605` (PR #16 + staff/Time Off + PR #17). Las correcciones restantes se trasladaron desde
`fix/gallery-incidents-v1` sin duplicar BSUID. No se han desplegado esas correcciones ni
escrito datos de producción. Los apartados históricos describen la auditoría inicial de
`f7c4cf7`; para la secuencia actual usar la actualización al inicio del plan de despliegue.

Documentos hermanos, **separados a propósito**:
- `docs/ops/gallery-incidents-deploy-plan.md`: despliegue por etapas, criterios de parada y rollback.
- `docs/proposals/gallery-fresha-reconciliation-2026-10.md`: reconciliación comercial con Fresha.
  Ninguna de sus decisiones bloquea ni forma parte de este despliegue.

## 0. Base

- `origin/main` = `f7c4cf7`. **Commit desplegado: `f7c4cf7b4efb7fa49065ab8c86fb29ad88569f2d`**. Lo
  confirmó el usuario en el despliegue activo de Railway (13 oct). Concuerda con el `307 → /login` de
  `/api/catalog/v1/products`: el módulo está desplegado y el middleware lo rebota.
- `fix/platform-audit-phase1` (`317fbbb`, sobre `0adf949`) **no está en `main`**: contiene la
  validación de contactos, las rutas de ficha dentro del cliente y el filtro `?staff=` de la
  agenda. Aquí **no se duplican**; requieren decisión de integración (§4).

## 1. WhatsApp / handoff (ejecución 5059)

- **Causa.** El backend **no clasifica**: guarda tal cual el `code` que devuelve n8n
  (`web/lib/sendToWebhook.ts`). Un `CHANNEL_POLICY` almacenado prueba que el workflow respondió
  `200 {status:"rejected", code:"CHANNEL_POLICY"}` ante un `500 / 131000` de Meta. La
  clasificación errónea está en el workflow, probablemente en una rama de error que lo absorbe
  todo. Además, el ejemplo del contrato empujaba a usar `CHANNEL_POLICY`.
- **Propuesta para el workflow** (sin aplicar): `tools/n8n/handoffSendErrorMapping.mjs`.
  - `CHANNEL_POLICY` solo para reglas reales del canal: 131047, 470 y límites de tasa.
  - `INVALID_RECIPIENT` solo para 131026 y 131021.
  - Cualquier otro error es `CHANNEL_ERROR`, incluidos el genérico 131000 y los 5xx.
  - Los números del proveedor pasan en `provider`. Verificar los códigos con la documentación de Meta.
- **Plataforma** (en esta rama):
  - El Inbox muestra el `failure_code`.
  - Se aceptan `provider.{http_status, code, subcode, trace_id}` saneados; nunca el texto libre del proveedor.
  - "Reintentar" reclama el mensaje de forma **atómica** (solo si sigue en `failed`), así que no puede reenviar un mensaje entregado ni duplicar con dos clics.
- **Analytics.** Hoy mide solo el estado de la ejecución de n8n. Un envío rechazado y capturado
  probablemente cuenta como éxito. El denominador es `success + error`, y los demás estados
  quedan fuera. La métrica existente **no cambia**; se añade una tarjeta aparte de envíos de
  agente (`handoff_messages`: aceptados, fallidos por `failure_code`, pendientes; fila 11).
  "Entregado" de verdad requiere ingerir los webhooks de estado de WhatsApp, que hoy no existen.
- **Plantillas** (no conectadas): son una funcionalidad aparte y no justifican saltarse la ventana.
- El saldo de mensajería agotado en **Fresha** es una incidencia de Fresha, ajena a este fallo.

## 2. Correcciones en esta rama

| # | Hallazgo (verificado en código) | Cambio | Pruebas |
|---|---|---|---|
| 1 | `/api/catalog` fuera de `PUBLIC_PREFIXES`: el bot recibe 307→/login | Prefijo añadido | `machineApiMiddleware` (falla en `main`) |
| 2 | `takes_bookings` solo se respetaba en la vista pública; "cualquier profesional" y el bot podían asignar a quien no reserva | Motor y lista de staff del bot | `galleryIncidents` (falla en `main`) |
| 3 | Bot listaba servicios que nadie reservable realiza | `listBookableServicesForSite` (misma regla que la reserva pública) | `galleryIncidents` |
| 4 | Reagendar comprobaba con la duración actual del servicio, no la de la cita | `timingOverride` con la instantánea | `galleryIncidents` (falla en `main`) |
| 5 | Reintentar podía reenviar un mensaje enviado o duplicar | Reclamo atómico `failed→sending` | `galleryIncidents` |
| 6 | Diagnóstico de envío perdido / código no visible | `provider` saneado + código en el Inbox | `handoffSendDiagnostics` |
| 7 | Borrar certificación de otro cliente del mismo tenant | Borrado acotado a `staff_id` | `staffFields` |
| 8 | Excepción con profesional de otra sede | Validación de sede | contrato |
| 9 | Filtro de flujo del Inbox persistente e invisible | Línea "Mostrando solo el flujo X · Quitar filtro" | contrato |
| 10 | Un BSUID ("CO.1234567890") se convertía en teléfono "+1234567890" (normalizeE164 quitaba letras) | Solo la **forma BSUID** (`isBsuid`: dos letras, punto, alfanumérico) deja de ser teléfono y queda `external`. Cualquier otra entrada con letras (`wa:5730…`, el ejemplo de `docs/scheduling-n8n-contract.md`) se normaliza igual que antes. Compatibilidad para contactos legados (abajo) | `bsuidIdentity`, `galleryIncidents` |
| 11 | Analytics: 100% de ejecuciones se leía como entrega | Tarjeta aparte "Agent sends" (aceptados / fallidos por código / pendientes; denominador = todos los envíos de agente) + pie "executions — not message delivery". La métrica existente no cambia | `handoffSendMetrics`, integración |
| 12 | El id de trazabilidad de Meta (`fbtrace_id`) se perdía | `provider.trace_id` admitido (8–64 alfanuméricos) | `handoffSendDiagnostics` |
| 13 | El auto-enlace (`linkNullConversationsByPhone`) **y el backfill E-5** (`BACKFILL_CTE` / `backfillConversationContacts`) quitaban las letras del `conversation_ref`: una conversación por BSUID se enlazaba con quien tuviera esos dígitos como teléfono real | Un ref BSUID solo enlaza por igualdad exacta con una identidad `external`. En el backfill también con el contacto que el código viejo creó desde esa BSUID (teléfono legado **y** `channel_user_id` = BSUID). Si existen ambos, es ambiguo y no se enlaza | `galleryIncidents` (los dos caminos fallan en `main`) |
| 14 | El aviso de duplicados del formulario de contacto leía los dígitos de un `channel_user_id` BSUID como teléfono | El lado escalar ignora `channel_user_id` con forma BSUID | `galleryIncidents` |

### Evidencia de /api/catalog en las tres capas
- **Middleware**: `/api/catalog` no está en `PUBLIC_PREFIXES` (`main`). Producción, misma petición (Bearer inválido, sin cookie): `/api/crm/…` y `/api/scheduling/…` → `401` JSON del handler; `/api/catalog/v1/products` → `307 /login`. La prueba no distingue si la ruta está desplegada (el middleware corre antes del enrutado): tras el fix, 401 = desplegada, 404 = no.
- **Autenticación**: `authenticateCatalog` → `authenticateHandoffRequest` (mismo chokepoint que CRM) + capacidad `catalog.read` + workflow + módulo. Correcta.
- **Handler**: `test/integration/catalog.test.ts` 4/4 (invoca el handler directamente, por eso no vio el middleware).

### BSUID: diagnóstico de impacto y plan de compatibilidad

**Qué hay hoy (código de `main`).** Un contacto que llegó por BSUID `CO.<dígitos>` quedó con
`channel_user_id = 'CO.<dígitos>'` y una identidad `phone` `'+<dígitos>'` inventada (y, según el
camino de entrada, también `phone_e164`; Q1 mide ambos). No hay UNIQUE sobre `(channel, channel_user_id)` desde la migración
`contact-spine`; las identidades son únicas por `(tenant, client, kind, value)`.

**Impacto del fix solo (sin compatibilidad), medido en la base de prueba:**
1. *Ingesta.* El siguiente mensaje de esa BSUID se clasifica `external`. No coincide con nada y
   `resolveContactByIdentity` **crea un segundo contacto** (partición del historial).
2. *Bot.* `findContactIdsByIdentity` deja de encontrar el contacto legado.
3. *Auto-enlace y backfill.* `linkNullConversationsByPhone` y `BACKFILL_CTE` seguían comparando
   dígitos en SQL. Enlazaban conversaciones BSUID con el contacto legado **y también con un
   cliente real** cuyo teléfono coincidiera con esos dígitos (fila 13).
4. *Un teléfono real que coincide con los dígitos* resuelve hoy al contacto legado, porque la
   identidad inventada ya lo reclama. Eso **no cambia** con esta rama: es dato existente, no código.

**Compatibilidad incluida (sin reparar ni fusionar).** Ojo: **escribe datos en la ingesta**. Lo
único de solo lectura es el diagnóstico SQL.
- **Lectura del contacto antiguo.** `legacyBsuidPhone(v)` reproduce exactamente lo que el código
  viejo derivaba de una BSUID: todos sus dígitos, de 7 a 15 y sin cero inicial, con `+` delante.
  Si una BSUID no coincide con ninguna identidad, se busca el contacto con esa identidad `phone`
  legada **y** `channel_user_id` igual a esa BSUID (lo creó ella). El dueño real de esos dígitos
  como teléfono nunca coincide (otro `channel_user_id`). Si no hay fila legada, no se adopta a
  nadie por suposición.
- **Ningún teléfono derivado.** Ningún camino escribe `+<dígitos>` a partir de una BSUID, con
  cualquier valor de cualquier variable de entorno. Se probó y se retiró un modo `dual` que sí lo
  hacía: en el orden "primero la BSUID, después un cliente real con ese número", el cliente real
  quedaba resuelto como la persona de la BSUID (`test/integration/bsuidIdentity.test.ts`).
- **Escrituras de la ingesta (en producción, con cada mensaje entrante):**
  - `INSERT` de la identidad `external` (contacto nuevo o antiguo que la aprende);
  - `fillEmptyAndTouch`: `last_contact_at` y campos vacíos;
  - el auto-enlace pone `contact_id` en las conversaciones sin contacto que coincidan.

  Es el mismo camino de escritura que ya sigue cualquier mensaje con una identidad nueva. No es
  una reparación por lotes, pero **no** es de solo lectura. La identidad `phone` inventada que ya
  existe y `phone_e164` **no se modifican**.
- **Lecturas puras:** `findContactIdsByIdentity` (bot) y el aviso de duplicados.
- **Auto-enlace y backfill:** un ref BSUID nunca se lee como teléfono. Un ref con otras letras
  (`wa:5730…`) conserva su lectura por dígitos. El backfill **escribe** si alguien lo ejecuta
  (`src/scripts/backfillConversationContacts.ts`). No se ha ejecutado, no forma parte del
  despliegue y requiere autorización.
- **Residual histórico** (igual que hoy en producción; no lo introduce ni lo resuelve esta rama):
  la identidad `phone` que R0 **ya** inventó puede hacer que un cliente real con ese número caiga
  en el contacto BSUID antiguo. Es un dato, no código. La decisión está en
  `docs/ops/gallery-incidents-deploy-plan.md` §7.

**Diagnóstico (preparado, sin ejecutar).** `docs/ops/gallery-identity-diagnostic.sql` es de solo
lectura (`BEGIN READ ONLY … ROLLBACK`) y está validado en la base de prueba con casos sintéticos:
- Q1: teléfonos inventados.
- Q2: contactos BSUID.
- Q3: posibles duplicados por nombre.
- Q4: candidatos de duplicado registrados.
- Q5: conversaciones BSUID enlazadas a otra persona.
- Q6: candidatos que R0 no encontraría, con la regla exacta de R0. Solo BSUID de 7–15 dígitos;
  las de 16 o más ya eran `external` en R0. Q6s es su resumen compartible.
- Q9 y Q10: caracterizan sin datos personales los candidatos de Q1 y de Q6.

Línea base del 13 oct (v1 y v2, resumen anonimizado): ver `docs/ops/gallery-incidents-deploy-plan.md`
§0. Hay 35 identidades BSUID: 33 se comportan igual en R0 y con el fix, 1 se encuentra por su propio
teléfono y queda 1 candidata, con la BSUID declarada, que no bloquea. Q1 tiene 1 contacto histórico,
que se conserva sin cambios.
- Q7: una BSUID con más de un contacto (partición).
- Q8: contadores de la ventana frente a la ventana anterior.

La limpieza de teléfonos inventados, si se decide, es una migración aparte, revisada y autorizada.

**Rollback.** Se vuelve a la imagen de contingencia C (`fix/bsuid-identity-contingency`: `main` +
solo esta corrección), no a R0. Ver `docs/ops/gallery-incidents-deploy-plan.md`.

### Fase 1 en producción: port mínimo de contactos
Las correcciones existen en `fix/platform-audit-phase1` (`317fbbb`, sobre el rediseño `0adf949`).
El subconjunto de **contactos** está preparado, sin commit, en la rama `fix/contacts-validation-port`
(worktree `worktrees/mai-contacts-port`, desde `origin/main` `f7c4cf7`, sin upstream):
- Aplicado tal cual: `contactForm`, `contactActionValidation`, `contactActions`, `ContactCreateForm`,
  `ContactEditForm`, `ContactsTable` y la página de contactos (enlace de fila dentro de `/clients/{id}`).
- Adaptado: `contactLabels` usa las palabras literales del `STATUS_LABEL` de `AgendaView` en `main`
  ("Sin confirmar", "Inasistencia"). `agenda/status.ts` no existe en `main`, y la prueba compara contra
  ese mapa.
- Excluido: `AdminPanel`, el filtro `?staff=`, presencia de staff y todo el rediseño.
- Pruebas: `contactIdentityValidity`, `clientScopedLinks`, `appointmentStatusVocabulary` y
  `contactsRedesignContract` (84/84). En una copia de `main` sin el port fallan 1, 2, 2 y 2.

## 3. Despliegue y rollback

Ver `docs/ops/gallery-incidents-deploy-plan.md`. Resumen: no hay migraciones, pero **sí hay
escrituras de datos en la ingesta**. El despliegue va en dos etapas, primero C (solo identidad) y
después R1, y el rollback de R1 es C, que conserva la corrección de identidad.

## 4. Decisiones pendientes (código)

1. Revisión y commit de esta rama y de `fix/contacts-validation-port`.
2. Integración de `fix/platform-audit-phase1` en `main` (choque en `schedulingAdminActions.ts`).
3. Autorizar el diagnóstico de solo lectura en producción (`docs/ops/gallery-identity-diagnostic.sql`).
4. R0 identificado (`f7c4cf7b4efb…`). Falta autorizar cada etapa: etapa 1 (C) y etapa 2 (R1).
5. Datos históricos (teléfonos inventados por R0): diferir o migración revisada (plan §7).
6. Aplicar el mapeo de errores en el workflow n8n (copia revisada, nunca el activo sin autorización).

Las decisiones comerciales de Fresha están en su propio documento.
