# Handoff · el reparto 98,1 / 1,9 de la reunión W-3

**Qué hay que averiguar:** la diarización de la reunión de prueba devolvió dos
hablantes con un reparto de **98,10 % / 1,90 %** sobre 26 turnos, y los **15
segmentos del transcript quedaron todos asignados al primero**. No sabemos si
eso describe la grabación o si es un defecto.

**Qué NO es:** un fallo del recorrido. Las tres etapas terminaron, los tres
artefactos se ingirieron con checksum verificado y el run 2 cerró
`outcome='succeeded'`. Esto es una pregunta de **calidad de la diarización**, no
de la tubería.

---

## Los datos que ya están confirmados

Leídos de `mai_w3_staging`, sólo lectura.

| | |
|---|---|
| reunión | `cc00c4cf-a69f-46a3-acf7-f22e90fed109` |
| tenant / cliente | `c545358f-491f-441d-8803-5ab2b579026b` / `381e9e01-f5e5-41b3-a0bd-162650b3130f` |
| run que produjo el resultado | `58c367fa-6f6c-42a8-b61c-70638b06d147` (nº2, `reprocess`, `succeeded`) |
| versión de transcript activa | `a0b50364-8d89-41b1-9696-d4f046f4b61d` |
| audio normalizado | 119,595 s · 16 kHz · 1 canal · `pcm_s16le` · 3.827.132 B |
| artefacto de diarización | 386 B · `item_count = 26` · `state = ingested` |
| backend | `wespeaker` · `metrics.speaker_count = 2` |
| reparto | `SPEAKER_00` 98,10 % · `SPEAKER_01` 1,90 % (suma 100,00) |
| segmentos | 15, **todos** con `speaker_label = 'SPEAKER_00'`, `overlap = false` en todos |
| hablantes | 2 filas en `meeting_speakers`, las dos con `display_name` NULL y sin `contact_id` |

Aritmética que conviene tener presente: 1,90 % de 119,6 s son **~2,3 s**
repartidos entre los turnos de `SPEAKER_01`. Los segmentos de whisper duran
entre 4 y 13 s. mai asigna la etiqueta **por mayor solape temporal**
(`artifacts.ts`), y `overlap = true` exige que un segundo turno cubra ≥ 25 % del
segmento (`OVERLAP_THRESHOLD`). Con 2,3 s repartidos, ningún segmento tiene a
`SPEAKER_01` como mayoría ni llega al umbral de solape. **Todas las capas
hicieron lo que dicen.**

---

## Lo que hay que hacer, en orden

### 1 · Leer el artefacto de diarización, sin mover las claves de R2

Los 26 turnos con sus tiempos y etiquetas son el primer dato que falta.

**La herramienta ya existe:** `src/scripts/meetingsFetchArtifacts.ts` (commit
`f44485f`). Baja el normalizado y los artefactos crudos leyendo las claves de
`meeting_media` y `meeting_result_uploads` —su registro auditable, con `state`,
`job_id` y `attempt`— y **no firma ninguna URL**: usa `store.getBytes(key)`, o
sea un GetObject con el SDK, así que no existe ninguna URL que pueda acabar en
una consola o en un log. Pide todos los intentos, no sólo el ingerido, que es lo
que hace falta para comparar dos ejecuciones.

**Lo que queda pendiente es DÓNDE se ejecuta.** El script llama a
`resolveMeetingsStorage(process.env)` (línea 117), así que necesita
`MEETINGS_STORAGE_ACCESS_KEY_ID` y `MEETINGS_STORAGE_SECRET_ACCESS_KEY` en el
entorno del proceso — y su línea de uso lo documenta corriendo en el Mac, «donde
está `DATABASE_URL`». Eso traslada las claves de R2 al Mac, y **acordamos que
permanecen exclusivamente en Railway**.

Haber cambiado la URL firmada por `getBytes` resuelve una fuga distinta (la URL)
y no ésta (las claves). La siguiente acción es **resolver la descarga donde las
credenciales ya están**, sin copiarlas:

- ejecutar ese mismo script **en el servicio de Railway** —`railway run`, una
  consola del servicio, o un job puntual—, donde `MEETINGS_STORAGE_*` y
  `DATABASE_URL` ya existen, y sacar los ficheros de ahí; o
