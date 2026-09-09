# Contratos de etapa · normalize · transcribe · diarize

Fase 0 de T-2/T-3/W-2. `analyze` queda fuera (T-4).

Los jobs se crean **secuencialmente**: cada etapa crea la siguiente en la misma
transacción en que se marca `succeeded`. Ninguna etapa aparece en `queued` antes
de que su insumo exista.

---

## 0 · Vocabulario

**Artefacto** = un objeto en el bucket privado, con clave generada por el
servidor, checksum SHA-256, tamaño y content type declarados por el worker y
**verificados por mai** antes de ingerir.

**`schema_version`** identifica la forma del *payload*, no la del esquema SQL.
Cada tipo de artefacto tiene su propia numeración, empezando en 1. Un worker
declara la versión que produjo; mai rechaza lo que no sabe leer. La columna
`meeting_transcript_versions.schema_version` guarda la del artefacto del que se
ingirió, para que una versión persistida siempre diga de qué forma vino.

**Clave de almacenamiento**: la deriva el servidor, siempre, con esta forma:

```
t/{tenant_id}/c/{client_id}/m/{meeting_id}/r/{run_id}/{role}/a{attempt}/{nombre}
```

Es determinista a partir de (meeting, run, job, attempt, rol). Dos consecuencias
que importan: repetir `result/init` devuelve la MISMA clave con una URL nueva
—idempotencia sin necesidad de recordar nada—, y dos intentos del mismo job
nunca escriben en el mismo objeto, así que el resultado de un intento viejo no
puede pisar el del actual.

---

## 1 · normalize

| | |
|---|---|
| **Entrada** | `meeting_media` role=`original`, `deleted_at IS NULL`. Signed GET con Range. |
| **Salida** | Audio normalizado: WAV PCM s16le, 16 kHz, mono. |
| **`schema_version`** | **1**, pero describe el *envoltorio* (`kind='normalized_media'`), no un payload: la salida es audio. Su forma real son `sample_rate`/`channels`/`codec`, que se persisten como columnas de `meeting_media`. |
| **Transición** | job `queued → leased → uploading_result → succeeded`. `meetings.media_state` no cambia: sigue `ready` (describe el original). |
| **Persistencia de mai** | Tras verificar el objeto: marca el artefacto `ingested` **e** `INSERT meeting_media` role=`normalized` con `bytes`, `checksum_sha256`, `content_type`, `duration_seconds`, `sample_rate`, `channels`, `codec`, `probe_ok`. Es la única etapa cuyo artefacto se ingiere en cuanto se verifica; los otros dos esperan (§5). |
| **Siguiente job** | `transcribe`, en la misma transacción. Condición exacta: la fila `meeting_media` role=`normalized` de ESTE run existe y `probe_ok = true`. |
| **Fallo parcial** | No existe. O hay audio normalizado utilizable o no hay. `probe_ok=false` ⇒ `probe_error` obligatorio (CHECK) y el job va a `failed`; el run termina `outcome='failed'`, `meetings.transcript_state='failed'`. |
| **Idempotencia** | `ru_attempt_key UNIQUE (job_id, attempt, kind)` igual que las otras dos etapas, más `meeting_media_key_unique UNIQUE (storage_key)`: un segundo `result/complete` del mismo intento no crea una segunda fila y se responde éxito. |

**Por qué se sube el audio normalizado en vez de pasarlo en memoria.**
`meetings.transcribe` es una autorización de pool, no afinidad de ejecución: dos
procesos distintos pueden reclamar `normalize` y `transcribe` de la misma
reunión. El insumo tiene que estar en un sitio que los dos alcancen.

---

## 2 · transcribe

| | |
|---|---|
| **Entrada** | `meeting_media` role=`normalized` de este run. Signed GET con Range. |
| **Salida** | NDJSON + gzip. Una línea de cabecera y una línea por segmento. `kind='transcript'`, `schema_version=1`. |
| **`schema_version`** | **1** (ver §4). |
| **Transición** | job `queued → leased → uploading_result → succeeded`. `meetings.transcript_state`: `pending → running` al reclamar, y **NO pasa a `ready` aquí** (ver §5). |
| **Persistencia de mai** | Verifica y deja el artefacto en `meeting_result_uploads.state='verified'`. **No ingiere todavía.** |
| **Siguiente job** | `diarize`, en la misma transacción. Condición exacta: el artefacto de transcripción de este run está `verified` **y** existe el `meeting_media` role=`normalized` que diarize necesita como insumo. Si la reunión pidió `diarize: false` en `requested_options`, no se crea y se ingiere de inmediato con `diarization_state='skipped'`. |
| **Fallo parcial** | No existe a nivel de etapa. Un transcript a medias no es utilizable: sin él no hay texto y las etapas siguientes no tienen insumo. `failed` ⇒ run `outcome='failed'`, `transcript_state='failed'`. |
| **Idempotencia** | `ru_attempt_key UNIQUE (job_id, attempt, kind)`: repetir `result/init` devuelve la misma fila y una URL nueva. Repetir `result/complete` con el mismo checksum es un no-op que responde éxito; con un checksum distinto es `checksum_mismatch` (el objeto ya se verificó y no se revisa). |

