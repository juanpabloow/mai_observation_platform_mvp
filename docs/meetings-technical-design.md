# Reuniones — diseño técnico (revisión 5)

**Nada implementado.** Sin migraciones, sin infraestructura, sin secretos, sin
archivos borrados, sin consultas a Railway. **W-1 y T-1 no autorizados.**

Revisión 5: cálculo de tamaños **medido** en datos históricos, un único camino de
ingesta, heartbeat fuera del historial, D-10/D-11/D-12 cerradas.

Documento hermano: `docs/meetings-worker-inconsistencies.md`.

---

## 0. Arquitectura cerrada (D-1, topología A)

`mai` es dueño del dominio Meetings, **única fuente de verdad PostgreSQL**,
**broker de trabajos**, y responsable de tenants, clients, permisos,
asociaciones, transcripts, análisis, citas y estados finales.

**Transcript-Project no tendrá una segunda base de dominio en producción.**
"Proyecto independiente" significa independencia de **despliegue y repositorio**:
su código vive en su repo y se reutiliza su pipeline de ML. (Corrección de una
mala lectura mía en la revisión 3, que llegó a plantear topologías B y C
inexistentes; retiradas.)

```
┌────────────────────────────────────────────────────────────────────────┐
│ BROWSER · UI Reuniones — se conserva │
└───┬───────────────────────────────────────────────────────▲───────────┘
    │ crear reunión → signed PUT · leer dominio │
    ▼ │
┌────────────────────────────┐ ┌──────────────────────────────────┐
│ mai (Railway) │───────▶│ PostgreSQL de mai │
│ web · Server Actions │ │ ÚNICA FUENTE DE VERDAD │
│ /api/meetings/v1 (broker) │◀───────│ dominio · runs · jobs · pools │
│ worker · leases, retención│ └──────────────────────────────────┘
└──────────┬─────────────────┘
           │ firma URLs
           ▼
   ┌────────────────────┐
   │ R2 PRIVADO │
   │ audio · artefactos│
   └──┬──────────▲──────┘
      │ GET │ PUT
┌─────┼──────────┼──────────────────────────────────────────────────────┐
│ RUNTIME GPU EXTERNO — Ubuntu/LAN hoy · proveedor GPU después │
│ OUTBOUND-ONLY: sin puertos entrantes, sin acceso a la base │
│ reclama meetings.transcribe Y meetings.analyze (D-10) │
│ descarga de R2 · procesa · sube artefacto · confirma en mai │
└──────────────────────────────────────────────────────────────────────┘
```

Railway nunca ejecuta Whisper Medium ni pyannote en CPU.

---

## 1. Tamaño real de un transcript — medido (corrección 1)

Mi cifra anterior ("15 000–25 000 segmentos, 5–15 MB") era **inventada y
errónea**: 4,2 segmentos/min × 240 min = 1 008, no 15 000. La medición corrige el
orden de magnitud en ~50×.

### 1.1 Método

La base `transcript_app` (`192.168.1.15:5432`) **no es alcanzable** desde aquí, así
que la medición se hizo sobre los **artefactos en disco** de
`Transcript-Project/uploads/processed/`, en solo lectura, sin modificar nada.

Para cada reunión se leyó `segments.json` (o `transcript.json`) y se calculó el
tamaño del **NDJSON canónico**: una línea por segmento con exactamente los campos
que `mai` persiste (`index, start, end, speaker, text`), más su tamaño con gzip -6.

### 1.2 Datos

```
id duración segs seg/min json orig NDJSON gzip
35f68b67 0:30:03 205 6.8 21 KB 10 KB 2 KB
69d9232c 0:30:03 205 6.8 21 KB 10 KB 2 KB
f2d98435 0:30:03 205 6.8 21 KB 10 KB 2 KB
aa061453 0:07:02 67 9.5 13 KB 9 KB 3 KB
e80fb399 0:07:02 67 9.5 13 KB 9 KB 3 KB
2c20c1d5 0:07:03 20 2.8 2 KB 1 KB 0 KB
e86957cc 0:01:59 16 8.1 3 KB 2 KB 1 KB
ebb475ce 0:01:59 27 13.6 3 KB 1 KB 0 KB
3ee65db7 0:01:18 14 10.7 3 KB 2 KB 1 KB
570fcf20 0:01:18 14 10.7 3 KB 2 KB 1 KB
```

| Métrica | p50 | p95 | máximo |
|---|---|---|---|
| Duración | 7:02 | 30:03 | **30:03** |
| Segmentos | 27 | 205 | **205** |
| Segmentos/min | 8,1 | 10,7 | **13,6** |
| NDJSON | 2 KB | 10 KB | **10 KB** |
| NDJSON gzip | 1 KB | 3 KB | **3 KB** |

**Reunión mayor disponible: 30 min 03 s, 205 segmentos, 10 KB de NDJSON.**

### 1.3 Extrapolación a 4 horas

Con la tasa **máxima** observada (13,6 seg/min), no la media:

| | 4 h (14 400 s) |
|---|---|
| Segmentos | ≈ **3 274** |
| NDJSON | ≈ **158 KB** |
| NDJSON gzip | ≈ **53 KB** |

### 1.4 Límites de esta medición

Hay que decirlo antes de usarla: **n = 10 ficheros, ~5 grabaciones distintas.**
Tres comparten exactamente 205 segmentos y 30:03 —es el mismo audio procesado con
backends distintos—, y otros dos pares también. La reunión más larga es de 30
min, así que **las cuatro horas son extrapolación, no observación**. El corpus
histórico real está en la base LAN y no se consultó.

Consecuencia honesta: la extrapolación es útil para descartar un orden de
magnitud (no son megabytes), **no** para dimensionar al byte. Y basta para eso.

