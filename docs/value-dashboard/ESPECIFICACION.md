# Dashboard de valor: especificación de métricas (v3.1)

**Estado:** propuesta para revisión. No hay código del dashboard y **no se ejecutó nada en producción**.

**Archivos:**
- **`consultas.sql`:** consultas de referencia Q0–Q9, solo lectura.
- **`pruebas/consultas.test.mjs`:** 14 escenarios sintéticos que verifican que cada consulta mide lo que promete.
- **`pruebas/mutaciones.py`:** 20 mutaciones que reintroducen los errores encontrados en revisión. Cada una debe hacer fallar al menos una prueba.
- **Cómo reproducir todo:** §9.

**Principios:**
1. Cada cifra es un **hecho medido** o una **estimación declarada**, y la pantalla dice cuál es. Nada se llama «ahorro» ni «cobro» sin evidencia.
2. **Un dato desconocido es NULL, nunca 0.** Un 0 significa «medido, y no hubo ninguno».
3. **Las métricas conversacionales quedan deshabilitadas** («Sin evidencia suficiente») mientras no haya evidencia de instrumentación (§5).

**Historial de cambios:**

| Versión | Cambio |
|---|---|
| v2 | Resultado e intervención humana separados; turnos con ventana; Q7 desde el inicio del seguimiento; Q1 como contraste; etiquetas de Q4a/Q4b/Q5 |
| v3.1 | Q9 juzga solo workflows **conversacionales** (un workflow de mantenimiento no bloquea); corregida la afirmación sobre el emparejamiento (evita duplicar evidencia, **no** garantiza parejas correctas); §9 para reproducir |
| v3 | Q1 con emparejamiento **uno a uno**; Q1b distingue **sin mapeos configurados** de **mapeos sin turnos**; filtro **explícito de tenant** en ejecuciones (Q1b, Q8, Q9); nueva **Q9** (puerta de evidencia); **desconocido ≠ 0** en Q3, Q4a, Q4b, Q5, Q7 y Q9; limitaciones del contraste temporal (§5.3) |

---

## 1. Acceso

**Quién lo ve:** el dueño del negocio y la agencia. Es el mismo permiso que las analíticas de workflows: `canSeeWorkflowInsights` (`web/lib/access.ts:91`), que da acceso a la agencia (owner/admin del tenant) y al owner del propio negocio. Setters y staff quedan fuera.

**Dónde se valida:** en el servidor, en la página y en cada consulta, siempre filtrando por `tenant_id` y `client_id`.

**Tenant explícito en ejecuciones:** el filtro de tenant se aplica de forma explícita también a `executions`. Esta tabla tiene llaves foráneas **separadas** a la conexión y al tenant (no una compuesta), así que el tenant **no** se puede deducir de la conexión.

## 2. Conversaciones (solo con evidencia habilitada, §5)

### 2.1 Turnos (Q3)

- **Cuándo empieza un turno:** en un mensaje del cliente cuyo mensaje anterior, en **toda** la historia, no es del cliente. Varios mensajes seguidos del cliente son un solo turno, y un turno que empezó antes del periodo no es del periodo.
- **Dónde termina:** donde empieza el siguiente turno.
- **Su respuesta:** el **primer** mensaje del bot o del equipo dentro del turno.
- **Ventana:** el parámetro `ventana` (propuesta: 30 min). No se corta en el fin del periodo.

| Estado del turno | Regla |
|---|---|
| Respondido por el bot / por una persona | La primera respuesta llegó dentro de la ventana, según quién respondió primero |
| Respuesta tardía | Llegó después de la ventana |
| Sin respuesta observable | La ventana venció y no hay respuesta **registrada** |
| En curso | La ventana todavía no vence |

**Tiempo de respuesta:** mediana y p90 **solo** de los turnos respondidos por el bot. Si no hay ninguno, el valor es **desconocido (NULL)**, no 0 segundos. Siempre se muestra junto a los turnos tardíos, sin respuesta y en curso.

### 2.2 Clase de cada conversación (Q2)

**Quién entra:** las conversaciones con algún turno que empieza en el periodo, o con una cita **del bot** (`appointments.origin = 'n8n'`) ligada y creada en el periodo.

