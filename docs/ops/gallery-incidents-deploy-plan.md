# Gallery — plan de despliegue, criterios de parada y rollback

Estado: **plan histórico de la primera integración**. La base `f7c4cf7` y la contingencia C
que aparecen más abajo documentan el diagnóstico original; **ya no son instrucciones para
el siguiente despliegue**. No desplegar una imagen antigua que elimine el rediseño o las
funciones de staff/ausencias. Cada despliegue, cambio en Railway o reparación de datos sigue
requiriendo autorización explícita.

## Integración actual — 13 de octubre de 2026

- `main` está en `75df605599a14a93db9eac51423cf270eb82e837`: incluye el PR #16 (BSUID),
  `8dff1c2` (staff y Time Off) y el PR #17 (rediseño y auditoría de Scheduling).
- `fix/gallery-incidents-integration` parte de ese `main` y aplica **solo** las correcciones
  restantes y las herramientas/documentación. No vuelve a aplicar el commit de identidad.
- El diagnóstico original y sus datos históricos se conservan; no se han ejecutado backfills,
  fusiones, importaciones ni reparaciones de producción.
- Las validaciones de contactos del port ya están incluidas en el PR #17. No desplegar esa
  rama antigua por separado ni duplicar sus cambios.
- La web de producción carga el diseño nuevo. Esto no certifica el SHA del Worker: antes de
  desplegar estas correcciones hay que registrar el commit Active de **ambos** servicios y
  confirmar que el despliegue previo terminó.
- El workflow n8n continúa sin cambios. Su mapeo es una propuesta para una copia de pruebas;
  su publicación y activación requieren aprobación específica.

### Próximo despliegue (no ejecutado)

1. Revisar el PR de `fix/gallery-incidents-integration`, sus pruebas y su diff contra `75df605`.
2. Confirmar la versión Active de Worker y Web service; no desplegar mientras el anterior
   siga en cola. Si `main` cambia, volver a integrar y verificar antes de aprobar el PR.
3. Autorizar el merge/despliegue por separado. No hay migraciones nuevas en esta integración.
4. Humo sin escrituras: Inbox, contactos, Agenda, Staff y Configuración cargan; catálogo con
   Bearer inválido devuelve 401 JSON en lugar de 307; revisar envíos en Analytics sin
   interpretar aceptación como entrega. No enviar mensajes ni crear citas reales para probar.
5. Si hay una regresión, usar la imagen Active **registrada justo antes de este despliegue**,
   que debe conservar BSUID, rediseño y Time Off. No reutilizar a ciegas R0 ni la antigua C.
6. Q1 y Q3 siguen intactos. Cualquier diagnóstico posterior requiere sesión de solo lectura;
   cualquier reparación de datos necesita su propio plan y autorización.

---

## Plan original (archivo de contexto; no ejecutar con sus antiguas imágenes)

Fuera de este despliegue, por decisión:
- la reconciliación comercial con Fresha (`docs/proposals/gallery-fresha-reconciliation-2026-10.md`);
- cualquier importación, limpieza o reparación de datos, incluido el backfill E-5;
- el cambio del workflow de n8n;
- el port de contactos (`fix/contacts-validation-port`, con rama y despliegue propios).

## 0. Línea base del diagnóstico (13 oct) y recomendación

El usuario ejecutó el diagnóstico **dos veces** el 13 oct, en sesión de solo lectura y con ventana
desde el 13 sep (Bogotá): v1 a las 09:54 y v2 a las 10:08, esta última con Q6 corregida y Q6s, Q9 y
Q10. Aquí solo figura el resumen anonimizado que entregó. Los archivos con datos personales siguen
siendo privados y no están en el repositorio. Nadie modificó datos.