### 1.5 Qué cambia en el diseño

Un transcript de 4 h son ~**158 KB**, ~**53 KB** comprimido. Eso elimina dos
cosas que la revisión 4 justificaba con cifras falsas:

- **Fuera el troceado en partes.** 53 KB caben en un solo objeto. `PUT` por
  partes era una solución a un problema que no existe.
- **Fuera el umbral de 1 MB.** No hay dos caminos que elegir (corrección 2).

Lo que **no** cambia: el soporte a reuniones de 4 h se mantiene, y la ingesta
sigue siendo por artefacto. La justificación ya no es el tamaño (§2).

---

## 2. Un único camino canónico de ingesta (corrección 2)

Transcript y segmentos **siempre** viajan por el mismo mecanismo, sin umbrales:

```
1. POST /jobs/{id}/result/init
     { schema_version, kind:"transcript",
       segment_count, bytes, bytes_gzip, checksum_sha256 }
   → { upload_id, put_url, expires_at }

2. PUT put_url ← UN objeto: NDJSON + gzip
     Content-Type: application/x-ndjson
     Content-Encoding: gzip

3. POST /jobs/{id}/result/complete
     { upload_id, checksum_sha256, bytes }
   → mai: descarga · verifica checksum y tamaño · valida contra el JSON Schema
          de `schema_version` · ingiere en UNA transacción · crea la versión
```

### 2.1 Por qué el artefacto, si son 53 KB

La justificación **no** es el tamaño. Son cinco razones que se sostienen a
cualquier tamaño:

1. **Un solo camino.** Un umbral significa dos rutas de persistencia, dos
   historias de idempotencia y dos sitios donde equivocarse. Con una sola, el
   caso de 30 s y el de 4 h se prueban con el mismo test.
2. **Integridad de punta a punta.** El artefacto es un objeto con checksum
   verificable **independientemente del HTTP**. Un body JSON no lo es: si el
   proxy lo trunca, `mai` recibe algo sintácticamente inválido y no sabe si
   faltó o nunca existió.
3. **Reintento barato.** Si `complete` falla, el artefacto **ya está en R2**: el
   reintento no reenvía nada. Con body inline, cada reintento retransmite todo.
4. **Artefacto auditable.** El diseño ya necesitaba `raw_result_key` para
   depurar. El artefacto canónico **es** ese objeto: no hay una copia para
   ingerir y otra para diagnosticar.
5. **Desacople de los límites de `mai`.** El worker no necesita saber el tamaño
   máximo de body, el timeout del proxy ni la memoria del runtime. Hoy caben 53
   KB; el día que un modelo con timestamps por palabra multiplique los segmentos
   por 10, el contrato no cambia.

### 2.2 Qué sí viaja inline

Solo lo pequeño y no canónico: **progreso** y **metadata del job**. Concretamente
`heartbeat` (etapa, porcentaje, métricas), el `summary` de `result/init`
(duración, idioma, modelo, backend) y el cuerpo de `fail`. Nunca segmentos.

### 2.3 Consecuencia en el esquema

`meeting_result_uploads` se simplifica: **una fila por artefacto**, no por parte.

```sql
CREATE TABLE meeting_result_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  client_id uuid NOT NULL,
  job_id uuid NOT NULL,
  attempt smallint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transcript','analysis','raw')),
  schema_version smallint NOT NULL,
  r2_key text NOT NULL UNIQUE,
  bytes bigint,
  checksum_sha256 text,
  segment_count integer,
  state text NOT NULL DEFAULT 'awaiting_upload'
                   CHECK (state IN ('awaiting_upload','uploaded','verified','ingested','rejected')),
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz,
  CONSTRAINT ru_job_fkey FOREIGN KEY (job_id, tenant_id, client_id)
    REFERENCES meeting_processing_jobs (id, tenant_id, client_id) ON DELETE CASCADE,
  CONSTRAINT ru_attempt_unique UNIQUE (job_id, attempt, kind)
);
```

`UNIQUE (job_id, attempt, kind)` es la idempotencia: un `init` repetido para el
mismo intento devuelve la misma fila y la misma `put_url`, no crea otra.

---

## 3. Heartbeat fuera del historial (corrección 3)

Un heartbeat cada 30 s por job durante 4 h son **480 filas por reunión**. Con 100
reuniones/mes eso son 48 000 filas de ruido que no responden ninguna pregunta.

**El heartbeat actualiza el job, no escribe historia:**

```sql
-- en meeting_processing_jobs
last_heartbeat_at timestamptz,
lease_expires_at timestamptz,
progress_pct smallint,
last_progress_at timestamptz -- para el muestreo de §3.1
```

`meeting_job_events` registra **solo** hechos:

| `kind` | Cuándo |
|---|---|
| `claimed` | el worker reclama (con `credential_id`) |
| `state_changed` | transición de etapa o de estado del job |
| `progress` | **muestreado**: §3.1 |
| `retried` | reintento con su `attempt` y `next_attempt_at` |
| `lease_expired` | el barrido lo devuelve a la cola |
| `cancelled` | cancelación de una persona |
| `failed` | fallo con `failure_code` |
| `result_ingested` | artefacto verificado e ingerido |

### 3.1 Muestreo de progreso

Se escribe un evento `progress` solo si **alguna** condición se cumple:

- el porcentaje cruzó un múltiplo de **10 %** desde el último evento; o
- han pasado más de **5 min** desde `last_progress_at`; o
- la etapa cambió.

Para una reunión de 4 h eso son ~10–15 eventos en vez de 480, y sigue
respondiendo "¿se quedó colgado?" con granularidad suficiente.

