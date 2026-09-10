#!/usr/bin/env python3
"""Parches 2..5 del worker. PENDIENTES DE APLICAR Y DE VERIFICAR EN LINUX.

    python3 tools/w3/worker/01_diarization_service.py
    python3 tools/w3/worker/02_stages_runner_config.py

Nada de esto se ha ejecutado todavía: la máquina de la GPU se cayó dos veces y el
recorrido completo está sin verificar. Se versiona aquí para que lo que se aplique sea
exactamente lo revisado, y no algo teclado a mano sobre un servidor.
"""
import sys

R = "/home/santiagov/services/mai-w3-worker/transcript-worker"


def patch(path, pairs, *, expect_all=True):
    with open(path, encoding="utf-8") as handle:
        text = handle.read()
    for old, new in pairs:
        if old not in text:
            if expect_all:
                raise SystemExit(f"NO ENCONTRADO en {path}:\n{old[:200]}")
            continue
        text = text.replace(old, new, 1)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    print(f"parcheado {path}")


# ══════════════════════════════════════════════════════════════════════════════
# 2 · stages.py — el backend REAL, el número de hablantes, y liberar la VRAM
# ══════════════════════════════════════════════════════════════════════════════
patch(R + "/app/pull/stages.py", [
    # ── El backend que corrió de verdad ───────────────────────────────────────
    (
        '''def run_diarize(audio_path: str, file_id: str) -> DiarizeOutcome:
    """
    Llama al servicio de diarización existente.

    `diarize()` ya elige el backend según la configuración y cae al de reserva
    si el primero falla; eso no se cambia. Lo que se hace aquí es leer del
    resultado QUÉ backend acabó corriendo, porque es lo que va en la cabecera
    del artefacto y lo que mai guarda en `diarization_backend`. Suponer el
    configurado escribiría en la base un backend que no fue el que corrió.
    """
    from app import config as cfg
    from app.services.diarization_service import diarize
    from app.services.whisper_service import resolve_device

    try:
        result = diarize(
            audio_path=audio_path,
            device=resolve_device(cfg.WHISPER_DEVICE),
            min_speakers=cfg.DIARIZATION_MIN_SPEAKERS,
            max_speakers=cfg.DIARIZATION_MAX_SPEAKERS,
            file_id=file_id,
        )
    except Exception as error:  # noqa: BLE001
        raise StageError("diarize_failed", str(error)) from None

    turns = result.get("speaker_turns") or result.get("turns") or []
    backend = str(result.get("backend") or cfg.DIARIZATION_BACKEND)''',
        '''def run_diarize(
    audio_path: str,
    file_id: str,
    num_speakers: Optional[int] = None,
) -> DiarizeOutcome:
    """
    Llama al servicio de diarización existente.

    `diarize()` ya elige el backend según la configuración y cae al de reserva
    si el primero falla; eso no se cambia. Lo que se hace aquí es leer del
    resultado QUÉ backend acabó corriendo, porque es lo que va en la cabecera
    del artefacto y lo que mai guarda en `diarization_backend`. Suponer el
    configurado escribiría en la base un backend que no fue el que corrió.

    ── CORRECCIÓN: se leía una clave que `diarize()` nunca devuelve ───────────

    Esto hacía `result.get("backend")`, y `diarize()` no devuelve `backend`:
    devuelve `_backend_used`. Así que el `or` caía SIEMPRE en
    `cfg.DIARIZATION_BACKEND` — exactamente el «suponer el configurado» que el
    párrafo de arriba dice evitar. Era inocuo mientras primario y reserva fueran
    los dos `wespeaker`, y deja de serlo en cuanto no lo son.

    No es teórico: probando `pyannote_full` en la GTX 1650 SUPER con el worker
    en marcha, se quedó sin VRAM, cayó a `wespeaker` y devolvió
    `_backend_used="wespeaker"`. Con el código anterior, mai habría guardado
    `diarization_backend = 'pyannote_full'` — resultados del backend viejo
    etiquetados como del nuevo, que es peor que el fallo.

    ── num_speakers ──────────────────────────────────────────────────────────

    Viene de `requested_options.speakerCount` del run, que es lo que eligió quien
    subió la reunión. `None` es AUTOMÁTICO y es el valor por defecto, así que un
    run sin la opción se comporta como siempre.
    """
    from app import config as cfg
    from app.services.diarization_service import diarize
    from app.services.whisper_service import resolve_device, whisper_service

    # La VRAM no da para whisper y pyannote a la vez en una tarjeta de 4 GB (medido:
    # 1160 + 1670 contra 2757 disponibles). Se suelta whisper ANTES de diarizar; el
    # siguiente job de transcripción lo recarga. Sin esto, `pyannote_full` se queda sin
    # memoria y cae al de reserva sin que nadie lo pida.
    whisper_service.unload()

    try:
        result = diarize(
            audio_path=audio_path,
            device=resolve_device(cfg.WHISPER_DEVICE),
            min_speakers=cfg.DIARIZATION_MIN_SPEAKERS,
            max_speakers=cfg.DIARIZATION_MAX_SPEAKERS,
            num_speakers=num_speakers,
            file_id=file_id,
        )
    except Exception as error:  # noqa: BLE001
        raise StageError("diarize_failed", str(error)) from None

    turns = result.get("speaker_turns") or result.get("turns") or []
    # `_backend_used` es la clave que `diarize()` SÍ devuelve. El `or` se conserva por
    # si un día dejara de ponerla, pero ya no es el camino normal.
    backend = str(result.get("_backend_used") or result.get("backend") or cfg.DIARIZATION_BACKEND)''',
    ),
    # ── Palabras con tiempo ───────────────────────────────────────────────────
    (
        '''def run_transcribe(audio_path: str) -> TranscribeOutcome:''',
        '''def run_transcribe(audio_path: str) -> TranscribeOutcome:''',
    ),
    (
        '''    from app.services.whisper_service import WhisperLoadError, whisper_service

    try:
        result = whisper_service.transcribe(audio_path)''',
        '''    from app.services.diarization_service import release_models
    from app.services.whisper_service import WhisperLoadError, whisper_service

    # Simétrico a lo de `run_diarize`: se suelta pyannote antes de cargar whisper.
    release_models()

    try:
        # `word_timestamps=True`: mai los necesita para atribuir hablante DENTRO de un
        # segmento. Sin ellos, un segmento de whisper que contiene a dos personas se
        # atribuye entero a una — medido en una reunión real, la pregunta de una voz
        # quedaba a nombre de quien respondía. El coste en tiempo es pequeño y el
        # servicio ya lo soportaba; simplemente no se le pedía.
        result = whisper_service.transcribe(audio_path, word_timestamps=True)''',
    ),
])

