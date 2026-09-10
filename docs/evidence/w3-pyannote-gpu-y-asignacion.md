# pyannote en la GTX 1650 SUPER, y la asignación al texto

Todo medido en `ml-server`. El servicio histórico (`uvicorn:8001`, 960 MiB de VRAM)
**no se tocó** y respondió 200 antes y después. La reunión `cc00c4cf-…` **no se
reprocesó**: su transcripción activa sigue siendo `a0b50364-…`.

## 1 · La puerta de la GPU: pasa, con una condición dura

| | libre antes | resultado | reloj | pico del proceso |
|---|---|---|---|---|
| con el worker W3 corriendo | 1586 MiB | **OOM → cae a wespeaker** | — | — |
| ídem, `expandable_segments` | 1586 MiB | **OOM → cae a wespeaker** | — | — |
| worker W3 parado (ventana controlada) | 2746 MiB | **pyannote_full ✓** | 10,6 s frío · **6,7 s caliente** | 1746 MiB |

`6,7 s` para 119,59 s de audio son **0,06× tiempo real**, frente a los 137 s en CPU:
**20× más rápido**. Y el resultado en GPU es **idéntico** al de CPU — 47 turnos,
74,95 / 25,05, acierto 73,2 %, Hombre 71,4 % con 0,0 % atribuido a la Mujer. La tarjeta
llegó a 2716 MiB de 4096, con 1000 MiB libres en el peor momento.

### La condición: whisper y pyannote no caben a la vez

Presupuesto real de la tarjeta: 3717 MiB utilizables − 960 del histórico = **2757 MiB**
para el worker.

    whisper medium residente   1160 MiB
    pyannote_full              1670 MiB
    ─────────────────────────────────────
    total                      2830 MiB   >  2757   ✗ por ~73 MiB

Se pasa por muy poco, y por eso OOM-eó con el worker en marcha. Pero **no hace falta
que coexistan**: `transcribe` y `diarize` son jobs distintos. Cada uno cabe solo
(1160 + 960 = 2120 ✓ · 1670 + 960 = 2630 ✓). El arreglo es **liberar el modelo que no
se está usando al cambiar de etapa**, a cambio de recargarlo (~4 s pyannote).

## 2 · Un fallo que la prueba destapó, y que era el peligro real

Cuando pyannote OOM-eó, `diarize()` cayó a wespeaker y devolvió
`_backend_used="wespeaker"`. Pero `run_diarize` (stages.py) lee `result.get("backend")`
— una clave que **`diarize()` nunca devuelve** — y escribe `cfg.DIARIZATION_BACKEND`.

Es decir: con pyannote como predeterminado y sin liberar VRAM, **cada reunión habría
OOM-eado, caído al wespeaker roto, y guardado `diarization_backend = 'pyannote_full'`
en la base.** Resultados malos etiquetados como arreglados. Su propio docstring dice
que evita justamente eso.

## 3 · Los 47 turnos NO se convierten en 47 bloques

`alignSegments` etiqueta los **segmentos de whisper**, no los turnos. Con 26 turnos o
con 47, los bloques visuales son los mismos **14** y sus tiempos son los del texto.
Estructuralmente, la legibilidad no estaba en riesgo.

## 4 · Pero detectar bien los turnos NO basta — tenías razón

Transcripción **nueva y aislada** (misma configuración: `medium`/`cuda`/`float16`; 14
segmentos, no los 15 almacenados — whisper no es bit-determinista entre ejecuciones).

El segmento 0 va de **0,96 a 10,72 s** y contiene a las dos personas:

> «Bueno, ¿y qué te gustaría almorzar? **No sé. Podríamos comer pollo.**»

Por mayor solape, pyannote se lo da a `SPEAKER_01` (3,81 s contra 2,73 s). O sea: **la
pregunta de la Mujer queda atribuida al Hombre.** Mejorar los turnos hizo que el bloque
cambiara de respuesta equivocada. 5 de los 14 segmentos quedan marcados `overlap=true`:
el sistema *sabe* que están mezclados y aun así escribe una sola etiqueta.

## 5 · La atribución por palabra lo resuelve, y sigue siendo legible

Whisper **ya produce tiempos por palabra** (`word_timestamps=True`); hoy el worker no
los pide. No se parte texto por proporción de caracteres: se usan esos tiempos reales.

    0.96- 3.94  SPEAKER_00  Bueno, ¿y qué te gustaría almorzar?
    5.02-10.72  SPEAKER_01  No sé. Podríamos comer pollo.

Barrido de la guarda mínima, para no acabar en picadillo:

| guarda | bloques | de 1–2 palabras | global | Hombre | Hombre «a otro» | Mujer |
|---|---|---|---|---|---|---|
| por segmento (hoy) | 14 | — | 83,7 % | 71,4 % | 22,9 % | 85,4 % |
| sin guarda | 35 | 12 | 88,2 % | 91,4 % | 0,0 % | 87,8 % |
| **≥ 3 palabras** | **23** | **0** | **88,9 %** | **91,4 %** | **0,0 %** | **88,6 %** |
| ≥ 3 palabras y ≥ 0,6 s | 22 | 0 | 88,9 % | 84,3 % | 8,6 % | 89,6 % |
| ≥ 6 palabras y ≥ 1,2 s | 18 | 0 | 83,0 % | 14,3 % | 80,0 % | 92,6 % |

**≥ 3 palabras, sin suelo de duración.** El suelo temporal es contraproducente: absorbe
las réplicas cortas y correctas del Hombre (91,4 % → 84,3 %, y su «a otro» sube de 0 a
8,6 %). Con la guarda de palabras quedan **23 bloques** —no 35, no 47—, **ningún**
fragmento de una o dos palabras, y los tiempos siguen siendo los de las palabras dentro
del segmento original: no se inventa ninguna frontera.

## Alcance

La referencia cubre los primeros 57 s. Los porcentajes de arriba se miden ahí y no se
extrapolan al resto del audio.
