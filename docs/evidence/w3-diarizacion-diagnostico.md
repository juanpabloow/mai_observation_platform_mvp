# Diagnóstico · el reparto 98,1 / 1,9 de la reunión W-3

Reunión `cc00c4cf-a69f-46a3-acf7-f22e90fed109`. Todo lo de aquí se midió **fuera del
consumidor de la cola**, en CPU, sobre el `normalized.wav` de la propia reunión. No se
reclamó ningún job, no se tocó PostgreSQL, R2 ni el servicio, **no se volvió a
transcribir** y la transcripción activa (`a0b50364-8d89-41b1-9696-d4f046f4b61d`) sigue
siendo la misma.

## El insumo, verificado antes de usarlo

3.827.132 B · 119,594688 s · 16 kHz · 1 canal · `pcm_s16le` · sha256
`c3455aaa…5b817`. El tamaño coincide exactamente con el registrado para el artefacto
normalizado, y el checksum se comprobó otra vez tras copiarlo a la máquina Linux.

## La reproducción es fiel

`auto` en CPU devuelve **26 turnos** y **98,10 / 1,90**, que es exactamente lo que
produjo el run de producción en CUDA. La comparación mide, por tanto, lo que pasó.

## `num_speakers=2` no cambia NADA

Los turnos de `auto` y de `ns2` son **idénticos objeto a objeto**: 0 instantes en
desacuerdo emparejados, y 0 también comparando los nombres en crudo. La razón es que
`auto` ya elegía `k=2` (`avg_pairwise_similarity` 0,3131, muy por debajo del 0,75 de la
puerta 1; mejor silueta en k=2). Forzar dos hablantes ejecuta el mismo agrupamiento.

**Esto descarta la hipótesis del número de hablantes.** El arreglo no está en `k`.

## El denominador, corregido

`talk_share_pct` se calcula en `alignSegments` sobre la suma de los turnos: es
porcentaje **del habla detectada**, no de la duración. La VAD detectó **100,16 s** de
119,59 (83,8 %). Así que `SPEAKER_01` = 1,90 % × 100,16 = **1,90 s** exactos — no los
«~2,3 s» del handoff, que dividía por la duración total.

## Ni la VAD ni la embedding son el problema

Contra la referencia a oído, la intervención masculina de **00:05–00:10** cae en tres
segmentos de VAD propios: `5,06–7,26`, `7,84–8,92` y `9,88–10,44`. **La VAD sí puso
frontera ahí.**

Y la embedding distingue las voces sin ambigüedad: el coseno entre el centroide del
Hombre y el de la Mujer es **0,2931**, y los dos segmentos masculinos puntúan **0,8094**
contra el centroide del Hombre frente a 0,27 y 0,20 contra el de la Mujer.

## Lo que falla es `linkage="average"`

En `cluster_embeddings`, `AgglomerativeClustering(metric="cosine", linkage="average")`
con k=2 parte los 26 segmentos así:

| cluster | segmentos | segundos | duraciones |
|---|---|---|---|
| 0 | 23 | 98,26 | de 0,56 a 9,46 — **la Mujer y el Hombre juntos** |
| 1 | 3 | 1,90 | 0,42 · 0,42 · 1,06 |

El reparto 98,1 / 1,9 no es «dos personas»: es **«los segmentos largos» contra «los
tres más cortos»**. `SPEAKER_01` no solapa ninguna intervención masculina — el cotejo
lo empareja como `~sin-par`. La linkage por media aísla primero los atípicos, y las
embeddings de 0,42 s son ruido casi ortogonal a las dos voces (segmento 22,26–22,68:
0,005 contra el Hombre, 0,190 contra la Mujer).

### Descartar los segmentos cortos NO lo arregla

Resultado negativo que conviene tener escrito: con umbral de 0,8 s y de 1,0 s el
acierto del Hombre sigue siendo **0,0 %**, porque la linkage por media se limita a
aislar los siguientes atípicos. El problema es la linkage, no los segmentos cortos.

## Qué sí lo arregla, sobre las MISMAS embeddings

Cambiando **sólo** la linkage, con `num_speakers=2`:

| variante | reparto | acierto Hombre | Hombre «a otro» |
|---|---|---|---|
| `cosine/average` (hoy) | 98,10 / 1,90 | **0,0 %** | 75,7 % |
| `cosine/complete` | 65,95 / 34,05 | **61,4 %** | 14,3 % |
| `euclidean/ward` | 64,06 / 35,94 | 61,4 % | 14,3 % |
| **`pyannote_full`** | **74,95 / 25,05** | **71,4 %** | **0,0 %** |

`pyannote_full` es el único que acierta en **las tres** intervenciones masculinas
—00:05–00:10 al 66 %, 00:15–00:16 al **100 %**, 00:26–00:27 al 70 %— y el único que no
atribuye **nada** del habla del Hombre a la Mujer. Su segmentación neuronal da 47 turnos
en vez de 26 y sí corta en `13,68–14,19` y `14,81–16,52`, que es la interjección de un
segundo que el trozo `14,90–21,86` de la VAD por energía se tragaba entera.

`auto` y `ns2` también coinciden con `pyannote_full`: encuentra dos voces por su cuenta.

Coste: 137 s de reloj en CPU para 120 s de audio. En la GTX 1650 SUPER, mucho menos.

## Dos defectos, no uno

1. **La linkage del agrupamiento** (`average`). Es la causa del 98,1 / 1,9 y se lleva la
   intervención masculina de cinco segundos. Es el defecto dominante.
2. **`merge_gap_ms=400` de la VAD por energía.** La interjección de 00:15–00:16 se queda
   en 0 % con **todas** las variantes de wespeaker, porque el trozo `14,90–21,86` la
   absorbe. Sólo la segmentación neuronal la recupera.

Y de paso, `min_speech_ms`/umbral de −45 dB dejan fuera el **20,4 %** del habla anotada
de la Mujer como silencio. Es un tercer asunto, menor, y no se toca aquí.

## Sobre el porcentaje global, que aquí engaña

El acierto global apenas se mueve (69,1 % → 70,2 % → 73,2 %) porque la Mujer ocupa 50
de los 57 s anotados y ya se acertaba. Lo que cambia es lo que importa: el Hombre pasa
de **invisible** a detectado. `complete` mejora al Hombre a costa de atribuirle algo de
la Mujer (su «a otro» sube de 0,8 % a 8,2 %); `pyannote_full` mejora los dos.

## Alcance, explícito

La referencia cubre **los primeros 57 s** y nada de esto se extrapola más allá. El
reparto global de `pyannote_full` (74,95 / 25,05) sobre los 119,59 s **no se declara
correcto**: en el tramo anotado la proporción es 87,7 / 12,3, y el resto del audio no
está anotado — el Hombre puede hablar más después de 00:57. Lo que sí está medido es
que las tres intervenciones anotadas se detectan y se atribuyen bien.

## Cómo reproducirlo

    python3 tools/w3/compare_diarization.py --audio normalized.wav --device cpu \
        --num-speakers 2 --reference tools/w3/reference-cc00c4cf.tsv --out out-cpu
    python3 tools/w3/probe_embeddings.py           # VAD, embeddings y separabilidad
    python3 tools/w3/probe_clustering_variants.py  # linkage y selección de k
    python3 tools/w3/probe_pyannote.py             # el otro backend admitido
