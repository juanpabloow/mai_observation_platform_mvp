"""`pyannote_full`, el otro backend ya admitido, contra la misma referencia. Aislado."""
import json
import os, sys, time

# Las rutas NO se escriben aquí: describen máquinas concretas y este repositorio es
# público. Se derivan de $HOME y se pueden redirigir por entorno.
HOME = os.path.expanduser("~")
DIAG = os.environ.get("W3_DIAG", f"{HOME}/w3-diag")
WORKER = os.environ.get("W3_WORKER", f"{HOME}/services/mai-w3-worker/transcript-worker")
sys.path.insert(0, f"{WORKER}")
sys.path.insert(0, f"{DIAG}")
os.chdir(f"{WORKER}")
from app.services.diarization_service import diarize
from compare_diarization import parse_reference, score_against_reference, reference_intervals_report

REF = parse_reference(open(f"{DIAG}/reference-cc00c4cf.tsv", encoding="utf-8").read())
AUDIO = f"{DIAG}/cc00c4cf-normalized.wav"

for tag, ns in (("auto", None), ("ns2", 2)):
    t0 = time.time()
    r = diarize(audio_path=AUDIO, device="cpu", min_speakers=1, max_speakers=10,
                num_speakers=ns, file_id=f"pyan-{tag}", backend="pyannote_full")
    turns = r["speaker_turns"]
    per = {}
    for t in turns: per[t["speaker"]] = per.get(t["speaker"], 0) + t["end"] - t["start"]
    tot = sum(per.values())
    sc = score_against_reference(turns, REF, 0.1)
    print(f"\n{'='*78}\n### pyannote_full · {tag} (num_speakers={ns}) · backend usado: {r.get('_backend_used')}")
    print(f"  voces={r['unique_speakers']} turnos={len(turns)} hablado={tot:.2f} s  wall={time.time()-t0:.1f}s")
    print(f"  reparto: {json.dumps({k: round(100*v/tot,2) for k,v in sorted(per.items())})}")
    print(f"  acierto global {sc['accuracy_pct']} %  |  emparejado {json.dumps(sc['mapping'], ensure_ascii=False)}")
    for voz, row in sc["per_reference_speaker"].items():
        print(f"    {voz:7s} anotado {row['seconds_annotated']:5.1f} s  acierto {row['accuracy_pct']:5.1f} %  "
              f"silencio {row['missed_as_silence_pct']:5.1f} %  a otro {row['attributed_to_other_pct']:5.1f} %")
    print("    intervalo      s  referencia  dominante        acierto")
    for x in reference_intervals_report(turns, REF, 0.1):
        print(f"    {x['start']:5.1f}-{x['end']:5.1f} {x['seconds']:5.1f}  {x['reference']:10s}  {x['dominant']:15s}  {x['correct_pct']:5.1f} %")
    with open(f"{DIAG}/out-cpu/pyannote_{tag}.json", "w") as h:
        json.dump({"num_speakers": ns, "result": r, "score": sc}, h, indent=2, ensure_ascii=False)
    if tag == "auto":
        print("\n    turnos (primeros 60 s):")
        for t in turns:
            if t["start"] < 60:
                print(f"      {t['start']:7.2f} {t['end']:7.2f} {t['end']-t['start']:6.2f}  {t['speaker']}")