**Dos dimensiones independientes:**
- **Resultado:** cita del bot ligada (`source_conversation_id`). Una cita manual o pública ligada **no** es resultado del bot.
- **Intervención humana:** se cumple con cualquiera de estas tres señales:
  - un mensaje del equipo en el periodo;
  - una transición a `pending` o `human` en el periodo;
  - la conversación ya estaba fuera del bot al empezar el periodo.

| Clase (excluyente, en este orden) | ¿Suma tiempo? |
|---|---|
| Con intervención humana (se informa cuántas tuvieron cita del bot) | No |
| **U2** Cita del bot sin intervención | Sí |
| En curso | No (todavía) |
| **U1** Todos sus turnos respondidos por el bot dentro de la ventana | Sí |
| Con turnos sin respuesta o tardíos | No |

**«Resuelta» no se usa:** el esquema no tiene ese estado (`conversations.mode ∈ bot|pending|human`).

**La unidad es «conversación en el periodo».** Sumar meses no da el total del trimestre.

## 3. Dinero: valor, nunca cobro

**No hay registro de pagos** (`1798000000001_products.ts:6`).

**Cómo se trata un valor desconocido (Q4a, Q4b, Q5, Q7):**
- **`valor` es NULL** cuando el grupo tiene citas pero **ninguna** con precio.
- **Es parcial** cuando faltan algunos precios: `sin_precio` dice cuántos, y la pantalla lo muestra («$40.000 · 1 cita sin precio»).
- **Es 0** solo cuando no hubo citas en el grupo.
- **Q4a y Q4b** devuelven una fila por (canal, estado). Si una fila no aparece, hubo 0 citas (dato medido).

**Las consultas:**
- **Q4a, reservas creadas en el periodo** (`created_at`) con su estado actual. No son «servicios del periodo». U3 son las filas del canal `public`.
- **Q4b, citas con fecha en el periodo** (`start_at`). De aquí sale el **valor de servicios completados en el periodo**, que no significa cobrado.
- **Q5, reservas del bot fuera del horario semanal configurado.** No considera cierres puntuales ni festivos.
- **Q7, cohorte de clientes nuevos:**
  - **Periodo efectivo:** [máx(inicio del periodo, `tracking_started_at`), fin).
  - **Valor:** servicios completados con fecha dentro de ese periodo, de los clientes creados en él.
  - **Sin seguimiento:** no hay filas.
  - **Periodo parcial:** Q7s dice desde cuándo hay seguimiento y si el periodo es parcial.

## 4. Tiempo: una unidad, un supuesto

| Unidad | Origen | Supuesto (minutos) |
|---|---|---|
| U1 Conversación respondida por el bot | Q2 `u1_respondida_por_bot` | `min_conversacion_atendida` |
| U2 Conversación con cita del bot (incluye agendar) | Q2 `u2_cita_bot` | `min_conversacion_con_cita` |
| U3 Reserva de la página | Q4a, canal `public` | `min_agendar_manual` |

**Sin solapes:** U2 exige `origin = 'n8n'` y U3 `origin = 'public'`, y cada conversación tiene una sola clase.

**Lo que no suma tiempo:** las conversaciones con intervención humana, en curso, tardías o sin respuesta; las gestiones del bot (Q6, solo se cuentan); y las ejecuciones.

**Fórmulas:**
- **Tiempo liberado estimado** = U1 × `min_conversacion_atendida` + U2 × `min_conversacion_con_cita` + U3 × `min_agendar_manual`.
- **Valor estimado** = horas × `costo_hora`. No es ahorro de caja.

**Requisitos para mostrarlos:**
- **Supuestos:** sin supuestos confirmados, la pantalla muestra «Configura tu estimación».
- **U1 y U2:** dependen de las métricas conversacionales. Mientras estas estén deshabilitadas (§5), el tiempo liberado **solo incluye U3** y lo dice («Solo reservas de la página. Las conversaciones se suman cuando se verifique el registro de mensajes»). Nunca se muestran como 0.