- añadir una **ruta de sesión de sólo lectura** que sirva el artefacto con las
  mismas tres comprobaciones que `…/media` (`resolveAppScope`, la reunión acotada
  por tenant y cliente, y la clave verificada contra el prefijo del ámbito).
  Para 386 B de NDJSON conviene **servir el contenido**, no redirigir con una URL
  firmada.

Lo que no vale es cualquier variante que empiece por «copia el Access Key al Mac».

### 2 · Comparar los turnos con el audio

Con los 26 turnos delante, la pregunta es una sola: **¿los tramos de
`SPEAKER_01` corresponden a alguien hablando?**

- Escuchar el audio normalizado en las marcas de `SPEAKER_01` (el reproductor de
  la UI ya sirve para esto: navega por marca de tiempo).
- Mirar la forma de los turnos: si son astillas de 0,1–0,3 s dispersas, es la
  firma de una VAD por energía entrando y saliendo del segundo grupo; si son dos
  o tres intervenciones de un segundo o más, la segunda voz existe y habló poco.

### 3 · Y sólo después, comparar los turnos con los segmentos

Una vez se sepa qué hay en el audio, se compara con lo que mai escribió: para
cada turno de `SPEAKER_01`, qué segmento lo contiene y cuánto solapa. Eso dice si
la fusión por mayor solape descartó una intervención real que merecía su propio
segmento.

> **Cuidado con el atajo.** No sirve deducir dónde falla a partir del número de
> hablantes del artefacto. Ya sabemos que son dos, con reparto 98,1 / 1,9, y que
> los 15 segmentos fueron al primero — y eso, por sí solo, **es compatible tanto
> con una grabación de una sola voz dominante como con un diarizador que colapsó
> dos**. Hay que comparar los turnos con el audio, y después con los segmentos.
> Cualquier regla del tipo «un hablante ⇒ problema de detección, dos ⇒ problema
> de ingesta» es falsa aquí y haría repetir la investigación.

### 4 · Repetir la diarización con el número de hablantes forzado

**La herramienta ya existe:** `tools/w3/compare_diarization.py` (commit
`f44485f`). Importa `diarize` y lo llama dos veces sobre el mismo WAV, fijando
`backend="wespeaker"` explícito y leyendo `min_speakers`/`max_speakers` de la
config del worker, de modo que **lo único que varía es `num_speakers`**. No abre
puerto, no reclama jobs y no necesita PostgreSQL. Introspecciona la firma de
`diarize` y aborta nombrando el parámetro que falte, en vez de llamar con menos
argumentos y comparar dos cosas distintas creyendo que son la misma. CPU y GPU no
se mezclan: el device va en el nombre del fichero y en el informe.

**Lo que le falta es emparejar las etiquetas.** Su función `disagreements()`
compara los nombres directamente (`ta[t] != tb[t]`) sobre un muestreo por
segundo. El docstring es honesto —dice que las etiquetas de dos ejecuciones no
son comparables por nombre y que sólo señala DÓNDE difieren, dejando el juicio al
oído—, pero la salida sigue siendo engañosa: **si las dos ejecuciones coinciden
salvo por una permutación de nombres, el informe marca los 120 segundos como
desacuerdo**, y eso se lee como «las dos ejecuciones no se parecen en nada»
cuando son la misma segmentación con otros nombres. Es justo la conclusión
opuesta a la correcta.

El emparejamiento correcto, antes de comparar: construir la matriz de solape
temporal entre los turnos de las dos ejecuciones y quedarse con la asignación que
maximiza el solape total. Con dos hablantes son dos permutaciones, así que basta
probarlas y elegir la mejor; con N, es una asignación húngara. Sólo después de
emparejar se compara el reparto y la frontera de los turnos, y sólo entonces la
lista de desacuerdos señala instantes que merezca la pena escuchar.

## Entorno operativo del worker

| | |
|---|---|
| repositorio / rama | `Transcript-Project`, `w2/worker-pull-clean` |
| último commit confirmado | **`2452aba`** (verificado: es la cabeza local y la de `origin`) |
| entorno Conda | `/home/santiagov/miniconda3/envs/mai-w3` |
| lanzador | `transcript-worker/scripts/w3-worker.sh` |
| servicio de usuario | `vanegas-w3-worker.service` |
| acceso | `ssh santiagov@100.103.187.118` |

Comprobación del apilado CUDA antes de tocar nada:
`W3_CONDA_PREFIX=/home/santiagov/miniconda3/envs/mai-w3 bash scripts/check_gpu_stack.sh`.