---

## 4. D-10 · CERRADA — runtime del análisis

El runtime adaptado de Transcript-Project reclama **ambas** capacidades:

- `meetings.transcribe` — normalize, transcribe, diarize (trabajo de GPU);
- `meetings.analyze` — análisis con LLM, reutilizando su integración existente.

Puede ser el mismo proceso o dos dentro del mismo runtime, pero con
**capacidades y concurrencia independientes**. En el esquema:

```sql
-- worker_pools
capabilities text[] NOT NULL DEFAULT '{}', -- {'meetings.transcribe','meetings.analyze'}
concurrency jsonb NOT NULL DEFAULT '{}'::jsonb
  -- { "meetings.transcribe": 1, "meetings.analyze": 4 }
```

`concurrency` pasa de `smallint` a `jsonb` **por capacidad**: la GPU admite un
job a la vez, pero el análisis es I/O contra un LLM y admite varios. Con un solo
número, o se desaprovecha el LLM o se satura la GPU.

`claim` respeta el límite por capacidad: si ya hay un `transcribe` en vuelo para
esa credencial, entrega `analyze` si hay, y `204` si no.

Mover `analyze` a otro worker después es emitir una credencial en un pool con
solo esa capacidad. **Cero cambios de contrato ni de dominio** — es exactamente
lo que el diseño garantiza.

---

## 5. D-11 · CERRADA — sin poda automática

**No se poda nada.** Versiones de transcript y análisis se conservan para
auditoría y para no romper citas históricas. **Ningún `DELETE` automático.**

### 5.1 Métricas de almacenamiento

En vez de podar, se mide. Vista de solo lectura sobre lo que ya existe:

| Métrica | Fuente |
|---|---|
| Bytes de audio por tenant/client | `SUM(meeting_media.bytes) WHERE deleted_at IS NULL` |
| Segmentos por tenant | `COUNT(*)` sobre `meeting_segments` vía `transcript_versions` |
| Versiones por reunión | `COUNT(*)` sobre `meeting_transcript_versions` |
| Versiones **no activas** | las que no son `active_transcript_id` |
| Bytes de artefactos | `SUM(meeting_result_uploads.bytes)` |
| Crecimiento mensual | agregado por `created_at` |

Alertas por umbral configurable, no borrado.

### 5.2 Política de archivo futura — diseñada, no activa

Una versión **solo** podrá archivarse o eliminarse si se cumplen las **cuatro**:

1. **no está activa** (`active_transcript_id`/`active_analysis_id` no la apuntan);
2. **nada la referencia**: ninguna cita, reporte, tarea ni mensaje de chat;
3. **cumple la política de retención** vigente del tenant/client;
4. **la operación queda auditada** (quién, cuándo, qué, cuántos bytes).

La condición 2 es comprobable en SQL sin heurística, porque las FK ya existen:
una versión referenciada no se puede borrar ni por error —`ON DELETE CASCADE`
protege la integridad, y la comprobación previa protege el dato.

Nada de esto se implementa en el MVP. Queda como diseño para cuando las métricas
de §5.1 digan que hace falta.

---

## 6. D-12 · No bloquea el MVP

El audio original **se conserva por defecto, sin borrado automático**. La
configuración de retención **existe en el esquema pero queda desactivada** hasta
que exista política legal:

```json
{ "meetings": { "retention": {
    "enabled": false, // ← interruptor maestro, apagado
    "original_audio_days": null, // null = conservar siempre
    "derived_days": 7, // D-2, solo si enabled = true
    "derived_days_on_failure": 7
} } }
```

Con `enabled: false` el barrido **no calcula `delete_after` para nada**. Los
campos `delete_after`/`deleted_at` de `meeting_media` quedan nulos. Encender la
retención después es cambiar un booleano, no una migración.

---

## 7. Alcance del MVP — vertical slice

Las trece capacidades acordadas, sin cambios:

| # | Capacidad | Sostenida por |
|--:|---|---|
| 1 | Crear y subir una reunión | `meetings`, signed PUT |
| 2 | Guardar audio en R2 privado | `meeting_media` + bucket privado |
| 3 | Crear y reclamar un job con lease | `meeting_processing_jobs`, `worker_pools`, `worker_credentials` |
| 4 | Procesar con el GPU worker | contrato `/jobs/*` |
| 5 | Persistir transcript y segmentos versionados | `meeting_transcript_versions`, `meeting_segments` |
| 6 | Renombrar participantes sin perder cambios al reprocesar | `meeting_speakers` + `meeting_transcript_speakers` |
| 7 | Generar resumen/análisis estructurado | `meeting_analyses`, `meeting_findings`, `meeting_next_steps`, `llm_calls` |
| 8 | Relacionar findings con citas verificables | `meeting_citations`, `meeting_finding_citations` |
| 9 | Abrir una cita en el minuto del transcript/audio | `citations.segment_id` + signed GET con `Range` |
| 10 | Asociar con contactos, conversaciones y citas de agenda | `meeting_contacts`, `meeting_conversations`, `meeting_appointments` |
| 11 | Reprocesamiento inmutable | `meeting_processing_runs` + punteros `active_*` |
| 12 | Fallos parciales y "Completada con avisos" | cuatro máquinas de estado + `meetings.warnings` |
| 13 | Reuniones de hasta 4 horas | artefacto canónico (§2), medido en §1 |

**Evidencia está dentro del MVP.** Reportes y Copilot aparecen vacíos o
deshabilitados, con estados que la UI ya tiene construidos.

**Fuera:** Copilot · reportes personalizados · importación histórica · varios
proveedores LLM simultáneos · allowlists de tenants · UI administrativa avanzada
· poda o archivo de versiones.

