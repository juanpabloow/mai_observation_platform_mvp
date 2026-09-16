#!/usr/bin/env python3
"""Prueba las partes PURAS de compare_diarization.py.

    python3 tools/w3/test_compare_diarization.py

Corre en cualquier sitio: no importa el worker, ni torch, ni necesita GPU, base de
datos o red. Eso es a propósito — el script de comparación se puede verificar antes de
llevarlo a la máquina Linux, y así lo que se lleva no es un borrador.

Lo que se afirma es lo que decide si la comparación sirve: que el reparto por hablante
se calcule sobre los turnos, que `label_at` no herede etiqueta en los silencios, y que
el desacuerdo entre dos ejecuciones se mida por instante y NO pretenda decir cuál
acierta — las etiquetas de dos ejecuciones no son comparables por su nombre.
"""

from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from compare_diarization import (  # noqa: E402
    disagreements,
    label_at,
    label_timeline,
    match_labels,
    overlap_matrix,
    parse_reference,
    reference_intervals_report,
    relabel,
    render_summary,
    score_against_reference,
    summarize,
)

FAILURES = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"  ok   {message}")
    else:
        print(f"  FAIL {message}")
        FAILURES.append(message)


def turn(start: float, end: float, speaker: str) -> dict:
    return {"start": start, "end": end, "speaker": speaker}


print("summarize")
result = {
    "unique_speakers": 2,
    "speech_segments": 4,
    "audio_duration_seconds": 20.0,
    "processing_time_seconds": 1.5,
    "speaker_turns": [
        turn(0, 4, "SPEAKER_00"),
        turn(4, 6, "SPEAKER_01"),
        turn(6, 10, "SPEAKER_00"),
    ],
}
s = summarize(result)
check(s["turn_count"] == 3, "cuenta los turnos")
check(s["seconds_per_speaker"] == {"SPEAKER_00": 8.0, "SPEAKER_01": 2.0},
      "suma segundos por hablante sobre los TURNOS")
check(s["spoken_seconds_total"] == 10.0, "el total es lo hablado, no la duración del audio")
check(s["share_pct_per_speaker"] == {"SPEAKER_00": 80.0, "SPEAKER_01": 20.0}, "reparto en %")

print("summarize · casos degenerados")
vacio = summarize({"unique_speakers": 0, "speaker_turns": []})
check(vacio["turn_count"] == 0 and vacio["spoken_seconds_total"] == 0.0,
      "sin turnos no divide por cero")
negativo = summarize({"speaker_turns": [turn(5, 3, "SPEAKER_00")]})
check(negativo["seconds_per_speaker"] == {"SPEAKER_00": 0.0},
      "un turno con fin < inicio no resta tiempo")

print("label_at")
turns = [turn(0, 4, "A"), turn(6, 10, "B")]
check(label_at(turns, 0) == "A", "el borde inicial pertenece al turno")
check(label_at(turns, 3.99) == "A", "dentro")
check(label_at(turns, 4) is None, "el borde final NO pertenece: los turnos no se solapan por redondeo")
check(label_at(turns, 5) is None, "un silencio no hereda la etiqueta anterior")
check(label_at(turns, 7) == "B", "el siguiente turno")
check(label_at([], 1) is None, "sin turnos, nadie")

print("label_timeline")
timeline = label_timeline(turns, duration=8.0, step=2.0)
check([label for _, label in timeline] == ["A", "A", None, "B"], "muestrea a paso fijo")
check([t for t, _ in timeline] == [0.0, 2.0, 4.0, 6.0], "los instantes son los del paso")

print("overlap_matrix")
labels_a, labels_b, grid = overlap_matrix(
    [turn(0, 4, "A"), turn(4, 8, "B")],
    [turn(0, 3, "X"), turn(3, 8, "Y")],
)
check(labels_a == ["A", "B"] and labels_b == ["X", "Y"], "etiquetas ordenadas y estables")
check(grid == [[3.0, 1.0], [0.0, 4.0]], "cada celda son los segundos de solape")

print("match_labels · la permutación es lo que hay que sobrevivir")
a = [turn(0, 4, "SPEAKER_00"), turn(4, 8, "SPEAKER_01")]
permutado = [turn(0, 4, "SPEAKER_01"), turn(4, 8, "SPEAKER_00")]
mapping = match_labels(a, permutado)
check(mapping == {"SPEAKER_01": "SPEAKER_00", "SPEAKER_00": "SPEAKER_01"},
      "empareja por solape, no por nombre")
check(relabel(permutado, mapping) == a, "aplicado, la permutación se deshace")

# El emparejado voraz («el mejor de cada fila») fallaría aquí: las dos etiquetas de
# la derecha prefieren `A`, y quedarse con eso dejaría `B` sin par y perdería 5 s.
codicioso = match_labels(
    [turn(0, 10, "A"), turn(10, 16, "B")],
    [turn(0, 6, "X"), turn(6, 10, "Y"), turn(10, 15, "Y")],
)
check(codicioso == {"X": "A", "Y": "B"},
      "maximiza el solape TOTAL, no el de cada etiqueta por separado")

sin_par = match_labels([turn(0, 4, "A")], [turn(0, 4, "X"), turn(10, 14, "Z")])
check(sin_par["X"] == "A", "la que solapa se empareja")
check(sin_par["Z"].endswith("~sin-par"),
      "una etiqueta con solape cero NO se renombra como otra: se marca sin par")
check(match_labels([], []) == {} and match_labels(a, []) == {}, "sin turnos, sin emparejado")

