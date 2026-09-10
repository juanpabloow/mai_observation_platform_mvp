#!/usr/bin/env python3
"""Compara diarización automática frente a un número fijo de hablantes, aislada.

    # 1 · CPU, siempre seguro (no compite por la GPU con el servicio)
    python3 tools/w3/compare_diarization.py --audio /tmp/audio.wav --device cpu --out /tmp/w3cmp

    # 2 · GPU, sólo con la GPU demostrablemente libre (ver --allow-busy-gpu)
    python3 tools/w3/compare_diarization.py --audio /tmp/audio.wav --device cuda --out /tmp/w3cmp

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
    a: List[Dict[str, Any]], b: List[Dict[str, Any]], duration: float, step: float = 1.0
) -> List[Tuple[float, Optional[str], Optional[str]]]:
    """
    Segundos donde las dos ejecuciones NO coinciden.

    Las etiquetas de dos ejecuciones no son comparables por su nombre —`SPEAKER_00` de
    una no es el de la otra—, así que esto no dice «cuál acierta»: dice DÓNDE difieren,
    que es la lista de instantes que hay que escuchar. El juicio es del oído.
    """
    ta = dict(label_timeline(a, duration, step))
    tb = dict(label_timeline(b, duration, step))
    return [(t, ta[t], tb.get(t)) for t in sorted(ta) if ta[t] != tb.get(t)]


def render_summary(
    device: str,
    audio: str,
    params: Dict[str, Any],
    runs: Dict[str, Dict[str, Any]],
    diff: List[Tuple[float, Optional[str], Optional[str]]],
    warnings: List[str],
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
    lines.append(f"## Instantes en desacuerdo: {len(diff)}")
    lines.append("")
    lines.append(
        "Las etiquetas de dos ejecuciones no son comparables por nombre, así que esto "
        "NO dice cuál acierta: dice qué segundos hay que escuchar."
    )
    lines.append("")
    if diff:
        lines.append("| s | auto | fijo |")
        lines.append("|---|---|---|")
        for t, left, right in diff[:60]:
            lines.append(f"| {t} | {left or '—'} | {right or '—'} |")
        if len(diff) > 60:
            lines.append(f"| … | ({len(diff) - 60} más) | |")
    else:
        lines.append("Ninguno: las dos ejecuciones cubren el audio igual.")
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
    parser.add_argument("--num-speakers", type=int, default=3)
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
    diff = disagreements(
        raw[tags[0]].get("speaker_turns") or [],
        raw[tags[1]].get("speaker_turns") or [],
        duration,
        args.step,
    )
    report = render_summary(args.device, audio, params, runs, diff, warnings)
    report_path = os.path.join(out_dir, f"summary_{args.device}.md")
    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write(report)
    print(f"\n{report}")
    print(f"→ {report_path}")
    print("No se ha tocado la base, ni R2, ni la cola, ni el servicio.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
