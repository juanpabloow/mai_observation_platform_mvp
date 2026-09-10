"""Los contratos de W-3: palabras, artefacto v2, speakerCount y backend real.

Sin GPU, sin red y sin modelos: todo lo que necesita GPU esta sustituido por dobles.
Lo que se afirma aqui es exactamente lo que mai va a leer y lo que la tarjeta de 4 GB
exige, no el detalle interno de como se consigue.
"""

from __future__ import annotations

import gzip
import json

import pytest

from app.pull.artifacts import write_diarization_artifact, write_transcript_artifact
from app.pull.mai_client import ClaimedJob
from app.pull.runner import _requested_speaker_count


# ══════════════════════════════════════════════════════════════════════════════
#  Liberar la VRAM entre etapas
# ══════════════════════════════════════════════════════════════════════════════

def test_unload_suelta_el_modelo_y_es_idempotente():
    from app.services.whisper_service import WhisperService

    service = WhisperService()
    assert service.unload() is False, "sin modelo cargado no hay nada que soltar"

    service._model = object()          # doble: no hace falta un WhisperModel real
    service._resolved_device = "cuda"
    assert service.is_loaded is True

    assert service.unload() is True
    assert service.is_loaded is False, "la referencia se solto: CTranslate2 libera al destruirse"
    assert service.unload() is False, "y repetirlo no falla"


def test_unload_no_borra_lo_que_describe_el_health_check():
    """`describe()` tiene que seguir contestando tras descargar, sin cargar nada."""
    from app.services.whisper_service import WhisperService

    service = WhisperService()
    service._model = object()
    service.unload()
    described = service.describe()
    assert described["loaded"] is False
    assert described["load_error"] is None, "descargar no es un fallo de carga"
    assert described["model"], "sigue sabiendo que modelo usaria"


def test_release_models_es_idempotente_y_limpia_los_dos_backends():
    from app.services import diarization_service as ds

    ds._wespeaker_model = None
    ds._pyannote_pipeline = None
    assert ds.release_models() is False

    ds._wespeaker_model = object()
    ds._pyannote_pipeline = object()
    assert ds.release_models() is True
    assert ds._wespeaker_model is None
    assert ds._pyannote_pipeline is None
    assert ds._wespeaker_device is None
    assert ds._pyannote_pipeline_device is None
    assert ds.release_models() is False


def test_las_dos_etapas_se_sueltan_el_modelo_de_la_otra(monkeypatch):
    """
    El requisito de la tarjeta de 4 GB, afirmado como comportamiento y no como
    comentario: transcribe suelta la diarizacion, y diarize suelta whisper.
    """
    from app.pull import stages
    from app.services import diarization_service as ds
    from app.services import whisper_service as ws

    llamadas: list[str] = []

    monkeypatch.setattr(ds, "release_models", lambda: llamadas.append("release_diarizacion"))
    monkeypatch.setattr(ws.whisper_service, "transcribe",
                        lambda path, **kw: {"segments": [], "language": "es", "duration": 1.0,
                                            "model": "medium", "device": "cpu", "compute_type": "int8"})
    stages.run_transcribe("/tmp/x.wav")
    assert llamadas == ["release_diarizacion"], "transcribe suelta pyannote ANTES de cargar whisper"

    llamadas.clear()
    monkeypatch.setattr(ws.whisper_service, "unload", lambda: llamadas.append("unload_whisper"))
    monkeypatch.setattr(ds, "diarize", lambda **kw: {"speaker_turns": [], "_backend_used": "wespeaker"})
    stages.run_diarize("/tmp/x.wav", file_id="m1")
    assert llamadas == ["unload_whisper"], "diarize suelta whisper ANTES de cargar pyannote"


# ══════════════════════════════════════════════════════════════════════════════
#  El backend que corrio DE VERDAD
# ══════════════════════════════════════════════════════════════════════════════