El valor `allowlist` de `worker_pools.scope` **no existe** en M-3: sólo
`internal` y `single_tenant`, con `single_tenant` como defecto. Se añadirá en
M-11, en la misma migración que crea `worker_pool_tenants`. Un valor de enum
cuyo mecanismo de resolución no existe no es una función pendiente: es un pool
que el claim no sabe atender, y del que alguien acabará "arreglando" el claim
tratándolo como `internal` — la falla de aislamiento entre tenants. El primer
pool interno **sí** exige autorización explícita y auditada.

**21 tablas** sostienen el slice; 7 son posteriores. Total **28**. `21 + 7 = 28`.

MVP: `meetings`, `meeting_media`, `meeting_processing_runs`,
`meeting_processing_jobs`, `meeting_job_events`, `meeting_transcript_versions`,
`meeting_segments`, `meeting_speakers`, `meeting_transcript_speakers`,
`worker_pools`, `worker_credentials`, `meeting_analyses`, `meeting_findings`,
`meeting_citations`, `meeting_finding_citations`, `meeting_next_steps`,
`llm_calls`, `meeting_result_uploads`, `meeting_contacts`,
`meeting_appointments`, `meeting_conversations`.

Posteriores: `meeting_step_commitments`, `worker_pool_tenants`,
`meeting_import_batches`, `meeting_reports`, `meeting_report_citations`,
`meeting_chat_messages`, `meeting_chat_citations`.

**Dependencia visible:** la capacidad 10 exige `meeting_conversations` → exige
`conversations.client_id` → exige el preflight **D-8**. Es lo único del slice que
depende de una verificación en producción; M-7/M-8 van al final del MVP para que
no frene las otras doce.

---

## 8. Migraciones propuestas

Ninguna escrita, ninguna aplicada.

| ID | Nombre | Contenido | Depende de |
|---|---|---|---|
| **M-1** | `meetings-core` | `meetings`, `meeting_media`, `meeting_processing_runs`, `meeting_processing_jobs` (con `last_heartbeat_at`, `last_progress_at`), `meeting_job_events` | — |
| **M-2** | `meetings-transcript` | `meeting_transcript_versions`, `meeting_segments`, `meeting_speakers`, `meeting_transcript_speakers` | M-1 |
| **M-3** | `meetings-worker-pools` | `worker_pools` (con `concurrency jsonb`), `worker_credentials` | — |
| **M-4** | `meetings-result-uploads` | `meeting_result_uploads` (una fila por artefacto) | M-1 |
| **M-5** | `meetings-analysis` | `meeting_analyses`, `meeting_findings`, `meeting_citations`, `meeting_finding_citations`, `meeting_next_steps` | M-2 |
| **M-6** | `meetings-llm-calls` | `llm_calls` | — |
| **M-7** | `conversations-client-id` | `UNIQUE (tenant_id, n8n_workflow_id)` en `workflows`; `conversations.client_id`; backfill; `NOT NULL`; FK y `UNIQUE` compuestos | **preflight D-8** |
| **M-8** | `meetings-associations` | `UNIQUE (id, tenant_id, client_id)` en `appointments`; `meeting_contacts`, `meeting_appointments`, `meeting_conversations` | M-1, M-7 |
| M-9 | `meetings-commitments` | `UNIQUE` en `crm_tasks`; `meeting_step_commitments` | M-5 |
| M-10 | `meetings-reports-chat` | `meeting_reports`, `meeting_report_citations`, `meeting_chat_messages`, `meeting_chat_citations` | M-5 |
| M-11 | `meetings-import` | `meeting_import_batches`, `worker_pool_tenants` | M-1 |

Ocho para el MVP (M-1..M-8). Cada una con `down`; todo `down` que borre datos
**rehúsa ejecutarse si hay filas**. M-7 es la única que toca tablas en uso, es
aditiva, y su paso 1 es lo que el preflight D-8 verifica.

### 8.1 Constraints previas, verificadas contra la base local

| Tabla | UNIQUE hoy | Falta |
|---|---|---|
| `clients` | `(id, tenant_id)` | nada |
| `contacts` | `(id, tenant_id, client_id)` | nada |
| `appointments` | solo `PK (id)` | añadir en M-8 |
| `crm_tasks` | solo `PK (id)` | añadir en M-9 |
| `conversations` | solo `PK (id)`, sin `client_id` | M-7 |

---

## 9. Secuencia de transición — nada se borra

**Regla:** documentar que algo está huérfano no autoriza eliminarlo.

| Fase | Qué | No hace |
|---|---|---|
| **T-0** | Documentos aprobados | — |
| **W-1** *(sin autorizar)* | Cerrar I-1, I-2, I-4, I-5, I-6. `config.py` tipado, `whisper_service` con carga diferida, `audio_probe` escrito. El worker sigue sirviendo HTTP igual que hoy. | No borra `config_patch_phase18.py` |
| **T-1** *(sin autorizar)* | M-1..M-4 en staging | No toca producción |
| **T-2** | R2 privado + subida firmada | No migra audio existente |
| **T-3** | `/api/meetings/v1/jobs/*` + pool `internal-lan` | — |
| **W-2** | `client.py` + polling **junto a** las rutas HTTP | No retira nada |
| **W-3** | Validar end-to-end en staging | **Puerta de calidad** |
| **T-4** | M-5..M-6; etapa `analyze` en el mismo runtime (D-10) | — |
| **T-5** | Preflight D-8 (read-only) → M-7 → M-8 | Si el preflight falla, se para |
| **T-6** | Producción, cliente piloto a `provider: live` | — |
| **T-7** | Resto de clientes | — |
| **T-8** | *Propuesta separada*: retirar la app histórica y los archivos huérfanos | Autorización propia |

