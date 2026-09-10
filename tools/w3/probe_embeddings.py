"""Dónde falla exactamente: ¿la VAD, la embedding, o el agrupamiento?

No reclama jobs, no toca la base, R2 ni el servicio. Sólo lee el WAV y llama a las
mismas funciones del worker que usó la ejecución real.
"""
import json, os, sys
sys.path.insert(0, "/home/santiagov/services/mai-w3-worker/transcript-worker")
sys.path.insert(0, "/home/santiagov/w3-diag")
os.chdir("/home/santiagov/services/mai-w3-worker/transcript-worker")

import numpy as np, torchaudio
from app.services.diarization_service import energy_vad, extract_embedding
from compare_diarization import parse_reference, score_against_reference, label_at
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

AUDIO = "/home/santiagov/w3-diag/cc00c4cf-normalized.wav"
REF   = parse_reference(open("/home/santiagov/w3-diag/reference-cc00c4cf.tsv", encoding="utf-8").read())

wav, sr = torchaudio.load(AUDIO)
x = wav.squeeze(0).numpy()
segs = energy_vad(x, sr)
print(f"VAD: {len(segs)} segmentos, {sum(s['end']-s['start'] for s in segs):.2f} s de habla")

embs, valid = [], []
for s in segs:
    e = extract_embedding(x[int(s['start']*sr):int(s['end']*sr)], sr, device="cpu")
    if e is not None:
        embs.append(e); valid.append(s)
E = np.stack(embs)
N = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-10)
print(f"embeddings: {len(embs)} (dim {E.shape[1]})")

def truth(seg):
    """Quién habla según la referencia, por mayoría dentro del segmento. None fuera del tramo."""
    c = {}
    t = seg["start"]
    while t < seg["end"]:
        v = label_at(REF, t)
        if v: c[v] = c.get(v, 0) + 1
        t += 0.05
    return max(c, key=c.get) if c else None

verdad = [truth(s) for s in valid]
hombre = [i for i, v in enumerate(verdad) if v == "Hombre"]
mujer  = [i for i, v in enumerate(verdad) if v == "Mujer"]
print(f"\nsegmentos con verdad conocida: Hombre={hombre} Mujer={mujer}")

# ¿Las embeddings SEPARAN al hombre de la mujer? Es la pregunta de fondo: si la
# distancia entre voces es menor que la dispersión dentro de una voz, ningún
# agrupamiento las va a separar y el arreglo no está en el número de clusters.
if hombre and mujer:
    ch = N[hombre].mean(0); ch /= np.linalg.norm(ch)
    cm = N[mujer].mean(0);  cm /= np.linalg.norm(cm)
    print(f"\ncoseno entre centroides Hombre/Mujer: {float(ch @ cm):.4f}")
    print("  (1.0 = indistinguibles; cuanto más bajo, más separables)")
    print("\n  seg  inicio    fin    dur  verdad   sim.Hombre  sim.Mujer  ->  más cerca de")
    for i, s in enumerate(valid):
        sh, sm = float(N[i] @ ch), float(N[i] @ cm)
        v = verdad[i] or "-"
        near = "Hombre" if sh > sm else "Mujer"
        flag = "  <-- MAL" if v != "-" and near != v else ""
        print(f"  {i:3d} {s['start']:7.2f} {s['end']:7.2f} {s['end']-s['start']:6.2f}  {v:7s} "
              f"{sh:10.4f} {sm:10.4f}  ->  {near}{flag}")

def evaluate(name, labels, subset=None):
    """Puntúa un agrupamiento contra la referencia, emparejando etiquetas."""
    idx = subset if subset is not None else range(len(valid))
    turns = [{"start": valid[i]["start"], "end": valid[i]["end"],
              "speaker": f"SPEAKER_{int(labels[j]):02d}"} for j, i in enumerate(idx)]
    sc = score_against_reference(turns, REF, 0.1)
    ph = sc["per_reference_speaker"].get("Hombre", {})
    print(f"  {name:44s} k={len(set(labels)):2d}  acierto {sc['accuracy_pct']:5.1f} %  "
          f"Hombre {ph.get('accuracy_pct', 0.0):5.1f} %  map={json.dumps(sc['mapping'], ensure_ascii=False)}")
    return sc

print("\n== variantes de agrupamiento, sobre las MISMAS embeddings ==")
for k in (2, 3, 4, 5, 6):
    lab = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average").fit_predict(N)
    evaluate(f"cosine/average (lo que corre hoy), k={k}", lab)

print()
for link in ("complete", "single"):
    lab = AgglomerativeClustering(n_clusters=2, metric="cosine", linkage=link).fit_predict(N)
    evaluate(f"cosine/{link}, k=2", lab)
lab = AgglomerativeClustering(n_clusters=2, linkage="ward").fit_predict(N)
evaluate("euclidean/ward, k=2", lab)

print("\n== y descartando los segmentos cortos, que son los que se van solos ==")
for floor in (0.8, 1.0, 1.5):
    keep = [i for i, s in enumerate(valid) if s["end"] - s["start"] >= floor]
    if len(keep) < 3: continue
    sub = N[keep]
    lab = AgglomerativeClustering(n_clusters=2, metric="cosine", linkage="average").fit_predict(sub)
    evaluate(f"cosine/average k=2, sólo segmentos >= {floor} s ({len(keep)} de {len(valid)})", lab, keep)

print("\n== duración de los segmentos por cluster de la ejecución real ==")
real = AgglomerativeClustering(n_clusters=2, metric="cosine", linkage="average").fit_predict(N)
for c in sorted(set(real)):
    d = [round(valid[i]["end"] - valid[i]["start"], 2) for i in range(len(valid)) if real[i] == c]
    print(f"  cluster {c}: {len(d)} segmentos, {sum(d):.2f} s, duraciones {sorted(d)}")
