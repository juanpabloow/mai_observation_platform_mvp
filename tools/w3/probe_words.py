"""¿Cuántos bloques salen si se parte por PALABRA en el cambio de hablante?

La pregunta es si se puede atribuir bien sin romper la legibilidad. No se parte texto
por proporción de caracteres: se usan los tiempos por palabra que whisper ya produce.
Transcripción NUEVA y aislada; no es la almacenada ni se ingiere.
"""
import json, os, sys, time
sys.path.insert(0, "/home/santiagov/services/mai-w3-worker/transcript-worker")
sys.path.insert(0, "/home/santiagov/w3-diag")
os.chdir("/home/santiagov/services/mai-w3-worker/transcript-worker")
from compare_diarization import parse_reference, score_against_reference

REF = parse_reference(open("/home/santiagov/w3-diag/reference-cc00c4cf.tsv", encoding="utf-8").read())
pya = json.load(open("/home/santiagov/w3-diag/out-cpu/pyannote_auto.json"))["result"]["speaker_turns"]

from app.services.whisper_service import whisper_service
tr = whisper_service.transcribe("/home/santiagov/w3-diag/cc00c4cf-normalized.wav", word_timestamps=True)
segs = tr["segments"]
print(f"[TRANSCRIPCIÓN NUEVA, aislada] {len(segs)} segmentos")
json.dump({"nota": "NUEVA Y AISLADA, no es la almacenada", "segments": segs},
          open("/home/santiagov/w3-diag/out-cpu/transcript_nuevo.json", "w"), indent=2, ensure_ascii=False)

def lab(a, b, turns):
    best, who = 0.0, None
    for t in turns:
        sh = min(b, t["end"]) - max(a, t["start"])
        if sh > best: best, who = sh, t["speaker"]
    return who

def seg_label(s, turns):
    by = {}
    for t in turns:
        sh = min(s["end"], t["end"]) - max(s["start"], t["start"])
        if sh > 0: by[t["speaker"]] = by.get(t["speaker"], 0.0) + sh
    return sorted(by.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] if by else None

bloques_seg, bloques_pal = [], []
for s in segs:
    a, b = float(s["start"]), float(s["end"])
    bloques_seg.append({"start": a, "end": b, "speaker": seg_label(s, pya),
                        "text": (s.get("text") or "").strip()})
    ws = s.get("words") or []
    if not ws:
        bloques_pal.append(bloques_seg[-1]); continue
    # Agrupa palabras CONSECUTIVAS del mismo hablante. Los tiempos de cada bloque
    # son los de sus palabras: no se inventa ninguna frontera nueva.
    run = []
    for w in ws:
        who = lab(float(w["start"]), float(w["end"]), pya)
        if run and run[-1]["who"] == who: run[-1]["words"].append(w)
        else: run.append({"who": who, "words": [w]})
    for r in run:
        bloques_pal.append({"start": float(r["words"][0]["start"]), "end": float(r["words"][-1]["end"]),
                            "speaker": r["who"], "text": "".join(w["word"] for w in r["words"]).strip()})

print(f"\nbloques por SEGMENTO : {len(bloques_seg)}")
print(f"bloques por PALABRA  : {len(bloques_pal)}   (turnos de pyannote: {len(pya)})")
print(f"  -> ni 47 bloques ni uno por turno: sólo se parte donde el hablante cambia DENTRO de un segmento")

for nombre, bl in (("por segmento", bloques_seg), ("por palabra", bloques_pal)):
    sc = score_against_reference([{"start": x["start"], "end": x["end"], "speaker": str(x["speaker"])} for x in bl], REF, 0.1)
    h = sc["per_reference_speaker"].get("Hombre", {}); m = sc["per_reference_speaker"].get("Mujer", {})
    print(f"\n  atribución {nombre:12s}: acierto global {sc['accuracy_pct']:5.1f} %  "
          f"Hombre {h.get('accuracy_pct',0):5.1f} % (a otro {h.get('attributed_to_other_pct',0):4.1f} %)  "
          f"Mujer {m.get('accuracy_pct',0):5.1f} % (a otro {m.get('attributed_to_other_pct',0):4.1f} %)")

print("\n== los bloques del primer minuto, partidos por palabra ==")
for x in bloques_pal:
    if x["start"] < 60:
        print(f"  {x['start']:6.2f}-{x['end']:6.2f}  {str(x['speaker']):11s}  {x['text'][:64]}")

dist = {}
for x in bloques_pal: dist[len(x["text"].split())] = dist.get(len(x["text"].split()), 0) + 1
print(f"\nbloques de 1-2 palabras (riesgo de picadillo): {sum(v for k,v in dist.items() if k<=2)} de {len(bloques_pal)}")
json.dump({"nota": "derivado de la transcripción NUEVA", "por_segmento": bloques_seg, "por_palabra": bloques_pal},
          open("/home/santiagov/w3-diag/out-cpu/bloques.json", "w"), indent=2, ensure_ascii=False)
