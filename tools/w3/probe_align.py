"""Asignación de hablante AL TEXTO: qué cambia al pasar de 26 a 47 turnos.

Transcribe de nuevo el WAV con los MISMOS ajustes del worker (medium/cuda/float16)
para tener las fronteras de segmento. Esa transcripción es NUEVA y AISLADA: no es la
almacenada, no se ingiere, y se marca como tal en todo lo que escribe.

Reimplementa `alignSegments` de src/meetings/artifacts.ts al pie de la letra —mayor
solape, empate por orden alfabético, OVERLAP_THRESHOLD 0,25, reparto sobre los TURNOS—
para poder comparar las dos diarizaciones contra el mismo texto.
"""
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
from compare_diarization import parse_reference, label_at

OVERLAP_THRESHOLD = 0.25
AUDIO = f"{DIAG}/cc00c4cf-normalized.wav"
REF = parse_reference(open(f"{DIAG}/reference-cc00c4cf.tsv", encoding="utf-8").read())

def align(segments, turns):
    """Puerto fiel de alignSegments (artifacts.ts)."""
    out = []
    for s in segments:
        by = {}
        for t in turns:
            sh = min(s["end"], t["end"]) - max(s["start"], t["start"])
            if sh > 0: by[t["speaker"]] = by.get(t["speaker"], 0.0) + sh
        if not by:
            out.append({**s, "speakerLabel": None, "overlap": False, "share": {}})
            continue
        ranked = sorted(by.items(), key=lambda kv: (-kv[1], kv[0]))
        dur = max(s["end"] - s["start"], 1e-9)
        runner = ranked[1][1] if len(ranked) > 1 else 0.0
        out.append({**s, "speakerLabel": ranked[0][0],
                    "overlap": runner / dur >= OVERLAP_THRESHOLD,
                    "share": {k: round(v, 2) for k, v in ranked}})
    return out

def talk_share(turns):
    per = {}
    for t in turns: per[t["speaker"]] = per.get(t["speaker"], 0.0) + t["end"] - t["start"]
    tot = sum(per.values())
    return {k: round(100 * v / tot, 2) for k, v in sorted(per.items())} if tot else {}

# ── 1 · transcripción NUEVA (no la almacenada) ────────────────────────────────
from app.services.whisper_service import whisper_service
t0 = time.time()
tr = whisper_service.transcribe(AUDIO, word_timestamps=True)
segs_raw = tr["segments"]
print(f"[TRANSCRIPCIÓN NUEVA, aislada] {len(segs_raw)} segmentos, idioma={tr.get('language')}, "
      f"modelo={tr.get('model')}, device={tr.get('device')}, compute={tr.get('compute_type')}, "
      f"{time.time()-t0:.1f}s")
print(f"  ¿trae tiempos por palabra?: {'sí' if segs_raw and segs_raw[0].get('words') else 'NO'}"
      f"  (palabras en el 1er segmento: {len(segs_raw[0].get('words') or [])})")
segments = [{"index": i, "start": float(s["start"]), "end": float(s["end"]),
             "text": (s.get("text") or "").strip(), "words": s.get("words") or []}
            for i, s in enumerate(segs_raw)]

# ── 2 · las dos diarizaciones ─────────────────────────────────────────────────
wes = json.load(open(f"{DIAG}/out-cpu/diar_cpu_auto.json"))["result"]["speaker_turns"]
pya = json.load(open(f"{DIAG}/out-cpu/pyannote_auto.json"))["result"]["speaker_turns"]
print(f"\nturnos: wespeaker={len(wes)}  pyannote={len(pya)}")
print(f"reparto sobre turnos: wespeaker={talk_share(wes)}  pyannote={talk_share(pya)}")

A, B = align(segments, wes), align(segments, pya)
print(f"\nBLOQUES VISUALES: {len(segments)} con wespeaker y {len(segments)} con pyannote.")
print("Los 47 turnos NO crean bloques: `alignSegments` etiqueta los segmentos de whisper,")
print("no los turnos. La agrupación y los tiempos son los del texto, intactos.\n")

def truth(s):
    c = {}
    t = s["start"]
    while t < s["end"]:
        v = label_at(REF, t)
        if v: c[v] = c.get(v, 0) + 1
        t += 0.05
    return max(c, key=c.get) if c else None

print(f"{'#':>2} {'inicio':>7} {'fin':>7} {'dur':>5} {'oído':>7} | {'wespeaker':>11} {'ov':>3} | {'pyannote':>11} {'ov':>3} | texto")
cambia = 0
for a, b in zip(A, B):
    if a["speakerLabel"] != b["speakerLabel"]: cambia += 1
    v = truth(a) or "-"
    print(f"{a['index']:>2} {a['start']:7.2f} {a['end']:7.2f} {a['end']-a['start']:5.2f} {v:>7} | "
          f"{str(a['speakerLabel']):>11} {'SÍ' if a['overlap'] else '  ':>3} | "
          f"{str(b['speakerLabel']):>11} {'SÍ' if b['overlap'] else '  ':>3} | {a['text'][:52]}")

print(f"\nsegmentos que cambian de etiqueta: {cambia} de {len(segments)}")
print(f"marcados con solape: wespeaker={sum(1 for x in A if x['overlap'])}  pyannote={sum(1 for x in B if x['overlap'])}")
print(f"etiquetas distintas en los segmentos: wespeaker={sorted({str(x['speakerLabel']) for x in A})}  "
      f"pyannote={sorted({str(x['speakerLabel']) for x in B})}")

# ── 3 · el segmento que contiene la intervención masculina de 00:05–00:10 ─────
print("\n== el segmento que cubre 00:05–00:10 (la intervención masculina de 5 s) ==")
for a, b in zip(A, B):
    if a["start"] < 10 and a["end"] > 5:
        print(f"  segmento {a['index']} [{a['start']:.2f}–{a['end']:.2f}] «{a['text'][:70]}»")
        print(f"    wespeaker -> {a['speakerLabel']}  solape por etiqueta {a['share']}")
        print(f"    pyannote  -> {b['speakerLabel']}  solape por etiqueta {b['share']}  overlap={b['overlap']}")
        n = len(a["words"])
        if n:
            print(f"    tiene {n} palabras con tiempo; si se asignaran por palabra:")
            for w in a["words"]:
                lab = None; best = 0
                for t in pya:
                    sh = min(float(w["end"]), t["end"]) - max(float(w["start"]), t["start"])
                    if sh > best: best, lab = sh, t["speaker"]
                print(f"      {float(w['start']):6.2f}-{float(w['end']):6.2f} {str(lab):>11}  {w['word']}")

json.dump({"nota": "TRANSCRIPCIÓN NUEVA Y AISLADA, no es la almacenada ni se ingiere",
           "segments": [{k: v for k, v in s.items() if k != "words"} for s in segments],
           "align_wespeaker": [{k: v for k, v in x.items() if k != "words"} for x in A],
           "align_pyannote": [{k: v for k, v in x.items() if k != "words"} for x in B]},
          open(f"{DIAG}/out-cpu/align_comparison.json", "w"), indent=2, ensure_ascii=False)