print("disagreements · emparejado por defecto")
diff = disagreements(a, permutado, duration=8.0, step=1.0)
check(diff == [],
      "PERMUTAR LOS NOMBRES NO PRODUCE DESACUERDO: es la misma segmentación")
crudo = disagreements(a, permutado, duration=8.0, step=1.0, match=False)
check(len(crudo) == 8,
      "y sin emparejar sí lo produciría en los 8 instantes — la lectura contraria")
identico = disagreements(a, a, duration=8.0, step=1.0)
check(identico == [], "una ejecución consigo misma no difiere en ningún instante")

# Con las etiquetas ya emparejadas, lo que queda es desacuerdo real: la frontera se
# movió. Se comprueba con nombres permutados A PROPÓSITO, para que el resultado no
# pueda salir bien por coincidencia de nombres.
movido = [turn(0, 6, "SPEAKER_01"), turn(6, 8, "SPEAKER_00")]
diff_movido = disagreements(a, movido, duration=8.0, step=1.0)
check([t for t, _, _ in diff_movido] == [4.0, 5.0],
      "una frontera desplazada sí sale, y sólo en los segundos que cambian")

# Un tercer hablante que aparece sólo en una de las dos: los instantes son los de escuchar.
tres = [turn(0, 4, "SPEAKER_00"), turn(4, 6, "SPEAKER_02"), turn(6, 8, "SPEAKER_01")]
dos = [turn(0, 4, "SPEAKER_00"), turn(4, 8, "SPEAKER_01")]
diff3 = disagreements(dos, tres, duration=8.0, step=1.0)
check([t for t, _, _ in diff3] == [4.0, 5.0],
      "señala sólo los segundos donde reparten distinto, no la cola entera")
check(all(isinstance(row, tuple) and len(row) == 3 for row in diff3),
      "cada fila es (instante, izquierda, derecha)")

print("parse_reference")
ref = parse_reference("""
# comentario
00:00  00:05  Mujer
00:05  00:10  Hombre
10     15     Mujer
""")
check([r["speaker"] for r in ref] == ["Mujer", "Hombre", "Mujer"], "lee los nombres")
check([r["start"] for r in ref] == [0.0, 5.0, 10.0], "mm:ss y segundos dan lo mismo")
check([r["end"] for r in ref] == [5.0, 10.0, 15.0], "y los finales")

print("score_against_reference")
# Una ejecución perfecta salvo por los nombres, que son índices de cluster.
perfecta = [turn(0, 5, "SPEAKER_07"), turn(5, 10, "SPEAKER_03"), turn(10, 15, "SPEAKER_07")]
score = score_against_reference(perfecta, ref, step=0.1)
check(score["accuracy_pct"] == 100.0,
      "acierto pleno pese a que los nombres no se parecen a los de la referencia")
check(score["mapping"] == {"SPEAKER_07": "Mujer", "SPEAKER_03": "Hombre"},
      "y el emparejado dice qué etiqueta es qué voz")
check(score["window"] == [0.0, 15.0], "el alcance es el tramo anotado, no el audio entero")

# El modo de fallo del caso: la voz breve se absorbe en la dominante. No es lo mismo
# que no oírla, y el informe tiene que distinguirlo.
colapsada = [turn(0, 15, "SPEAKER_00")]
malo = score_against_reference(colapsada, ref, step=0.1)
check(malo["per_reference_speaker"]["Hombre"]["attributed_to_other_pct"] == 100.0,
      "atribuir la voz breve a la dominante se reporta como «a otro»")
check(malo["per_reference_speaker"]["Hombre"]["missed_as_silence_pct"] == 0.0,
      "y NO como silencio: son dos fallos distintos con arreglos distintos")

muda = score_against_reference([turn(0, 5, "S0"), turn(10, 15, "S0")], ref, step=0.1)
check(muda["per_reference_speaker"]["Hombre"]["missed_as_silence_pct"] == 100.0,
      "no oír nada donde la referencia dice que se habla sí es silencio")

print("reference_intervals_report")
filas = reference_intervals_report(colapsada, ref, step=0.1)
check(len(filas) == 3, "una fila por intervalo anotado")
check(filas[1]["reference"] == "Hombre" and filas[1]["seconds"] == 5.0,
      "la intervención de cinco segundos aparece con su duración")
check(filas[1]["correct_pct"] == 0.0, "y con su acierto, que aquí es cero")

print("render_summary")
report = render_summary(
    device="cpu",
    audio="/tmp/audio.wav",
    params={"min_speakers": 1, "max_speakers": 10, "source": "app.config.settings"},
    runs={"auto": summarize(result), "ns2": summarize(result)},
    diff=diff3,
    warnings=["la GPU estaba ocupada"],
    mapping={"SPEAKER_00": "SPEAKER_01"},
    reference={"auto": {**score, "intervals": filas}},
)
check("device=cpu" in report, "el device queda escrito: CPU y GPU no se mezclan")
check("backend fijado: `wespeaker`" in report, "el backend fijado queda escrito")
check("min=1 max=10" in report, "los parámetros del pipeline quedan escritos")
check("la GPU estaba ocupada" in report, "los avisos viajan con el resultado")
check("Emparejado de etiquetas" in report, "el emparejado queda escrito, no implícito")
check("ya emparejados" in report, "y el desacuerdo dice que ya está emparejado")
check("Contra la referencia a oído" in report, "la referencia entra en el informe")
check(str(len(diff3)) in report, "el número de instantes en desacuerdo aparece")

print()
if FAILURES:
    print(f"{len(FAILURES)} fallo(s)")
    raise SystemExit(1)
print("todo verde")