# `Optional` puede no estar importado en stages.py.
with open(R + "/app/pull/stages.py", encoding="utf-8") as handle:
    stages = handle.read()
if "Optional" not in stages.split("\n\n")[0] and "from typing import" in stages:
    import re
    stages = re.sub(
        r"from typing import ([^\n]+)",
        lambda m: "from typing import " + m.group(1) if "Optional" in m.group(1)
        else "from typing import " + m.group(1) + ", Optional",
        stages, count=1,
    )
    with open(R + "/app/pull/stages.py", "w", encoding="utf-8") as handle:
        handle.write(stages)
    print("stages.py: Optional importado")

# ══════════════════════════════════════════════════════════════════════════════
# 3 · runner.py — pasar la opción y las palabras
# ══════════════════════════════════════════════════════════════════════════════
patch(R + "/app/pull/runner.py", [
    (
        '''        outcome = run_diarize(audio, file_id=job.meeting_id)''',
        '''        outcome = run_diarize(
            audio,
            file_id=job.meeting_id,
            num_speakers=_requested_speaker_count(job),
        )''',
    ),
    (
        '''    def _do_transcribe(self, job: ClaimedJob, workspace: JobWorkspace, monitor: HeartbeatMonitor) -> None:''',
        '''    @staticmethod
    def _requested_speaker_count(job: ClaimedJob) -> Optional[int]:
        """
        Cuántas personas dijo quien subió la reunión que hablan, si lo dijo.

        Sale de `options`, que mai rellena con `requested_options` del run. La AUSENCIA
        de la clave es automático, que es el comportamiento de siempre: así un run
        anterior a que la opción existiera y uno donde se eligió «Automático» hacen lo
        mismo, sin dos caminos que mantener.

        Se valida aquí aunque mai ya valide en su 400: este proceso no controla quién
        le habla, y un número absurdo tiene que ignorarse con un aviso, no reventar el
        job ni llegar a sklearn.
        """
        raw = (job.options or {}).get("speakerCount")
        if raw is None:
            return None
        try:
            value = int(raw)
        except (TypeError, ValueError):
            logger.warning("speakerCount no numérico (%r): se diariza en automático", raw)
            return None
        if not 1 <= value <= 10:
            logger.warning("speakerCount fuera de 1..10 (%r): se diariza en automático", raw)
            return None
        return value

    def _do_transcribe(self, job: ClaimedJob, workspace: JobWorkspace, monitor: HeartbeatMonitor) -> None:''',
    ),
    (
        '''            compute_type=outcome.compute_type,
        )''',
        '''            compute_type=outcome.compute_type,
        )''',
    ),
])

# El método se referencia como `_requested_speaker_count(job)` dentro de la clase.
with open(R + "/app/pull/runner.py", encoding="utf-8") as handle:
    runner = handle.read()
runner = runner.replace("num_speakers=_requested_speaker_count(job),",
                        "num_speakers=self._requested_speaker_count(job),")
