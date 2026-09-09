# Worker de transcripción — inconsistencias a resolver antes de fusionar

Revisión conceptual de `transcript-worker/app/` en `Transcript-Project`, hecha
sobre el árbol tal como está en disco. Cada punto dice **qué está mal**, **cómo
se manifiesta** y **cuál es la corrección**. Nada de esto está implementado
todavía.

El orden no es arbitrario: I-1 a I-4 hacen que el árbol actual no pueda arrancar
completo, y hay que cerrarlos antes de que el worker pueda hablar con `mai`.

**Revisión 4.** D-1 está cerrada: `mai` es dueño del dominio, única fuente de
verdad y broker; este worker pasa a ser un **consumidor de cola outbound-only**
con GPU externa (Ubuntu/LAN hoy, proveedor GPU después). Eso **reduce** el
trabajo de I-3, I-8 y I-9 —el camino nuevo no pasa por rutas HTTP— y **agrava**
I-4 e I-6, porque un servicio desplegado no admite configuración parcheada a mano
ni un arranque que muere con el modelo.

**Nada se borra.** Ni las rutas HTTP, ni los patchers, ni ningún archivo. Que un
archivo esté huérfano se documenta; eliminarlo es una propuesta separada con su
propia autorización (§Cutover). **W-1 todavía no está autorizado.**

---

## I-1 · Hay dos paradigmas de configuración incompatibles

`config.py` exporta una **instancia** de pydantic:

```python
class Settings(BaseSettings):
    app_name: str = "transcript-worker"
    host: str = "0.0.0.0"
    port: int = 8001
settings = Settings()
```

Pero `experimental.py` y `diarization_service.py` leen **constantes de módulo**:

```python
from app import config as cfg
...
cfg.DIARIZATION_ENABLED, cfg.SUPPORTED_EXTENSIONS, cfg.DIARIZATION_BACKEND,
cfg.DIARIZATION_FALLBACK_BACKEND, cfg.PYANNOTE_MODEL, cfg.HF_TOKEN
```

Ninguna de esas seis existe en `config.py`. Son **18 referencias** (11 en
`experimental.py`, 7 en `diarization_service.py`) que resuelven a
`AttributeError` en el primer acceso.

Y al revés: `settings` — lo único que `config.py` exporta de verdad — lo consume
**un solo sitio**, `main.py`, para el título de FastAPI. `settings.host` y
`settings.port` no los lee nadie; uvicorn se lanza desde fuera con sus propios
argumentos, así que son decorativos y pueden mentir sobre dónde escucha el
proceso.

**Corrección.** Un solo paradigma, y que sea el tipado: todo pasa a `Settings`
con `pydantic-settings`, y todo consumidor lee `settings.x`. Las seis constantes
que faltan se declaran como campos con su tipo y su default. `host`/`port` se
eliminan o se usan de verdad en el arranque; un valor de configuración que nadie
lee es peor que ausente porque induce a confiar en él.

Nota aparte: `class Config: env_file` es el idioma de **pydantic v1**.
`pydantic_settings.BaseSettings` es v2 y espera
`model_config = SettingsConfigDict(env_file=".env")`. Hoy funciona por
compatibilidad, con aviso de deprecación.

---

## I-2 · `experimental.py` no se puede importar

```python
from app.services.audio_probe import AudioValidationError, validate_audio
```

`app/services/` contiene `__init__.py`, `diarization_service.py`,
`merge_service.py` y `whisper_service.py`. **`audio_probe.py` no existe.** El
import es de nivel de módulo, así que importar `experimental` lanza
`ImportError` antes de evaluar cualquier ruta.

Eso explica I-3 y hay que decirlo en ese orden: `experimental` no está registrado
en `main.py` porque **no puede estarlo**.

**Corrección.** Escribir `audio_probe.py`: probe con ffprobe —duración, canales,
sample rate, códec— y pasa a ser el único validador del worker. El diseño ya lo
necesita: `meeting_media` guarda esos campos.

> **Actualización (pasada de hardening, T-2/T-3).** Este párrafo decía antes que
> `probe_ok`/`probe_error` eran «la diferencia entre medios inválidos y
> transcripción fallida». `probe_error` ya no existe: un sondeo fallido no
> produce fila de medio, produce un job fallido con `failure_code` /
> `failure_detail`. La distinción sigue existiendo, pero está entre TABLAS
> —`meeting_media` cuando hay medio, `meeting_processing_jobs` cuando no— no
> entre dos columnas de la misma fila.

