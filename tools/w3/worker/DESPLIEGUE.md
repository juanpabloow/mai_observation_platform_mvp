# Orden de despliegue y vuelta atrás · palabras, v2, speakerCount y backend

**Nada de esto se ha desplegado.** Los cambios del worker viven en una copia aislada
(`/home/santiagov/w3-work/transcript-worker`); el árbol del servicio
(`/home/santiagov/services/mai-w3-worker/transcript-worker`) está en `2452aba`, con
`git status` limpio, y el servicio no se ha tocado.

## ⚠ Dos cosas que descubrí al preparar el despliegue, y que cambian el plan

### 1 · Cambiar el `default` de `config.py` NO cambia el backend

`.env.w3` del servicio contiene **`DIARIZATION_BACKEND=wespeaker`**, explícito. Las
variables de entorno ganan al `default` del modelo de settings, así que el cambio en
`config.py` es, por sí solo, **inocuo**: el servicio seguiría corriendo wespeaker y
nadie se enteraría de que el despliegue no hizo nada.

El paso 3 tiene por tanto DOS partes, y la del fichero es la que manda:

    # copia de seguridad ANTES de tocarlo
    cp ~/services/mai-w3-worker/transcript-worker/.env.w3{,.bak-AAAAMMDD}
    # y cambiar la linea
    DIARIZATION_BACKEND=pyannote_full

Que el `default` del código coincida sigue siendo lo correcto —es lo que se aplica si
alguien despliega sin ese fichero—, pero no es lo que decide aquí.

La contrapartida es buena: **la vuelta atrás del backend es editar una línea y
reiniciar**, sin tocar código.

### 2 · La prueba de GPU NO validó el `compute_type` del servicio

La ventana del 10 de septiembre corrió con **`float16`**, porque la copia aislada no
tiene `.env.w3`. El servicio usa **`WHISPER_COMPUTE_TYPE=int8_float16`**.

Son distintos, así que **esa prueba no valida esta configuración**. Lo que sí midió
—`pyannote_full` sin caída a la reserva, pico de 2286 MiB, 460 MiB libres— vale para
`float16`. Cabe esperar que `int8_float16` consuma MENOS (cuantiza los pesos), pero eso
es un razonamiento, no una medida, y en esta tarjeta el razonamiento ya ha fallado dos
veces.

**RESUELTO.** Se repitió la ventana con la configuración real, sobre el commit
`c2614b2` que es lo que se va a desplegar, y verificando los valores EFECTIVOS antes de
medir nada — cargar `.env.w3` no basta, porque ese fichero todavía dice `wespeaker`, así
que el backend se sobreescribe en la prueba y el guion aborta si lo efectivo no es lo
que se pretende validar.

| | `float16` (ventana 1) | **`int8_float16` (config real)** |
|---|---|---|
| transcribe | 38,2 s | **14,4 s** |
| diarize | 12,0 s | 11,5 s |
| pico del proceso | 2286 MiB | **1750 MiB** |
| pico de la tarjeta | 3256 | **2720** de 3717 |
| libre mínimo | 460 MiB | **996 MiB** |
| backend | pyannote_full | **pyannote_full** |

La configuración real es **mejor** en las dos dimensiones que preocupaban: 2,65× más
rápida transcribiendo y 536 MiB menos de pico, con el margen casi duplicado.

Y explica de paso una discrepancia que arrastraba sin resolver: la transcripción
aislada que hice con `float16` daba **14** segmentos y la de producción **15**. Con
`int8_float16` salen 15. Whisper no es idéntico entre tipos de cómputo, y el que
importa es el que corre.

## El orden, y por qué es ese

    1. migración        1784000000000_meetings-speaker-uncertain
    2. mai (web/API)    07aa488 y anteriores
    3. worker           w3-worker.patch  +  .env.w3: DIARIZATION_BACKEND=pyannote_full

**1 antes que 2** porque el código nuevo de mai escribe `speaker_uncertain` en cada
segmento. La migración es aditiva (`ADD COLUMN … NOT NULL DEFAULT false`), así que el
mai VIEJO sigue funcionando con la columna ya puesta: sus `INSERT` no la nombran y el
DEFAULT la rellena. Se puede aplicar sin prisa por el paso 2.

