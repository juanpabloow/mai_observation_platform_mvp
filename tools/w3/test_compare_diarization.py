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
    render_summary,
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

print("disagreements")
# Mismo reparto temporal, nombres distintos: NO puede reportarse como acuerdo, porque
# las etiquetas de dos ejecuciones no son el mismo espacio de nombres.
a = [turn(0, 4, "SPEAKER_00"), turn(4, 8, "SPEAKER_01")]
b = [turn(0, 4, "SPEAKER_01"), turn(4, 8, "SPEAKER_00")]
diff = disagreements(a, b, duration=8.0, step=1.0)
check(len(diff) == 8, "renombrar hablantes cuenta como desacuerdo en todos los instantes")
identico = disagreements(a, a, duration=8.0, step=1.0)
check(identico == [], "una ejecución consigo misma no difiere en ningún instante")

# Un tercer hablante que aparece sólo en una de las dos: los instantes son los de escuchar.
tres = [turn(0, 4, "SPEAKER_00"), turn(4, 6, "SPEAKER_02"), turn(6, 8, "SPEAKER_01")]
dos = [turn(0, 4, "SPEAKER_00"), turn(4, 8, "SPEAKER_01")]
diff3 = disagreements(dos, tres, duration=8.0, step=1.0)
# `dos` dice SPEAKER_01 de 4 a 8; `tres` mete SPEAKER_02 de 4 a 6 y vuelve a
# SPEAKER_01 en 6. Así que difieren en 4 y 5, y COINCIDEN en 6 y 7: el desacuerdo es
# el intervalo del tercer hablante, no todo lo que hay después de él.
check([t for t, _, _ in diff3] == [4.0, 5.0],
      "señala sólo los segundos donde reparten distinto, no la cola entera")
check([(row[1], row[2]) for row in diff3] == [("SPEAKER_01", "SPEAKER_02")] * 2,
      "y dice qué puso cada ejecución en esos segundos")
check(all(isinstance(row, tuple) and len(row) == 3 for row in diff3),
      "cada fila es (instante, izquierda, derecha)")

print("render_summary")
report = render_summary(
    device="cpu",
    audio="/tmp/audio.wav",
    params={"min_speakers": 1, "max_speakers": 10, "source": "app.config.settings"},
    runs={"auto": summarize(result), "ns3": summarize(result)},
    diff=diff3,
    warnings=["la GPU estaba ocupada"],
)
check("device=cpu" in report, "el device queda escrito: CPU y GPU no se mezclan")
check("backend fijado: `wespeaker`" in report, "el backend fijado queda escrito")
check("min=1 max=10" in report, "los parámetros del pipeline quedan escritos")
check("la GPU estaba ocupada" in report, "los avisos viajan con el resultado")
check("NO dice cuál acierta" in report, "el informe no pretende juzgar sin oído")
check(str(len(diff3)) in report, "el número de instantes en desacuerdo aparece")

print()
if FAILURES:
    print(f"{len(FAILURES)} fallo(s)")
    raise SystemExit(1)
print("todo verde")