**No** se resuelve borrando el import: `experimental.py` se conserva intacto, y
escribir el módulo que le falta lo hace importable otra vez sin decidir todavía
si sus rutas se retiran.

---

## I-3 · 369 líneas de código muerto en el árbol

`main.py` registra `health`, `gpu` y `transcribe`. No registra `experimental`.

Pero `experimental.py` es justamente donde vive **todo lo que el producto
necesita**: diarización, el pipeline completo transcripción + diarización +
merge, y la selección de backend (`wespeaker` / `pyannote_full`). El endpoint que
sí está publicado, `/transcribe`, devuelve segmentos **sin hablante** — no sirve
para el módulo Reuniones, que separa participantes.

Es decir: el árbol arranca, responde y no hace lo que hace falta.

**Corrección.** El pipeline con diarización pasa a ser el camino único, pero **no
por eliminación**: el bucle de polling lo invoca directamente desde los servicios
(`diarization_service`, `merge_service`), sin pasar por ninguna ruta. Las tres
rutas —`/transcribe`, `/experimental/diarize`,
`/experimental/transcribe-diarize`— **se conservan** y siguen siendo el camino de
vuelta mientras el pull no esté validado en producción.

Lo que cambia en W-1 es solo que `experimental.py` vuelva a ser importable
(I-2). Retirar rutas es T-8, y es una propuesta aparte.

---

## I-4 · La configuración desplegada no es la del repositorio

`config_patch_phase18.py` **reescribe código fuente en el servidor**:

```python
CONFIG_PATH = "/home/santiagov/services/transcript-worker/app/config.py"
...
APPEND_AFTER = "DIARIZATION_MAX_SPEAKERS"
lines.insert(insert_after_idx + 1, ADDITION)
open(CONFIG_PATH, "w").write(new_text)
```

El script busca `DIARIZATION_MAX_SPEAKERS`, que **no está** en el `config.py` del
repo, y aborta si no lo encuentra. Luego, el `config.py` del servidor tiene un
contenido que este árbol no contiene ni describe.

Consecuencias que ya son reales:

- La fuente de verdad de la configuración es un fichero mutado a mano en una
  máquina. No hay forma de saber qué está corriendo leyendo el repo.
- El script existe **duplicado** en `app/config_patch_phase18.py` y
  `scripts/config_patch_phase18.py`. Dos copias del mismo mutador divergen.
- Su docstring dice `HF_TOKEN: fill in your HuggingFace token`. Es decir, la
  instrucción es **poner un secreto en código fuente**.

**Corrección.** Tres cosas, en este orden:

1. Traer el `config.py` real del servidor al repo y reconciliarlo con I-1 (un
   `Settings` tipado). El repo pasa a ser la fuente de verdad.
2. **Dejar de usar** las dos copias del patcher — no borrarlas. La configuración
   se cambia desplegando, no parcheando en caliente. Los archivos quedan en el
   repo, marcados como huérfanos, hasta que T-8 autorice su retirada. No hay
   riesgo en conservarlos: nada en runtime los importa, son scripts de operación
   manual.
3. `HF_TOKEN` sale del código a variable de entorno, sin default.

**[R2] Esto pasa de "alta" a bloqueante.** Un servicio desplegado con réplicas no
tiene "el servidor" que parchear: cada réplica arranca desde la imagen. Un
`config.py` que solo existe mutado en una máquina no se puede desplegar, y el
patcher no puede ejecutarse contra un contenedor efímero. La configuración tiene
que salir del código a variables de entorno **antes** de empaquetar la imagen.

---

## I-5 · `whisper_service.py` ignora toda la configuración

```python
MODEL_SIZE = "medium"
DEVICE = "cuda"
COMPUTE_TYPE = "float16"
```

Constantes de módulo. Mientras tanto `.env.local` de la app Next define
`WHISPER_MODEL`, y `Upload` en Prisma tiene una columna `whisper_model` para
registrar con qué modelo se transcribió. **Ninguna de las dos influye en lo que
el worker carga.** La columna puede afirmar `large-v3` mientras el proceso corre
`medium`.

