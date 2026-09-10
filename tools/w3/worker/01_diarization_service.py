import io, sys
R = "/home/santiagov/services/mai-w3-worker/transcript-worker"
p = R + "/app/services/diarization_service.py"
s = open(p, encoding="utf-8").read()

# ── 1 · la linkage, en un solo sitio ──────────────────────────────────────────
OLD = '''SINGLE_SPEAKER_SIM_THRESHOLD = 0.75
SILHOUETTE_SPLIT_THRESHOLD   = 0.10'''
NEW = '''SINGLE_SPEAKER_SIM_THRESHOLD = 0.75
SILHOUETTE_SPLIT_THRESHOLD   = 0.10

# ── La linkage del agrupamiento ───────────────────────────────────────────────
#
# Era "average", y eso NO agrupaba por persona: agrupaba por «típico contra atípico».
# Medido sobre una reunión real de 119,6 s con dos voces claramente distintas, k=2
# partía los 26 segmentos en 23 (98,26 s, las DOS personas juntas) contra 3 (1,90 s,
# de 0,42 · 0,42 · 1,06 s). El reparto 98,1 / 1,9 que llegó a la base no eran dos
# hablantes: eran los segmentos largos contra los tres más cortos.
#
# La causa es conocida de la linkage por media: las embeddings de los segmentos muy
# cortos son casi ortogonales a todo —uno de 0,42 s puntuaba 0,005 contra el centroide
# de una voz y 0,190 contra la otra—, así que la media las aísla ANTES de separar a las
# personas. Y no se arregla descartando los cortos: con umbral de 0,8 s y de 1,0 s el
# hablante minoritario seguía en 0,0 % de acierto, porque la media se limita a aislar
# los siguientes atípicos.
#
# "complete" mide por el peor caso dentro del cluster, así que exige que un cluster sea
# COMPACTO y no admite un cajón de sastre. Sobre las mismas embeddings, el hablante
# minoritario pasó de 0,0 % a 61,4 % de acierto y el reparto de 98,1/1,9 a 65,95/34,05.
#
# Esto es el backend de RESERVA: el primario es pyannote_full. Que la reserva estuviera
# rota significaba que un fallo del primario no degradaba, sino que devolvía basura.
CLUSTER_LINKAGE = "complete"
CLUSTER_METRIC  = "cosine"'''
assert OLD in s
s = s.replace(OLD, NEW, 1)

# ── 2 · usarla en los tres sitios ─────────────────────────────────────────────
old_loop = '''        clust  = AgglomerativeClustering(n_clusters=k, metric="cosine", linkage="average")
        labels = clust.fit_predict(normed)'''
new_loop = '''        clust  = AgglomerativeClustering(n_clusters=k, metric=CLUSTER_METRIC, linkage=CLUSTER_LINKAGE)
        labels = clust.fit_predict(normed)'''
assert old_loop in s
s = s.replace(old_loop, new_loop, 1)

old_fit = '''    clust = AgglomerativeClustering(n_clusters=best_k, metric="cosine", linkage="average")
    return clust.fit_predict(normed).astype(int), diagnostics'''
new_fit = '''    clust = AgglomerativeClustering(n_clusters=best_k, metric=CLUSTER_METRIC, linkage=CLUSTER_LINKAGE)
    return clust.fit_predict(normed).astype(int), diagnostics'''
assert old_fit in s
s = s.replace(old_fit, new_fit, 1)

old_forced = '''        clust  = AgglomerativeClustering(
            n_clusters=min(num_speakers, len(emb_arr)),
            metric="cosine", linkage="average",
        )'''
new_forced = '''        clust  = AgglomerativeClustering(
            n_clusters=min(num_speakers, len(emb_arr)),
            metric=CLUSTER_METRIC, linkage=CLUSTER_LINKAGE,
        )'''
assert old_forced in s
s = s.replace(old_forced, new_forced, 1)

# La linkage queda EN LOS DIAGNÓSTICOS: si mañana cambia, hay que poder saber con cuál
# se produjo un resultado ya guardado sin adivinarlo por la fecha del commit.
s = s.replace('''        "silhouette_threshold":     SILHOUETTE_SPLIT_THRESHOLD,
        "similarity_threshold":     SINGLE_SPEAKER_SIM_THRESHOLD,
    }''', '''        "silhouette_threshold":     SILHOUETTE_SPLIT_THRESHOLD,
        "similarity_threshold":     SINGLE_SPEAKER_SIM_THRESHOLD,
        "linkage":                  CLUSTER_LINKAGE,
        "metric":                   CLUSTER_METRIC,
    }''', 1)
s = s.replace('''        cluster_diag: Dict[str, Any] = {"selected_k": num_speakers, "forced": True}''',
'''        cluster_diag: Dict[str, Any] = {
            "selected_k": num_speakers, "forced": True,
            "linkage": CLUSTER_LINKAGE, "metric": CLUSTER_METRIC,
        }''', 1)

# ── 3 · liberar VRAM al cambiar de etapa ──────────────────────────────────────
OLD_EMPTY = '''def _empty_result(t_start: float, audio_duration: float) -> Dict[str, Any]:'''
NEW_RELEASE = '''def release_models() -> None:
    """
    Suelta los modelos de diarización de la VRAM.

    En una tarjeta de 4 GB esto no es higiene, es el requisito que hace viable
    `pyannote_full`. Medido en la GTX 1650 SUPER: de los 3717 MiB utilizables, el
    servicio histórico de la máquina ocupa 960 fijos, whisper `medium` residente 1160 y
    pyannote 1670. Los dos juntos son 2830 contra 2757 disponibles — se pasa por ~73
    MiB, y el resultado es un OOM que cae al backend de reserva SIN que el usuario se
    entere. Por separado cada uno cabe de sobra.

    `transcribe` y `diarize` son jobs distintos, así que nunca hace falta que coexistan.
    El coste es recargar (~4 s pyannote), y se paga una vez por job.
    """
    global _wespeaker_model, _wespeaker_device, _pyannote_pipeline, _pyannote_pipeline_device
    had = _wespeaker_model is not None or _pyannote_pipeline is not None
    _wespeaker_model = None
    _wespeaker_device = None
    _pyannote_pipeline = None
    _pyannote_pipeline_device = None
    if not had:
        return
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.info("[diarize] Modelos liberados de la VRAM.")
    except Exception as exc:  # noqa: BLE001 — liberar es best-effort, nunca tumba el job
        logger.warning("[diarize] No se pudo vaciar la caché de CUDA: %s", exc)


def _empty_result(t_start: float, audio_duration: float) -> Dict[str, Any]:'''
assert OLD_EMPTY in s
s = s.replace(OLD_EMPTY, NEW_RELEASE, 1)

open(p, "w", encoding="utf-8").write(s)
print("diarization_service.py parcheado")
