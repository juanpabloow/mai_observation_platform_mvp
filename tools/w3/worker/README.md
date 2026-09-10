# Parches del worker · PENDIENTES DE APLICAR

Nada de esta carpeta se ha ejecutado. Se versiona para que lo que acabe corriendo en
`ml-server` sea exactamente lo revisado, y no algo teclado a mano sobre un servidor.

    ssh santiagov@100.103.187.118
    cd /home/santiagov/services/mai-w3-worker/transcript-worker
    git status --porcelain          # tiene que estar limpio antes
    python3 tools/w3/worker/01_diarization_service.py
    python3 tools/w3/worker/02_stages_runner_config.py

## Qué cambia cada uno

1. **`01_diarization_service.py`** — la linkage del agrupamiento pasa de `average` a
   `complete`, en un solo sitio (`CLUSTER_LINKAGE`), y queda escrita en los
   diagnósticos para poder saber con cuál se produjo un resultado ya guardado. Añade
   `release_models()` para soltar la VRAM.

2. **`02_stages_runner_config.py`** — cuatro cosas:
   - `run_diarize` lee **`_backend_used`**, que es la clave que `diarize()` sí
     devuelve. Antes leía `backend`, que no existe, así que el `or` caía siempre en el
     backend *configurado*. Con `pyannote_full` por defecto, un OOM habría guardado
     `diarization_backend = 'pyannote_full'` sobre un resultado de `wespeaker`.
   - `run_diarize` acepta `num_speakers`, y `runner` lo saca de
     `options.speakerCount` con validación propia (1..10; cualquier otra cosa avisa y
     sigue en automático).
   - `run_transcribe` pide `word_timestamps=True`, y el artefacto de transcript sube a
     `schema_version` 2 con `words` recortadas al segmento. Un segmento sin palabras
     sale sin la clave: **no se inventa ningún tiempo**.

     **Cuidado con descartar palabras.** mai sólo parte un segmento si sus `words`
     se corresponden UNA A UNA con los tokens de su `text` —y además coinciden los
     textos—, porque el texto de cada bloque se rebana del original y así no se puede
     perder ni duplicar nada. El filtro de `02` descarta palabras vacías o con tiempos
     ilegibles; cada descarte rompe esa correspondencia y hace que mai **no parta ese
     segmento** (lo emite entero y marcado `speaker_uncertain`). Eso es correcto y
     seguro, pero significa que un filtro demasiado agresivo cuesta atribución. Hay
     que medir cuántos segmentos acaban sin partir por esta razón antes de dar el
     recorrido por bueno.
   - `DIARIZATION_BACKEND` pasa a `pyannote_full`, con `wespeaker` de reserva.

## Lo que hay que comprobar DESPUÉS de aplicarlos, y que no está comprobado

- `whisper_service.unload()` **no existe todavía**: hay que añadirlo a
  `WhisperService` (soltar `self._model` bajo su lock y vaciar la caché de CUDA).
  `01`/`02` no lo crean, así que `02` fallará hasta que esté.
- Que whisper y pyannote no coincidan nunca en VRAM, midiéndolo, no deduciéndolo.
- La regresión de `complete` contra audios distintos del de prueba.
- `merge_gap_ms` aislado, que es lo único que sostendría atribuirle la interjección
  perdida de 00:15–00:16.
- Un recorrido completo con `speakerCount` elegido, comprobando en los logs del worker
  que `[diarize] ... num_speakers=2` aparece de verdad.
- Cuántos segmentos quedan sin partir porque `words` no se corresponde con el texto.
  Si son muchos, el problema está en cómo el worker emite las palabras, no en mai.