| Consulta | Línea base | Lectura |
|---|---|---|
| Q1 | 1 contacto con identidad `phone` igual a los dígitos de su BSUID | Caso histórico (Q9). **Se conserva sin cambios** |
| Q2 | 9 contactos BSUID por `channel_user_id`, ninguno con `phone_e164` | El contador va por `channel_user_id`, no por identidades `external` |
| Q3 | 1 grupo de 2 contactos con el mismo nombre (manual + WhatsApp; 1 y 0 citas) | Coincidencia de nombre, no duplicado. **No se fusiona** |
| Q4, Q5, Q7 | 0 | Sin candidatos registrados, sin alertas de enlace y sin particiones |
| Q6s (v2) | 35 identidades `external` BSUID: 33 que R0 ya guarda como `external`, 1 que R0 encuentra por su propio teléfono y **1 candidata**. Por longitud: 15 dígitos ×2, 16 ×32, 17 ×1 | 35 es el total de identidades, no de contactos afectados. La Q6 antigua (34 filas) sobrestimaba el riesgo porque no aplicaba la regla de R0 |
| Q8 (v1) | 43 contactos creados en la ventana, 9 de ellos BSUID; 0 candidatos a duplicado | — |

**Q9, el caso histórico de Q1** (BSUID de 15 dígitos, que R0 lee como teléfono):
- *Lo que indica que R0 inventó el teléfono:*
  - ya tiene también su identidad `external`;
  - la identidad `phone` se creó 4 ms después que el contacto, con etiqueta `whatsapp`;
  - no hay teléfono escalar;
  - tiene 1 conversación cuya referencia es la BSUID;
  - no hay conversaciones con esos dígitos como referencia, ni otros contactos con ese número, ni citas.
- *Lo que no prueba:* que nadie use ese número. La consulta de referencias telefónicas excluye las
  que tienen letras (`wa:…`), así que un 0 ahí no es una ausencia universal.
- *Efecto del despliegue:* ninguno. La conversación entra por la BSUID, que coincide con la identidad
  `external` tanto en R0 como en C y R1; no hay partición. El riesgo residual (un cliente real con
  esos dígitos) es igual que hoy.
- *Decisión:* **se conserva sin cambios** durante el despliegue. Cualquier reparación será específica,
  revisada y autorizada por separado (§7).

**Q10, la candidata restante de Q6** (15 dígitos), con estos datos:
- `channel_user_id` con forma de teléfono, no BSUID;
- identidades `external` y `phone`, sin que otro contacto tenga ese número;
- etiqueta de la identidad externa `whatsapp_bsuid`, creada 9 ms después que el contacto;
- 1 conversación con referencia telefónica y 0 citas.

Es compatible con un contacto creado por su teléfono y con la BSUID **declarada** como identidad
adicional, algo que R0 ya soporta. **No bloquea el despliegue.** Pero no demuestra qué envía hoy cada
workflow, así que **no autoriza un rollback ciego a R0**: la regla del punto 4 de abajo sigue vigente.

**Regla de R0** (`f7c4cf7`): solo lee una BSUID como teléfono si, quitando todo lo que no es dígito,
quedan **7–15 dígitos y el primero no es 0**. Si no, ya la guardaba como `external`, igual que el fix.
En la línea base, el cambio de identidad no altera el comportamiento de 33 de las 35 identidades. Las
pruebas fijan esa paridad por longitud:
- `test/unit/bsuidIdentity.test.ts`: 1–20 dígitos, con y sin cero inicial;
- `test/integration/bsuidIdentity.test.ts`: 15, 16 y 17 dígitos, con y sin identidad declarada.

**Recomendación (sin ejecutar nada).**
1. ✅ Línea base tomada (v1 + v2). No hacen falta fusiones ni limpieza general.
2. ✅ Q10: BSUID declarada; no bloquea.
3. 🔒 Desplegar en dos etapas, primero C y después R1 (§4–§5). El rollback de R1 es C.
4. Volver a R0 solo si Q6s `r0_phone_candidates_in_window` = 0 **con `since` = hora del despliegue**
   (la candidata de la línea base es anterior y queda fuera), o si Q10 muestra que las filas nuevas
   tienen la BSUID declarada. Si no, se avanza sobre C.
