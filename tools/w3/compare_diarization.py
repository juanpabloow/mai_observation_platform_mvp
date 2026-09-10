#!/usr/bin/env python3
"""Compara diarización automática frente a un número fijo de hablantes, aislada.

    # 1 · CPU, siempre seguro (no compite por la GPU con el servicio)
    python3 tools/w3/compare_diarization.py --audio /tmp/audio.wav --device cpu \
        --num-speakers 2 --reference tools/w3/reference-cc00c4cf.tsv --out /tmp/w3cmp

    # 2 · GPU, sólo con la GPU demostrablemente libre (ver --allow-busy-gpu)
    python3 tools/w3/compare_diarization.py --audio /tmp/audio.wav --device cuda \
        --num-speakers 2 --reference tools/w3/reference-cc00c4cf.tsv --out /tmp/w3cmp

QUÉ ES Y QUÉ NO ES
------------------
Es una prueba LOCAL Y AISLADA: importa el servicio de diarización del worker y lo
llama dos veces sobre el MISMO fichero. No abre puerto, no arranca un segundo
consumidor, no reclama jobs, no habla con PostgreSQL ni con R2, y no escribe nada
fuera de `--out`. El servicio `vanegas-w3-worker.service` sigue como esté.

LO QUE SE FIJA, Y POR QUÉ
-------------------------
* `backend="wespeaker"` EXPLÍCITO. `diarize()` cae en `cfg.DIARIZATION_BACKEND` si no
  se le dice, así que sin fijarlo la comparación dependería de la configuración del
  momento y dos ejecuciones podrían usar backends distintos sin avisar.
* `min_speakers` y `max_speakers` se LEEN de la configuración del propio worker, no se
  escriben aquí. Son los mismos valores que usa el pipeline; escribir 1 y 10 a mano
  sería inventar una tercera fuente de verdad que se desincroniza en cuanto alguien
  cambie el `.env`.
* Lo ÚNICO que varía entre las dos ejecuciones es `num_speakers`. Eso es la prueba.
* `--num-speakers` vale DOS por defecto. La primera versión de esto comparaba contra
  tres, que no es la hipótesis del caso: la grabación tiene dos voces.

LAS ETIQUETAS SE EMPAREJAN ANTES DE COMPARAR
--------------------------------------------
`SPEAKER_00` de una ejecución no es el `SPEAKER_00` de la otra: son índices de cluster
y el orden en que salen no significa nada. Comparar los nombres tal cual hace que una
PERMUTACIÓN PURA —la misma segmentación con los nombres cambiados— se reporte como
desacuerdo en todos los instantes, que es exactamente la conclusión contraria a la
correcta. `match_labels` resuelve la asignación de SOLAPE MÁXIMO (exacta, por DP sobre
máscara de bits, no voraz) y traduce las etiquetas de la segunda ejecución al espacio
de nombres de la primera. `test_compare_diarization.py` lo exige: permutar los nombres
tiene que dar CERO desacuerdos.

QUÉ DICE Y QUÉ NO DICE LA COMPARACIÓN ENTRE DOS EJECUCIONES
-----------------------------------------------------------
Dos ejecuciones que se parecen no son dos ejecuciones correctas: pueden equivocarse
igual. Comparar `auto` con `ns2` dice si fijar el número de hablantes CAMBIA algo, y
por tanto si el problema está en la elección de `k` o más arriba, en cómo se trocea el
audio antes de agrupar. Quién acierta lo dice `--reference`, y sólo dentro del tramo
anotado.

CPU Y GPU NO SE MEZCLAN
-----------------------
Los resultados salen a ficheros con el device en el nombre y el resumen dice cuál
fue. Comparar un `auto` en CPU con un `ns3` en GPU no mide el número de hablantes:
mide dos cosas a la vez. Empieza por CPU, que no depende de que la GPU esté libre.

QUE EL SERVICIO ESTÉ ACTIVO NO SIGNIFICA QUE ESTÉ EN REPOSO
-----------------------------------------------------------
`systemctl --user is-active` dice que el proceso vive, no que no esté transcribiendo.
Para `--device cuda` esto exige que `nvidia-smi` no reporte NINGÚN proceso de cómputo,
que es la única evidencia real de reposo disponible desde fuera. Se puede saltar con
`--allow-busy-gpu`, y entonces lo que salga lleva ese aviso escrito.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
import shutil
import subprocess
import sys
import time
import wave
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_WORKER_ROOT = "/home/santiagov/services/mai-w3-worker/transcript-worker"
BACKEND = "wespeaker"

# ── Partes puras: se prueban sin worker, sin torch y sin GPU ────────────────────


def summarize(result: Dict[str, Any]) -> Dict[str, Any]:
    """Los números que se comparan entre dos ejecuciones."""
    turns = result.get("speaker_turns") or []
    per_speaker: Dict[str, float] = {}
    for turn in turns:
        label = str(turn.get("speaker"))
        span = float(turn.get("end", 0.0)) - float(turn.get("start", 0.0))
        per_speaker[label] = round(per_speaker.get(label, 0.0) + max(span, 0.0), 2)
    spoken = round(sum(per_speaker.values()), 2)
    return {
        "unique_speakers": result.get("unique_speakers"),
        "turn_count": len(turns),
        "speech_segments": result.get("speech_segments"),
        "audio_duration_seconds": result.get("audio_duration_seconds"),
        "processing_time_seconds": result.get("processing_time_seconds"),
        "spoken_seconds_total": spoken,
        "seconds_per_speaker": dict(sorted(per_speaker.items())),
        "share_pct_per_speaker": {
            label: round(100.0 * seconds / spoken, 1) if spoken > 0 else 0.0
            for label, seconds in sorted(per_speaker.items())
        },
    }


def label_at(turns: List[Dict[str, Any]], t: float) -> Optional[str]:
    """Qué etiqueta cubre el segundo `t`. None si ninguna: silencio, no herencia."""
    for turn in turns:
        if float(turn.get("start", 0.0)) <= t < float(turn.get("end", 0.0)):
            return str(turn.get("speaker"))
    return None


def label_timeline(
    turns: List[Dict[str, Any]], duration: float, step: float = 1.0
) -> List[Tuple[float, Optional[str]]]:
    """Muestreo regular, para cotejar con el audio en segundos concretos."""
    out: List[Tuple[float, Optional[str]]] = []
    t = 0.0
    while t < duration:
        out.append((round(t, 2), label_at(turns, t)))
        t += step
    return out


def disagreements(
    a: List[Dict[str, Any]],
    b: List[Dict[str, Any]],
    duration: float,
    step: float = 1.0,
    match: bool = True,
) -> List[Tuple[float, Optional[str], Optional[str]]]:
    """
    Segundos donde las dos ejecuciones NO coinciden, con las etiquetas EMPAREJADAS.

    `SPEAKER_00` de una ejecución no es el de la otra: son índices de cluster. Sin
    emparejar, dos ejecuciones idénticas salvo por una permutación de nombres se
    reportan como desacuerdo en todos los instantes, que se lee como «no se parecen
    en nada» cuando son exactamente la misma segmentación. Por eso `match=True` es el
    valor por defecto: primero se traducen los nombres de `b` al espacio de `a` por
    solape máximo, y sólo entonces se compara.

    Emparejadas las etiquetas, lo que queda SÍ es desacuerdo real: la frontera de un
    turno se movió, o un tramo cambió de hablante. Sigue sin decir cuál acierta —para
    eso está la referencia a oído—, pero ya no señala instantes que no lo son.

    `match=False` deja la comparación cruda por nombre. Está para poder mostrar la
    diferencia entre las dos lecturas, no para usarla como medida.
    """
    if match:
        b = relabel(b, match_labels(a, b))
    ta = dict(label_timeline(a, duration, step))
    tb = dict(label_timeline(b, duration, step))
    return [(t, ta[t], tb.get(t)) for t in sorted(ta) if ta[t] != tb.get(t)]


# ── Emparejar etiquetas antes de comparar ──────────────────────────────────────


def overlap_matrix(
    a: List[Dict[str, Any]], b: List[Dict[str, Any]]
) -> Tuple[List[str], List[str], List[List[float]]]:
    """Segundos de solape temporal entre cada etiqueta de `a` y cada una de `b`."""
    labels_a = sorted({str(t.get("speaker")) for t in a})
    labels_b = sorted({str(t.get("speaker")) for t in b})
    index_a = {label: i for i, label in enumerate(labels_a)}
    index_b = {label: j for j, label in enumerate(labels_b)}
    grid = [[0.0] * len(labels_b) for _ in labels_a]
    for ta in a:
        sa, ea = float(ta.get("start", 0.0)), float(ta.get("end", 0.0))
        if ea <= sa:
            continue
        i = index_a[str(ta.get("speaker"))]
        for tb in b:
            sb, eb = float(tb.get("start", 0.0)), float(tb.get("end", 0.0))
            shared = min(ea, eb) - max(sa, sb)
            if shared > 0:
                grid[i][index_b[str(tb.get("speaker"))]] += shared
    return labels_a, labels_b, grid


def _best_assignment(grid: List[List[float]], n_rows: int, n_cols: int) -> List[int]:
    """
    Asignación de solape máximo, exacta, por DP sobre máscara de bits.

    No es una heurística voraz: emparejar por «el mejor de cada fila» puede dar dos
    filas a la misma columna y decidirse por el orden de recorrido, que es justo la
    clase de arbitrariedad que haría que el informe cambiara sin que cambien los
    datos. Con `n <= 10` hablantes esto son ~10 · 2^10 pasos.

    Devuelve, por fila, la columna asignada, o -1 si esa fila se queda sin par.
    """
    if n_rows == 0 or n_cols == 0:
        return [-1] * n_rows
    NEG = float("-inf")
    # best[row][mask] = mejor solape total asignando las filas >= row con las
    # columnas todavía libres en `mask`.
    size = 1 << n_cols
    best = [[NEG] * size for _ in range(n_rows + 1)]
    take = [[-2] * size for _ in range(n_rows + 1)]
    for mask in range(size):
        best[n_rows][mask] = 0.0
    for row in range(n_rows - 1, -1, -1):
        for mask in range(size):
            # Dejar esta fila sin par siempre es legal: las dos ejecuciones pueden
            # tener distinto número de etiquetas y forzar un par sería inventarlo.
            unpaired = best[row + 1][mask]
            top, chosen = NEG, -1
            for col in range(n_cols):
                bit = 1 << col
                if not mask & bit:
                    continue
                value = grid[row][col] + best[row + 1][mask ^ bit]
                if value > top:
                    top, chosen = value, col
            # Los empates se rompen SIEMPRE igual, y hacia el mismo lado: entre dos
            # asignaciones de idéntico solape gana emparejar (`unpaired > top` es
            # estricto) y, dentro de una fila, la columna de índice menor (`value >
            # top` también lo es). No es que una sea más correcta; es que sin una
            # regla fija el informe cambiaría sin que cambien los datos. El par de
            # solape CERO lo descarta después `match_labels`.
            if chosen == -1 or unpaired > top:
                top, chosen = unpaired, -1
            best[row][mask], take[row][mask] = top, chosen
    assignment = [-1] * n_rows
    mask = size - 1
    for row in range(n_rows):
        col = take[row][mask]
        assignment[row] = col
        if col >= 0:
            mask ^= 1 << col
    return assignment


def match_labels(
    a: List[Dict[str, Any]], b: List[Dict[str, Any]]
) -> Dict[str, str]:
    """
    Traduce las etiquetas de `b` al espacio de nombres de `a`, por solape máximo.

    `SPEAKER_00` de una ejecución no es el `SPEAKER_00` de la otra: son índices de
    cluster, y el orden en que salen no significa nada. Comparar los nombres tal cual
    hace que una PERMUTACIÓN PURA —la misma segmentación con los nombres cambiados—
    se lea como desacuerdo total, que es la conclusión contraria a la correcta.

    Las etiquetas de `b` que no encuentran par (porque `b` tiene más hablantes) se
    conservan con un sufijo, para que se vean como lo que son: algo que sólo existe
    en una de las dos ejecuciones, no un desacuerdo con un hablante concreto.
    """
    labels_a, labels_b, grid = overlap_matrix(a, b)
    if not labels_b:
        return {}
    # La DP asigna filas→columnas; aquí interesa columna(b)→fila(a), así que se
    # traspone y se resuelve en esa orientación.
    transposed = [[grid[i][j] for i in range(len(labels_a))] for j in range(len(labels_b))]
    assignment = _best_assignment(transposed, len(labels_b), len(labels_a))
    mapping: Dict[str, str] = {}
    for j, label_b in enumerate(labels_b):
        i = assignment[j]
        # Un par con solape cero no es un par: son dos etiquetas que nunca coinciden
        # en el tiempo, y renombrar una como la otra fabricaría un acuerdo falso.
        if i >= 0 and transposed[j][i] > 0:
            mapping[label_b] = labels_a[i]
        else:
            mapping[label_b] = f"{label_b}~sin-par"
    return mapping


def relabel(turns: List[Dict[str, Any]], mapping: Dict[str, str]) -> List[Dict[str, Any]]:
    """Aplica un emparejado. No toca los tiempos: sólo el nombre."""
    return [
        {**turn, "speaker": mapping.get(str(turn.get("speaker")), str(turn.get("speaker")))}
        for turn in turns
    ]


# ── Referencia manual del oído ─────────────────────────────────────────────────


def parse_reference(text: str) -> List[Dict[str, Any]]:
    """
    Lee la anotación a oído: `inicio  fin  nombre` por línea, `#` comenta.

    Los tiempos se admiten en segundos (`5`, `5.5`) o como `mm:ss`. Los nombres son
    los de quien escuchó —«Mujer», «Hombre»—, y NO se presuponen equivalentes a
    ningún `SPEAKER_NN`: para eso está `match_labels`.
    """
    out: List[Dict[str, Any]] = []
    for position, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        parts = line.replace(",", " ").replace("\t", " ").split()
        if len(parts) < 3:
            raise SystemExit(f"Referencia, línea {position}: hacen falta inicio, fin y nombre — {raw!r}")
        start, end = _seconds(parts[0], position), _seconds(parts[1], position)
        if end <= start:
            raise SystemExit(f"Referencia, línea {position}: el fin no es posterior al inicio — {raw!r}")
        out.append({"start": start, "end": end, "speaker": " ".join(parts[2:])})
    if not out:
        raise SystemExit("La referencia no tiene ningún intervalo.")
    return sorted(out, key=lambda row: row["start"])


def _seconds(token: str, position: int) -> float:
    try:
        if ":" in token:
            minutes, seconds = token.split(":", 1)
            return float(minutes) * 60.0 + float(seconds)
        return float(token)
    except ValueError:
        raise SystemExit(f"Referencia, línea {position}: {token!r} no es un tiempo") from None


def score_against_reference(
    turns: List[Dict[str, Any]], reference: List[Dict[str, Any]], step: float = 0.1
) -> Dict[str, Any]:
    """
    Cuánto acierta una ejecución contra la referencia, DENTRO del tramo anotado.

    Se emparejan primero las etiquetas con la referencia (mismo motivo de siempre) y
    después se mide por muestreo fino. El alcance es el tramo anotado y sólo ése: el
    resto del audio no está anotado y extrapolar ahí sería inventar.

    `missed_as_silence` separa los dos modos de fallo, que piden arreglos distintos:
    la VAD no oyó nada (silencio) frente a oyó y atribuyó a quien no era.
    """
    mapping = match_labels(reference, turns)
    mapped = relabel(turns, mapping)
    window_start = min(row["start"] for row in reference)
    window_end = max(row["end"] for row in reference)

    total = hits = silence = wrong = 0
    per_speaker: Dict[str, Dict[str, int]] = {}
    t = window_start
    while t < window_end:
        truth = label_at(reference, t)
        if truth is not None:
            got = label_at(mapped, t)
            bucket = per_speaker.setdefault(truth, {"total": 0, "hit": 0, "silence": 0, "wrong": 0})
            total += 1
            bucket["total"] += 1
            if got == truth:
                hits += 1
                bucket["hit"] += 1
            elif got is None:
                silence += 1
                bucket["silence"] += 1
            else:
                wrong += 1
                bucket["wrong"] += 1
        t = round(t + step, 6)

    pct = lambda part: round(100.0 * part / total, 1) if total else 0.0  # noqa: E731
    return {
        "mapping": mapping,
        "window": [round(window_start, 2), round(window_end, 2)],
        "sampled_points": total,
        "accuracy_pct": pct(hits),
        "missed_as_silence_pct": pct(silence),
        "attributed_to_other_pct": pct(wrong),
        "per_reference_speaker": {
            name: {
                "seconds_annotated": round(counts["total"] * step, 2),
                "accuracy_pct": round(100.0 * counts["hit"] / counts["total"], 1) if counts["total"] else 0.0,
                "missed_as_silence_pct": round(100.0 * counts["silence"] / counts["total"], 1) if counts["total"] else 0.0,
                "attributed_to_other_pct": round(100.0 * counts["wrong"] / counts["total"], 1) if counts["total"] else 0.0,
            }
            for name, counts in sorted(per_speaker.items())
        },
    }


def reference_intervals_report(
    turns: List[Dict[str, Any]], reference: List[Dict[str, Any]], step: float = 0.1
) -> List[Dict[str, Any]]:
    """
    Intervalo a intervalo: qué puso la ejecución donde la referencia dice quién habla.

    Las intervenciones cortas son las que se pierden primero y las que no se ven en un
    porcentaje global, así que se listan una a una.
    """
    mapping = match_labels(reference, turns)
    mapped = relabel(turns, mapping)
    rows: List[Dict[str, Any]] = []
    for row in reference:
        counts: Dict[str, int] = {}
        total = 0
        t = row["start"]
        while t < row["end"]:
            got = label_at(mapped, t)
            counts[got if got is not None else "—silencio—"] = counts.get(got if got is not None else "—silencio—", 0) + 1
            total += 1
            t = round(t + step, 6)
        dominant = max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0] if counts else "—silencio—"
        rows.append({
            "start": round(row["start"], 2),
            "end": round(row["end"], 2),
            "seconds": round(row["end"] - row["start"], 2),
            "reference": row["speaker"],
            "dominant": dominant,
            "correct_pct": round(100.0 * counts.get(row["speaker"], 0) / total, 1) if total else 0.0,
            "breakdown": {k: round(v * step, 2) for k, v in sorted(counts.items())},
        })
    return rows


def render_summary(
    device: str,
    audio: str,
    params: Dict[str, Any],
    runs: Dict[str, Dict[str, Any]],
    diff: List[Tuple[float, Optional[str], Optional[str]]],
    warnings: List[str],
    mapping: Optional[Dict[str, str]] = None,
    reference: Optional[Dict[str, Dict[str, Any]]] = None,
) -> str:
    lines = [
        f"# Diarización · auto vs fijo — device={device}",
        "",
        f"* audio: `{os.path.basename(audio)}`",
        f"* backend fijado: `{BACKEND}`",
        f"* parámetros del pipeline: min={params['min_speakers']} max={params['max_speakers']}",
        f"* lo único que varía: `num_speakers`",
        "",
    ]
    for warning in warnings:
        lines.append(f"> ⚠ {warning}")
    if warnings:
        lines.append("")
    lines.append("| ejecución | voces | turnos | hablado (s) | tiempo (s) |")
    lines.append("|---|---|---|---|---|")
    for tag, summary in runs.items():
        lines.append(
            f"| {tag} | {summary['unique_speakers']} | {summary['turn_count']} "
            f"| {summary['spoken_seconds_total']} | {summary['processing_time_seconds']} |"
        )
    lines.append("")
    for tag, summary in runs.items():
        lines.append(f"**{tag}** · reparto: `{json.dumps(summary['share_pct_per_speaker'])}`")
    lines.append("")

    if mapping is not None:
        lines.append("## Emparejado de etiquetas")
        lines.append("")
        lines.append(
            "`SPEAKER_00` de una ejecución no es el de la otra. Las del run fijo se "
            "traducen al espacio de nombres del automático por SOLAPE MÁXIMO, y sólo "
            "después se comparan; si no, una permutación pura de nombres se reportaría "
            "como desacuerdo en todos los instantes."
        )
        lines.append("")
        lines.append("| fijo | → automático |")
        lines.append("|---|---|")
        for source, target in sorted(mapping.items()):
            lines.append(f"| `{source}` | `{target}` |")
        lines.append("")

    lines.append(f"## Instantes en desacuerdo (ya emparejados): {len(diff)}")
    lines.append("")
    lines.append(
        "Emparejadas las etiquetas, esto SÍ es desacuerdo real: la frontera de un turno "
        "se movió o un tramo cambió de hablante. Sigue sin decir cuál acierta — eso lo "
        "dice la referencia a oído, no la comparación entre dos ejecuciones."
    )
    lines.append("")
    if diff:
        lines.append("| s | auto | fijo (emparejado) |")
        lines.append("|---|---|---|")
        for t, left, right in diff[:60]:
            lines.append(f"| {t} | {left or '—'} | {right or '—'} |")
        if len(diff) > 60:
            lines.append(f"| … | ({len(diff) - 60} más) | |")
    else:
        lines.append("Ninguno: las dos ejecuciones cubren el audio igual.")
    lines.append("")

    if reference:
        lines.append("## Contra la referencia a oído")
        lines.append("")
        lines.append(
            "Los nombres de la referencia son de quien escuchó y NO se presuponen "
            "equivalentes a ningún `SPEAKER_NN`: se emparejan igual, por solape. El "
            "alcance es el tramo anotado y sólo ése."
        )
        lines.append("")
        for tag, score in reference.items():
            window = score["window"]
            lines.append(
                f"**{tag}** · tramo {window[0]}–{window[1]} s · acierto "
                f"**{score['accuracy_pct']} %** · perdido como silencio "
                f"{score['missed_as_silence_pct']} % · atribuido a otro "
                f"{score['attributed_to_other_pct']} %"
            )
            lines.append("")
            lines.append(f"  · emparejado: `{json.dumps(score['mapping'], ensure_ascii=False)}`")
            lines.append("")
            lines.append("  | voz de referencia | anotado (s) | acierto | silencio | a otro |")
            lines.append("  |---|---|---|---|---|")
            for name, row in score["per_reference_speaker"].items():
                lines.append(
                    f"  | {name} | {row['seconds_annotated']} | {row['accuracy_pct']} % "
                    f"| {row['missed_as_silence_pct']} % | {row['attributed_to_other_pct']} % |"
                )
            lines.append("")
            intervals = score.get("intervals") or []
            if intervals:
                lines.append("  | intervalo | s | referencia | dominante | acierto |")
                lines.append("  |---|---|---|---|---|")
                for row in intervals:
                    lines.append(
                        f"  | {row['start']}–{row['end']} | {row['seconds']} | {row['reference']} "
                        f"| {row['dominant']} | {row['correct_pct']} % |"
                    )
                lines.append("")

    return "\n".join(lines)


# ── Entorno: resolución, comprobaciones y las dos llamadas ─────────────────────


def probe_wav(path: str) -> Dict[str, Any]:
    """
    El insumo debe ser el WAV NORMALIZADO, no el original subido.

    Un fichero ilegible aborta con un mensaje, no con un traceback de `chunk.py`: el
    error más probable aquí es haber pasado el m4a original o un `.wav` truncado, y
    eso hay que poder leerlo de un vistazo.
    """
    try:
        return _probe_wav(path)
    except Exception as cause:  # noqa: BLE001
        raise SystemExit(
            f"No pude leer {path} como WAV ({type(cause).__name__}: {cause}). "
            "Esta comparación necesita el audio NORMALIZADO del pipeline "
            "(16 kHz mono s16le), no el original subido."
        )


def _probe_wav(path: str) -> Dict[str, Any]:
    with wave.open(path, "rb") as handle:
        frames, rate, channels, width = (
            handle.getnframes(),
            handle.getframerate(),
            handle.getnchannels(),
            handle.getsampwidth(),
        )
    return {
        "duration_seconds": round(frames / float(rate), 2) if rate else 0.0,
        "sample_rate": rate,
        "channels": channels,
        "sample_width_bytes": width,
    }


def gpu_compute_processes() -> Optional[List[str]]:
    """
    Procesos de cómputo en la GPU. None si `nvidia-smi` no está: sin evidencia no se
    afirma que esté libre.
    """
    if shutil.which("nvidia-smi") is None:
        return None
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory",
             "--format=csv,noheader"],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


def user_unit_state(unit: str) -> str:
    try:
        out = subprocess.run(
            ["systemctl", "--user", "is-active", unit],
            capture_output=True, text=True, timeout=20, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return "desconocido"
    return out.stdout.strip() or "desconocido"


def load_worker(root: str) -> Tuple[Any, Dict[str, Any]]:
    """
    Importa el servicio de diarización del worker y LEE sus parámetros.

    Falla ruidosamente si la firma no tiene lo que esta prueba necesita: es preferible
    a llamar con menos argumentos y comparar dos cosas distintas creyendo que son la
    misma.
    """
    if not os.path.isdir(root):
        raise SystemExit(f"No existe el worker en {root} (usa --worker-root)")
    sys.path.insert(0, root)
    os.chdir(root)  # el config del worker resuelve rutas relativas a su raíz
    try:
        from app.services.diarization_service import diarize  # type: ignore
    except Exception as cause:  # noqa: BLE001 — se reporta tal cual y se aborta
        raise SystemExit(f"No se pudo importar diarization_service desde {root}: {cause}")

    signature = inspect.signature(diarize)
    for needed in ("audio_path", "device", "min_speakers", "max_speakers", "num_speakers", "backend"):
        if needed not in signature.parameters:
            raise SystemExit(
                f"`diarize()` en {root} no acepta `{needed}`. Firma real: {signature}. "
                "Esta comparación exige fijar backend y número de hablantes; revísala "
                "antes de sacar conclusiones."
            )

    params: Dict[str, Any] = {}
    try:
        from app.config import settings  # type: ignore
        params["min_speakers"] = int(getattr(settings, "diarization_min_speakers"))
        params["max_speakers"] = int(getattr(settings, "diarization_max_speakers"))
        params["source"] = "app.config.settings"
    except Exception:  # noqa: BLE001
        try:
            from app import config as cfg  # type: ignore
            params["min_speakers"] = int(getattr(cfg, "DIARIZATION_MIN_SPEAKERS"))
            params["max_speakers"] = int(getattr(cfg, "DIARIZATION_MAX_SPEAKERS"))
            params["source"] = "app.config (módulo)"
        except Exception as cause:  # noqa: BLE001
            raise SystemExit(
                "No se pudieron leer min/max speakers de la configuración del worker "
                f"({cause}). No se escriben a mano: serían una tercera fuente de verdad."
            )
    return diarize, params


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--audio", required=True, help="WAV normalizado (16 kHz mono)")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--out", required=True, help="Directorio de salida")
    parser.add_argument(
        "--num-speakers",
        type=int,
        default=2,
        help="El número que se fija en la segunda ejecución. Para este caso son DOS: "
             "la comparación publicada al principio iba contra tres, que no es la "
             "hipótesis que hay sobre la mesa.",
    )
    parser.add_argument(
        "--reference",
        help="Anotación a oído (`inicio fin nombre` por línea, mm:ss o segundos). "
             "Cotejar contra ella es lo único que dice cuál acierta.",
    )
    parser.add_argument(
        "--reference-step", type=float, default=0.1,
        help="Paso del muestreo contra la referencia, en s. Fino a propósito: las "
             "intervenciones de un segundo no se ven con paso de 1 s.",
    )
    parser.add_argument("--worker-root", default=DEFAULT_WORKER_ROOT)
    parser.add_argument("--unit", default="vanegas-w3-worker.service")
    parser.add_argument("--step", type=float, default=1.0, help="Paso del muestreo, en s")
    parser.add_argument(
        "--allow-busy-gpu",
        action="store_true",
        help="Correr en cuda aunque haya procesos de cómputo. Lo que salga lo dirá.",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.audio):
        raise SystemExit(f"No existe el audio: {args.audio}")
    audio = os.path.abspath(args.audio)
    out_dir = os.path.abspath(args.out)
    # `load_worker` hace `chdir` a la raíz del worker —su config resuelve rutas
    # relativas contra ella—, así que TODA ruta de la línea de comandos se absolutiza
    # ANTES. Con `--reference` relativa esto reventaba después de las dos
    # ejecuciones, tirando el trabajo ya hecho por una ruta.
    reference_path = os.path.abspath(args.reference) if args.reference else None
    if reference_path and not os.path.isfile(reference_path):
        raise SystemExit(f"No existe la referencia: {reference_path}")
    os.makedirs(out_dir, exist_ok=True)

    probe = probe_wav(audio)
    warnings: List[str] = []
    if probe["sample_rate"] != 16000 or probe["channels"] != 1:
        warnings.append(
            f"El audio es {probe['sample_rate']} Hz / {probe['channels']} canal(es). "
            "El pipeline diariza el NORMALIZADO (16 kHz mono); con otro insumo esto no "
            "reproduce lo que hizo el worker."
        )

    unit = user_unit_state(args.unit)
    processes = gpu_compute_processes()
    print(f"servicio {args.unit}: {unit}  (activo != en reposo)")
    if processes is None:
        print("nvidia-smi: no disponible — sin evidencia de que la GPU esté libre")
    else:
        print(f"procesos de cómputo en GPU: {len(processes)}")
        for line in processes:
            print(f"  · {line}")

    if args.device == "cuda":
        if processes is None and not args.allow_busy_gpu:
            raise SystemExit(
                "No puedo comprobar si la GPU está libre (falta nvidia-smi). Empieza por "
                "--device cpu, o repite con --allow-busy-gpu asumiendo la contención."
            )
        if processes and not args.allow_busy_gpu:
            raise SystemExit(
                f"Hay {len(processes)} proceso(s) usando la GPU: el servicio está trabajando. "
                "Corre primero --device cpu; repite en cuda cuando esté en reposo, o fuerza "
                "con --allow-busy-gpu."
            )
        if processes and args.allow_busy_gpu:
            warnings.append(
                f"Ejecutado con {len(processes)} proceso(s) compitiendo por la GPU: los "
                "tiempos no son comparables y el resultado pudo verse afectado por VRAM."
            )

    diarize, params = load_worker(args.worker_root)
    print(f"parámetros del pipeline ({params['source']}): "
          f"min={params['min_speakers']} max={params['max_speakers']}")

    runs: Dict[str, Dict[str, Any]] = {}
    raw: Dict[str, Dict[str, Any]] = {}
    for tag, num in (("auto", None), (f"ns{args.num_speakers}", args.num_speakers)):
        print(f"→ {tag} (device={args.device}, backend={BACKEND}, num_speakers={num}) …")
        started = time.time()
        result = diarize(
            audio_path=audio,
            device=args.device,
            min_speakers=params["min_speakers"],
            max_speakers=params["max_speakers"],
            num_speakers=num,
            file_id=f"w3cmp-{tag}",
            backend=BACKEND,
        )
        wall = round(time.time() - started, 2)
        raw[tag] = result
        runs[tag] = summarize(result)
        runs[tag]["wall_seconds"] = wall
        path = os.path.join(out_dir, f"diar_{args.device}_{tag}.json")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {"device": args.device, "backend": BACKEND, "num_speakers": num,
                 "params": params, "audio_probe": probe, "result": result},
                handle, indent=2, ensure_ascii=False,
            )
        print(f"  voces={runs[tag]['unique_speakers']} turnos={runs[tag]['turn_count']} "
              f"wall={wall}s → {os.path.basename(path)}")

    tags = list(runs)
    duration = float(probe["duration_seconds"])
    turns_a = raw[tags[0]].get("speaker_turns") or []
    turns_b = raw[tags[1]].get("speaker_turns") or []

    mapping = match_labels(turns_a, turns_b)
    diff = disagreements(turns_a, turns_b, duration, args.step)
    raw_diff = disagreements(turns_a, turns_b, duration, args.step, match=False)
    print(f"emparejado fijo→auto: {json.dumps(mapping)}")
    print(f"desacuerdo: {len(diff)} instantes emparejados "
          f"({len(raw_diff)} si se comparan los nombres crudos)")

    scores: Dict[str, Dict[str, Any]] = {}
    if reference_path:
        with open(reference_path, encoding="utf-8") as handle:
            reference_rows = parse_reference(handle.read())
        for tag in tags:
            score = score_against_reference(
                raw[tag].get("speaker_turns") or [], reference_rows, args.reference_step
            )
            score["intervals"] = reference_intervals_report(
                raw[tag].get("speaker_turns") or [], reference_rows, args.reference_step
            )
            scores[tag] = score
            print(f"contra la referencia · {tag}: acierto {score['accuracy_pct']} % "
                  f"(silencio {score['missed_as_silence_pct']} %, "
                  f"a otro {score['attributed_to_other_pct']} %)")
        with open(os.path.join(out_dir, f"reference_{args.device}.json"), "w", encoding="utf-8") as handle:
            json.dump({"reference": reference_rows, "scores": scores}, handle, indent=2, ensure_ascii=False)

    report = render_summary(
        args.device, audio, params, runs, diff, warnings, mapping, scores or None
    )
    report_path = os.path.join(out_dir, f"summary_{args.device}.md")
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write(report)
    print(f"\n{report}")
    print(f"→ {report_path}")
    print("No se ha tocado la base, ni R2, ni la cola, ni el servicio.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