> **No arrancar otro consumidor.** El servicio `vanegas-w3-worker.service` ya
> consume la cola con la capacidad `meetings.transcribe`. Un segundo proceso con
> la misma credencial reclamaría jobs de forma indistinguible y dejaría la
> investigación sin poder atribuir qué proceso produjo qué. Para reproducir la
> diarización, hacerlo **fuera del runner**: invocar `diarize()` directamente
> sobre una copia local del `normalized.wav`, sin reclamar nada.
>
> El worker histórico de esa máquina (`/home/santiagov/services/transcript-worker`,
> Python 3.10) no se toca: tiene su propio entorno y su propio servicio.

---

## Reproceso: qué conserva y qué no

Si la investigación acaba en «hay que volver a diarizar», el mecanismo es
`npm run w3:reprocess` (ver §7 bis del runbook). Lo que hace y lo que **no**:

- **Conserva** el job fallido y el run anteriores, intactos, con sus `attempts`.
- **Conserva** la versión de transcript anterior: `tv_run_key UNIQUE (run_id)`
  da una versión por run, así que el run nuevo **añade** una fila y la vieja
  sigue ahí con sus segmentos y sus hablantes.
- **Pero una ingesta exitosa REPUNTA `meetings.active_transcript_id`** a la
  versión del run nuevo (`service.ts:1406`, dentro de `ingestRun`). Todo lo que
  lee «la transcripción activa» —la pantalla de detalle, `getMeetingState`,
  `getActiveTranscript`— pasa a mostrar la nueva.

Comprobado en ejecución contra una base desechable, no deducido del código: tras
la ingesta del run 2 conviven **2 versiones**, la del run 1 sigue intacta con sus
15 segmentos, el puntero apunta a la del run 2, y meter una segunda versión en el
mismo run es imposible (`tv_run_key`).

Consecuencia práctica: **no se puede prometer que el puntero no cambia.** Si hace
falta comparar el antes y el después, hay que guardar el id de la versión actual
(`a0b50364-…`) antes de reprocesar; seguirá existiendo, pero dejará de ser la
activa y habrá que consultarla por id.

---

## Estado de la verificación de la UI, con su alcance real

Lo que se probó de la pantalla de Reuniones y **hasta dónde llega cada prueba**:

- **Lectura del detalle, hablantes y reproducción del audio:** verificado en el
  navegador contra una base desechable, con bytes reales servidos por un MinIO
  local. La reproducción avanzó de 0,54 s a 2,94 s con el buffer completo.
- **Subida desde el navegador:** el fichero se inyectó en el `input` con un
  `DataTransfer` y se disparó un evento `change` sintético. **Es una
  verificación parcial**: prueba la cadena desde el manejador de React hacia
  abajo —hash, creación, firma, PUT con progreso, confirmación y sondeo— y el
  resultado en la base es real. **No prueba** la interacción nativa: el selector
  de ficheros del sistema, el arrastrar y soltar de verdad, ni los permisos que
  el navegador aplica a un `File` elegido por una persona. Eso sigue pendiente de
  una pasada manual.
- **Almacenamiento:** el PUT fue HTTP real, pero contra **MinIO**, no contra R2.
  MinIO no devuelve `ChecksumSHA256` en el `HEAD`, así que la verificación del
  contenido **por parte del almacenamiento** no se ejercitó; `evaluateConfirm`
  aceptó por tamaño. En R2 debería salir verificada, y es en R2 donde hay que
  comprobarlo.
- **Qué commit está desplegado:** no se puede inferir de la ausencia de una regla
  CSS ni de un texto en el DOM. Eso sólo dice que el bundle servido no contiene
  esa regla, lo cual es compatible con varios commits. Para saber qué está
  desplegado hay que leerlo del servicio: el commit que Railway reporta en el
  despliegue, o un endpoint que exponga el SHA de la build.

---

## Pendiente fuera del código

- **CORS del bucket de R2**, sin lo cual la subida desde el navegador falla en el
  preflight. Las cabeceras salen de `signPut`, que firma `content-type`,
  `content-length` y `x-amz-checksum-sha256` (esta última se mantiene como
  cabecera, `unhoistableHeaders`, no va a la query). Origen: el dominio exacto de
  staging, nunca `*`.
- **Railway**: apuntar el servicio a `t3/meetings-ui` cuando se quiera desplegar
  la pantalla.