5. Q1 y Q3 quedan intactos.

## 1. Imágenes

| Imagen | Contenido | Rama |
|---|---|---|
| **R0** | Lo que corre hoy en producción: `f7c4cf7b4efb7fa49065ab8c86fb29ad88569f2d` (despliegue activo en Railway) | `origin/main` |
| **C** (contingencia) | `origin/main` `f7c4cf7` + **solo** la corrección de identidad BSUID | `fix/bsuid-identity-contingency` (worktree `mai-bsuid-contingency`) |
| **R1** | Todas las correcciones de Gallery, con la **misma** corrección de identidad que C | `fix/gallery-incidents-v1` |

La corrección de identidad es idéntica byte a byte en C y en R1:
- código: `src/scheduling/phone.ts`, `src/db/repositories/contactIdentities.ts` y
  `src/scripts/backfillConversationContacts.ts`;
- pruebas: `test/unit/bsuidIdentity.test.ts` y `test/integration/bsuidIdentity.test.ts`;
- diagnóstico: `docs/ops/gallery-identity-diagnostic.sql` y `docs/ops/run-gallery-identity-diagnostic.sh`.

**Ningún camino escribe un teléfono derivado de una BSUID**, con cualquier valor de cualquier
variable de entorno: el código de identidad no lee ninguna, y una prueba lo comprueba. Los datos
históricos se siguen leyendo con la compatibilidad de solo lectura (`legacyBsuidPhone`).

## 2. Por qué C y no "volver a R0"

R1 y C crean contactos BSUID con **solo** la identidad `external`. Para BSUID de 16 o más dígitos,
la mayoría en producción, R0 hace exactamente lo mismo. Para una BSUID de **7–15 dígitos**, R0 la
lee como el teléfono `+<dígitos>`: si el workflow no la declara también como `external`, R0 no
encuentra el contacto y crea otro en el siguiente mensaje, partiendo el historial. Por eso:
- **Revertir las demás funcionalidades** = desplegar **C**, nunca R0. C conserva la corrección de
  identidad y las demás escrituras de R1 son compatibles con C (tabla de abajo).
- **Revertir la propia corrección de identidad** (volver a R0) solo es seguro si Q6s
  `r0_phone_candidates_in_window` = 0 desde el despliegue, o si Q10 muestra que esas filas tienen la
  BSUID declarada. Si no, hay que **avanzar** (corregir sobre C) o aceptar explícitamente la
  partición de los contactos que lista Q6.

| Escritura de R1 | ¿Compatible con C? |
|---|---|
| Identidades `external` de BSUID; enlaces de conversación solo por identidad exacta | Sí: es el mismo código |
| `failure_detail` con "(HTTP 500 · código …)" | Sí: es texto |
| Reintento `failed → sending` atómico | Sí: mismas columnas |
| Certificaciones y excepciones (validación más estricta) | Sí: solo rechaza escrituras que antes eran indebidas |
| `takes_bookings`, Analytics, middleware, Inbox | Solo lectura o interfaz, sin datos nuevos |

## 3. Precondiciones: si falla alguna, se detiene

| # | Precondición | Si no se cumple |
|---|---|---|
| P1 | **R0 identificado** en Railway. ✅ `f7c4cf7b4efb7fa49065ab8c86fb29ad88569f2d` (despliegue activo) | **Detener.** Sin R0 no se sabe qué cambia C ni a qué se vuelve |
| P2 | **C construida sobre R0.** ✅ C y R1 parten de `f7c4cf7b4efb…`. Si R0 cambia antes de desplegar (otro despliegue en Railway), se rehace C y se repite P4 | Detener hasta rehacerla |
| P3 | Revisión y commit 🔒. En R1, commits separados: (a) identidad, igual que C; (b) resto de correcciones; (c) dry-run de Fresha y documentación, sin efecto en tiempo de ejecución | — |
| P4 | Verificación de C y de R1: typecheck raíz y web, unit, integración y `next build` en verde respecto a la línea base | Detener |
| P5 | `git diff C R1 -- <archivos de identidad>` vacío | Detener: C no sería una contingencia válida de R1 |
| P6 | 🔒 Diagnóstico de solo lectura con `since` = hace 30 días: línea base B, revisada con el usuario | Detener hasta revisarla |
| P7 | Decisión sobre los **datos históricos** (§7) tomada o diferida de forma explícita | Detener hasta decidir |