if "from typing import" in runner and "Optional" not in runner.split("\n\n")[0]:
    import re
    runner = re.sub(
        r"from typing import ([^\n]+)",
        lambda m: "from typing import " + m.group(1) if "Optional" in m.group(1)
        else "from typing import " + m.group(1) + ", Optional",
        runner, count=1,
    )
with open(R + "/app/pull/runner.py", "w", encoding="utf-8") as handle:
    handle.write(runner)
print("runner.py: referencias ajustadas")

# ══════════════════════════════════════════════════════════════════════════════
# 4 · artifacts.py — schema_version 2 del transcript, con `words`
# ══════════════════════════════════════════════════════════════════════════════
patch(R + "/app/pull/artifacts.py", [
    (
        "SCHEMA_VERSION = 1",
        '''SCHEMA_VERSION = 1
# El transcript pasa a 2 porque sus líneas pueden llevar `words`. La diarización se
# queda en 1: su formato no ha cambiado. Estaban compartiendo una constante, y con eso
# subir uno habría subido el otro y mai habría rechazado el artefacto de turnos por la
# cabecera.
TRANSCRIPT_SCHEMA_VERSION = 2
DIARIZATION_SCHEMA_VERSION = 1''',
    ),
    (
        '''    header = {
        "schema": TRANSCRIPT_SCHEMA,
        "schema_version": SCHEMA_VERSION,''',
        '''    header = {
        "schema": TRANSCRIPT_SCHEMA,
        "schema_version": TRANSCRIPT_SCHEMA_VERSION,''',
    ),
    (
        '''        confidence = segment.get("confidence")
        if isinstance(confidence, (int, float)):
            row["confidence"] = max(0.0, min(1.0, round(float(confidence), 4)))
        rows.append(row)''',
        '''        confidence = segment.get("confidence")
        if isinstance(confidence, (int, float)):
            row["confidence"] = max(0.0, min(1.0, round(float(confidence), 4)))

        # ── `words`, sólo si whisper las trajo ────────────────────────────────
        #
        # Se RECORTAN a los límites del segmento y se descartan las que caen fuera:
        # mai valida que cada palabra esté dentro de su segmento y rechaza el artefacto
        # entero si no, así que dejar pasar una palabra desalineada costaría el
        # pipeline completo. Y no se inventa ninguna: un segmento sin palabras sale sin
        # la clave, y mai lo trata como v1.
        words = segment.get("words")
        if isinstance(words, list) and words:
            cleaned: list[dict[str, Any]] = []
            previous_end = start
            for word in words:
                if not isinstance(word, Mapping):
                    continue
                text = str(word.get("word", ""))
                if text == "":
                    continue
                try:
                    w_start = float(word.get("start"))
                    w_end = float(word.get("end"))
                except (TypeError, ValueError):
                    continue
                w_start = min(max(w_start, previous_end), end)
                w_end = min(max(w_end, w_start), end)
                if w_end <= w_start:
                    continue
                cleaned.append({
                    "start": round(w_start, 3),
                    "end": round(w_end, 3),
                    "word": text,
                })
                previous_end = w_end
            if cleaned:
                row["words"] = cleaned
        rows.append(row)''',
    ),
    (
        '''        "schema": DIARIZATION_SCHEMA,
        "schema_version": SCHEMA_VERSION,''',
        '''        "schema": DIARIZATION_SCHEMA,
        "schema_version": DIARIZATION_SCHEMA_VERSION,''',
    ),
])

# ══════════════════════════════════════════════════════════════════════════════
# 5 · config.py — pyannote_full como predeterminado, wespeaker de reserva
# ══════════════════════════════════════════════════════════════════════════════
patch(R + "/app/config.py", [
    (
        '''    diarization_backend: DiarizationBackend = "wespeaker"
    diarization_fallback_backend: DiarizationBackend = "wespeaker"''',
        '''    # pyannote_full por defecto: su segmentación neuronal corta donde cambia la voz,
    # no donde baja la energía, y es el único de los dos que detectó las tres
    # intervenciones anotadas a oído de la reunión de prueba — incluida una de un
    # segundo— sin atribuir NADA del hablante minoritario al mayoritario.
    #
    # Requisito de la tarjeta de 4 GB: NO puede coexistir con whisper en VRAM
    # (1670 + 1160 contra 2757 disponibles). `run_diarize` y `run_transcribe` sueltan
    # el modelo del otro antes de cargar el suyo; sin eso, esto OOM-ea y cae a la
    # reserva en cada reunión.
    diarization_backend: DiarizationBackend = "pyannote_full"
    diarization_fallback_backend: DiarizationBackend = "wespeaker"''',
    ),
])

print("\\nTODOS LOS PARCHES APLICADOS. Falta verificar el recorrido completo.")