**Supuestos** (tabla nueva, versionada y de solo inserción; propuesta, no creada):
- **Qué guarda cada versión:**
  - `method_version`, los cuatro valores y `effective_from`;
  - quién la propuso desde la agencia y cuándo (`proposed_by`/`_at`);
  - quién la confirmó por parte del negocio y cuándo (`confirmed_by`/`_at`);
  - `status`.
- **Cómo se aplica:** cada día usa la versión confirmada vigente ese día, y el historial queda visible.

## 5. Evidencia de instrumentación

### 5.1 Contraste automático (Q1, Q1b, Q9)

Las métricas conversacionales dependen de que el workflow **reporte** los mensajes a la plataforma (`POST /api/handoff/v1/messages`, `sender ∈ user|bot`). Contarlos no dice cuántos faltan, así que se contrastan con una segunda fuente independiente: los **turnos reconstruidos de las ejecuciones** de n8n (`conversation_turns`, `src/conversations/deriveTurns.ts`).

**Q1, por workflow, con emparejamiento uno a uno:**
- **Cómo empareja:** cada turno de ejecución se empareja con **a lo sumo un** mensaje del cliente y **a lo sumo una** respuesta del bot, y cada mensaje con a lo sumo un turno. Se elige la pareja **mutuamente más cercana** en el tiempo.
- **Evita duplicar evidencia:** un mismo mensaje no justifica dos turnos.
- **No garantiza parejas correctas:** dos mensajes cercanos pueden pertenecer a turnos distintos y emparejarse cruzados. Es un **contraste temporal aproximado**, que puede errar en ambos sentidos (§5.3).

**Q1b, workflows con ejecuciones que no se pueden contrastar:**
- **`sin_mapeos_configurados`:** no tiene los roles `conversation_id` y `user_message` en `field_mappings` (`mapping_kind = 'conversation'`). Nunca habrá turnos. Incluye los mapeos incompletos y devuelve los roles que sí existen.
- **`mapeos_sin_turnos`:** tiene los dos roles, pero no se reconstruyó ningún turno en el periodo. Puede ser una extracción fallida, ejecuciones que no son mensajes o una derivación aún no ejecutada.

**Q9, decisión automática por workflow:**
- **Solo juzga workflows conversacionales:** los que tienen algún mapeo de conversación o reportaron mensajes en el periodo.
  - Los demás (por ejemplo, de mantenimiento) aparecen como `no_conversacional` y **no bloquean**.
  - **Riesgo residual:** un workflow de atención que no reporta mensajes **y** no tiene mapeos se vería como no conversacional. Por eso la revisión manual (§7) también **confirma la lista** de workflows conversacionales.
- **Estados posibles:**
  - `sin_ejecuciones_para_contrastar` (reportó mensajes, pero no hay ejecuciones ingeridas que contrastar);
  - `sin_mapeos_configurados`;
  - `mapeos_sin_turnos`;
  - `muestra_insuficiente` (menos de `minimo` turnos; propuesta: 50);
  - `por_debajo_del_umbral` (alguna proporción por debajo de `umbral`, o desconocida);
  - `contraste_suficiente`.
- **Qué mide:**
  - turnos con conversación registrada;
  - turnos con mensaje del cliente registrado;
  - respuestas de la ejecución registradas como mensaje del bot.
- **Proporción sin datos:** es **NULL**, no 0 %. Por ejemplo, si las ejecuciones no capturan la respuesta (sin mapeo `ai_response`), esa proporción es desconocida, y una evidencia incompleta **no habilita**.
- **`habilitable`:** se cumple solo si hay **al menos un** workflow conversacional y **todos** los conversacionales están en `contraste_suficiente`.
- **Sin datos:** un cliente sin ejecuciones ni mensajes no devuelve filas, y uno con solo workflows de mantenimiento tampoco es habilitable.

### 5.2 Regla de habilitación (para el futuro código del dashboard)

Las métricas conversacionales (Q2, Q3 y U1/U2 en el tiempo) se muestran **solo si se cumplen las dos condiciones:**
1. Q9 devuelve `habilitable = true` para el cliente y el periodo.
2. Hay una **revisión manual aprobada** y vigente para ese cliente (§7), que alguien registró con fecha y responsable.