Las decisiones comerciales de Fresha **no** son precondición.

## 4. Etapa 1: desplegar C (solo identidad)

1. 🔒 Desplegar C.
2. Humo, solo lectura, sin enviar mensajes ni crear citas: el Inbox carga y la ficha de un
   contacto existente abre.
3. Observación: **48 h que incluyan un día laborable completo de Gallery**. Diagnóstico 🔒 con
   `since` = hora del despliegue.

**Criterios de parada** (basta uno):

| # | Señal | Umbral |
|---|---|---|
| S1 | Q7 con `new_in_window = true` (una BSUID con un contacto nuevo duplicado) | > 0 |
| S2 | Q8 `duplicate_candidates_detected` | `in_window` ≥ 3 **y** > 2 × `previous_window` |
| S3 | Logs del web: `E-5: conversation auto-link failed`, o 5xx en `/api/handoff/v1/messages`, `/api/crm/v1/*` o `/api/scheduling/v1/*` | Por encima de las 24 h previas |
| S4 | Tasa de error de las ejecuciones del bot de Gallery (Analytics) | Más de 10 puntos sobre la semana previa |

**Si se detiene la etapa 1** (Q6s y Q10 con `since` = hora del despliegue):
- Si `r0_phone_candidates_in_window` = 0, o si todas sus filas tienen la BSUID declarada en Q10,
  volver a R0 🔒 es seguro.
- Si no, **no** se vuelve a R0 sin aceptar explícitamente la lista de Q6. La alternativa
  recomendada es corregir sobre C y redesplegar.

## 5. Etapa 2: desplegar R1 (resto de correcciones)

Requiere autorización 🔒 propia y la etapa 1 estable.
1. 🔒 Desplegar R1.
2. Humo, solo lectura:
   - `GET /api/catalog/v1/products` con Bearer inválido → `401` JSON (no `307`).
   - `/api/scheduling/v1/services` y `/v1/staff` sin profesionales con `takes_bookings = false`.
   - El filtro de flujo del Inbox se ve y se puede quitar.
3. Observación: otras 48 h con un día laborable.

**Criterios de parada**: S1–S4 de la etapa 1, más **S5**: `/api/catalog/v1/*` sigue dando `307` o
da `5xx`.

**Rollback de la etapa 2**: volver a **C** 🔒, nunca a R0. Es compatible con los datos (§2).

## 6. Diagnóstico de producción (línea base: v1 y v2 del 13 oct, ejecutadas por el usuario)

`docs/ops/gallery-identity-diagnostic.sql`: solo `SELECT` dentro de `BEGIN READ ONLY … ROLLBACK`.
Se ejecuta **solo** con `docs/ops/run-gallery-identity-diagnostic.sh` y únicamente con autorización 🔒.

**Base verificada.** El despliegue activo en Railway es `f7c4cf7b4efb7fa49065ab8c86fb29ad88569f2d`
(R0). C y R1 parten exactamente de ese commit, así que P1 y P2 se cumplen.

**Cómo se ejecuta** (lo hace el usuario; la credencial no pasa por ningún chat ni archivo):

```
read -rs DIAG_DATABASE_URL; export DIAG_DATABASE_URL
docs/ops/run-gallery-identity-diagnostic.sh '<since>' ~/gallery-diagnostic-<fecha>.txt
unset DIAG_DATABASE_URL
```

**Garantías del script y del SQL** (probadas contra la base de prueba aislada):
- **Sesión de solo lectura** (`default_transaction_read_only=on`). Una escritura en esa sesión
  falla con "cannot execute … in a read-only transaction".