---

## 3 · diarize

| | |
|---|---|
| **Entrada** | `meeting_media` role=`normalized` de este run, **y** el artefacto de transcripción `verified` de este run (para alinear turnos con segmentos). Dos signed GET. |
| **Salida** | NDJSON + gzip: una línea de cabecera y una línea por turno de hablante. `kind='diarization'`, `schema_version=1`. |
| **`schema_version`** | **1** (ver §4). |
| **Transición** | job `queued → leased → uploading_result → succeeded`. `meetings.diarization_state`: `pending → running` al reclamar. |
| **Persistencia de mai** | Verifica el artefacto, y **entonces sí ingiere todo el pipeline de transcripción en una transacción** (ver §5). |
| **Siguiente job** | Ninguno en esta fase. `analyze` es T-4; su condición ya está fijada: la versión de transcript **persistida**, no «transcribe terminó». |
| **Fallo parcial** | **Aquí sí existe, y es el único caso.** Si diarize falla o se omite, el transcript se ingiere igual, sin etiquetas de hablante: `diarization_state` = `failed` \| `skipped`, un aviso en `meetings.warnings`, `meeting_transcript_versions.diarization_backend = NULL` y `meeting_transcript_speakers` vacío. El run termina `outcome='partial'`. Es el estado «Completada con avisos» que la UI ya tiene construido. |
| **Idempotencia** | Igual que transcribe. Además, la ingestión completa es idempotente por `tv_run_key UNIQUE (run_id)`: un segundo intento de ingerir el mismo run choca contra esa constraint y mai lo interpreta como «ya estaba». |

---

## 4 · Forma de los artefactos

NDJSON con gzip, primera línea = cabecera, resto = elementos. La cabecera lleva
la versión, así que un lector puede decidir si sigue leyendo antes de parsear
nada más.

**Transcript, `schema_version = 1`:**

```
{"schema":"meetings.transcript","schema_version":1,"language":"es","duration_seconds":1802.5,"model":"medium","device":"cuda","compute_type":"float16","segment_count":205}
{"i":0,"start":0.0,"end":4.12,"text":"Buenos días a todos.","confidence":0.94}
{"i":1,"start":4.12,"end":9.87,"text":"Empezamos con el estado del proyecto.","confidence":0.91}
```

`i` es el índice denso desde 0 y es la clave de `meeting_segments.segment_index`.
`end >= start` (lo exige `segments_time_order`). `confidence` opcional en [0,1].

**Diarización, `schema_version = 1`:**

```
{"schema":"meetings.diarization","schema_version":1,"backend":"wespeaker","speaker_count":4,"turn_count":312}
{"start":0.0,"end":4.30,"speaker":"SPEAKER_00"}
{"start":4.30,"end":10.02,"speaker":"SPEAKER_01"}
```

`speaker` es la etiqueta cruda del diarizador; **no** un nombre humano. La
asociación etiqueta→persona vive en `meeting_transcript_speakers` +
`meeting_speakers`, que es lo que hace que un renombre sobreviva al
reprocesamiento.

La alineación turno→segmento la hace **mai** en la ingestión, no el worker:
cada segmento recibe la etiqueta del turno con mayor solape temporal, y
`overlap = true` si dos turnos distintos solapan el segmento por encima de un
umbral. Ponerla en mai —y no en el worker— significa que la regla vive en un
solo sitio y que reprocesar sólo diarize no exige volver a transcribir.

---

## 5 · La versión de transcript se crea UNA vez

**Decisión, y es la que preserva el versionado inmutable.**

La alternativa era ingerir al terminar `transcribe` (creando la versión y sus
segmentos) y luego, al terminar `diarize`, **actualizar**
`meeting_segments.speaker_label` e insertar los hablantes. Funciona, pero
convierte una versión ya persistida en algo mutable, y la línea entre «estoy
completando esta versión» y «estoy revisando esta versión» deja de existir en
los datos: nada distingue un `UPDATE` legítimo de la ingestión de uno posterior.

Así que la versión se escribe una sola vez, cuando el pipeline de transcripción
**resuelve** —diarize terminó, falló, o no se pidió—, en una transacción que:

