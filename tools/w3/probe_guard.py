"""¿Qué guarda mínima evita el picadillo sin perder la atribución?

Reutiliza la transcripción nueva ya guardada: no vuelve a transcribir.
"""
import json, sys
sys.path.insert(0, "/home/santiagov/w3-diag")
from compare_diarization import parse_reference, score_against_reference

REF = parse_reference(open("/home/santiagov/w3-diag/reference-cc00c4cf.tsv", encoding="utf-8").read())
pya = json.load(open("/home/santiagov/w3-diag/out-cpu/pyannote_auto.json"))["result"]["speaker_turns"]
segs = json.load(open("/home/santiagov/w3-diag/out-cpu/transcript_nuevo.json"))["segments"]

def lab(a, b):
    best, who = 0.0, None
    for t in pya:
        sh = min(b, t["end"]) - max(a, t["start"])
        if sh > best: best, who = sh, t["speaker"]
    return who

def build(min_words, min_secs):
    """Parte por palabra, pero un tramo que no llegue a la guarda NO abre bloque:
    se absorbe en el vecino. Los tiempos siguen siendo los de las palabras."""
    out = []
    for s in segs:
        ws = s.get("words") or []
        if not ws:
            out.append({"start": float(s["start"]), "end": float(s["end"]),
                        "speaker": lab(float(s["start"]), float(s["end"])),
                        "text": (s.get("text") or "").strip()}); continue
        runs = []
        for w in ws:
            who = lab(float(w["start"]), float(w["end"]))
            if runs and runs[-1]["who"] == who: runs[-1]["w"].append(w)
            else: runs.append({"who": who, "w": [w]})
        # absorbe los tramos cortos en el vecino más largo, repetidamente
        changed = True
        while changed and len(runs) > 1:
            changed = False
            for i, r in enumerate(runs):
                dur = float(r["w"][-1]["end"]) - float(r["w"][0]["start"])
                if len(r["w"]) >= min_words and dur >= min_secs: continue
                prev = runs[i-1] if i > 0 else None
                nxt = runs[i+1] if i < len(runs)-1 else None
                tgt = prev if (nxt is None or (prev is not None and len(prev["w"]) >= len(nxt["w"]))) else nxt
                if tgt is None: continue
                tgt["w"] = sorted(tgt["w"] + r["w"], key=lambda x: float(x["start"]))
                runs.pop(i); changed = True; break
        for r in runs:
            out.append({"start": float(r["w"][0]["start"]), "end": float(r["w"][-1]["end"]),
                        "speaker": r["who"], "text": "".join(x["word"] for x in r["w"]).strip()})
    return out

print(f"{'guarda':>22} {'bloques':>8} {'1-2 pal':>8} {'global':>8} {'Hombre':>8} {'H a otro':>9} {'Mujer':>8}")
best = None
for mw, ms in ((0,0.0),(2,0.0),(3,0.0),(3,0.6),(4,0.8),(5,1.0),(6,1.2)):
    bl = build(mw, ms)
    sc = score_against_reference([{"start":x["start"],"end":x["end"],"speaker":str(x["speaker"])} for x in bl], REF, 0.1)
    h = sc["per_reference_speaker"].get("Hombre", {}); m = sc["per_reference_speaker"].get("Mujer", {})
    corto = sum(1 for x in bl if len(x["text"].split()) <= 2)
    tag = "sin guarda" if mw == 0 else f">={mw} pal y >={ms}s"
    print(f"{tag:>22} {len(bl):>8} {corto:>8} {sc['accuracy_pct']:>7.1f}% {h.get('accuracy_pct',0):>7.1f}% "
          f"{h.get('attributed_to_other_pct',0):>8.1f}% {m.get('accuracy_pct',0):>7.1f}%")
    if mw == 3 and ms == 0.6: best = bl

print("\n== con guarda >=3 palabras y >=0,6 s, el primer minuto ==")
for x in best:
    if x["start"] < 60:
        print(f"  {x['start']:6.2f}-{x['end']:6.2f}  {str(x['speaker']):11s}  {x['text'][:66]}")
