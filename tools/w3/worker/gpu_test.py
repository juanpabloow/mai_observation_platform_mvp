#!/usr/bin/env python3
"""La UNICA prueba de GPU: ¿cabe pyannote si la etapa suelta whisper primero?

Corre la secuencia REAL de produccion DENTRO DE UN MISMO PROCESO, que es como ocurre
en el worker: cargar whisper -> transcribir -> run_diarize (que llama a
`whisper_service.unload()`) -> pyannote. Un proceso aparte no probaria nada, porque no
puede liberar la memoria del worker.

NO reclama trabajos, NO habla con mai, NO sube resultados y NO escribe fuera de --out.
Usa la copia AISLADA del worker, no el arbol del servicio.
"""
from __future__ import annotations

import argparse, json, os, subprocess, sys, threading, time

WORK = "/home/santiagov/w3-work/transcript-worker"  # se puede cambiar con --worker-root
AUDIO = "/home/santiagov/w3-diag/cc00c4cf-normalized.wav"
FLOOR_MIB = 250          # por debajo de esto se declara riesgo de OOM
NEED_FOR_PYANNOTE = 1800 # medido: ~1670 de pico + margen


def smi(query: str) -> list[str]:
    out = subprocess.run(["nvidia-smi", f"--query-{query}", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True, timeout=15, check=False)
    return [l.strip() for l in out.stdout.splitlines() if l.strip()]


def free_mib() -> int:
    try:
        return int(smi("gpu=memory.free")[0])
    except Exception:
        return -1


def others() -> dict[int, int]:
    out = {}
    for row in smi("compute-apps=pid,used_memory"):
        pid, mem = [x.strip() for x in row.split(",")]
        out[int(pid)] = int(mem)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--deadline-s", type=float, default=240.0)
    ap.add_argument("--worker-root", default=WORK)
    ap.add_argument("--expect-compute", default=None,
                    help="Aborta si el compute_type EFECTIVO no es este.")
    ap.add_argument("--expect-backend", default=None,
                    help="Aborta si el backend EFECTIVO no es este.")
    args = ap.parse_args()

    report: dict = {"fases": [], "aviso_suelo": False}
    t0 = time.monotonic()
    pid = os.getpid()
    peak = {"self": 0, "total": 0, "free_min": free_mib()}
    stop = threading.Event()

    def sampler() -> None:
        while not stop.is_set():
            f = free_mib()
            if f >= 0:
                peak["free_min"] = min(peak["free_min"], f)
                if f < FLOOR_MIB:
                    report["aviso_suelo"] = True
            for p, m in others().items():
                if p == pid:
                    peak["self"] = max(peak["self"], m)
            try:
                peak["total"] = max(peak["total"], int(smi("gpu=memory.used")[0]))
            except Exception:
                pass
            time.sleep(0.25)

    # ── Fase 0 · preflight ────────────────────────────────────────────────────
    hist = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                           "--max-time", "5", "http://127.0.0.1:8001/health"],
                          capture_output=True, text=True, check=False).stdout.strip()
    report["historico_antes"] = {"http": hist, "vram": others()}
    report["libre_antes"] = free_mib()
    print(f"[0] historico HTTP {hist} · GPU libre {report['libre_antes']} MiB · otros {others()}")
    if hist != "200":
        report["resultado"] = "abortada: el servicio historico no responde 200"
        json.dump(report, open(args.out, "w"), indent=2, ensure_ascii=False)
        return 2

    # ── Fase 0 bis · los valores EFECTIVOS, verificados antes de medir nada ──
    #
    # Cargar `.env.w3` no basta: ese fichero todavia dice `wespeaker`, asi que una
    # prueba que solo lo cargue mediria el backend viejo y se presentaria como
    # validacion del nuevo. Aqui se LEE lo que de verdad resolvio el proceso y se
    # aborta si no es lo que se pretende validar.
    root = args.worker_root
    sys.path.insert(0, root)
    os.chdir(root)
    from app.config import settings
    from app.services.whisper_service import resolve_compute_type, resolve_device

    dev = resolve_device(settings.whisper_device)
    efectivo = {
        "worker_root": root,
        "model": settings.whisper_model,
        "device": dev,
        "compute_type": resolve_compute_type(dev),
        "diarization_backend": settings.diarization_backend,
        "diarization_fallback": settings.diarization_fallback_backend,
    }
    report["config_efectiva"] = efectivo
    print(f"[0b] EFECTIVO -> model={efectivo['model']} device={efectivo['device']} "
          f"compute={efectivo['compute_type']} backend={efectivo['diarization_backend']} "
          f"fallback={efectivo['diarization_fallback']}")
    fallos = []
    if args.expect_compute and efectivo["compute_type"] != args.expect_compute:
        fallos.append(f"compute_type es {efectivo['compute_type']}, se esperaba {args.expect_compute}")
    if args.expect_backend and efectivo["diarization_backend"] != args.expect_backend:
        fallos.append(f"backend es {efectivo['diarization_backend']}, se esperaba {args.expect_backend}")
    if fallos:
        report["resultado"] = "abortada: " + " · ".join(fallos)
        print(f"[!] {report['resultado']}")
        json.dump(report, open(args.out, "w"), indent=2, ensure_ascii=False)
        return 2

    threading.Thread(target=sampler, daemon=True).start()

    try:
        # ── Fase 1 · whisper en GPU, con palabras ─────────────────────────────
        t = time.monotonic()
        from app.pull.stages import run_diarize, run_transcribe
        tr = run_transcribe(AUDIO)
        d1 = round(time.monotonic() - t, 1)
        con_palabras = sum(1 for s in tr.segments if s.get("words"))
        report["fases"].append({
            "fase": "transcribe", "s": d1, "device": tr.device, "compute": tr.compute_type,
            "segmentos": len(tr.segments), "con_palabras": con_palabras,
            "libre_al_acabar": free_mib(), "pico_proceso": peak["self"],
        })
        print(f"[1] transcribe {d1}s · {len(tr.segments)} segmentos ({con_palabras} con palabras) "
              f"· device={tr.device} · libre {free_mib()} MiB · pico {peak['self']} MiB")

        if time.monotonic() - t0 > args.deadline_s:
            raise TimeoutError("se agoto el limite de tiempo tras transcribe")

        # ── Fase 2 · diarizar: run_diarize suelta whisper y carga pyannote ────
        from app.services.whisper_service import whisper_service
        cargado_antes = whisper_service.is_loaded
        t = time.monotonic()
        di = run_diarize(AUDIO, file_id="gpu-window", num_speakers=None)
        d2 = round(time.monotonic() - t, 1)
        libre_tras_unload = None  # se mide dentro; aqui queda el estado final
        report["fases"].append({
            "fase": "diarize", "s": d2, "backend": di.backend, "turnos": len(di.turns),
            "whisper_cargado_antes": cargado_antes,
            "whisper_cargado_despues": whisper_service.is_loaded,
            "libre_al_acabar": free_mib(), "pico_proceso": peak["self"],
        })
        print(f"[2] diarize {d2}s · backend={di.backend} · {len(di.turns)} turnos "
              f"· whisper cargado antes/despues: {cargado_antes}/{whisper_service.is_loaded} "
              f"· libre {free_mib()} MiB")

        # ── Veredicto ─────────────────────────────────────────────────────────
        ok = di.backend == "pyannote_full"
        report["resultado"] = "PASA" if ok else f"FALLA: corrio {di.backend}, no pyannote_full"
        report["backend"] = di.backend
    except Exception as exc:  # noqa: BLE001
        report["resultado"] = f"ERROR: {type(exc).__name__}: {exc}"
        print(f"[!] {report['resultado']}")
    finally:
        stop.set(); time.sleep(0.5)
        report["memoria"] = {
            "pico_proceso_mib": peak["self"], "pico_tarjeta_mib": peak["total"],
            "libre_minimo_mib": peak["free_min"], "suelo_mib": FLOOR_MIB,
        }
        report["segundos_total"] = round(time.monotonic() - t0, 1)
        hist2 = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                                "--max-time", "5", "http://127.0.0.1:8001/health"],
                               capture_output=True, text=True, check=False).stdout.strip()
        report["historico_despues"] = {"http": hist2, "vram": others()}
        json.dump(report, open(args.out, "w"), indent=2, ensure_ascii=False)
        print(f"[3] pico proceso {peak['self']} MiB · pico tarjeta {peak['total']} MiB "
              f"· libre minimo {peak['free_min']} MiB · historico HTTP {hist2}")
        print(f"[=] {report['resultado']} en {report['segundos_total']}s")
    return 0 if report.get("resultado") == "PASA" else 1


if __name__ == "__main__":
    raise SystemExit(main())