**2 antes que 3** y esto sí es un cerrojo: el worker nuevo emite `schema_version` 2 del
transcript, y el mai viejo sólo admite la 1 — `parseTranscriptArtifact` lanza
`unsupported_schema_version` y la ingesta falla con el artefacto ya subido y la GPU ya
gastada. El mai nuevo admite **las dos** (`SUPPORTED_TRANSCRIPT_VERSIONS = [1, 2]`),
así que en la ventana entre 2 y 3 el worker viejo sigue emitiendo v1 y mai lo lee sin
problema. La ventana es segura en un sentido y sólo en uno.

El artefacto de **diarización se queda en v1**: su formato no cambió. Iban compartiendo
una constante `SCHEMA_VERSION`, y subir el transcript habría subido también el de
turnos, que mai habría rechazado por la cabecera. Están separados y hay prueba.

## Vuelta atrás, en orden inverso

### 3 · worker — reversible en un minuto, sin desplegar código

El cambio más arriesgado es el backend, y su vuelta atrás **no necesita revertir nada**:

    # en `.env.w3` del servicio
    DIARIZATION_BACKEND=wespeaker
    systemctl --user restart vanegas-w3-worker.service

Eso deja `pyannote_full` fuera conservando el resto (palabras, v2, speakerCount, y la
linkage `complete` arreglada). Es la mitigación que hay que intentar ANTES de revertir
código, porque casi todo lo que puede salir mal en la GPU es el backend.

Para revertir el worker entero:

    cd /home/santiagov/services/mai-w3-worker/transcript-worker
    git checkout -- .            # el arbol esta limpio: no hay nada propio que perder
    systemctl --user restart vanegas-w3-worker.service

El worker viejo vuelve a emitir v1, que el mai nuevo sigue leyendo. **Esta vuelta atrás
es segura y no deja nada inconsistente.**

### 2 · mai — con una consecuencia que hay que aceptar antes de desplegar

Revertir mai a la versión anterior a `07e0abe` tiene un coste **asimétrico**: las
reuniones ya procesadas con la pila nueva tienen en R2 un transcript v2, y el mai viejo
**no puede volver a ingerirlo**. Las filas ya escritas siguen bien —son segmentos
normales—, así que la pantalla no se rompe; lo que deja de funcionar es
**reingerir o reprocesar esas reuniones concretas** hasta volver a poner el mai nuevo.

Si se revierte mai, hay que revertir el worker PRIMERO (paso 3), o el worker seguirá
emitiendo v2 contra un mai que no lo admite y toda reunión nueva fallará en la ingesta.

### 1 · migración — la última, y sólo si hace falta

    MEETINGS_ENV_KIND=staging … npx tsx src/scripts/meetingsRollbackPreflight.ts
    npx node-pg-migrate --tsx down 1

El preflight comprueba que la cabeza de `pgmigrations` sea exactamente las **6** de
Reuniones en orden, y aborta si alguien metió otra encima — que es justo lo que hizo
cuando se añadió ésta. Revertirla sólo pierde el indicador `speaker_uncertain`; ningún
otro dato depende de él.

**No hay que revertirla** para volver atrás en el código: la columna con su DEFAULT es
inocua para el mai viejo. Dejarla puesta es lo razonable salvo que estorbe.

## Qué comprobar en cada paso antes de seguir al siguiente

| paso | señal de que fue bien | señal de que hay que parar |
|---|---|---|
| 1 migración | `\d meeting_segments` muestra `speaker_uncertain` | cualquier error del `up` |
| 2 mai | una reunión NUEVA con el worker viejo se ingiere y se ve | `unsupported_schema_version` en los eventos del job |
| 3 worker | en el diario: `[diarize] backend='pyannote_full'` y `num_speakers=…` | `Falling back to 'wespeaker'` — es el OOM, ver abajo |

Si aparece el `Falling back`, la base ya **no** mentirá sobre ello: ese era el defecto
que se corrigió, y ahora `diarization_backend` guarda el backend que corrió de verdad.