def test_se_registra_el_backend_que_corrio_no_el_configurado(monkeypatch):
    """
    El caso que motivo la correccion: pyannote se queda sin VRAM, `diarize()` cae a
    wespeaker y devuelve `_backend_used="wespeaker"`. Antes se guardaba el
    CONFIGURADO, o sea un resultado de wespeaker etiquetado como pyannote.
    """
    from app import config as cfg
    from app.pull import stages
    from app.services import diarization_service as ds
    from app.services import whisper_service as ws

    monkeypatch.setattr(ws.whisper_service, "unload", lambda: False)
    monkeypatch.setattr(cfg, "DIARIZATION_BACKEND", "pyannote_full", raising=False)
    monkeypatch.setattr(ds, "diarize", lambda **kw: {
        "speaker_turns": [{"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0}],
        "_backend_used": "wespeaker",
        "_backend_fallback": True,
        "_backend_error": "CUDA out of memory",
    })
    outcome = stages.run_diarize("/tmp/x.wav", file_id="m1")
    assert outcome.backend == "wespeaker", "lo que corrio, no lo que se pidio"


def test_sin_fallback_se_registra_el_primario(monkeypatch):
    from app import config as cfg
    from app.pull import stages
    from app.services import diarization_service as ds
    from app.services import whisper_service as ws

    monkeypatch.setattr(ws.whisper_service, "unload", lambda: False)
    monkeypatch.setattr(cfg, "DIARIZATION_BACKEND", "pyannote_full", raising=False)
    monkeypatch.setattr(ds, "diarize", lambda **kw: {
        "speaker_turns": [], "_backend_used": "pyannote_full",
    })
    assert stages.run_diarize("/tmp/x.wav", file_id="m1").backend == "pyannote_full"


def test_un_backend_que_mai_no_admite_aborta_la_etapa(monkeypatch):
    from app.pull import stages
    from app.services import diarization_service as ds
    from app.services import whisper_service as ws

    monkeypatch.setattr(ws.whisper_service, "unload", lambda: False)
    monkeypatch.setattr(ds, "diarize", lambda **kw: {"speaker_turns": [], "_backend_used": "otro"})
    with pytest.raises(stages.StageError):
        stages.run_diarize("/tmp/x.wav", file_id="m1")


# ══════════════════════════════════════════════════════════════════════════════
#  speakerCount, desde las opciones del run hasta la llamada real
# ══════════════════════════════════════════════════════════════════════════════

def job_con(options) -> ClaimedJob:
    return ClaimedJob(
        job_id="j", meeting_id="m", run_id="r", stage="diarize", attempt=1,
        lease_token="t", lease_expires_at="2026-01-01T00:00:00Z", inputs=[],
        options=options, language_hint=None,
    )


@pytest.mark.parametrize("options,esperado", [
    ({}, None),                       # run anterior a la opcion
    ({"speakerCount": None}, None),   # «Automatico» explicito
    ({"speakerCount": 2}, 2),
    ({"speakerCount": 1}, 1),         # 1 es una AFIRMACION, no automatico
    ({"speakerCount": 10}, 10),
    ({"speakerCount": "3"}, 3),       # JSON laxo: se acepta si es un entero legible
    ({"speakerCount": 0}, None),      # fuera de rango
    ({"speakerCount": 11}, None),
    ({"speakerCount": 2.7}, 2),       # int() trunca; queda dentro de rango
    ({"speakerCount": "dos"}, None),
    ({"speakerCount": True}, None),   # bool es int en Python, y no significa «uno»
    ({"speakerCount": [2]}, None),
])
def test_speaker_count_se_lee_y_se_valida(options, esperado):
    assert _requested_speaker_count(job_con(options)) == esperado


def test_ausente_y_automatico_son_indistinguibles():
    """Es la propiedad que evita mantener dos caminos: mai omite la clave a proposito."""
    assert _requested_speaker_count(job_con({})) is _requested_speaker_count(
        job_con({"speakerCount": None})
    )


def test_el_numero_llega_hasta_la_llamada_a_diarize(monkeypatch):
    from app.pull import stages
    from app.services import diarization_service as ds
    from app.services import whisper_service as ws

    visto = {}
    monkeypatch.setattr(ws.whisper_service, "unload", lambda: False)

    def fake(**kw):
        visto.update(kw)
        return {"speaker_turns": [], "_backend_used": "wespeaker"}

    monkeypatch.setattr(ds, "diarize", fake)
    stages.run_diarize("/tmp/x.wav", file_id="m1", num_speakers=2)
    assert visto["num_speakers"] == 2, "es el argumento que de verdad cambia el resultado"

    visto.clear()
    stages.run_diarize("/tmp/x.wav", file_id="m1")
    assert visto["num_speakers"] is None, "automatico por omision"


# ══════════════════════════════════════════════════════════════════════════════
#  El artefacto v2 y sus palabras
# ══════════════════════════════════════════════════════════════════════════════

def leer(path):
    lines = gzip.open(path, "rt", encoding="utf-8").read().strip().split("\n")
    return json.loads(lines[0]), [json.loads(x) for x in lines[1:]]


def escribir(tmp_path, segments):
    path = str(tmp_path / "t.ndjson.gz")
    write_transcript_artifact(
        path, segments=segments, language="es", duration_seconds=10.0,
        model="medium", device="cuda", compute_type="float16",
    )
    return leer(path)


def test_las_palabras_viajan_en_el_artefacto(tmp_path):
    header, rows = escribir(tmp_path, [{
        "start": 0.0, "end": 2.0, "text": "hola mundo",
        "words": [{"start": 0.0, "end": 1.0, "word": "hola"},
                  {"start": 1.0, "end": 2.0, "word": " mundo"}],
    }])
    assert header["schema_version"] == 2
    assert rows[0]["words"] == [
        {"start": 0.0, "end": 1.0, "word": "hola"},
        {"start": 1.0, "end": 2.0, "word": " mundo"},
    ]


def test_una_palabra_fuera_del_segmento_se_recorta_en_vez_de_invalidar_el_artefacto(tmp_path):
    """mai rechaza el artefacto ENTERO si una palabra se sale. Se recorta aqui."""
    _, rows = escribir(tmp_path, [{
        "start": 1.0, "end": 3.0, "text": "una",
        "words": [{"start": 0.2, "end": 9.0, "word": "una"}],
    }])
    assert rows[0]["words"] == [{"start": 1.0, "end": 3.0, "word": "una"}]


def test_las_palabras_salen_en_orden_no_decreciente(tmp_path):
    _, rows = escribir(tmp_path, [{
        "start": 0.0, "end": 3.0, "text": "a b",
        "words": [{"start": 2.0, "end": 3.0, "word": "a"},
                  {"start": 0.0, "end": 1.0, "word": "b"}],
    }])
    tiempos = [(w["start"], w["end"]) for w in rows[0]["words"]]
    assert all(tiempos[i][0] >= tiempos[i - 1][1] - 1e-9 for i in range(1, len(tiempos)))


def test_una_palabra_con_tiempos_ilegibles_NO_desaparece(tmp_path):
    """
    Descartarla romperia la correspondencia uno a uno con los tokens del texto, y mai
    entonces NO parte ese segmento. Se conserva con duracion cero.
    """
    _, rows = escribir(tmp_path, [{
        "start": 0.0, "end": 3.0, "text": "a b c",
        "words": [{"start": 0.0, "end": 1.0, "word": "a"},
                  {"start": None, "end": None, "word": "b"},
                  {"start": 2.0, "end": 3.0, "word": "c"}],
    }])
    assert [w["word"] for w in rows[0]["words"]] == ["a", "b", "c"]


def test_sin_palabras_no_aparece_la_clave(tmp_path):
    _, rows = escribir(tmp_path, [{"start": 0.0, "end": 1.0, "text": "hola"}])
    assert "words" not in rows[0], "ausente, no vacia: mai lo lleva por el camino de v1"
    _, rows = escribir(tmp_path, [{"start": 0.0, "end": 1.0, "text": "hola", "words": []}])
    assert "words" not in rows[0]


def test_la_diarizacion_se_queda_en_v1(tmp_path):
    """Su formato no cambio. Subirla habria hecho que mai rechazara el artefacto."""
    path = str(tmp_path / "d.ndjson.gz")
    write_diarization_artifact(
        path, turns=[{"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0}], backend="pyannote_full",
    )
    header, _ = leer(path)
    assert header["schema_version"] == 1
    assert header["backend"] == "pyannote_full"


# ══════════════════════════════════════════════════════════════════════════════
#  La configuracion
# ══════════════════════════════════════════════════════════════════════════════

def test_el_backend_por_defecto_es_pyannote_con_wespeaker_de_reserva():
    from app.config import Settings

    settings = Settings()
    assert settings.diarization_backend == "pyannote_full"
    assert settings.diarization_fallback_backend == "wespeaker"


def test_la_linkage_del_agrupamiento_es_complete():
    """Es el backend de RESERVA: dejarlo roto convertiria un fallo en basura."""
    from app.services.diarization_service import CLUSTER_LINKAGE, CLUSTER_METRIC

    assert CLUSTER_LINKAGE == "complete"
    assert CLUSTER_METRIC == "cosine"
