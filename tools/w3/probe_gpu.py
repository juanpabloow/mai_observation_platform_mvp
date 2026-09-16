"""pyannote_full en la GTX 1650 SUPER: velocidad, memoria y precisión.

Proceso AISLADO. No reclama jobs, no toca la base, R2 ni la cola. El servicio W3 y el
histórico (uvicorn:8001) siguen corriendo: este es un TERCER proceso que usa la VRAM
libre, y por eso lo primero que hace es comprobar que hay margen y abortar si no.
"""
import json
import os, subprocess, sys, threading, time
sys.path.insert(0, f"{WORKER}")
sys.path.insert(0, f"{DIAG}")
os.chdir(f"{WORKER}")

AUDIO = f"{DIAG}/cc00c4cf-normalized.wav"
MIN_FREE_MIB = 900

def smi(query, extra=()):
    out = subprocess.run(["nvidia-smi", f"--query-{query}", "--format=csv,noheader,nounits", *extra],
                         capture_output=True, text=True, check=False)
    return [l.strip() for l in out.stdout.splitlines() if l.strip()]

free0 = int(smi("gpu=memory.free")[0])
print(f"VRAM libre antes: {free0} MiB")
print("otros procesos:", smi("compute-apps=pid,used_memory"))
if free0 < MIN_FREE_MIB:
    raise SystemExit(f"Sólo {free0} MiB libres (<{MIN_FREE_MIB}). No arranco: el riesgo de "
                     "dejar sin memoria al worker o al histórico no lo paga esta medida.")

PID = os.getpid()
peak = {"self": 0, "total": 0, "free_min": free0}
stop = threading.Event()
def sampler():
    while not stop.is_set():
        for row in smi("compute-apps=pid,used_memory"):
            p, m = [x.strip() for x in row.split(",")]
            if int(p) == PID: peak["self"] = max(peak["self"], int(m))
        peak["total"] = max(peak["total"], int(smi("gpu=memory.used")[0]))
        peak["free_min"] = min(peak["free_min"], int(smi("gpu=memory.free")[0]))
        time.sleep(0.25)
threading.Thread(target=sampler, daemon=True).start()

import torch

# Las rutas NO se escriben aquí: describen máquinas concretas y este repositorio es
# público. Se derivan de $HOME y se pueden redirigir por entorno.
HOME = os.path.expanduser("~")
DIAG = os.environ.get("W3_DIAG", f"{HOME}/w3-diag")
WORKER = os.environ.get("W3_WORKER", f"{HOME}/services/mai-w3-worker/transcript-worker")
torch.cuda.init(); torch.zeros(1, device="cuda")
time.sleep(1.0)
ctx = peak["self"]
print(f"contexto CUDA de este proceso: ~{ctx} MiB (lo paga una vez, y el worker YA lo tiene)")

from app.services.diarization_service import diarize
from compare_diarization import parse_reference, score_against_reference, reference_intervals_report
REF = parse_reference(open(f"{DIAG}/reference-cc00c4cf.tsv", encoding="utf-8").read())

results = {}
for tag, ns in (("auto", None), ("ns2", 2)):
    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    r = diarize(audio_path=AUDIO, device="cuda", min_speakers=1, max_speakers=10,
                num_speakers=ns, file_id=f"gpu-{tag}", backend="pyannote_full")
    wall = time.time() - t0
    reserved = torch.cuda.max_memory_reserved() / 1024**2
    alloc = torch.cuda.max_memory_allocated() / 1024**2
    sc = score_against_reference(r["speaker_turns"], REF, 0.1)
    turns = r["speaker_turns"]
    per = {}
    for t in turns: per[t["speaker"]] = per.get(t["speaker"], 0) + t["end"] - t["start"]
    tot = sum(per.values())
    results[tag] = {"wall": round(wall, 1), "reserved_mib": round(reserved, 1),
                    "alloc_mib": round(alloc, 1), "turns": len(turns),
                    "backend_used": r.get("_backend_used"),
                    "share": {k: round(100*v/tot, 2) for k, v in sorted(per.items())},
                    "score": sc}
    print(f"\n### cuda · {tag} (num_speakers={ns}) · backend usado: {r.get('_backend_used')}")
    print(f"  wall {wall:.1f}s  ({wall/119.59:.2f}x tiempo real)  turnos={len(turns)}  voces={r['unique_speakers']}")
    print(f"  torch reservado {reserved:.0f} MiB · asignado {alloc:.0f} MiB")
    print(f"  reparto: {json.dumps(results[tag]['share'])}")
    print(f"  acierto {sc['accuracy_pct']} %  emparejado {json.dumps(sc['mapping'], ensure_ascii=False)}")
    for voz, row in sc["per_reference_speaker"].items():
        print(f"    {voz:7s} acierto {row['accuracy_pct']:5.1f} %  silencio {row['missed_as_silence_pct']:5.1f} %  a otro {row['attributed_to_other_pct']:5.1f} %")
    for x in reference_intervals_report(turns, REF, 0.1):
        print(f"    {x['start']:5.1f}-{x['end']:5.1f} {x['seconds']:5.1f}s  {x['reference']:7s} -> {x['dominant']:15s} {x['correct_pct']:5.1f} %")

stop.set(); time.sleep(0.6)
print(f"\n== memoria ==")
print(f"  pico de ESTE proceso (con su contexto CUDA): {peak['self']} MiB")
print(f"  pico total de la tarjeta: {peak['total']} MiB de 4096")
print(f"  mínimo libre durante la prueba: {peak['free_min']} MiB")
print(f"  coste marginal de pyannote sobre un proceso que ya tiene contexto: ~{peak['self']-ctx} MiB")
json.dump({"peak": peak, "ctx_mib": ctx, "runs": results},
          open(f"{DIAG}/out-cpu/gpu_pyannote.json", "w"), indent=2, ensure_ascii=False)