1. lee los artefactos `verified` del run;
2. `INSERT meeting_transcript_versions` (una por run, garantizado por `tv_run_key`);
3. `INSERT meeting_segments` en bloque, con `speaker_label` ya alineado si hubo diarización;
4. `INSERT meeting_speakers` para las etiquetas nuevas e `INSERT meeting_transcript_speakers` con `talk_share_pct`;
5. marca los artefactos `ingested`;
6. `UPDATE meetings SET active_transcript_id = …, transcript_state='ready', diarization_state=…`;
7. cierra el run con `outcome` `succeeded` o `partial`.

Después de eso, **ninguna fila de esa versión se vuelve a escribir**. Un
reprocesamiento crea un run nuevo y una versión nueva, y «deshacer» es mover
`active_transcript_id`.

Esto coincide con el orden que el propio plan de validación describe: subir los
artefactos primero (paso 7) y verificar e ingerir después (paso 8).

Consecuencia operativa que hay que aceptar: el texto no está consultable hasta
que diarize resuelve. Para los tamaños medidos (30 min ⇒ 205 segmentos) diarize
son minutos, y la UI ya tiene el estado `running`. Si algún día se quisiera
mostrar el texto antes, la forma correcta no es mutar la versión: es una versión
`schema_version` sin hablantes seguida de otra con ellos, y el puntero moviéndose
— dos versiones inmutables, no una mutable.

---

## 6 · Máquina de estados por reunión

```
media_state       pending → uploading → ready            (T-2/T-3: upload)
                                    ↘ invalid            (ffprobe rechaza)

transcript_state  pending → running → ready              (ingestión, §5)
                                   ↘ failed
                                   ↘ skipped

diarization_state pending → running → ready              (ingestión con hablantes)
                                   ↘ partial             (hubo turnos pero incompletos)
                                   ↘ failed              (diarize falló; texto sí)
                                   ↘ skipped             (no se pidió)
```

`transcript_state='ready'` y `diarization_state` se escriben **en la misma
transacción**. No existe el instante en que el transcript esté listo y la
diarización diga `pending`.

---

## 7 · Qué exige esto de M-1..M-4

Casi nada. Tres cosas se resolvieron sin tocar el esquema:

- **El insumo de cada etapa** se identifica derivando la clave determinista, no
  consultando por run — y `meeting_media_key_unique UNIQUE (storage_key)` es
  suficiente para comprobar que existe.
- **La inmutabilidad** se preserva escribiendo la versión una sola vez (§5), sin
  necesidad de una constraint que prohíba escribir en versiones cerradas.
- **La idempotencia de la ingestión** la da `tv_run_key UNIQUE (run_id)`, que ya
  existe.

**Un cambio sí hizo falta**, y está aplicado con autorización:
`meeting_result_uploads.kind` no tenía valor para el artefacto de diarización.
El `CHECK` de M-4 pasa a
`('normalized_media','transcript','diarization','analysis','raw')`, con lo que
las tres etapas suben por el mismo camino y con el mismo registro de
idempotencia. El razonamiento completo —incluidas las tres alternativas que no
servían— está en `docs/meetings-schema-blockers.md`.

---

## 8 · Invariantes añadidas en la pasada de hardening

### Procedencia del medio: relacional, no deducida

| rol | `run_id` | vivos por run |
|---|---|---|
| `original` | **NULL obligatorio** | uno por reunión (`meeting_media_one_live_original_idx`) |
| `normalized`, `raw_result` | **obligatorio** | **uno** por (run, rol) (`meeting_media_one_live_derived_idx`) |

`meeting_media_run_scoped` impone las dos direcciones, y la FK compuesta incluye
`meeting_id`: el run tiene que ser de esa reunión.

Un reintento que vuelve a subir **reemplaza**: el derivado anterior pasa a
`deleted_at` en la misma transacción. El histórico se conserva y deja de estar
vivo — y «vivo» significa algo porque el índice único parcial lo hace cumplir.

La consulta del insumo de una etapa es `WHERE run_id = $1 AND role = $2`. **No**
se derivan claves ni se recorren intentos: una clave de objeto es una cadena
opaca, y usarla como índice significa que cambiar su esquema rompe la lectura de
datos ya escritos.

### Capacidades: reclamables y no reclamables

| capacidad | reclamable | límite de concurrencia | sólo interna |
|---|---|---|---|
| `meetings.transcribe` | sí | obligatorio | no |
| `meetings.analyze` | sí | obligatorio | no |
| `meetings.maintenance` | **no** | **no aplica** | **sí** |

Reclamable y «sólo interna» son preguntas distintas, aunque hoy `maintenance`
sea la única que responde igual a las dos. Reclamable responde a *¿tiene etapa y
concurrencia?* (`meetings_claimable_capability`); sólo-interna responde a
*¿puede pertenecer a un pool atado a un tenant?*
(`meetings_internal_only_capability`).