- **Guardas del SQL.** Aborta con salida 3, antes de leer nada, si la sesión no es de solo lectura,
  si falta `client_id` o `since`, o si el cliente no existe en esa base (base equivocada o vacía).
- **La credencial no se expone.** Viaja solo como variable de entorno hacia el contenedor
  `postgres:16` local (`--pull never`). No se imprime, no queda en el historial ni en la línea de
  comandos del host, y la salida muestra el *nombre* de la base, no el host, el usuario ni la
  contraseña.
- **Salida protegida.** Se escribe con permisos 600, fuera del repositorio, nunca sobrescribe un
  archivo y se borra si la ejecución falla. Contiene datos personales: no se sube ni se pega.

| Consulta | Uso | ¿Compartible? |
|---|---|---|
| Q1–Q2 | Teléfonos inventados y contactos BSUID existentes. Dimensionan §7 | No: ids y valores |
| Q3–Q4 | Posibles duplicados (solo diagnóstico; nunca fusionar por nombre) | No |
| Q5 | Conversaciones BSUID enlazadas a otra persona (dato existente) | No |
| Q6 | Candidatos que R0 no encontraría, aplicando su regla exacta (7–15 dígitos, primero ≠ 0) | No |
| **Q6s** | Q6 en contadores: total, cuántas R0 ya guarda como `external`, candidatos, candidatos en la ventana y distribución por longitud | **Sí** |
| Q7 | Señal de parada: una BSUID, varios contactos | No |
| Q8 | Contadores de la ventana frente a la ventana anterior | Sí |
| **Q9** | Caracteriza el candidato de Q1: ¿teléfono inventado o hay señales de una persona real? | **Sí** |
| **Q10** | Caracteriza los candidatos de Q6: ¿la BSUID llegó declarada? ¿quién tiene el teléfono? | **Sí** |

## 7. Decisión pendiente: datos históricos (no la resuelve ningún código)

Los contactos que R0 creó desde una BSUID **de 7–15 dígitos** tienen una identidad `phone` inventada
(Q1: **1 contacto** en producción el 13 oct; Q9 lo caracteriza en §0). Mientras exista, un **cliente real con ese número** que
escriba o reserve se resuelve a ese contacto BSUID.
Ocurre hoy en producción y **sigue ocurriendo en C y en R1**, porque es un dato, no código.

Una corrección solo de código no es viable:
- Si se ignora esa identidad al buscar, el alta del cliente real choca con la unicidad de
  `(tenant, client, kind, value)` y termina adoptando el mismo contacto.
- Si no se reclama el teléfono, se crea un contacto nuevo en cada mensaje.

Antes de decidir, Q9 dice sin mostrar datos si ese número tiene señales de una persona real:
conversaciones cuyo `conversation_ref` son esos dígitos, otros contactos con ese número o citas.
**No se limpia esa identidad**, ni de forma automática ni por la sola coincidencia de dígitos.

Opciones para el usuario:
1. **Diferir.** Desplegar C y R1 sin tocar datos. El riesgo histórico queda igual que hoy, acotado
   a las filas de Q1.
2. **Migración revisada y autorizada** (no preparada aquí, no se ejecuta sin aprobación): para cada
   fila de Q1 cuyo valor sea exactamente el derivado de su propio `channel_user_id`, convertir la
   identidad `phone` en la `external` de esa BSUID. Hay que resolver antes cualquier colisión que
   aparezca. La compatibilidad de lectura dejaría de ser necesaria para esas filas.

Las particiones (Q7) y los enlaces de Q5 tienen el mismo tratamiento: se informan y no se reparan
de forma automática. Los dos contactos de Q3, que solo comparten nombre, **no se fusionan**.

## 8. Después: fuera de este plan, cada uno con autorización propia

- Workflow n8n: aplicar `tools/n8n/handoffSendErrorMapping.mjs` en una **copia** revisada.
- Reconciliación con Fresha: su propio documento y sus decisiones comerciales.