### 9.1 La app histórica como rollback

Corrección de la revisión 4: **no está "desplegada"**. Hoy existe únicamente en
la LAN (`192.168.1.15`), y su base tampoco es alcanzable desde fuera.

Lo que se compromete es más modesto y verificable: la app histórica de
Transcript-Project **permanece disponible y ejecutable** en la LAN como camino de
vuelta hasta que T-8 se apruebe. Nadie la borra, nadie la desinstala, y su base
`transcript_app` sigue intacta. No se afirma que esté sirviendo tráfico ni que
sea alcanzable desde Railway, porque no lo es.

---

## 10. Rollback

| Situación | Reversión | Pérdida |
|---|---|---|
| La UI real falla | `provider: "none"` | Ninguna |
| El módulo molesta | Apagar `meetings` en Modules | Ninguna |
| Un worker escribe mal | `revoked_at` en la credencial | Jobs vuelven a `queued` |
| Un pool entero | `enabled = false` | Ídem |
| Análisis malo | `active_analysis_id` a la versión anterior | Ninguna |
| Transcript malo | `active_transcript_id` a la anterior | Ninguna |
| Artefacto corrupto | `state = 'rejected'`, job a `queued` | Ninguna: el objeto queda para diagnóstico |
| Todo el camino nuevo | La app histórica sigue ejecutable en LAN hasta T-8 | Ninguna |
| Esquema malo | `down` de la migración | Destructivo; rehúsa si hay filas |

Las fixtures no son un proveedor de producción: son desarrollo y test.

---

## 11. Decisiones

### 11.1 Cerradas
**D-1** topología A, sin segunda base · **D-2** derivados 7 días · **D-3** 1
reproceso activo, 3 intentos, cuota, override · **D-4** `conversations` pertenece
a un client; M-7 · **D-5** LLM tras interfaz, `llm_calls`, presupuesto ·
**D-6** "Completada con avisos" · **D-7** pools con autorización explícita ·
**D-9** integración existente tras la interfaz · **D-10** mismo runtime reclama
`transcribe` y `analyze`, concurrencia por capacidad · **D-11** sin poda
automática, métricas + política de archivo diseñada · **D-12** audio conservado,
retención con interruptor apagado.

### 11.2 Abiertas

**D-8 · Preflight read-only de `conversations`.** Verificar en producción,
**inmediatamente antes de M-7**, que no exista `n8n_workflow_id` repetido entre
conexiones del mismo tenant. Verificado 0 casos en la copia local. Bloquea M-7 y
la capacidad 10. **No se consulta Railway en esta fase.**

**D-13 · Corpus de medición.** §1.4 lo dice: n = 10 ficheros, ~5 grabaciones, la
mayor de 30 min. Las 4 h son extrapolación. Si quieres dimensionar con datos
reales, hace falta una medición contra `transcript_app` cuando la LAN esté
disponible. No bloquea el MVP: el artefacto canónico funciona a cualquier tamaño,
y por eso se eligió por razones estructurales y no de tamaño (§2.1).

**D-14 · Política legal del audio.** D-12 deja el interruptor apagado. Sigue
pendiente decidir la política.

### 11.3 Riesgos que bloquean empezar

1. **D-8 bloquea la capacidad 10** (M-7/M-8), no las otras doce.
2. **Ningún riesgo bloquea T-1** una vez apruebes el diseño.
3. **W-1 sigue sin autorizar**; es prerrequisito de W-2 y de W-3.
4. **El corpus de medición es débil** (D-13). Mitigado por diseño, no por datos:
   un solo camino de ingesta que no depende del tamaño.

---

## Revisión 6 · pasada correctiva sobre T-1 y W-1

Catorce defectos señalados, más tres encontrados al validar. Lo que sigue son
las decisiones de esquema que cambiaron; los detalles viven en los comentarios
de cada migración.

### La regla que salió de esto: los actos se copian, no se referencian