**Si falta cualquiera de las dos:**
- se muestra «Sin evidencia suficiente» con el motivo (por ejemplo, «el workflow X no registra las respuestas del bot»);
- **ningún número**, ni siquiera 0.
- Las métricas de citas (Q4a, Q4b, Q5, Q6, Q7) **no dependen** de esta regla.

### 5.3 Limitaciones que conserva el contraste temporal

1. **Relojes distintos.**
   - **La hora del turno** es `executions.started_at`, el reloj de n8n (`deriveTurns.ts:104`).
   - **La hora del mensaje** es la que envía el workflow en `occurred_at` (opcional). Si no la envía, es la hora de **recepción** en la plataforma (`messages/route.ts:91-99`).
   - **El riesgo:** un desfase de reloj o una cola de envío mayor que la `tolerancia` desempareja turnos que sí se registraron, lo que hace subestimar.
2. **La tolerancia es un compromiso.**
   - **Si es amplia,** puede emparejar un mensaje con el turno equivocado de la misma conversación, porque dos mensajes cercanos pueden pertenecer a turnos distintos. El emparejamiento uno a uno evita usar un mensaje dos veces, pero **no** garantiza que la pareja sea la correcta: el resultado puede salir mejor o peor que la realidad.
   - **Si es estrecha,** pierde las respuestas lentas o en cola.
3. **Ráfagas.** Varios mensajes del cliente en pocos segundos pueden generar una sola ejecución o varias. La pareja mutua más cercana puede dejar sin pareja turnos reales (lo que subestima) o cruzar parejas (lo que oculta un faltante).
4. **Clave de conversación.** El contraste exige que la clave extraída por el mapeo (`conversation_turns.conversation_id`) sea **la misma** que `conversations.conversation_ref`. Si el workflow usa claves distintas en cada lado, todo aparece como no registrado, aunque sí lo esté.
5. **Cobertura de la segunda fuente.** Las ejecuciones no ingeridas, la derivación pendiente o con errores, y los workflows sin mapeos no aparecen como turnos. **Lo que n8n nunca ejecutó o no ingerimos es invisible para ambas fuentes.**
6. **Contenido.** Solo se contrastan la presencia y el tiempo, no el texto. Un mensaje registrado podría no ser exactamente el de esa ejecución.
7. **Reintentos.**
   - **Reenvíos:** se deduplican por `external_message_id` cuando el workflow lo envía.
   - **Reejecuciones:** reemplazan su turno por ejecución, pero pueden crear otro turno si son ejecuciones distintas.

**Por estas limitaciones, Q9 solo sirve para descartar o habilitar provisionalmente.** La confirmación requiere la revisión manual de §7. Sus parámetros (`tolerancia`, `ventana`, `umbral`, `minimo`) son un punto de partida, **no** una certificación de fiabilidad.

## 6. Evidencia y pruebas

### 6.1 Del esquema y el código

| Afirmación | Respaldo |
|---|---|
| No hay estado «resuelta» | CHECK `conversations.mode ∈ (bot, pending, human)` |
| Remitentes | CHECK `handoff_messages.sender ∈ (user, bot, human_agent)`; la ingesta máquina solo acepta `user`/`bot` (`web/app/api/handoff/v1/messages/route.ts:36`); el equipo escribe `human_agent` desde la plataforma (`web/lib/sendActions.ts:70`) |
| Hora de los mensajes | `occurred_at` opcional del workflow; si no viene, la hora de recepción (`messages/route.ts:91-99`) |
| Hora de los turnos | `turnTimestamp = execution.started_at` (`src/conversations/deriveTurns.ts:104`) |
| Mapeos de conversación | `field_mappings.mapping_kind = 'conversation'`, un rol por workflow; un turno exige `conversation_id` y `user_message` (`deriveTurns.ts`) |
| Ejecuciones sin FK compuesta al tenant | FK `executions.n8n_connection_id → n8n_connections` y `executions.tenant_id → tenants`, por separado |
| Canales de cita | CHECK `appointments.origin ∈ (public, n8n, internal, walk_in)`; escriben esos valores `v1/appointments/route.ts:298`, `booking/[slug]/route.ts:237` y `schedulingActions.ts:222` |
| Cita ligada a conversación | Solo si el bot envía `conversation_ref`, que es opcional (`v1/appointments/route.ts:209`; `src/scheduling/booking.ts:383-387`) |
| Gestiones del bot sin conversación | `appointment_events` no tiene columna de conversación; `actorType: "n8n"` (`[id]/cancel/route.ts:38`, `[id]/reschedule/route.ts:82`) |
| Origen y seguimiento | CHECK `contacts.origin_kind`; `attribution_settings.tracking_started_at` (`migrations/1808000000000_attribution.ts:109`) |
| Sin pagos | No existe ninguna tabla de pagos (`1798000000001_products.ts:6`) |
| Ejecuciones con error | `status IN ('error','crashed')` (`src/db/repositories/analytics.ts:95`) |

