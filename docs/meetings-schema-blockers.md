# Bloqueo de esquema detectado en la Fase 0

Un solo bloqueo real, y una asimetría que recomiendo resolver con él. No he
tocado M-1..M-4.

---

## B-1 · `meeting_result_uploads.kind` no puede nombrar el artefacto de diarización

**El estado actual** (M-4):

```sql
kind text NOT NULL CHECK (kind IN ('transcript','analysis','raw'))
```

**El problema.** `diarize` produce un artefacto ingestible propio: una lista de
turnos `(start, end, speaker)`. No es un transcript —no contiene texto—, no es
un análisis, y no es `raw` (que en el diseño es la salida cruda que se conserva
para auditoría, no algo de lo que se ingiera).

Las tres salidas sin cambiar el esquema, y por qué ninguna sirve:

1. **Usar `kind='transcript'` para diarize.** No viola ninguna constraint: la
   idempotencia es `UNIQUE (job_id, attempt, kind)` y diarize es otro `job_id`.
   Pero entonces `kind` deja de responder «qué es este objeto» y hay que
   preguntárselo al job (`job_id → stage`) para saber cómo parsearlo. Es
   exactamente la clase de estado que miente que este esquema ha estado
   eliminando en las revisiones anteriores: la columna afirma un tipo de payload
   y el payload es otro. Además, la primera consulta que alguien escriba
   —«dame los transcripts de esta reunión»— devolverá diarizaciones.

2. **Usar `kind='raw'`.** Cambia el significado de `raw` de «salida cruda
   conservada para auditoría» a «salida cruda de la etapa que sea, a veces
   ingestible». Cuando llegue T-4, `analyze` querrá su propio `raw` auditable y
   el valor tendrá dos sentidos a la vez.

3. **Mandar la diarización por `meeting_media` role=`raw_result`.** Cabe
   físicamente (esa tabla tiene `bytes`, `checksum_sha256`, `content_type`),
   pero `meeting_media` no tiene `job_id` ni `attempt` ni estados, así que el
   artefacto perdería el ciclo `awaiting_upload → uploaded → verified → ingested`
   y la idempotencia por intento. Un payload ingestible por el camino débil,
   mientras el transcript va por el fuerte: dos mecanismos para la misma
   operación, que es lo que la propia M-4 argumenta en contra.

**Lo que propongo.** Ampliar el vocabulario:

```sql
kind IN ('transcript','diarization','analysis','raw','normalized_media')
```

`normalized_media` es la asimetría A-1 de más abajo; si se decide no resolverla,
el mínimo es añadir `'diarization'`.

**Cómo aplicarlo.** M-1..M-4 no se han aplicado a ninguna base compartida —sólo
a contenedores desechables— y sólo `1783400000000_meetings-module` llegó a la
copia local. Así que hay dos caminos y la elección es tuya:

- **Editar el CHECK dentro de M-4.** Deja una sola migración coherente, sin una
  M-5 que altere un CHECK creado tres migraciones antes. Es lo que haría si el
  esquema no estuviera desplegado en ningún sitio, que es el caso.
- **Una M-5 aditiva** que haga `DROP CONSTRAINT` / `ADD CONSTRAINT`. Preserva la
  regla de «las migraciones ya escritas no se editan», al coste de que el
  historial cuente una decisión que nunca estuvo en producción.

Recomiendo el primero, precisamente porque nada depende todavía de M-4.

---

## A-1 · El artefacto de `normalize` no tiene sitio en el ciclo de subida

**No es un bloqueo**: se puede implementar sin cambiar nada. Lo reporto porque
la implementación queda asimétrica y prefiero que la asimetría sea una decisión
tuya y no un residuo mío.

`normalize` produce audio, y su destino natural es `meeting_media`
role=`normalized`, que ya existe. Pero esa tabla tiene `bytes`,
`checksum_sha256` y `content_type` como `NOT NULL`, así que la fila **sólo puede
existir después de la subida**. No hay, por tanto, registro de
`awaiting_upload` para ese objeto.

Se puede implementar así: la clave es determinista, mai la deriva en
`result/init` y la vuelve a derivar en `result/complete`, verifica el objeto e
inserta `meeting_media`. Funciona, es seguro (la clave nunca viene del cliente)
y es idempotente (`meeting_media_key_unique`).

Lo que queda torcido es que **`normalize` usa un mecanismo de idempotencia
distinto al de las otras dos etapas**: determinismo de la clave en vez de la fila
`meeting_result_uploads(job_id, attempt, kind)`. Dos caminos para la misma
operación, y el worker tiene que saber cuál le toca según la etapa.

Con `kind='normalized_media'`, las tres etapas usan el mismo `result/init` +
`result/complete`, el mismo registro de idempotencia y el mismo ciclo de
verificación; la única diferencia queda dentro de mai, que además de marcar
`ingested` inserta la fila de `meeting_media`. El worker no distingue etapas.

---

## Otros dos puntos, ninguno bloqueante

**`meeting_media` no tiene `run_id`.** Los derivados «pueden repetirse entre
runs» (así lo dice el comentario del índice único), pero nada en la fila dice de
qué run vino cada `normalized`. La clave determinista incluye `run_id`, así que
la información existe y es recuperable, pero vive en una cadena de texto en vez
de en una columna. Cuando llegue la poda de artefactos por run, hará falta o una
columna o un `LIKE` sobre `storage_key`. No lo cambio ahora.

**`jobs_claimable_idx` no incluye `tenant_id` ni `requires`.** Es
`(priority, next_attempt_at, created_at) WHERE status='queued'`. Un pool
`single_tenant` filtra por tenant después del índice, y la capacidad se filtra
también fuera. Con el volumen del MVP es irrelevante; con miles de jobs en cola
de varios tenants, el claim de un pool pequeño recorrería trabajo que no le
toca. Queda anotado para cuando haya volumen, no antes.