También: `DEVICE = "cuda"` fijo. En una máquina sin GPU el fallo llega al cargar
el modelo, no al validar la configuración, y el mensaje es de CUDA, no
"no hay GPU en este host".

**Corrección.** Modelo, device y compute type salen de `settings`. El worker
**reporta** en cada resultado qué modelo usó realmente, y ese valor es el que se
persiste, en lugar de que la base guarde una intención.

---

## I-6 · El modelo se carga al importar el módulo

Última línea de `whisper_service.py`:

```python
whisper_service = WhisperService()
```

`main.py` → `routes.transcribe` → `services.whisper_service` → **carga el modelo
en la GPU durante el import**. Efectos:

- `/health` y `/gpu` no pueden responder si el modelo falla: el proceso muere en
  el arranque, antes de que uvicorn escuche. Un health check que solo existe
  cuando todo lo demás funciona no diagnostica nada.
- Cualquier herramienta que importe el paquete (un test, un script) reserva
  memoria de GPU.
- Con dos backends (`wespeaker`, `pyannote_full`) el patrón se multiplica: se
  cargan modelos que esa ejecución no va a usar.

**Corrección.** Carga diferida y explícita: el modelo se instancia la primera vez
que se pide, o en un hook de arranque que **puede fallar sin tumbar el proceso**
y que deja el worker en estado `degraded` — reportable por heartbeat.

**[R2] Con réplicas esto empeora.** La plataforma decide si un contenedor está
vivo por su health check. Si el modelo se carga al importar y falla, el proceso
muere antes de escuchar, el probe nunca responde, y la plataforma entra en un
bucle de reinicios sin decir por qué. Con carga diferida el contenedor responde
`/health` como `degraded`, no reclama trabajo, y el motivo es legible.

---

## I-7 · Dos listas de extensiones permitidas

- `transcribe.py`: `ALLOWED_EXTENSIONS = {".mp3", ".mp4", ".m4a", ".wav", ".flac", ".ogg", ".webm"}`
- `experimental.py`: `cfg.SUPPORTED_EXTENSIONS`

Dos allowlists para la misma decisión, en dos ficheros, y una de ellas apunta a
una constante inexistente (I-1). Cuando alguien añada un formato lo hará en una.

Y hay una tercera: el `route.ts` de la app Next valida su propia lista antes de
guardar. Con la fusión será la cuarta, en `mai`.

**Corrección.** Una sola lista, en `settings`, y el worker la **publica** en su
heartbeat. `mai` valida contra lo que el worker declara soportar, en vez de
mantener una copia que se desincroniza.

---

## I-8 · Manejo de ficheros dependiente del directorio de trabajo

```python
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)
```

Ruta **relativa**, creada al importar. Dónde aterriza depende del `cwd` con el
que systemd arrancó el proceso. Si el servicio se reinicia desde otro
directorio, los temporales se escriben en otro sitio.

Además `experimental_diarize` hace `content = await file.read()`: carga el
archivo **entero en RAM**. La lámina admite hasta 4 GB; un `.mp4` de 340 MB ya
es un pico de memoria evitable, y con dos peticiones concurrentes es un OOM.

**Corrección.** Directorio de trabajo absoluto desde `settings`, y streaming a
disco en lugar de `read()`. Con la fusión el problema **desaparece en su forma
actual**: no hay multipart entrante. El audio se descarga por URL firmada de R2
en streaming a un directorio temporal, se verifica el `checksum_sha256` que
`mai` entrega en el job, y se borra al terminar. El disco del contenedor es
scratch, nunca canónico.

---

## I-9 · Trabajo bloqueante en el bucle de eventos

- `transcribe.py` declara `def transcribe(...)` (síncrono). FastAPI lo ejecuta en
  el threadpool, lo cual es correcto por accidente.
- `experimental_diarize` declara `async def` y dentro llama a `diarize(...)`, que
  es CPU/GPU síncrono. Eso **bloquea el event loop**: mientras diariza, el
  proceso no atiende `/health`.

Los dos endpoints resuelven la misma clase de problema de dos formas distintas, y
la segunda es la incorrecta.

