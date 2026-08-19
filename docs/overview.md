# Qué es esta plataforma

> Documento de orientación para alguien (o alguna IA) que llega al repo sin
> contexto. Explica **qué hace el producto y por qué**, no cómo está codeado.
> Para el modelo de datos: [`docs/schema.md`](schema.md). Para correrlo:
> [`README.md`](../README.md).

## En una frase

Una plataforma **multi-tenant** que empezó observando automatizaciones de
[n8n](https://n8n.io/) y hoy es además el **sistema de registro operativo** de
negocios de servicio con cita previa: agenda, contactos y la bandeja donde un
humano toma el control de una conversación que llevaba un bot.

## El problema que resuelve

Un negocio pequeño de servicio presencial —una barbería, un salón— pone un bot de
WhatsApp para atender y agendar. Con n8n eso se construye rápido, pero deja tres
huecos que n8n no cubre y que la operación sí necesita:

1. **No se ve qué pasó.** Las ejecuciones de n8n son un log técnico, no una
   conversación. Nadie del negocio puede abrir n8n y entender qué le dijo el bot a
   un cliente.
2. **El bot se atasca y no hay relevo.** Cuando la conversación se sale del guion
   hace falta que una persona entre en el mismo hilo, sin perder historial y sin
   que el bot siga contestando por encima.
3. **La agenda vive en dos lados.** Si el bot agenda contra un Google Calendar y
   el mostrador agenda a mano, se reservan dos personas en el mismo horario. Con
   volumen, eso pasa **siempre**.

La plataforma cierra los tres. El tercero es el que define su arquitectura: aquí
**la agenda es la fuente de verdad**, y el doble booking es *estructuralmente
imposible* — lo bloquea Postgres con una constraint de exclusión, no una
validación de aplicación que se puede ganar en una carrera.

## Las cinco capacidades

### 1. Observabilidad de n8n (el origen)

Un worker consulta cada instancia n8n conectada en intervalos y guarda las
ejecuciones. El principio central: **cero especificidad de workflow en el esquema
o en el código**. El payload completo se guarda intacto y el significado se
configura por fuera.

- `executions.raw_data` guarda el JSON completo tal como vino.
- **`field_mappings`** es config del usuario que le da significado: apunta a una
  ruta dentro de `raw_data` y dice "esto es una columna llamada X" o "esto es el
  mensaje del usuario".
- De ahí se **derivan** los turnos de conversación (`conversation_turns`),
  reconstruibles desde cero en cualquier momento.

Consecuencia práctica: **conectar un workflow nuevo no requiere tocar código ni
migrar la base.** Alguien configura los mapeos en la UI y el workflow queda
visible.

### 2. Inbox y handoff humano

Cada conversación es una entidad **con estado** y una máquina de tres modos:

```
bot ──────► pending ──────► human
 ▲                            │
 └────────────────────────────┘
```

- **`bot`** — el workflow contesta solo.
- **`pending`** — algo pidió escalar (el propio workflow, una regla de la
  plataforma, o un agente). Está esperando que un humano lo tome.
- **`human`** — hay un agente asignado y el bot se calla.

Cada mensaje es un evento de primera clase, con dedup por id externo para que un
reintento del webhook no duplique nada. Cada cambio de modo deja rastro en una
tabla de auditoría con **quién** y **por qué**.

Dos detalles que suelen sorprender:

- **ACTIVE / INACTIVE se calcula en cada lectura**, no es un flag guardado. No hay
  cron, no hay drift.
- La invariante "hay agente asignado si y solo si el modo es `human`" **no** es un
  CHECK de base de datos, a propósito: pelearía con el `ON DELETE SET NULL` del
  agente y bloquearía borrar usuarios. Vive en la función de transición.

### 3. CRM

La pieza conceptual que sostiene todo lo demás: **la persona es una entidad
distinta de la conversación**. Una persona tiene muchas conversaciones y muchas
citas.

Lo verdaderamente no obvio es **cómo se la reconoce**. Un mismo cliente llega como
un `wa_id` de WhatsApp, como un teléfono tecleado en el formulario de reserva, y
como un email. Guardar eso en columnas escalares (`phone`, `email`) hace que sean
**tres contactos distintos** — duplicación por diseño.

La solución es `contact_identities`: una fila por cada forma de reconocer a la
persona, con el valor **normalizado** (E.164 para teléfonos, minúsculas para
emails) y un `UNIQUE` que hace **imposible el duplicado en el INSERT**, no en una
limpieza posterior. Un `wa_id` y un teléfono tecleado normalizan al mismo valor y
por lo tanto resuelven al **mismo contacto**.

Un solo punto del código decide esa resolución (`resolveContactByIdentity`), y es
**ciego al canal**: clasifica por el *valor*, nunca por la etiqueta de origen. Si
dos contactos existentes colisionan, **gana el más antiguo** y el otro queda
registrado como candidato a fusión. **Nunca fusiona solo** — unir dos personas es
una decisión humana.

Encima de eso: notas, tareas de seguimiento, etiquetas por negocio, timeline, y
**campos a medida** que cada negocio define sin migración ni código
(`client_field_definitions`, el análogo CRM de los `field_mappings`).

**Lo que deliberadamente no tiene:** companies, deals ni pipelines. No es un CRM de
ventas B2B; es la ficha operativa de una persona que entra a un local.

### 4. Scheduling

Sedes, empleados, servicios y citas, con disponibilidad **calculada** (no hay tabla
de slots) a partir de horarios de apertura, horarios por empleado, excepciones,
buffers, aviso mínimo y horizonte de reserva.

**La garantía central** es una constraint de exclusión GiST en `appointments`:

```sql
EXCLUDE USING gist (staff_id WITH =, tstzrange(blocked_from, blocked_until) WITH &&)
  WHERE (status IN ('scheduled', 'confirmed'))
```

Dos reservas concurrentes para el mismo empleado y horario: **exactamente una
commitea**; la otra recibe un error de Postgres que la API traduce a HTTP 409. No
es un `SELECT` y después un `INSERT` —que se puede perder en una carrera— sino una
garantía que vive en el motor. Hay un test de concurrencia real que lo verifica.

Decisiones que se leen raro en el esquema y tienen razón de ser:

- **Snapshots.** Nombre, duración, precio y buffers del servicio se **copian** a la
  cita al reservar. Editar el catálogo después no puede mutar una cita histórica.
- **Cancelar no borra.** El estado pasa a `cancelled` y el `WHERE` parcial de la
  constraint libera el horario. El historial queda.
- **Dos intervalos por cita.** El que ve el cliente (`start_at` → `service_end_at`)
  y el que bloquea la agenda (servicio **más** buffers). El segundo es el que usa
  la constraint.
- **`sites.slug` es único global**, no por tenant, para que la página pública
  `/book/{slug}` resuelva sin exponer un id de tenant en la URL.
- **Lo derivable no se guarda.** La antigüedad de un empleado sale de su
  `start_date` (guardar "3 años" garantiza estar mal dentro de un año); "es
  cliente" sale de tener ≥1 cita completada.

### 5. API para máquinas

Es la superficie por la que n8n *entra* a la plataforma. Autenticación por
**Bearer token por conexión**, con capacidades explícitas y **deny-by-default**:

| Capacidad | Permite |
|---|---|
| `handoff` | Empujar mensajes, escalar, cambiar modo |
| `scheduling.read` | Consultar sedes, servicios, empleados, disponibilidad |
| `scheduling.write` | Crear, reprogramar, cancelar y cerrar citas |
| `crm.read` | Leer contactos |
| `crm.write` | Crear/actualizar contactos, notas y etiquetas |

Del token solo se guarda el **hash SHA-256** más un prefijo de 8 caracteres para
mostrarlo; el token en claro se devuelve una única vez al emitirlo. Un token
grantea **solo** lo que lista: nunca hay comodín.

Además del token, cada request debe traer un header `X-Workflow-Ref` (el id del
workflow que llama). De ahí se resuelve a qué negocio pertenece la llamada — el
tenant y el cliente **nunca** se envían en el body. Es lo que hace que un workflow
no pueda tocar datos de otro negocio ni por error ni a propósito.

## Cómo se conecta con n8n — tres caminos, no uno

Es la parte que más confunde al llegar, porque los tres coexisten:

| Camino | Dirección | Para qué |
|---|---|---|
| **Polling** | plataforma → n8n | El worker consulta ejecuciones cada `POLL_INTERVAL_SECONDS`. Es la observabilidad. |
| **Webhook saliente** | plataforma → workflow | Cuando un agente humano escribe, la plataforma hace POST firmado con HMAC al webhook del workflow, que lo entrega al cliente final. |
| **API entrante** | workflow → plataforma | El workflow empuja mensajes, escala, y agenda citas usando su Bearer token. |

Detalle deliberado: el secreto del webhook se guarda **cifrado**, no hasheado,
porque hay que *usarlo* para firmar cada body saliente. El token entrante se
guarda **hasheado**, porque solo hay que *verificarlo*. No es una inconsistencia.

## Modelo de tenencia — dos niveles, no uno

Es lo primero que hay que entender para leer cualquier query del repo:

```
tenants (la cuenta)
   └── clients (un NEGOCIO dentro de la cuenta)
          ├── client_modules   ← qué superficies existen para este negocio
          ├── workflows        ← todo workflow tiene exactamente un negocio
          ├── contacts, sites, services, appointments...
```

- **`tenant_id`** es la cuenta: el techo de todo.
- **`client_id`** es el negocio dentro de la cuenta. Una agencia puede tener varios
  negocios en un solo tenant, y sus datos **no se mezclan**.
- Casi toda tabla de dominio lleva **las dos** columnas, y la pertenencia se fuerza
  con **FKs compuestas** (`(client_id, tenant_id) → clients(id, tenant_id)`): una
  fila no puede apuntar al negocio de otro tenant aunque la aplicación se
  equivoque. No hay Row-Level Security; el aislamiento es *estructural*.

### Roles

| Rol | Alcance |
|---|---|
| `owner` | Creador del tenant. Todo. |
| `admin` | Todo dentro del tenant. |
| `member` | **Duro-limitado a UN solo negocio.** Solo ve los datos de ese `client_id`. |

La invariante "`member` ⟺ tiene negocio asignado; `owner`/`admin` ⟺ no lo tiene"
está impuesta por un CHECK, y que el negocio asignado sea *del mismo tenant* está
impuesto por una FK compuesta. Las invitaciones guardan solo el hash del token, son
de un solo uso y expiran.

### Módulos por negocio

Cada negocio enciende solo lo que usa: **`crm`**, **`scheduling`**, **`inbox`**. La
**ausencia de fila significa deshabilitado**; una fila apagada conserva los ajustes
para cuando se vuelva a encender. La navegación y las APIs se cierran solas según
esto — un módulo apagado no es solo un link oculto, es un 403.

## Las superficies

**Internas** (requieren sesión):

| Superficie | Para qué |
|---|---|
| Clientes / Workflows | Los negocios, sus workflows y sus ejecuciones |
| Analytics | Métricas por workflow o agregadas |
| Inbox | La bandeja de conversaciones, con el handoff |
| Contactos | Lista, ficha, timeline, campos a medida |
| Agenda | La agenda de citas por sede |
| Staff | El roster de empleados y sus servicios |
| Scheduling admin | Sedes, servicios, horarios, excepciones |
| Equipo / Ajustes | Miembros, invitaciones, conexiones n8n, tokens máquina, seguridad |

**Públicas** (sin sesión): la página de reserva en `/book/{slug}`, y su API de
disponibilidad y reserva.

**Realtime sin WebSocket.** La plataforma no tiene socket: los cambios se propagan
por *polling* contra un feed append-only (`scheduling_events`) con un cursor
`bigint`. Si un cliente se pierde un evento, un refresh relee las tablas
autoritativas — el feed es una *pista*, no la fuente de verdad.

## Arquitectura en dos procesos

Dos procesos independientes, una base de datos, **una sola capa de acceso a datos**:

```
┌──────────────────────────┐     ┌──────────────────────────┐
│  Worker de ingesta        │     │  App web (Next.js)       │
│  (src/, proceso tsx)      │     │  (web/)                  │
└────────────┬─────────────┘     └────────────┬─────────────┘
             │   los dos importan el mismo    │
             └──────────►  src/db  ◄──────────┘
                    (pool pg, repositorios, tipos)
                             │
                     PostgreSQL (una sola BD)
```

El worker hace el polling e ingesta. La app web sirve todas las superficies y
todas las APIs. **No hay lógica de datos duplicada**: la app web importa los
repositorios del worker directamente, así que hay un solo juego de tipos de fila y
una sola definición de cada query. En producción se despliegan como dos servicios
desde este mismo repo.

## Principios de diseño (por qué el código se ve así)

Estos cinco explican la mayoría de las decisiones que de otro modo parecen raras:

1. **La semántica es configuración, no código.** `field_mappings` y
   `client_field_definitions` existen para que conectar un workflow o agregar un
   campo no sea una migración.
2. **Si se puede calcular, no se guarda.** Un flag almacenado garantiza estar
   desactualizado. "Es cliente", ACTIVE/INACTIVE, la antigüedad y la disponibilidad
   se derivan en tiempo de lectura.
3. **Las garantías viven en Postgres.** Anti-doble-booking, unicidad de identidad,
   idempotencia de ingesta y aislamiento entre negocios son constraints, no
   validaciones de aplicación que una carrera pueda ganar.
4. **Un solo punto de decisión.** Resolver identidad, resolver el alcance de un
   workflow, autenticar una máquina: cada uno tiene *un* chokepoint. Ninguna
   ramificación duplicada.
5. **Nada se borra en silencio.** Cancelar cambia estado. Fusionar guarda un
   snapshot. Las notas tienen borrado suave. Borrar un usuario suelta la
   atribución, nunca el historial.

## Estado actual y límites honestos

Es un **MVP en desarrollo activo**, no un producto cerrado. Lo que hay que saber:

- **Hay columnas que se escriben y nadie lee todavía.** El consentimiento de
  mensajería es *store-only* por diseño; `do_not_contact` y `preferred_channel` los
  guarda el formulario pero **ningún camino de envío los respeta aún** (la
  supresión aterriza cuando exista el sender).
- **Hay contactos legacy sin filas de identidad**, anteriores a la espina. Requieren
  un backfill manual que existe y es idempotente. Es la deuda que más
  probablemente muerda.
- **Hay un tipo de evento definido y nunca emitido** (`schedule.changed`) y tipos de
  evento de cita sin productor.
- **No hay recordatorios.** Nada notifica al cliente final de su cita.
- **No hay DST real en los tests**: Colombia no tiene cambio de hora, así que ese
  camino está sin ejercitar de punta a punta.

El inventario completo, con el detalle de cada punto, está en
[`docs/schema.md`](schema.md) § *Deuda conocida* y en
[`docs/crm-scheduling-audit.md`](crm-scheduling-audit.md) § G.

## Por dónde seguir

| Documento | Qué cubre |
|---|---|
| [`README.md`](../README.md) | Setup, cómo correrlo, scripts, variables de entorno |
| [`docs/schema.md`](schema.md) | El modelo de datos completo: 40 tablas, diagramas ER, constraints, deuda |
| [`docs/scheduling-v1.md`](scheduling-v1.md) | Scheduling a fondo: API n8n, ejemplos, cómo probar una carrera de doble reserva |
| [`docs/machine-api-v1.md`](machine-api-v1.md) | La API máquina y el modelo de capacidades |
| [`docs/handoff-contract-v1.md`](handoff-contract-v1.md) | El contrato de handoff con los workflows |
| [`docs/scheduling-openapi.yaml`](scheduling-openapi.yaml) | Spec OpenAPI (⚠️ no documenta el header obligatorio `X-Workflow-Ref`) |
| [`docs/crm-scheduling-audit.md`](crm-scheduling-audit.md) | Auditoría profunda de CRM + scheduling |