`meetings_pool_coherent` exige la biyección sólo dentro de las reclamables, y
«al menos un límite» sólo si el pool declara alguna. Un pool sólo de
mantenimiento es válido con `limits` vacío.

#### El barrido global exige ámbito Y capacidad

`/maintenance/requeue-expired` sólo lo ejecuta una identidad con
`scope = 'internal'` **y** `meetings.maintenance`. Las dos, a la vez, y la
garantía existe en dos niveles porque cubren caminos distintos:

| nivel | qué impide | qué NO ve |
|---|---|---|
| `pools_scope_allows_capabilities` (CHECK en `worker_pools`) | que se emita la capacidad en un pool `single_tenant`, tanto al insertar como al hacer UPDATE del scope o de las capacidades | una `WorkerIdentity` construida en memoria, que no pasa por la tabla |
| `requeueExpiredLeases` (servicio) | que cualquier llamador ejecute el barrido sin las dos cosas | nada sobre lo que ya está escrito en la base |

Con sólo el CHECK, el aislamiento dependería de que ningún camino fabricara una
identidad —y eso es justo lo que hará un cron o un adaptador interno. Con sólo
la comprobación del servicio, dependería de que nadie escribiera la fila
equivocada, y esa fila no falla al usarse: la credencial se emite, autentica y
espera.

Una credencial de proceso —incluso del mismo tenant— recibe el mismo 404 que un
recurso inexistente, y el mismo tanto si le falta el ámbito como si le falta la
capacidad: distinguirlos le diría cuál de las dos piezas conseguir. Y no obtiene
los recuentos globales.

### Idempotencia terminal

Los campos que se comparan son los **datos semánticos del resultado**, y sólo
esos:

| operación | se compara | NO se compara |
|---|---|---|
| `fail` | `failureCode`, `failureDetail` normalizado | — |
| `result/complete` | `bytes`, `checksumSha256` | `leaseToken` |
| `result/complete` de `normalize` | además `probe.durationSeconds`, `probe.sampleRate`, `probe.channels`, `probe.codec` | `leaseToken` |

El `leaseToken` queda fuera a propósito: es una prueba de posesión, no un dato
del resultado, y compararlo convertiría en conflicto un reenvío tras una
renovación de lease legítima. Sobre un job terminal, además, no hay nada contra
lo que compararlo — `jobs_lease_invariants` exige que `lease_token_hash` sea
NULL en cuanto el job cierra. Lo que autoriza el reenvío es la **credencial** y
el **intento**: otra credencial recibe 404 y otro intento recibe `attempt_stale`,
las dos cosas antes de mirar el payload.

Los valores autoritativos del sondeo no viven en la fila de la subida: se leen
del medio derivado que esa subida produjo (`meeting_media`, buscado por
`run_id` + `role` + `storage_key`, no por «el vivo del run», que un reintento
posterior pudo sustituir). `duration_seconds` es `numeric(12,3)`, así que el
valor entrante se cuantiza con la misma función tanto al escribirlo como al
compararlo: si el redondeo ocurriera sólo en la base, un worker que reenvía
`3600.4567` chocaría contra el `3600.457` guardado y mai inventaría un conflicto
a partir de su propio redondeo.

| situación | respuesta |
|---|---|
| `complete` repetido, todos los campos iguales | 200 con el resultado previo, **sin escribir nada** |
| `complete` repetido, checksum o tamaño distintos | 409 `terminal_conflict` |
| `complete` de `normalize` repetido, cualquier campo del sondeo distinto | 409 `terminal_conflict` |
| `complete` de `normalize` repetido **sin** el sondeo que constaba (o con uno que no constaba) | 409 `terminal_conflict` |
| `fail` repetido, mismo código y mismo detalle | 200 con el resultado previo |
| `fail` repetido, código distinto | 409 `terminal_conflict` |
| `fail` repetido, mismo código y detalle distinto (incluido nulo↔texto) | 409 `terminal_conflict` |
| `fail` sobre un job `succeeded` | 409 `terminal_conflict` |
| `complete` sobre un job `cancelled` / `abandoned` | 409 `invalid_transition` |

La última fila es deliberadamente otro código: un job cancelado no es un terminal
cuyo resultado se esté reafirmando, es un job que dejó de estar en el pipeline.
Un worker que recibe `terminal_conflict` tiene un bug; uno que recibe
`invalid_transition` perdió una carrera con una cancelación, que es normal.

En ningún caso se modifica el estado terminal ya escrito.

### Entitlement del módulo

Las rutas con sesión exigen, en este orden: forma del `clientId`, sesión que
alcance el cliente, cliente existente y no-por-defecto, y `meetings` habilitado
en `client_modules`. Las cuatro fallan con el **mismo 404**, igual que el resto
de los módulos.