### 6.2 Pruebas: 14 de 14 pasan contra la base local de pruebas, en transacciones que se deshacen

| # | Caso | Qué comprueba |
|---|---|---|
| 1 | Cita del bot con paso a persona; cita manual ligada; reserva pública | La primera no es U2; la manual no es resultado del bot; la pública solo es U3 |
| 2 | Respuesta de una persona sin transición; conversación en modo humano desde antes | Ambas son intervención humana; ninguna aparece abandonada |
| 3 | Turno anterior al periodo; persona antes que el bot; respuesta tardía; sin respuesta; turno al final del periodo | 5 turnos clasificados bien; mediana de 45 s |
| 4 | Ventana abierta | Queda «en curso»; sin turnos del bot la mediana es NULL |
| 5 | Seguimiento desde el 11 oct; cita fuera del periodo; cita completada sin precio; cliente sin seguimiento | Q7 aplica el seguimiento y el periodo, devuelve **NULL** si falta el precio y no da filas sin seguimiento |
| 6 | Dos turnos de ejecución de la misma conversación con un solo mensaje registrado | Q1 cuenta 1, no 2 (uno a uno) |
| 7 | Sin mapeos; mapeos sin turnos; mapeo incompleto; ejecución de **otro tenant** | Q1b separa los dos motivos y no cuenta otros tenants; Q8 tampoco |
| 8 | Contraste completo; aparece un workflow de mantenimiento; aparece uno conversacional sin mapeos; muestra pequeña | El de mantenimiento **no** bloquea; el conversacional sin mapeos sí; con un mínimo mayor da `muestra_insuficiente` |
| 9 | Respuestas de ejecución no registradas | `por_debajo_del_umbral` (0 % medido) |
| 10 | Ejecuciones sin respuesta capturada | Proporción **NULL**, no 0 %, y no habilitable |
| 11 | Cliente sin ejecuciones ni mensajes | Sin filas: no habilitable |
| 12 | Mensajes reportados sin ejecuciones; cliente con solo mantenimiento | `sin_ejecuciones_para_contrastar`; sin workflows conversacionales no se habilita |
| 13 | Reserva de octubre para noviembre; reserva de septiembre atendida en octubre; canal sin precios | Q4a y Q4b separan los casos; el valor es NULL o parcial |
| 14 | Sin reservas; reserva sin precio | Q5: 0 medido frente a NULL desconocido |

### 6.3 Mutaciones: las 20 detectadas

| Error reintroducido | Detectado por |
|---|---|
| Aceptar como resultado del bot cualquier cita | prueba 1 |
| Clasificar el resultado antes que la intervención | prueba 1 |
| Ignorar los mensajes del equipo | prueba 2 |
| Calcular `lag` solo en el periodo | prueba 3 |
| Cualquier mensaje del bot posterior | pruebas 2 y 3 |
| Sin ventana | prueba 3 |
| Ignorar el seguimiento | prueba 5 |
| Sumar citas de cualquier fecha | prueba 5 |
| Calcular Q4b por fecha de creación | prueba 13 |
| Emparejamiento múltiple en Q1 | prueba 6 |
| Un solo motivo en Q1b | prueba 7 |
| Q1b sin filtro de tenant | prueba 7 |
| Q8 sin filtro de tenant | prueba 7 |
| Q4a con desconocido convertido en 0 | prueba 13 |
| Q5 con desconocido convertido en 0 | prueba 14 |
| Q7 con desconocido convertido en 0 | prueba 5 |
| Q9 con proporción desconocida como 0 % | prueba 10 |
| Q9 habilitando sin mirar los demás workflows | prueba 8 |
| Q9 contando también los workflows no conversacionales | prueba 8 |
| Q9 sin exigir ejecuciones para contrastar | prueba 12 |