**Corrección.** El trabajo pesado nunca en el event loop. Con la fusión el asunto
cambia de naturaleza: al ser un consumidor de cola, el pipeline corre en su propio
hilo/proceso y el servidor HTTP del worker se queda **solo** con `/health`, que
debe responder siempre — incluida la mitad de un job, porque de eso depende que
la plataforma no lo reinicie a mitad de una transcripción de dos horas.

---

## Resumen

| # | Inconsistencia | Gravedad |
|---|---|---|
| I-1 | Dos paradigmas de config; 18 referencias a constantes inexistentes | **Bloqueante** |
| I-2 | `experimental.py` importa `audio_probe`, que no existe | **Bloqueante** |
| I-3 | El pipeline con diarización no está registrado; el publicado no sirve | **Bloqueante** |
| I-4 | El `config.py` desplegado no está en el repo; se parchea en caliente; pide secreto en fuente | **Alta** |
| I-5 | `whisper_service` ignora `WHISPER_MODEL`; la BD registra una intención, no un hecho | **Alta** |
| I-6 | El modelo se carga al importar; el health check muere con él | **Alta** |
| I-7 | Cuatro allowlists de extensiones para una decisión | Media |
| I-8 | Rutas relativas y `read()` completo en RAM | Media |
| I-9 | Diarización bloqueando el event loop | Media |

I-1, I-2 e I-3 se cierran juntos: son la misma deuda vista desde tres sitios —
la fase 18 se dejó a medias, con el código nuevo dependiendo de una
configuración y un módulo que nunca se commitearon.

---

## Cutover del worker — nada se borra **[R4]**

Corrección de la revisión 2, que decía "se borra" de tres ficheros, y de la
revisión 3, que aún borraba los patchers en W-1. **Ambas eran prematuras.**
Documentar que algo está huérfano no autoriza eliminarlo.

De las ~1 400 líneas de `transcript-worker/app/`:

| Componente | Destino | Fase |
|---|---|---|
| `services/diarization_service.py` (553) | **Se conserva** íntegro | — |
| `services/merge_service.py` (240) | **Se conserva** íntegro | — |
| `python/*.py` (pipeline y benchmarks) | **Se conserva** | — |
| `routes/health.py` | **Se conserva** siempre | — |
| `routes/gpu.py` | **Se conserva**; su contenido alimenta la telemetría del `claim` | — |
| `routes/transcribe.py` | **Se conserva** — camino de vuelta | retirada propuesta en T-8 |
| `routes/experimental.py` | **Se conserva** — vuelve a ser importable en W-1 | retirada propuesta en T-8 |
| `config_patch_phase18.py` (×2) | **Se conservan**, marcados huérfanos y sin uso | retirada propuesta en T-8 |
| `config.py` | **Se reescribe**: `Settings` tipado con las 6 constantes (I-1) | W-1 |
| `services/whisper_service.py` | **Se reescribe**: carga diferida, modelo desde config (I-5, I-6) | W-1 |
| `audio_probe.py` | **Se escribe**: el módulo que falta (I-2) | W-1 |
| `client.py` (claim/heartbeat/result/fail) | **Nuevo**, junto a lo existente | W-2 |
| bucle de polling | **Nuevo** en `main.py`, coexiste con FastAPI | W-2 |

### Orden

- **W-1** *(pendiente de autorización)* — Cerrar I-1, I-2, I-4, I-5, I-6. El
  worker **sigue sirviendo HTTP exactamente igual que hoy**: se arregla la
  configuración, la carga del modelo y el módulo que falta; no se toca ningún
  contrato. Verificable en aislamiento, sin `mai`.
- **W-2** — Añadir `client.py` y el bucle de polling **al lado** de las rutas
  HTTP. Los dos caminos coexisten; el pull apunta a `mai` en staging.
- **W-3** — Validar end-to-end en staging: reunión real, `claim` → `result` →
  visible en la UI. **Puerta de calidad**: sin esto no se avanza.
- **W-4** — Producción con el pool `internal-lan`. Las rutas viejas siguen en pie
  y son el camino de vuelta.
- **T-8** — *Propuesta separada, autorización propia*: retirar rutas y archivos
  huérfanos.

El pipeline de ML —lo que de verdad vale— se conserva íntegro en todas las
fases. Lo que cambia es la capa de configuración (W-1) y cómo llega el trabajo
(W-2). El resto permanece hasta que alguien decida explícitamente retirarlo.
