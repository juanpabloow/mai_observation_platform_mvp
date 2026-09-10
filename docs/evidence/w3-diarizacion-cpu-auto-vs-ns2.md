# Diarización · auto vs fijo — device=cpu

* audio: `cc00c4cf-normalized.wav`
* backend fijado: `wespeaker`
* parámetros del pipeline: min=1 max=10
* lo único que varía: `num_speakers`

| ejecución | voces | turnos | hablado (s) | tiempo (s) |
|---|---|---|---|---|
| auto | 2 | 26 | 100.16 | 6.37 |
| ns2 | 2 | 26 | 100.16 | 2.98 |

**auto** · reparto: `{"SPEAKER_00": 98.1, "SPEAKER_01": 1.9}`
**ns2** · reparto: `{"SPEAKER_00": 98.1, "SPEAKER_01": 1.9}`

## Emparejado de etiquetas

`SPEAKER_00` de una ejecución no es el de la otra. Las del run fijo se traducen al espacio de nombres del automático por SOLAPE MÁXIMO, y sólo después se comparan; si no, una permutación pura de nombres se reportaría como desacuerdo en todos los instantes.

| fijo | → automático |
|---|---|
| `SPEAKER_00` | `SPEAKER_00` |
| `SPEAKER_01` | `SPEAKER_01` |

## Instantes en desacuerdo (ya emparejados): 0

Emparejadas las etiquetas, esto SÍ es desacuerdo real: la frontera de un turno se movió o un tramo cambió de hablante. Sigue sin decir cuál acierta — eso lo dice la referencia a oído, no la comparación entre dos ejecuciones.

Ninguno: las dos ejecuciones cubren el audio igual.

## Contra la referencia a oído

Los nombres de la referencia son de quien escuchó y NO se presuponen equivalentes a ningún `SPEAKER_NN`: se emparejan igual, por solape. El alcance es el tramo anotado y sólo ése.

**auto** · tramo 0.0–57.0 s · acierto **69.1 %** · perdido como silencio 20.9 % · atribuido a otro 10.0 %

  · emparejado: `{"SPEAKER_00": "Mujer", "SPEAKER_01": "SPEAKER_01~sin-par"}`

  | voz de referencia | anotado (s) | acierto | silencio | a otro |
  |---|---|---|---|---|
  | Hombre | 7.0 | 0.0 % | 24.3 % | 75.7 % |
  | Mujer | 50.0 | 78.8 % | 20.4 % | 0.8 % |

  | intervalo | s | referencia | dominante | acierto |
  |---|---|---|---|---|
  | 0.0–5.0 | 5.0 | Mujer | Mujer | 54.0 % |
  | 5.0–10.0 | 5.0 | Hombre | Mujer | 0.0 % |
  | 10.0–15.0 | 5.0 | Mujer | Mujer | 78.0 % |
  | 15.0–16.0 | 1.0 | Hombre | Mujer | 0.0 % |
  | 16.0–26.0 | 10.0 | Mujer | Mujer | 84.0 % |
  | 26.0–27.0 | 1.0 | Hombre | Mujer | 0.0 % |
  | 27.0–57.0 | 30.0 | Mujer | Mujer | 81.3 % |

**ns2** · tramo 0.0–57.0 s · acierto **69.1 %** · perdido como silencio 20.9 % · atribuido a otro 10.0 %

  · emparejado: `{"SPEAKER_00": "Mujer", "SPEAKER_01": "SPEAKER_01~sin-par"}`

  | voz de referencia | anotado (s) | acierto | silencio | a otro |
  |---|---|---|---|---|
  | Hombre | 7.0 | 0.0 % | 24.3 % | 75.7 % |
  | Mujer | 50.0 | 78.8 % | 20.4 % | 0.8 % |

  | intervalo | s | referencia | dominante | acierto |
  |---|---|---|---|---|
  | 0.0–5.0 | 5.0 | Mujer | Mujer | 54.0 % |
  | 5.0–10.0 | 5.0 | Hombre | Mujer | 0.0 % |
  | 10.0–15.0 | 5.0 | Mujer | Mujer | 78.0 % |
  | 15.0–16.0 | 1.0 | Hombre | Mujer | 0.0 % |
  | 16.0–26.0 | 10.0 | Mujer | Mujer | 84.0 % |
  | 26.0–27.0 | 1.0 | Hombre | Mujer | 0.0 % |
  | 27.0–57.0 | 30.0 | Mujer | Mujer | 81.3 % |