**Lo que no comprobé:** datos de producción (no los consulté, según lo pedido) ni qué workflows de producción tienen mapeos o reportan mensajes.

## 7. Comprobación acotada en producción (pendiente; no ejecutada)

1. **Contraste automático, de solo lectura:**
   - Q0, Q1, Q1b y Q9 para **un** cliente y **un** periodo (14 días);
   - la ejecuta quien tenga acceso de lectura, con **autorización expresa**;
   - parámetros de partida (no son una certificación): `ventana` 30 min, `tolerancia` 2 min, `umbral` 0,95, `minimo` 50.
2. **Revisión manual.**
   - **Lista de workflows:** primero se **confirma** qué workflows son conversacionales; los que Q9 marca como `no_conversacional` deben serlo de verdad.
   - **Muestra:** luego se revisan 20 ejecuciones elegidas al azar de cada workflow de atención. Para cada una:
   - ¿están el mensaje del cliente y la respuesta del bot en la conversación correcta de la plataforma?
   - ¿la diferencia de hora cabe en la tolerancia?
   - ¿la clave de conversación es la misma en ambos lados?
3. **Criterio, fijado antes de mirar los datos:** se habilita solo si Q9 da `habilitable` y la muestra manual tiene ≥ 95 % de casos correctos (19 de 20). Si no, primero se corrige el workflow.
4. **Registro:** el resultado, con fecha, responsable y versión de la metodología, se guarda como la «revisión manual aprobada» de §5.2.
5. **Citas:** se mide el porcentaje de citas del bot con `source_conversation_id`, que condiciona U2.

## 8. Alcance de V1

**Siempre que haya datos:**
- reservas creadas por canal (Q4a) y servicios del periodo (Q4b), con el valor desconocido o parcial indicado;
- reservas del bot fuera del horario semanal (Q5);
- gestiones del bot (Q6);
- cohorte de clientes nuevos (Q7 / Q7s);
- salud de las automatizaciones (Q8).

**Solo con evidencia habilitada (§5.2):** conversaciones por clase (Q2), turnos y tiempo de respuesta (Q3), y U1/U2 en el tiempo.

**Estimación** (solo con supuestos confirmados): tiempo liberado y su valor, con la fórmula visible e indicando qué unidades incluye.

**Para la agencia:** el estado de la evidencia (Q1, Q1b, Q9) por workflow.

## 9. Cómo reproducir las pruebas

**Requisitos:**
- **PostgreSQL local** con el esquema del repositorio migrado hasta la 1808 (`npx node-pg-migrate up --tsx` contra una base vacía).
- **Una copia del repositorio** con sus dependencias instaladas (`REPO`), para usar su paquete `pg`.

**Pasos.** Desde la carpeta `entrega-dashboard-valor/`:

```bash
export REPO=/ruta/al/repo
export DATABASE_URL=postgres://usuario:clave@127.0.0.1:PUERTO/mai_booking_test
node --test pruebas/consultas.test.mjs
```

```bash
M=$(mktemp -d) && python3 pruebas/mutaciones.py "$M" && for f in "$M"/*.sql; do echo "$(basename "$f")"; SQL_FILE="$f" node --test pruebas/consultas.test.mjs 2>&1 | grep -c '^not ok'; done
```

**Resultado esperado:**
- **La primera orden:** `# pass 14`, `# fail 0`.
- **La segunda:** cada mutación muestra un número **mayor que 0** (al menos una prueba falla).

**Cuidados:**
- **Base:** la suite se niega a correr si la base no es local o no se llama `mai_booking_test`.
- **Datos:** cada escenario se crea y se deshace en su propia transacción.

**Huellas de los archivos de esta versión:** al final del informe de entrega van sus SHA-256, para comprobar que se revisan los archivos completos.
