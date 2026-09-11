"""Qué reparto y qué turnos daría cada arreglo candidato. Aislado, sin tocar nada."""
import json
import os, sys
sys.path.insert(0, f"{WORKER}")
sys.path.insert(0, f"{DIAG}")
os.chdir(f"{WORKER}")
import numpy as np, torchaudio
from app.services.diarization_service import energy_vad, extract_embedding
from compare_diarization import parse_reference, score_against_reference, reference_intervals_report
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics import silhouette_score

# Las rutas NO se escriben aquí: describen máquinas concretas y este repositorio es
# público. Se derivan de $HOME y se pueden redirigir por entorno.
HOME = os.path.expanduser("~")
DIAG = os.environ.get("W3_DIAG", f"{HOME}/w3-diag")
WORKER = os.environ.get("W3_WORKER", f"{HOME}/services/mai-w3-worker/transcript-worker")

REF = parse_reference(open(f"{DIAG}/reference-cc00c4cf.tsv", encoding="utf-8").read())
wav, sr = torchaudio.load(f"{DIAG}/cc00c4cf-normalized.wav")
x = wav.squeeze(0).numpy()
segs = energy_vad(x, sr)
embs, valid = [], []
for s in segs:
    e = extract_embedding(x[int(s['start']*sr):int(s['end']*sr)], sr, device="cpu")
    if e is not None: embs.append(e); valid.append(s)
E = np.stack(embs); N = E / (np.linalg.norm(E, axis=1, keepdims=True) + 1e-10)

def report(name, labels):
    turns = [{"start": valid[i]["start"], "end": valid[i]["end"],
              "speaker": f"SPEAKER_{int(labels[i]):02d}"} for i in range(len(valid))]
    per = {}
    for t in turns: per[t["speaker"]] = per.get(t["speaker"], 0) + t["end"] - t["start"]
    tot = sum(per.values())
    share = {k: round(100*v/tot, 2) for k, v in sorted(per.items())}
    sc = score_against_reference(turns, REF, 0.1)
    print(f"\n### {name}")
    print(f"  reparto: {json.dumps(share)}   (segundos: { {k: round(v,2) for k,v in sorted(per.items())} })")
    print(f"  acierto global {sc['accuracy_pct']} %  |  emparejado {json.dumps(sc['mapping'], ensure_ascii=False)}")
    for voz, row in sc["per_reference_speaker"].items():
        print(f"    {voz:7s} anotado {row['seconds_annotated']:5.1f} s  acierto {row['accuracy_pct']:5.1f} %  "
              f"silencio {row['missed_as_silence_pct']:5.1f} %  a otro {row['attributed_to_other_pct']:5.1f} %")
    print("    intervalo      s  referencia  dominante        acierto")
    for r in reference_intervals_report(turns, REF, 0.1):
        print(f"    {r['start']:5.1f}-{r['end']:5.1f} {r['seconds']:5.1f}  {r['reference']:10s}  {r['dominant']:15s}  {r['correct_pct']:5.1f} %")
    return share, sc

# La selección de k tal cual está hoy, pero con la linkage cambiada: es el único
# cambio, para que lo que se mida sea la linkage y no dos cosas a la vez.
def select_k(normed, linkage, metric, lo=1, hi=10):
    n = len(normed)
    sim = normed @ normed.T
    triu = np.triu_indices(n, k=1)
    avg = float(np.mean(sim[triu]))
    hi = min(hi, n - 1)
    best_k, best = max(2, lo), -2.0
    scores = {}
    for k in range(max(2, lo), hi + 1):
        kw = {"n_clusters": k, "linkage": linkage}
        if linkage != "ward": kw["metric"] = metric
        lab = AgglomerativeClustering(**kw).fit_predict(normed)
        try: sc = float(silhouette_score(normed, lab, metric=metric))
        except Exception: sc = -1.0
        scores[k] = round(sc, 4)
        if sc > best: best, best_k = sc, k
    if lo == 1 and (avg > 0.75 or best < 0.10):
        return 1, np.zeros(n, dtype=int), avg, scores
    kw = {"n_clusters": best_k, "linkage": linkage}
    if linkage != "ward": kw["metric"] = metric
    return best_k, AgglomerativeClustering(**kw).fit_predict(normed).astype(int), avg, scores

for linkage, metric in (("average", "cosine"), ("complete", "cosine"), ("ward", "euclidean")):
    k, lab, avg, scores = select_k(N, linkage, metric)
    print(f"\n{'='*78}\n{linkage}/{metric}: k elegido = {k}  avg_sim={avg:.4f}  siluetas={scores}")
    report(f"{linkage}/{metric}, k automático = {k}", lab)

print(f"\n{'='*78}")
print("== y con num_speakers=2 FORZADO, por linkage ==")
for linkage, metric in (("average", "cosine"), ("complete", "cosine"), ("ward", "euclidean")):
    kw = {"n_clusters": 2, "linkage": linkage}
    if linkage != "ward": kw["metric"] = metric
    report(f"{linkage}/{metric}, num_speakers=2 forzado", AgglomerativeClustering(**kw).fit_predict(N))