Tres defectos distintos (#1, #6 y el `credentials_revoke_coherent` de #5) eran
la misma cosa: **una FK a `"user"` con `ON DELETE SET NULL` y, a la vez, un
CHECK que exigía esa columna no nula.** Las dos reglas se contradicen. Borrar al
usuario intenta anular la columna, el CHECK lo impide, y el resultado no es una
integridad más fuerte sino un `DELETE` que falla con un error que no menciona ni
al usuario ni a la constraint que de verdad lo bloquea. Dar de baja a una
persona quedaba condicionado a un pool que autorizó o a una reunión que canceló.

Y hay algo peor que el error: la premisa. Si la constancia de un acto puede
desaparecer porque alguien borró una fila ajena, esa constancia no servía para
lo que existía.

Así que **quién hizo algo se guarda como etiqueta de texto cuando una constraint
depende de ello**, y la FK queda como puntero de conveniencia sin ninguna regla
que la exija:

| acto | registro (exigido) | puntero (opcional) |
|---|---|---|
| cancelar una reunión | `meetings.cancelled_by_label` | `cancelled_by_user_id` |
| autorizar un pool interno | `worker_pools.internal_authorized_actor_label` | `internal_authorized_by_user_id` |
| revocar una credencial | `worker_credentials.revoked_actor_label` | `revoked_by_user_id` |
| renombrar un hablante | `meeting_speakers.renamed_by_label` | `renamed_by_user_id` |

**El lease NO está en esta tabla.** La revisión 6 lo incluyó y era un error de
alcance, corregido en la revisión 7: copiar en vez de referenciar es la respuesta
cuando el padre **puede desaparecer legítimamente** —una persona se da de baja—,
no cuando **no debe** desaparecer. Una credencial de worker referenciada por un
job no se borra: se revoca. Su FK es `RESTRICT` y las invariantes del lease
exigen el uuid. Ver §Revisión 7.

Estas instancias no las encontró una revisión a ojo: las encontró un
**barrido** que borra de verdad el padre de cada una de las 15 FK con `SET NULL`
y comprueba que el hijo sobrevive. Y como la clase de defecto puede volver, hay
una comprobación que la busca directamente en el catálogo (`_detect_setnull_conflicts`)
en vez de enumerar casos.

Donde la FK es compuesta y sólo una columna debe anularse, se nombra:
`ON DELETE SET NULL (contact_id)`. Sin nombrarla, PostgreSQL intentaría anular
también `tenant_id` y `client_id`, que son `NOT NULL`.

**Versión mínima: PostgreSQL 15.** Esa sintaxis se introdujo en 15; en 14 o
anterior la migración falla con un error de sintaxis *a mitad* del `CREATE
TABLE`, que es el peor momento para fallar porque hay que averiguar en qué
estado quedó. La validación se hizo en **18.4**, pero lo que el esquema exige es
15+: decirlo así evita concluir que hace falta 18 para desplegar.

Por eso `npm run meetings:preflight` es obligatorio antes de staging y antes de
producción (`src/scripts/meetingsPreflight.ts`). Comprueba tres cosas contra
`DATABASE_URL`, sin modificar nada: la versión del servidor,
que `gen_random_uuid()` resuelve (todas las tablas nuevas la usan como DEFAULT),
y —lo importante— que `ON DELETE SET NULL (columna)` **se comporta** como se
espera, creando dos tablas temporales, borrando una fila y verificando que sólo
se anuló la columna nombrada, todo dentro de una transacción que revierte.
Comparar un número de versión demuestra que la sintaxis debería existir; la
prueba demuestra que existe.

### `meeting_id` dentro de las claves referenciables

Las claves compuestas eran `(id, tenant_id, client_id)`: garantizaban el tenant
y el cliente, no la reunión. Dos reuniones del mismo cliente podían mezclarse —
un job de la reunión A colgado del run de la B, un `active_transcript_id`
apuntando al transcript de otra reunión, un artefacto de resultado atribuido a
la reunión equivocada. Ahora las hijas referencian
`(id, meeting_id, tenant_id, client_id)` y cada cruce está probado como caso
negativo explícito.

`meeting_transcript_speakers` gana una columna `meeting_id` por eso mismo: sus
dos FK garantizaban tenant y cliente, pero no que la versión y el hablante
fueran de la misma reunión.

### `requires` es una columna generada

`meeting_processing_jobs.requires` ya no se escribe: se deriva de `stage` con
`meetings_stage_capability(text)`, `IMMUTABLE`. El mapeo es

| etapa | capacidad |
|---|---|
| `normalize`, `transcribe`, `diarize` | `meetings.transcribe` |
| `analyze` | `meetings.analyze` |

Las tres primeras comparten una capacidad porque comparten el fichero de audio
descargado y el modelo cargado; separarlas obligaría a tres descargas y tres
cargas del modelo para una sola reunión. Siendo generada, no existe la forma de
escribir un job que exija una capacidad que su etapa no necesita, ni una
desconocida — que era la vía por la que un job quedaba inreclamable para siempre.

### Invariantes completas del lease

`jobs_lease_coherent` sólo exigía lease en los estados activos, y dejaba pasar
token y expiry residuales en `queued` y en los terminales. Un job en cola con
token residual es a la vez reclamable y «ya reclamado». La nueva
`jobs_lease_invariants` dice qué debe y qué no debe haber en cada estado:

| estado | token | expiry | credencial |
|---|---|---|---|
| `queued` | NULL | NULL | NULL |
| `leased`, `uploading_result` | obligatorio | obligatorio | etiqueta obligatoria |
| `succeeded`, `failed`, `cancelled`, `abandoned` | NULL | NULL | **se conserva** (auditoría) |

La credencial se retiene tras terminar a propósito: es la respuesta a «quién
procesó esto». Las 24 combinaciones están probadas.

### `capabilities` y `concurrency` tienen que decir lo mismo

Se validaban por separado, cada una internamente correcta y las dos capaces de
contradecirse: una capacidad anunciada sin límite (el planificador asigna
trabajo que el worker no sabe acotar) o un límite para una capacidad no
anunciada (presupuesto reservado a capacidad muerta). `meetings_pool_coherent`
exige la biyección y al menos una capacidad efectiva.

### Revocación siempre atribuida

La constraint anterior tenía una rama (`OR revoked_at IS NOT NULL`) que vaciaba
la otra: se podía revocar sin decir quién ni por qué. La causa de fondo era que
no existía forma de expresar una revocación **automática** — el barrido de
caducadas, la respuesta a una filtración —, así que la única salida era el hueco.
Se resuelve nombrando al actor (`user` | `system`) en vez de suponerlo humano.

### El CHECK hexadecimal: lo que garantiza de verdad

Se afirmaba que «impide guardar el token en claro». Es falso: acepta cualquier
cadena de 64 caracteres `[0-9a-f]`, y generar tokens en hexadecimal es
precisamente lo natural. Lo que da es más modesto: rechaza lo que no tiene forma
de sha256 (prefijos, guiones, base64, longitudes distintas) y fija la forma de
la columna para que la comparación del claim sea siempre entre digests del mismo
tipo. Que lo almacenado sea un hash y no el secreto lo garantiza el servicio
emisor, y así queda documentado.

### `meeting_job_events.job_id`: FK con anulación de una columna

Decisión tomada: **FK mientras el job exista.** Al desaparecer se anula sólo
`job_id`; el evento conserva `meeting_id`, tenant y cliente. La auditoría
sobrevive —el punto de una tabla de auditoría— y mientras el puntero no sea NULL
la base garantiza que apunta a un job real de esa misma reunión. La alternativa
sin FK dejaba un uuid que podía no corresponder a nada y aun así parecer una
relación.

### W-1

- **`.env`**: la tolerancia con listas sueltas (`SUPPORTED_EXTENSIONS=mp3,wav`)
  sólo envolvía las variables de entorno; `DotEnvSettingsSource` es otra clase y
  seguía exigiendo JSON, mientras la documentación prometía las dos. Ahora la
  envoltura es un mixin aplicado a las dos fuentes, probado con un `.env` real
  en disco.
- **Encontrado al probar**: la envoltura rompía la forma JSON. `[".mp3", ".ogg"]`
  llegaba sin interpretar al validador, que lo partía por comas y producía la
  allowlist `{'.[".mp3"', '.".ogg"]'}` — una allowlist basura que habría
  rechazado todos los ficheros. Afectaba ya a las variables de entorno y no lo
  cubría ninguna prueba; lo destapó el test que verificaba la promesa de que
  «la forma JSON sigue funcionando». Ahora el JSON se intenta primero.
- **`device` vs `compute_type`**: `cpu` explícito con un tipo de GPU es un error
  de configuración al arrancar, con el nombre de la variable y el valor válido en
  el mensaje. `auto` en CPU sustituye por el equivalente soportado
  (`float16`→`float32`, `int8_float16`→`int8`), lo registra en el log y lo
  publica en `describe()` y en el resultado, porque el compute type cambia el
  resultado numérico y no puede cambiarse en silencio.
- **`words`** está declarado en el `TypedDict` (`total=False`, clave opcional).
  Un `type: ignore` sobre una clave de TypedDict no es ruido del checker: es la
  señal de que el tipo no describe el valor que el código produce.
- **`/gpu`** tiene dos ramas documentadas y probadas. Con torch: los mismos cinco
  campos que antes, sin `error`. Sin torch: los cinco más `error`, en un
  escenario que antes no producía respuesta porque el proceso no arrancaba. La
  distinción importa: `cuda_available: false` sin `error` es «hay torch, no hay
  CUDA»; con `error` es «no se pudo mirar».

---

## Revisión 7 · ciclo de vida de credenciales, orden de etapas, estados de artefacto

### Las credenciales no se borran: se revocan

Corrige el alcance de la regla de la revisión 6. `jobs_credential_fkey` y
`job_events_credential_fkey` pasan a **`ON DELETE RESTRICT`**.

La revisión 6 razonó desde «¿qué pasa cuando se borra una credencial
referenciada?» y respondió con `SET NULL` + una invariante montada sobre la
etiqueta para que el borrado no rompiera el CHECK. La pregunta estaba mal
planteada: **eso no debe pasar.** Una credencial que un job o un evento menciona
es la respuesta a «quién procesó esto»; borrarla no libera trabajo, borra la
atribución. Y peor: usar el `DELETE` como mecanismo de liberación convierte una
limpieza administrativa descuidada en pérdida silenciosa de auditoría sobre
trabajo en curso.

El mecanismo de liberación es **revocar + requeuear en la misma transacción**:

```sql
BEGIN;
  UPDATE worker_credentials
     SET revoked_at = now(), revoked_actor = 'system',
         revoked_actor_label = 'lease-sweep', revoked_reason = 'lease expirado'
   WHERE id = $1;

  UPDATE meeting_processing_jobs
     SET status = 'queued',
         lease_token_hash = NULL, lease_expires_at = NULL,
         leased_credential_id = NULL, leased_credential_label = NULL,
         next_attempt_at = now()
   WHERE leased_credential_id = $1
     AND status IN ('leased', 'uploading_result');
COMMIT;
```

**`attempts` no se incrementa aquí.** Lo cuenta el `claim`, que hace
`attempts = attempts + 1` al tomar la fila. Sumarlo también en el requeue
gastaría DOS intentos por un solo lease perdido, y un job con `max_attempts = 3`
moriría tras dos caídas de worker en vez de tres. El barrido automático
(`requeueExpiredLeases`) tampoco lo toca, por la misma razón.

El borrado físico no participa en la operación normal. Si algún día hace falta,
antes hay que comprobar que nadie la referencia — y `RESTRICT` es exactamente esa
comprobación, hecha por la base en vez de por quien se acuerde de hacerla.

Las invariantes del lease quedan así:

| estado | `lease_token_hash` | `lease_expires_at` | `leased_credential_id` | `leased_credential_label` |
|---|---|---|---|---|
| `queued` | NULL | NULL | NULL | NULL |
| `leased` · `uploading_result` | obligatorio | obligatorio | **obligatorio** | **obligatorio** |
| terminales | NULL | NULL | se conserva | se conserva |

Tres matices que importan:

- **Los cuatro NULL en `queued`.** Un requeue tiene que limpiarlos todos, así que
  la atribución del intento que acaba de soltarse **no vive en el job**: vive en
  `meeting_job_events`. La columna guarda el lease *actual*, no los pasados. Esa
  es la razón de que `job_events.credential_id` también sea `RESTRICT`: si el job
  ya no recuerda el intento anterior, el evento es el único que lo hace.
- **Un job activo no puede tener sólo la etiqueta.** Apuntaría a una credencial
  que la base no puede verificar.
- **Los terminales conservan pero no exigen.** Un job cancelado desde la cola
  nunca tuvo credencial; obligarle a inventar una sería falsear el registro.
  `jobs_credential_pair` añade que el uuid y la etiqueta van juntos en cualquier
  estado, para que no quede una etiqueta huérfana que la auditoría afirme y la
  base no respalde.

### Orden de etapas: creación secuencial (decisión para el MVP)

**Los cuatro jobs no se crean por adelantado.** Se crea `normalize` en `queued` y
cada etapa crea la siguiente al completarse, en la misma transacción en que se
marca `succeeded`.

```
crear run → INSERT job(normalize, queued)
normalize succeeded → INSERT job(transcribe, queued)
transcribe succeeded → INSERT job(diarize, queued) [si hay insumo]
diarize succeeded → persistir transcript
transcript persistido→ INSERT job(analyze, queued) [si el módulo lo pide]
```

Por qué secuencial y no precreado: **precrear los cuatro en `queued` es una
mentira sobre el estado del sistema.** `queued` significa «reclamable ahora», y
un `analyze` creado antes de que exista el transcript no es reclamable —
cualquier worker que lo reclamara fallaría inmediatamente. Un estado que miente
contamina todo lo que se construye encima: el conteo de trabajo pendiente, la
decisión de a qué pool asignar, las alertas de cola larga, y la lectura humana
de «¿en qué va esta reunión?».

Precrear sería viable, pero exigiría lo que hoy no existe: un estado `blocked`,
una tabla de dependencias explícitas entre jobs, y un desbloqueador que las
evalúe. Son tres piezas más para que el planificador pueda hacer algo que en el
MVP no necesita — no hay paralelismo entre etapas que aprovechar, porque cada una
consume la salida de la anterior. Si más adelante aparecen etapas realmente
paralelas, `blocked` + dependencias es el camino, y `jobs_stage_key UNIQUE
(run_id, stage)` ya impide que la transición al modelo precreado duplique jobs.

Las precondiciones reales de cada etapa:

| etapa | precondición | si no se cumple |
|---|---|---|
| `normalize` | media original en estado `ready` | el run no arranca |
| `transcribe` | `normalize` en `succeeded` | no se crea el job |
| `diarize` | `transcribe` en `succeeded` **y** el insumo que el backend de diarización requiera | se omite; `meetings.diarization_state = 'skipped'` y un aviso en `meetings.warnings` |
| `analyze` | versión de transcript **persistida** (no «transcribe terminó»: la fila en `meeting_transcript_versions` y sus segmentos escritos) | no se crea el job; `analysis_state = 'pending'` |

La precondición de `analyze` es la que más fácil se rompe si se razona por
estados de job en vez de por datos: `transcribe succeeded` sólo dice que el
worker terminó y subió el artefacto. Entre eso y «el transcript está en la base»
median la verificación del checksum y la ingesta, que pueden rechazar el
artefacto. `analyze` se crea cuando el artefacto está `ingested` y la versión
existe.

Esto se implementa en T-3. Queda documentado antes, como se pidió.

### `meetings.transcribe` es autorización, no afinidad

Que `normalize`, `transcribe` y `diarize` compartan capacidad significa
**exactamente una cosa**: un pool con `meetings.transcribe` está autorizado a
reclamar jobs de esas tres etapas.

La revisión 6 escribió que las tres «comparten el fichero de audio descargado y
el modelo cargado». Como garantía es **falso**: dos pools con la misma capacidad,
o dos procesos del mismo pool, pueden reclamar `normalize` y `transcribe` de la
misma reunión sin compartir disco ni memoria. La capacidad **no expresa afinidad
de ejecución.**

La razón real de agrupar es de **perfil de recurso**: las tres necesitan un
runtime con GPU y códecs; `analyze` sólo necesita salida a un LLM. De ahí que
admitan concurrencias distintas y puedan vivir en runtimes distintos. Que además
a menudo caigan en el mismo proceso —y entonces reaprovechen la descarga y el
modelo— es una optimización oportunista, no un invariante, y ningún diseño debe
apoyarse en ella. Garantizar la coincidencia exigiría un mecanismo explícito
(afinidad por run, o un job compuesto), que no es esta columna.

### Estados de `meeting_result_uploads`, en la base

Las invariantes son **constraints**, no reglas del servicio (`ru_state_invariants`):

| estado | exige |
|---|---|
| `awaiting_upload` | `uploaded_at`, `verified_at`, `ingested_at`, `rejected_at` todos NULL |
| `uploaded` | `uploaded_at`; los otros tres NULL |
| `verified` | `uploaded_at`, `verified_at`, `observed_bytes`, `observed_checksum_sha256` |
| `ingested` | los tres instantes **y** las mediciones |
| `rejected` | `rejected_at` **y** `reject_code` |

Más `ru_time_order` (los instantes no pueden estar del revés), `ru_observed_pair`
(las dos mediciones van juntas) y `ru_reject_detail_needs_code`. La columna
`rejected_at` es nueva: antes un rechazo tenía código pero no instante, y la
única forma de fecharlo era el `created_at` de la fila, que es cuando empezó la
subida.

Podrían vivir en el servicio de ingesta. No lo hacen por dos razones. La primera
es de consistencia: este esquema decidió lo contrario en todas las demás
decisiones difíciles, y una tabla que confía en el código mientras sus vecinas no
lo hacen es la que se corrompe. La segunda es específica de esta tabla: sus filas
las escriben **dos actores en momentos distintos** —el worker al subir, mai al
verificar e ingerir— y las tocan además barridos de limpieza y reintentos. Un
invariante que depende de que todos los caminos de escritura lo recuerden no es
un invariante.

Lo que la base garantiza es que ninguna fila esté en un estado cuyos datos no lo
respalden. Qué transición puede suceder a cuál sigue siendo del servicio.
