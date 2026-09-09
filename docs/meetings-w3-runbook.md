# W-3 · Preflight y runbook de validación en staging

**Estado: pasos 1 y 2 HECHOS en local. Nada remoto tocado.** B-1 y B-3 están
corregidos, los cuatro scripts existen y están probados, y todo el SQL de este
documento se ejecuta contra el esquema real en la suite de esquema. No se ha
desplegado, no se ha creado bucket, no se ha migrado ninguna base remota y no se
ha tocado la PC Linux.

**La puerta de revisión es AHORA**, antes del paso 3.

Alcance: validar el recorrido completo con audio real, R2 real, ffprobe real,
Whisper real y diarización real, contra `mai` corriendo en modo producción.
**T-4 (`analyze`) queda fuera.**

---

## 0 · Bloqueantes

| # | qué | estado |
|---|---|---|
| B-1 | el middleware redirigía las rutas del worker a `/login` | **corregido** · `1dee6a7` |
| B-2 | en esta rama no hay forma de subir un audio | **resuelto por diseño**: dos vías (§0 B-2), ambas implementadas |
| B-3 | `requirements.txt` del worker incompleto | **corregido** · `d0bb600` (worker) |
| — | la caché de rutas | **descartado con evidencia**: las once son `ƒ` Dynamic |

### B-1 · El middleware de Next redirige las rutas del worker a `/login`

`web/middleware.ts` corre sobre todo salvo estáticos, y su lista de prefijos
públicos es:

```
/login /signup /logout /forgot-password /reset-password /api/auth
/invite /api/handoff /api/health /api/scheduling /api/crm /api/booking /book
```

**`/api/meetings` no está.** El worker manda `Authorization: Bearer …` sin
cookie de sesión, así que `getSessionCookie(request)` devuelve nada y el
middleware responde **307 hacia `/login`**. El worker recibiría HTML de redirección
en vez de JSON, en las seis rutas de máquina, y el fallo no aparece en ninguna
prueba porque las pruebas de Route Handler **importan e invocan el handler**: no
pasan por el middleware. Es exactamente el hueco que este runbook tiene que
cerrar.

**Corregido en `1dee6a7`.** Sólo los dos subárboles de máquina:

```ts
// en PUBLIC_PREFIXES
"/api/meetings/v1/jobs",
"/api/meetings/v1/maintenance",
```

Cubierto por `web/tests/meetings-middleware.test.ts` (9 pruebas), que ejercita
`middleware()` con `NextRequest` real: las seis de máquina continúan al handler
y **cada una llama `authenticateWorker`** —que el middleware las deje pasar sólo
es correcto si el handler autentica—, ninguna resuelve ámbito de sesión, las
cinco de sesión siguen rebotando conservando `?redirect`, la lista de prefijos
de meetings es exactamente esos dos, y `/api/meetings/v1/jobsomething` no se
cuela por prefijo textual.

Los subárboles de **máquina** y sólo ésos. Las cinco rutas de sesión
(`/api/meetings/v1/meetings/**`) **se quedan fuera** a propósito: deben seguir
rebotando a `/login` sin cookie, igual que hoy. El patrón es el que ya usan
`/api/handoff`, `/api/scheduling` y `/api/crm` — máquinas con Bearer que se
autorizan solas.

Coherente con el comentario del propio middleware: no es la puerta de
seguridad, la puerta es la capa de datos. Para las rutas del worker esa puerta
es `authenticateWorkerToken` + el ámbito de la credencial.

**Pass/fail del arreglo:** `curl -s -o /dev/null -w '%{http_code}'` sobre
`/api/meetings/v1/jobs/claim` **sin** cabecera debe dar `401`, no `307`.

### B-2 · En esta rama no hay forma de subir un audio

- No existe UI de Reuniones en `t2/meetings-api` (`web/app/clients/[clientId]/reuniones/`
  vive sólo en tu árbol original, y traerla está fuera de lo autorizado).
- Las cinco rutas de creación y subida exigen **sesión** (`resolveAppScope` →
  `better-auth`). No hay API de máquina para crear una reunión.

Así que el recorrido necesita una de dos vías, y propongo **las dos**, porque
cada una cubre lo que la otra no puede:

| vía | qué hace | qué cubre | qué NO cubre |
|---|---|---|---|
| **A · script de staging** | llama a `createMeeting` / `uploadInit` / `uploadComplete` del servicio directamente, en proceso, con un `userId` real | el PUT real a R2 y todo el camino del worker, de forma determinista y repetible | routing, middleware y sesión de Next |
| **B · cookie de sesión real** | `curl` contra las cinco rutas con la cookie que tú saques de tu navegador | routing, middleware, sesión y traducción de errores de verdad | nada que A cubra mejor |

A da el audio en R2 sin fricción; B es lo que responde al punto 7. Se ejecutan
por separado, sobre **dos reuniones distintas**, para que ninguna dependa de la otra.

### B-3 · `requirements.txt` del worker está incompleto

Declara `fastapi`, `uvicorn`, `pydantic-settings`, `torch`, `faster-whisper`.
`diarization_service.py` importa además, y ninguno está declarado:

`numpy` · `torchaudio` · `pyannote.audio` · `scikit-learn`

Instalar sólo lo declarado deja el worker arrancando y **fallando en la etapa
`diarize`**, que es el peor momento para descubrirlo: después de gastar la GPU
en transcribir y un intento del job.

**Corregido en `d0bb600`** (repo del worker), en tres piezas:

| pieza | qué |
|---|---|
| `requirements/base.txt` | todo menos torch/torchaudio, con las cuatro que faltaban. Cada cota justificada por código, no por memoria |
| `requirements/torch.txt` | la **pareja** torch+torchaudio, **sin versión ni índice**: la rueda depende del driver, y ese dato está en tu máquina |
| `requirements/lock.txt` | vacío a propósito hasta W-3, para congelar el `pip freeze` de lo que realmente funcione |
| `scripts/inspect_gpu.sh` | **inventaría** driver, GPU, CUDA soportado y lo instalado. No elige la rueda: la matriz oficial vigente y el preflight son la autoridad |
| `app/pull/preflight.py` | comprueba todo **antes del primer claim** y sale con **código 2** si falta algo |

No hay ninguna rueda inventada en el repositorio.

### No-bloqueante ya resuelto · la caché de rutas

Pedías cubrir la caché. La comprobé en la salida real de `next build`: **las
once rutas se clasifican `ƒ` (Dynamic, server-rendered on demand)**. Diez son
POST, que Next nunca cachea; el único GET lee `request.url` y eso ya la fuerza.
**No hace falta añadir `force-dynamic`** — la propiedad ya se cumple y el
`build` la reimprime en cada despliegue. Igual se verifica en vivo en el paso
7.3.

---

## 1 · Servicios que deben existir en staging

| # | servicio | dónde | notas |
|---|---|---|---|
| S1 | **PostgreSQL de staging** | Railway, base **propia** | **≥ 15** (`ON DELETE SET NULL (columna)`). Base separada de producción; las migraciones M-1…M-4 no se han aplicado en ningún sitio compartido |
| S2 | **mai web/API** | Railway, servicio propio en el entorno *staging* | `railway.web.json`: NIXPACKS, `npm run start:web` (= `next start`). Necesita dominio público para que el worker lo alcance |
| S3 | **bucket R2 privado** | Cloudflare R2 | **Nuevo bucket**, distinto del público de logos. **Sin dominio público, sin acceso anónimo.** Token S3 con permiso sólo sobre él |
| S4 | **worker pull** | tu PC Linux con GPU | Proceso `python -m app.pull`. **Sólo salida** hacia S2 y S3; ningún puerto abierto |

Lo que **no** hace falta: el servicio `worker` de ingestión de n8n
(`railway.worker.json`) es otra cosa y no participa en W-3.

**Comprobación de que S3 está bien separado (automática y dura):** el arranque
de mai **falla** si `MEETINGS_STORAGE_BUCKET` es igual a `R2_BUCKET_NAME` o si
`MEETINGS_STORAGE_PUBLIC_URL` está definida (`assertSeparateFromPublicBucket`).
No hay que recordarlo: si te equivocas, no arranca.

---

## 2 · Variables de entorno por servicio

**Sólo nombres y propósito.** Ningún valor sale de aquí, y ninguno debe
aparecer en un log, un commit ni un mensaje.

### S2 · mai web/API (Railway → staging)

Obligatorias, sin ellas el proceso no arranca:

| nombre | propósito |
|---|---|
| `DATABASE_URL` | cadena de conexión a S2 |
| `ENCRYPTION_KEY` | clave de 32 bytes (64 hex) que `src/config.ts` exige; sin ella el arranque aborta |
| `BETTER_AUTH_SECRET` | firma de sesión |
| `BETTER_AUTH_URL` | origen público de staging; la sesión se emite contra él |
| `NODE_ENV` | `production`, para que `next start` sirva el build |

Almacenamiento privado de Reuniones:

| nombre | propósito |
|---|---|
| `MEETINGS_STORAGE_DRIVER` | `s3`. Si vale `fake` se usa memoria y se pierde todo al reiniciar; nunca por defecto |
| `MEETINGS_STORAGE_ENDPOINT` | endpoint S3 de la cuenta R2 |
| `MEETINGS_STORAGE_BUCKET` | nombre del bucket privado |
| `MEETINGS_STORAGE_ACCESS_KEY_ID` | id de la credencial S3 del bucket privado |
| `MEETINGS_STORAGE_SECRET_ACCESS_KEY` | secreto de esa credencial |

Opcionales, con defecto razonable:

| nombre | propósito | defecto |
|---|---|---|
| `MEETINGS_STORAGE_REGION` | región a firmar | `auto` (lo correcto en R2) |
| `MEETINGS_STORAGE_FORCE_PATH_STYLE` | bucket en la ruta | `true` (lo correcto en R2) |
| `MEETINGS_STORAGE_PUT_TTL_SECONDS` | caducidad de la URL de subida | `900` |
| `MEETINGS_STORAGE_GET_TTL_SECONDS` | caducidad de la URL de lectura | `3600` |
| `MEETINGS_LEASE_SECONDS` | duración del lease de un job | `300` |
| `MEETINGS_MAX_MEDIA_BYTES` | tamaño máximo del original | 2 GiB |
| `MEETINGS_MAX_DURATION_SECONDS` | duración máxima | 4 h |
| `MEETINGS_ALLOWED_EXTENSIONS` | extensiones admitidas | 7 de audio |
| `MEETINGS_ALLOWED_CONTENT_TYPES` | MIME admitidos | lista de audio |
| `LOG_LEVEL` | verbosidad de pino | `info` |

**Que NO deben existir en staging:**

| nombre | por qué |
|---|---|
| `MEETINGS_STORAGE_PUBLIC_URL` | su presencia **aborta el arranque**: un bucket privado no tiene base pública |
| `MEETINGS_STORAGE_SESSION_TOKEN` | sólo para credenciales temporales tipo STS; R2 no las usa |

Ya presentes por el resto de la app (bucket **público** de logos, no se toca):
`R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL`. **`R2_BUCKET_NAME` tiene que ser
distinto de `MEETINGS_STORAGE_BUCKET`.**

Opcionales de la app que W-3 no necesita: `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` (si entras con email+contraseña), `RESEND_API_KEY`,
`RESEND_FROM_NAME`, `INVITE_FROM_EMAIL`.

### Los scripts de W-3 (donde tú los ejecutes)

No son variables del servicio: son de la **sesión de shell** en la que corres
`w3:seed`, `w3:verify`, `w3:cleanup`, `w3:rollback-check` o `w3:http`.

| nombre | propósito |
|---|---|
| `MEETINGS_ENV_KIND` | debe valer `staging`. Sin ella ninguno arranca |
| `MEETINGS_EXPECTED_DB_HOST` | el host que **afirmas** esperar. Se compara con `DATABASE_URL` antes de conectar |
| `MEETINGS_EXPECTED_DB_NAME` | el nombre de base que afirmas esperar. Se compara antes de conectar **y** contra `current_database()` después |
| `DATABASE_URL` | la conexión. Nunca se imprime |

**Por qué tres y no una.** `MEETINGS_ENV_KIND=staging` dice qué *crees*, no a
dónde apunta `DATABASE_URL`. Las dos se ponen a mano en la misma línea, y
`MEETINGS_ENV_KIND=staging` con la `DATABASE_URL` de producción pegada del
portapapeles está a una tecla de distancia. Con la segunda afirmación, para que
un script destructivo arranque contra producción hay que equivocarse en **tres
variables de forma coherente**.

Y `current_database()` se comprueba **después** de conectar porque una
`DATABASE_URL` puede llevar el nombre en la query, resolverse por un
`search_path` raro, o pasar por un pooler que redirige. Comparar la cadena y
preguntar al servidor son dos cosas distintas; la que vale es la segunda. El
host **no** se puede verificar tras conectar —`inet_server_addr()` es nulo por
socket unix y con un pooler devuelve el del pooler— y eso se dice en vez de
fingir que se comprueba.

Sólo para `w3:http`:

| nombre | propósito |
|---|---|
| `MAI_BASE_URL` | origen del mai de staging |
| `W3_EXPECTED_MAI_HOST` | el host que **afirmas** esperar. Se compara con el de `MAI_BASE_URL` **antes del primer curl** |
| `W3_CLIENT_ID` | uuid del cliente sembrado (no es secreto) |
| `MAI_WORKER_TOKEN` | opcional. Con él se prueba que el token autentica y que su ámbito no alcanza el mantenimiento. **No se usa para reclamar** |
| `MAI_SESSION_COOKIE` | opcional. Tu cookie de navegador, para el bloque de sesión |
| `W3_ALLOW_WRITES` | **obligatoria para el bloque mutante.** Sin `=1`, el bloque que crea reuniones se omite |
| `W3_MEETING_ID` | opcional, para el chequeo de caché |

**Por qué `W3_EXPECTED_MAI_HOST`.** Este script manda un token de worker y, en
el bloque B, tu cookie de sesión. Mandarlos al host equivocado los **entrega**.
Así que antes del primer `curl` se valida `MAI_BASE_URL`, cuatro cosas:

| se comprueba | por qué |
|---|---|
| `hostname == W3_EXPECTED_MAI_HOST` | declarar el destino aparte convierte «pegué la URL equivocada» en un error en vez de en una fuga |
| **https** salvo en localhost | el token viaja en cada petición; por http lo ve cualquiera en el camino. Es la misma regla que el worker aplica en `app/pull/settings.py` |
| **sin usuario ni contraseña** embebidos | `https://u:p@host/` acabaría en el historial del shell y en los logs |
| esquema `http`/`https` | nada de `file:` ni cosas raras |

Si algo falla, el mensaje nombra el problema y el **hostname** — nunca la URL
completa: si lleva credenciales embebidas, imprimirla sería la fuga que la
comprobación existe para impedir.

### S4 · worker pull (PC Linux)

Obligatorias:

| nombre | propósito |
|---|---|
| `MEETINGS_PULL_ENABLED` | la bandera. Apagada salvo `1`/`true`/`yes`; sin ella el proceso sale con código 2 |
| `MAI_BASE_URL` | origen de S2. **Debe ser `https`** salvo localhost: el validador rechaza `http` remoto porque el token viajaría en claro |
| `MAI_WORKER_TOKEN` | token de la credencial `single_tenant`. **Sólo por entorno** — nunca argumento ni fichero, para que no aparezca en `ps` ni en el historial |

Opcionales del modo pull:

| nombre | propósito | defecto |
|---|---|---|
| `MEETINGS_WORKER_LABEL` | etiqueta en la auditoría | hostname |
| `MEETINGS_PULL_IDLE_SECONDS` | espera entre claims con la cola vacía | `5` |
| `MEETINGS_PULL_MAX_BACKOFF_SECONDS` | techo del backoff | `60` |
| `MEETINGS_PULL_HEARTBEAT_SECONDS` | cadencia del latido | `20` |
| `MEETINGS_PULL_WORKSPACE` | raíz de los temporales por job | temp del sistema |
| `MEETINGS_PULL_REQUEST_TIMEOUT` | timeout de una petición a mai | `30` |
| `MEETINGS_PULL_TRANSFER_TIMEOUT` | timeout de una transferencia de objeto | `900` |
| `LOG_LEVEL` | verbosidad | `INFO` |

Del worker histórico (`app/config.py`, prefijo por `.env`), relevantes para las etapas ML:

| nombre | propósito | defecto |
|---|---|---|
| `WHISPER_MODEL` | tamaño del modelo | `medium` |
| `WHISPER_DEVICE` | `cuda` / `cpu` / `auto` | `cuda` |
| `WHISPER_COMPUTE_TYPE` | precisión | `float16` |
| `DIARIZATION_ENABLED` | activa `diarize` | `true` |
| `DIARIZATION_BACKEND` | `wespeaker` o `pyannote_full` | `wespeaker` |
| `DIARIZATION_MIN_SPEAKERS` / `DIARIZATION_MAX_SPEAKERS` | cota de hablantes | `1` / `10` |
| `HF_TOKEN` | **sólo** si eliges `pyannote_full`. Con `wespeaker` no hace falta |

**Nada de R2 en el worker.** No tiene ni debe tener credenciales del bucket:
todo su acceso son URLs firmadas que mai le entrega y que caducan.

---

## 3 · Instalación y ejecución del worker en Linux

### 3.1 · Versiones y comprobaciones previas

| pieza | requisito | comprobación | pass |
|---|---|---|---|
| Python | **3.11** (el venv con que se validó W-1/W-2) | `python3.11 --version` | imprime `3.11.x` |
| driver NVIDIA | soporte de la rueda de torch elegida | `nvidia-smi` | lista la GPU y una versión de CUDA |
| CUDA runtime | lo trae la rueda de torch, no hace falta toolkit del sistema | `python -c "import torch;print(torch.cuda.is_available())"` | `True` |
| ffmpeg | con los códecs de audio | `ffmpeg -version` | responde |
| ffprobe | **imprescindible**: `normalize` mide con él | `ffprobe -version` | responde |

Si `torch.cuda.is_available()` da `False`, **para aquí**: con
`WHISPER_DEVICE=cuda` el modelo no carga, y dejarlo caer a CPU convertiría W-3
en una prueba de otra cosa.

### 3.2 · Entorno e instalación

```bash
cd ~/Transcript-Project/transcript-worker
python3.11 -m venv .venv-w3
source .venv-w3/bin/activate
python -m pip install --upgrade pip
```

**Primero mira la máquina.** El repositorio no fija ninguna rueda CUDA a
propósito: la correcta depende de tu driver, y una que el driver no soporta no
falla al instalar — falla en `torch.cuda.is_available()` después de bajar dos
gigas.

```bash
bash scripts/inspect_gpu.sh
```

**Inventaría** nombre de GPU, driver, memoria, capacidad de cómputo, el CUDA
máximo que el driver admite y lo que ya haya en el venv. **No elige la rueda**:
una tabla driver→CUDA escrita en el repositorio envejece en silencio y se lee
como autoridad, así que la decisión se toma en la PC Linux con la matriz oficial
y vigente:

<https://pytorch.org/get-started/locally/>

Con esos datos, instala la pareja del **mismo** índice y en el mismo comando:

```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/<el-de-la-matriz>
```

La autoridad sobre si la elección fue correcta **no es ninguna tabla, es el
preflight** (§3.4): comprueba la pareja tocando su extensión nativa y CUDA de
verdad, y sale con código 2 sin reclamar ningún job si algo no cuadra.

Luego el resto:

```bash
pip install -r requirements/base.txt
```

**Pass:** el preflight del worker (§3.4), que es quien lo comprueba de verdad.
No hace falta un script de imports a mano.


### 3.3 · Modelos requeridos y descarga previa

Dos, y conviene bajarlos **antes** de la prueba para que la primera descarga no
caduque un lease:

| modelo | quién lo usa | token HF |
|---|---|---|
| `faster-whisper` `medium` (CTranslate2) | `transcribe` | no |
| `pyannote/wespeaker-voxceleb-resnet34-LM` | `diarize` (backend por defecto) | **no** — es MIT |

```bash
python - <<'PY'
from faster_whisper import WhisperModel
WhisperModel("medium", device="cuda", compute_type="float16")
from pyannote.audio import Model
Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM")
print("modelos en caché")
PY
```

**Pass:** imprime `modelos en caché` sin descargar nada en la segunda ejecución.

> Si eliges `DIARIZATION_BACKEND=pyannote_full` necesitas `HF_TOKEN` y aceptar
> las condiciones del modelo en HuggingFace. Para W-3 recomiendo **no** hacerlo:
> añade una variable secreta y una dependencia de red a una prueba que ya tiene
> bastantes piezas nuevas.

### 3.4 · Arranque

El modo pull es un proceso **aparte**; no levanta ningún servidor y no cambia
las rutas HTTP históricas.

```bash
cd ~/Transcript-Project/transcript-worker
source .venv-w3/bin/activate
set -a; . ./.env.w3; set +a      # fichero local, 0600, NO versionado
python -m app.pull
```

**Lo primero que hace es el PREFLIGHT**, antes de reclamar nada:

```
preflight · OK   ffmpeg — ffmpeg version …
preflight · OK   ffprobe — ffprobe version …
preflight · OK   torch — 2.x.y+cuXXX
preflight · OK   torchaudio — 2.x.y+cuXXX
preflight · OK   torch/torchaudio emparejados — … backends=[…]
preflight · OK   CUDA — <tu GPU> · capacidad … · torch cuda …
preflight · OK   numpy · faster_whisper · pyannote.audio (Model) · scikit-learn
```

**Pass:** las nueve líneas en `OK`, y después el log describe el destino **sin
el token** — `mai_host`, `capabilities: ["meetings.transcribe"]`,
`worker_label`, `token_prefix` (8 caracteres, lo que la UI ya muestra).

**Fail:** cualquier `FALLO`. El proceso sale con **código 2** sin reclamar
ningún job, y `RestartPreventExitStatus=2` evita que systemd lo reintente en
bucle. Comprobado ejecutándolo en un venv sin la pila ML: siete fallos
reportados de una vez, cero jobs reclamados, cero apariciones del token.

**Fail también:** cualquier aparición del token completo o de una URL firmada
con query.

**Congela lo que funcionó**, en cuanto el preflight salga verde y W-3 termine:

```bash
pip freeze > requirements/lock.txt
```

`requirements/lock.txt` está vacío a propósito hasta ese momento: un lock que no
viene de una instalación real es una suposición con formato de certeza.

### 3.5 · Proceso persistente

**systemd de usuario**, no `nohup`: reinicia solo, tiene log propio y el
`EnvironmentFile` mantiene el token fuera de `ps`.

`~/.config/systemd/user/mai-meetings-pull.service`:

```ini
[Unit]
Description=mai meetings pull worker (W-3)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/Transcript-Project/transcript-worker
EnvironmentFile=%h/Transcript-Project/transcript-worker/.env.w3
ExecStart=%h/Transcript-Project/transcript-worker/.venv-w3/bin/python -m app.pull
Restart=on-failure
RestartSec=10
# Sale con 2 si la configuración es inválida: no reintentar en bucle algo que
# no va a mejorar sin intervención.
RestartPreventExitStatus=2
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
PrivateTmp=false

[Install]
WantedBy=default.target
```

```bash
chmod 600 ~/Transcript-Project/transcript-worker/.env.w3
systemctl --user daemon-reload
systemctl --user enable --now mai-meetings-pull
journalctl --user -u mai-meetings-pull -f
```

`PrivateTmp=false` porque el worker usa `MEETINGS_PULL_WORKSPACE` (o el temp del
sistema) para directorios `0700` por job, y con `PrivateTmp` no podrías
inspeccionarlos durante la prueba.

**Nota:** `loginctl enable-linger $USER` si quieres que sobreviva al cierre de sesión.

### 3.6 · Sólo tráfico de salida

El proceso pull **no escucha nada**. Lo verificamos en vez de suponerlo:

```bash
ss -lntp | grep -E "$(pgrep -f 'app.pull' | tr '\n' '|')0" || echo "sin puertos en escucha — correcto"
```

**Pass:** no aparece ningún socket en escucha del proceso.

Salidas necesarias, y sólo éstas: `443/tcp` hacia el host de S2 y hacia el
endpoint de R2. Si aplicas cortafuegos de salida:

```bash
# ilustrativo; adapta a tu herramienta
sudo ufw default deny outgoing
sudo ufw allow out to any port 443 proto tcp
sudo ufw allow out 53
```

**No hace falta ninguna entrada.** Si abres un puerto para este worker, algo
está mal entendido.

---

## 4 · Tenant, client, módulo y credencial de prueba

### 4.1 · Regla que no se negocia

El worker usa una credencial **`single_tenant`** con **`meetings.transcribe`** y
nada más. Una credencial `internal` para un worker normal está prohibida por
diseño y ahora también por la base: `pools_scope_allows_capabilities` impide que
un pool `single_tenant` declare `meetings.maintenance`, y
`requeueExpiredLeases` exige `scope='internal'` **y** la capacidad. Para W-3
**no** creamos ninguna credencial `internal`; el barrido no forma parte del
recorrido.

### 4.2 · Cómo, y por qué con un script

A mano son ~8 `INSERT` con uuids cruzados, y el token hay que **acuñarlo**
(`mtk_` + 32 bytes aleatorios, guardando sólo `sha256` y el prefijo de 8). Un
`INSERT` a mano con un token inventado no autenticaría, y uno con el token en
claro en la base sería peor que no tener credencial.

`src/scripts/meetingsStagingSeed.ts`, ya escrito y probado (`52600c7`):

```bash
MEETINGS_ENV_KIND=staging DATABASE_URL=… npm run w3:seed -- \
  --tenant-name "W3" --client-name "Cliente W3" \
  --user-email <tu-correo> --pool-slug w3-gpu --environment staging \
  > /ruta/segura/token.txt
```

**Todo el resumen sale por STDERR; por STDOUT sale ÚNICAMENTE el token.** Así
`> token.txt` captura el token y nada más. Los uuids de tenant y client —que no
son secretos y hacen falta para todo lo demás— van en el resumen de stderr.

En una transacción: `tenants` → `clients` (`is_default = false`, porque
`resolveAppScope` rechaza el cliente por defecto) → `tenant_members` como
`owner` → `client_modules (meetings, enabled)` → `worker_pools`
(`single_tenant`, `{meetings.transcribe}`, `limits {meetings.transcribe: 1}`) →
`worker_credentials` con `mintWorkerToken()`.

**El usuario tiene que existir ANTES.** Regístralo por el flujo real (`/signup`
del mai de staging). El script comprueba que existe **y** que tiene fila en
`account` —distingue los dos casos, porque el arreglo es distinto— y **aborta
sin escribir nada** si no. No inserta usuarios: `user`, `account` y `session`
son de Better Auth, y una fila puesta a mano parece válida y no permite entrar.

#### Idempotencia: relanzarlo se DETIENE, no reimprime

De la credencial la base guarda `sha256(token)` y el prefijo. El token en claro
no existe en ningún sitio después de la ejecución, así que «relanzar devuelve lo
mismo» es imposible sin haberlo guardado — y guardarlo sería peor que cualquier
alternativa. Relanzarlo con el pool ya creado sale con **código 2** y explica
las dos salidas:

```
✗ El pool 'w3-gpu' (staging) ya existe con 1 credencial(es) viva(s).
  NO se puede recuperar su token: la base sólo guarda el sha256 y el prefijo.
  · Si perdiste el token → --rotate-token
  · Si el worker ya está corriendo con él → no hace falta nada.
```

Y `--rotate-token` hace tres cosas distintas según cuántas credenciales **vivas**
tenga el pool:

| vivas | qué hace |
|---|---|
| **0** | emite una nueva con `rotated_from_id = NULL`. No hay nada que revocar; es el caso de «revoqué a mano y necesito otra» |
| **1** | la rotación normal: emite, enlaza por `rotated_from_id` y **revoca la anterior en la misma transacción**. Si fueran dos pasos, un fallo entre ellos dejaría dos vivas o ninguna |
| **>1** | **aborta** sin emitir ni revocar, y lista las vivas por prefijo |

El caso `>1` importa: rotar «la más reciente» dejaría las demás **vivas y sin
avisar**, y el pool acabaría con más credenciales activas que antes — lo
contrario de lo que uno cree que hace al rotar. Revocarlas todas por iniciativa
propia tampoco vale: puede haber un worker corriendo con cualquiera de ellas, y
cuál sobra no lo decide un script.

Y antes de todo eso, si el pool ya existía, se valida su contrato completo —
scope, tenant, `enabled`, capabilities exactas y concurrency. Cualquier
diferencia aborta sin tocar credenciales.

Comprobado contra PostgreSQL 18 desechable: seed (token de 48 bytes por stdout,
resumen por stderr) → relanzar (código 2, **0 bytes en stdout**) → rotar (2
credenciales, 1 viva, 1 con `rotated_from_id`).

**Pass:**

```sql
SELECT p.scope, p.capabilities, p.concurrency->'limits', c.token_prefix,
       c.revoked_at IS NULL AS viva
  FROM worker_credentials c JOIN worker_pools p ON p.id = c.pool_id
 WHERE p.slug = :pool_slug;
```

→ `single_tenant` · `{meetings.transcribe}` · `{"meetings.transcribe": 1}` ·
prefijo de 8 · `viva = true`.

```sql
SELECT enabled FROM client_modules
 WHERE tenant_id = :t AND client_id = :c AND module_key = 'meetings';
```

→ `true`.

**Fail** si `capabilities` contiene `meetings.maintenance` (además la base lo
habría rechazado) o si `scope` es `internal`.

### 4.3 · Negativa obligatoria antes de seguir

Con el token ya emitido, y **antes** de subir nada:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "authorization: Bearer $MAI_WORKER_TOKEN" \
  "$MAI_BASE_URL/api/meetings/v1/maintenance/requeue-expired" -d '{}' \
  -H 'content-type: application/json'
```

**Pass: `404`.** Si da `200`, la credencial tiene alcance global y hay que
revocarla y parar.

---

## 5 · Recorrido W-3

Diez pasos. El **1–3** por la vía A (script) y en paralelo el **7.2** por la
vía B (cookie), sobre reuniones distintas.

| # | paso | quién lo ejecuta |
|---|---|---|
| 1 | crear la reunión | script de staging (vía A) |
| 2 | `upload-init` → PUT real del audio a R2 | script + `curl` |
| 3 | `upload-complete` → mai verifica el objeto y encola `normalize` | script |
| 4 | el worker reclama `normalize` | worker |
| 5 | `normalize`: ffmpeg → WAV 16 kHz mono s16le, ffprobe real | worker |
| 6 | subida del normalizado + `result/complete` con el sondeo | worker |
| 7 | el worker reclama `transcribe`, Whisper real, artefacto NDJSON+gzip | worker |
| 8 | el worker reclama `diarize`, wespeaker real, artefacto NDJSON+gzip | worker |
| 9 | mai ingiere: versión de transcript + hablantes | mai, en la misma transacción |
| 10 | lectura de estado por la ruta GET real | `curl` con cookie |

**Audio recomendado:** 8–15 minutos, **dos o más voces reales** y turnos claros.
Con una sola voz `diarize` no demuestra nada, y con 30 segundos tampoco.
No uses audio con datos personales de nadie que no haya consentido.

---

## 6 · Qué verificamos en cada paso

**Todo esto está en un script.** `npm run w3:verify` corre las consultas de esta
sección y da un `PASS`/`FAIL`/`n/a` por comprobación:

```bash
MEETINGS_ENV_KIND=staging DATABASE_URL=… npm run w3:verify -- \
  --tenant-id <uuid> [--meeting-id <uuid>]
```

**Sólo lectura** — ni un `INSERT`, ni un `UPDATE`, ni un `DELETE`, y hay una
prueba que lee el fuente para exigirlo: una verificación que escribe mediría un
estado que ella misma causó. `n/a` es para lo que aún no ha ocurrido y no cuenta
como fallo, porque durante W-3 esto se ejecuta varias veces mientras el
recorrido avanza. Las comprobaciones de tenant van antes de las de reunión, así
que sirve ya justo después del seed.

Las consultas de abajo son las mismas, para cuando quieras mirar a mano. **Todas
se ejecutan contra el esquema real en `test/migrations/meetings/60-runbook-sql.sql`**,
así que no pueden envejecer en silencio. `:m` = uuid de la reunión, `:r` = uuid
del run, `:v` = uuid de la versión de transcript.

### Paso 1 · reunión creada

```sql
SELECT media_state, transcript_state, source_kind, idempotency_key
  FROM meetings WHERE id = :m;
```
**Pass:** `pending` · `pending`. Relanzar con la misma `idempotency_key` no crea
otra fila (`created = false`).

### Paso 2 · el objeto está en R2

- La URL firmada **no** se persiste en ningún sitio. Comprobación:
```sql
SELECT count(*) FROM meeting_media WHERE storage_key LIKE '%X-Amz%';
```
**Pass: `0`.**
- El PUT devuelve **200/204**. La clave la derivó el servidor:
  `t/{tenant}/c/{client}/m/{meeting}/original/source`.
**Fail:** un `403` de R2 apunta a firma o política del bucket; un `501` a
`Transfer-Encoding: chunked` (hay que mandar `Content-Length`).

### Paso 3 · confirmación y primer job

```sql
SELECT media_state FROM meetings WHERE id = :m;
SELECT role, run_id, bytes, checksum_sha256, probe_ok
  FROM meeting_media WHERE meeting_id = :m;
SELECT stage, status, attempts, requires FROM meeting_processing_jobs
 WHERE meeting_id = :m ORDER BY created_at;
```
**Pass:** `media_state='ready'`; una fila `original` con `run_id IS NULL`,
`probe_ok IS NULL` y el `checksum_sha256` **igual al sha256 local del fichero**;
**un solo** job, `stage='normalize'`, `status='queued'`,
`requires={meetings.transcribe}`.
**Fail:** más de un job (la creación es secuencial, no en lote).

### Paso 4 · claim, lease y heartbeat

```sql
SELECT status, attempts, leased_credential_label,
       lease_token_hash IS NOT NULL AS con_token,
       lease_expires_at > now() AS lease_vivo, progress_pct
  FROM meeting_processing_jobs WHERE meeting_id = :m AND stage = 'normalize';
```
**Pass:** `leased` · `attempts=1` · `con_token=true` · `lease_vivo=true` ·
`leased_credential_label` = `pool/prefijo`.

Heartbeat, durante una etapa larga. **El latido no escribe evento**: renueva el
lease y toca la fila del job, así que ahí es donde se observa.

```sql
SELECT last_heartbeat_at, last_progress_at, progress_pct, lease_expires_at,
       extract(epoch FROM (now() - last_heartbeat_at)) AS edad_latido
  FROM meeting_processing_jobs WHERE meeting_id = :m AND status IN ('leased','uploading_result');
```
**Pass:** `lease_expires_at` y `last_heartbeat_at` **avanzan** entre dos
consultas separadas ~40 s, y `edad_latido` se mantiene por debajo de
`MEETINGS_PULL_HEARTBEAT_SECONDS` × 2.
**Fail:** el lease caduca durante la transcripción → sube
`MEETINGS_LEASE_SECONDS` o baja `MEETINGS_PULL_HEARTBEAT_SECONDS`.

Los eventos, por separado. La columna de tiempo es **`at`**, no `created_at`, y
los ocho tipos admitidos son `claimed`, `state_changed`, `progress`, `retried`,
`lease_expired`, `cancelled`, `failed` y `result_ingested` — **`heartbeat` no
existe**, así que buscarlo aquí daría cero y parecería que el latido no funciona.

```sql
SELECT kind, count(*), max(at) FROM meeting_job_events
 WHERE meeting_id = :m GROUP BY kind ORDER BY 3;
```
**Pass:** aparece `claimed`, y `progress` si el worker mandó `progressPct`.

### Pasos 5–6 · normalize y el sondeo real

```sql
SELECT role, run_id, duration_seconds, sample_rate, channels, codec, probe_ok
  FROM meeting_media WHERE meeting_id = :m AND role = 'normalized'
   AND deleted_at IS NULL;
```
**Pass, y esto es el punto de la última corrección:** `sample_rate=16000`,
`channels=1`, `codec='pcm_s16le'`, `probe_ok=true`, `run_id = :r` (no nulo),
`duration_seconds` ≈ la duración real del audio (±0.5 s).
**Fail:** cualquier otro formato → mai responde **422 `media_rejected`**, el job
**no** se cierra y `transcribe` **no** se encola. Eso es correcto: revisa el
ffmpeg del worker.

```sql
SELECT kind, state, declared_bytes, observed_bytes,
       declared_checksum_sha256 = observed_checksum_sha256 AS checksum_cuadra,
       verified_at IS NOT NULL AS verificado
  FROM meeting_result_uploads WHERE meeting_id = :m ORDER BY created_at;
```
**Pass:** `normalized_media` en `ingested`, `checksum_cuadra=true`,
`observed_bytes = declared_bytes`.

Y el encadenado:
```sql
SELECT stage, status FROM meeting_processing_jobs WHERE meeting_id = :m ORDER BY created_at;
```
**Pass:** `normalize=succeeded`, `transcribe=queued`. **Un solo** `transcribe`.

### Pasos 7–8 · transcribe y diarize reales

**Pass por etapa:** `succeeded`; su `meeting_result_uploads` en `verified` o
`ingested` con checksum cuadrado; el artefacto es NDJSON gzip cuya primera línea
lleva `schema` y `schema_version: 1`.

`diarize` sólo se encola si `requested_options.diarize <> false`:
```sql
SELECT requested_options FROM meeting_processing_runs WHERE id = :r;
```

### Paso 9 · ingesta

```sql
-- El estado de diarización vive en `meetings`, NO en la versión: la versión
-- guarda `diarization_backend`, que dice QUÉ diarizó, no cómo acabó.
SELECT v.id, v.whisper_model, v.diarization_backend, v.language,
       v.duration_seconds, v.segment_count, v.schema_version,
       m.transcript_state, m.diarization_state,
       m.active_transcript_id = v.id AS es_la_activa
  FROM meeting_transcript_versions v JOIN meetings m ON m.id = v.meeting_id
 WHERE v.meeting_id = :m;

-- La tabla es `meeting_segments`.
SELECT count(*) AS segmentos FROM meeting_segments WHERE transcript_id = :v;

-- La columna es `talk_share_pct`, y es un PORCENTAJE: `numeric(5,2)` con
-- CHECK 0..100.
SELECT speaker_label, speaker_id, talk_share_pct
  FROM meeting_transcript_speakers WHERE transcript_id = :v ORDER BY speaker_label;

SELECT display_name, contact_id FROM meeting_speakers WHERE meeting_id = :m;
```
**Pass:** **una sola** versión (se escribe una vez, es inmutable, y
`tv_run_key UNIQUE (run_id)` lo garantiza); `segmentos = segment_count`;
**≥ 2** filas en `meeting_transcript_speakers` con `talk_share_pct` sumando
**≈ 100**; `es_la_activa = true`; `diarization_backend='wespeaker'`;
`meetings.transcript_state='ready'` y `meetings.diarization_state='ready'`.
**Fail:** dos versiones para el mismo run → la ingesta no fue idempotente.

### Reintento idempotente (provocado)

Con el run ya cerrado, repite el último `result/complete` **con el mismo
payload**, por la ruta real:

**Pass:** `200`, mismo `nextJob`, y **nada cambia** — mismo
`active_transcript_id`, mismo número de segmentos, ningún job nuevo.

Y con el payload **cambiado** (por ejemplo otra `probe.durationSeconds`):
**Pass: `409 terminal_conflict`** y el estado terminal intacto.

### Fallo controlado

Sobre una reunión **nueva**, deja que el worker reclame `normalize` y manda un
`fail` con un código estable:

```bash
curl -s -X POST -H "authorization: Bearer $MAI_WORKER_TOKEN" \
  -H 'content-type: application/json' \
  "$MAI_BASE_URL/api/meetings/v1/jobs/$JOB/fail" \
  -d '{"attempt":1,"leaseToken":"…","failureCode":"w3_fallo_controlado","failureDetail":"prueba"}'
```

```sql
SELECT status, attempts, max_attempts, failure_code, failure_detail,
       next_attempt_at, next_attempt_at > now() AS con_backoff
  FROM meeting_processing_jobs WHERE id = :job;
SELECT transcript_state, warnings FROM meetings WHERE id = :m2;
```
**Pass:** con `attempts < max_attempts`, vuelve a `queued` con
`next_attempt_at` en el futuro (backoff con jitter); agotados los intentos,
`failed` con `failure_code='w3_fallo_controlado'` y la reunión con
`transcript_state='failed'` y un aviso en `warnings`.

Repite el **mismo** `fail`: **`200`** con el resultado previo.
Cambia el `failureDetail`: **`409 terminal_conflict`**.

Y comprueba que **no quedó medio derivado del fallo**:
```sql
SELECT count(*) FROM meeting_media WHERE meeting_id = :m2 AND role = 'normalized';
```
**Pass: `0`.** Un sondeo fallido no produce fila de medio: produce un job
fallido. Es la semántica única que fijó `f6d2a45`.

---

## 7 · Arrancar Next en modo producción de staging

Es el punto que ninguna prueba cubre: los Route Handlers se prueban
**importándolos**, así que el enrutado, el middleware y la caché nunca se han
ejercitado.

### 7.1 · Build y arranque

Igual que Railway (`railway.web.json`), para que lo que se prueba sea lo que se
despliega:

```bash
npm ci && cd web && npm ci && npm run build && cd ..
NODE_ENV=production npm run start:web        # = next start
```

**Pass:** el build imprime las once rutas de `/api/meetings/v1/**` marcadas `ƒ`.

### 7.2 · Middleware: las dos mitades, por separado

**Está en un script, con DOS bloques separados:**

```bash
# BLOQUE A · enrutado, SIN CAMBIOS DE DOMINIO. Corre siempre.
MEETINGS_ENV_KIND=staging W3_EXPECTED_MAI_HOST=<host> MAI_BASE_URL=https://<host> \
  MAI_WORKER_TOKEN=… W3_CLIENT_ID=<uuid> npm run w3:http

# BLOQUE B · sesión, MUTANTE DE DOMINIO: crea reuniones. Hay que autorizarlo.
MEETINGS_ENV_KIND=staging W3_EXPECTED_MAI_HOST=<host> MAI_BASE_URL=https://<host> \
  MAI_WORKER_TOKEN=… W3_CLIENT_ID=<uuid> MAI_SESSION_COOKIE='…' \
  W3_ALLOW_WRITES=1 npm run w3:http
```

**El bloque A no cambia ningún estado de dominio**: no crea reuniones, no
reclama jobs, no mueve nada del pipeline. Cada llamada lleva escrito por qué:
las seis rutas de máquina sin token fallan en `authenticateWorker`, que es lo
primero de cada handler; la negativa de `maintenance` con token (404) se decide
antes de cualquier lectura del dominio; y la única llamada a `/claim` con token
manda un cuerpo inválido, así que `readValidated` la corta antes de `claim()`.

> **Lo que el bloque A SÍ escribe.** Autenticar con éxito dispara
> `touchLastUsed()`: `UPDATE worker_credentials SET last_used_at = now()`,
> best-effort. Las dos llamadas autenticadas de A.2 tocan esa columna. Es
> telemetría de la credencial y **no se desactiva** — un camino de
> autenticación distinto al de producción haría que el smoke dejara de probar
> el camino real, que es su único motivo de existir. La cabecera del script
> decía «NO MUTANTE» y era falso; ahora dice «sin cambios de dominio», que es
> lo que se puede sostener.

**El bloque B crea reuniones.** Exige **las tres cosas a la vez** —
`MEETINGS_ENV_KIND=staging`, el host declarado correcto y `W3_ALLOW_WRITES=1` —
reafirmadas en el propio bloque aunque dos ya hayan cortado antes: la
precondición del único bloque que escribe en el dominio no debe depender de que
nadie mueva un `exit` de la cabecera. Lista los `meetingId` creados al terminar
y recuerda que `w3:cleanup` los retira.

> **Lo que este script hacía y estaba mal.** La primera versión afirmaba «no
> escribe en la base» y hacía **un `claim` con token válido**. Un claim válido
> no es una consulta: es `FOR UPDATE SKIP LOCKED` + `UPDATE`, le pone un lease
> de cinco minutos al job y consume un intento — y como el script no manda
> latidos, el job se quedaba colgado con `attempts` gastado. Con el worker
> corriendo, le robaba trabajo. Ese claim **se eliminó**, no se protegió: el
> claim real se prueba en el §5, sobre el job sembrado, por el worker de verdad,
> y con seguimiento hasta su estado terminal.

Sin `-L` en ningún `curl`: seguir la redirección convertiría el 307 del
middleware en el 200 de `/login`, y el fallo de B-1 se habría visto como un
éxito raro. El token y la cookie se leen del entorno y nunca se imprimen; lo que
sale es el código HTTP y el `error.code`, que es un literal del servidor. Los
cuerpos van a un `mktemp -d` con permisos 0700 que un `trap` borra en cualquier
salida, incluso si el script muere — los `/tmp/w3*` fijos de antes eran
predecibles y compartidos, y ahí se escriben cuerpos que pueden llevar URLs
firmadas.

Los `curl` equivalentes, para mirar a mano:

```bash
BASE="$MAI_BASE_URL"

# (a) ruta de MÁQUINA sin cabecera → 401 del handler, NO 307 al login
curl -s -o /dev/null -w 'claim sin token: %{http_code}\n' \
  -X POST "$BASE/api/meetings/v1/jobs/claim" \
  -H 'content-type: application/json' -d '{}'

# (b) el token autentica y su ámbito NO alcanza el mantenimiento global.
#     404 prueba las dos cosas SIN reclamar trabajo. Un claim con token válido
#     aquí robaría un job y lo dejaría colgado sin latidos.
curl -s -o /dev/null -w 'maintenance con token de tenant: %{http_code}\n' \
  -X POST "$BASE/api/meetings/v1/maintenance/requeue-expired" \
  -H "authorization: Bearer $MAI_WORKER_TOKEN" \
  -H 'content-type: application/json' -d '{}'

# (c) ruta de SESIÓN sin cookie → 307 al login (debe seguir rebotando)
curl -s -o /dev/null -w 'meetings sin cookie: %{http_code} -> %{redirect_url}\n' \
  -X POST "$BASE/api/meetings/v1/meetings" \
  -H 'content-type: application/json' -d '{}'
```

**Pass:** (a) `401` · (b) `404` · (c) `307` hacia `/login`. Un `401` en (b)
significa que el token no autentica; un `200`, que la credencial tiene alcance
global y hay que revocarla y parar.
**Fail:** si (a) da `307`, B-1 no está arreglado. Si (c) da `400`, el arreglo se
pasó de alcance y expuso las rutas de sesión.

### 7.3 · Caché de rutas, en vivo

Dos GET seguidos con un cambio de estado en medio:

```bash
curl -s -H "cookie: $COOKIE" "$BASE/api/meetings/v1/meetings/$M?clientId=$C" | tee /tmp/a.json
# …provocar un avance de etapa…
curl -s -H "cookie: $COOKIE" "$BASE/api/meetings/v1/meetings/$M?clientId=$C" | tee /tmp/b.json
diff /tmp/a.json /tmp/b.json
```
**Pass:** difieren, y ninguna respuesta trae `x-nextjs-cache: HIT`.
**Fail:** idénticas tras un cambio real → hay caché y habría que añadir
`force-dynamic`.

### 7.4 · Sesión y entitlement, por HTTP real

Con la cookie de tu navegador (**tú** la extraes; yo no la veo — ponla en una
variable de shell, no en un fichero versionado):

```bash
# reunión creada por la ruta real
curl -s -X POST "$BASE/api/meetings/v1/meetings" -H "cookie: $COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$C\",\"title\":\"W-3 sesión\",\"idempotencyKey\":\"w3-$(date +%s)\"}"
```
**Pass:** `200` con `meetingId`.

Entitlement, la comprobación que importa:
```sql
UPDATE client_modules SET enabled = false
 WHERE tenant_id = :t AND client_id = :c AND module_key = 'meetings';
```
Repite el POST → **Pass: `404`**, el mismo que un recurso inexistente. Vuelve a
ponerlo en `true`.

Y una validación estricta por HTTP real:
```bash
curl -s -X POST "$BASE/api/meetings/v1/meetings" -H "cookie: $COOKIE" \
  -H 'content-type: application/json' \
  -d "{\"clientId\":\"$C\",\"title\":\"x\",\"idempotencyKey\":\"k\",\"tenantId\":\"$T\"}"
```
**Pass:** `400` `invalid_request` nombrando `tenantId` como campo no reconocido
— el ámbito nunca se lee de la petición.

---

## 8 · Rollback y limpieza

### 8.1 · Rollback si W-3 falla

| situación | acción |
|---|---|
| el worker no autentica o reencola de más | `systemctl --user stop mai-meetings-pull` y revocar la credencial (8.2) |
| mai arranca mal por almacenamiento | corregir la variable en Railway y redeploy; el arranque ya falla solo si el bucket privado no está separado |
| el esquema hay que retirarlo | **primero** `npm run w3:rollback-check`, y sólo si aprueba, `npx node-pg-migrate --tsx down 5` sobre **S2**. Las guardas **abortan** si quedan filas: por eso 8.2 va primero |

#### `down 5` no significa «revierte las de Reuniones»

Significa **«revierte las cinco últimas, sean las que sean»**. Si entre la
aplicación y el rollback aparece otra migración —otra rama, otro agente, un
backfill— `down 5` revierte **ésa** y sólo cuatro de Reuniones, dejando la
quinta aplicada y el esquema en un estado que nadie diseñó. Y lo haría sin
quejarse.

Así que antes hay una puerta:

```bash
MEETINGS_ENV_KIND=staging MEETINGS_EXPECTED_DB_HOST=… MEETINGS_EXPECTED_DB_NAME=… \
  DATABASE_URL=… npm run w3:rollback-check
```

Comprueba que la **cabeza** de `pgmigrations` sean exactamente estas cinco, en
este orden (de la más antigua a la más reciente):

```
1783400000000_meetings-module
1783500000000_meetings-core
1783600000000_meetings-transcript
1783700000000_meetings-worker-pools
1783800000000_meetings-result-uploads
```

**Pass:** imprime `Las cinco de Reuniones son la cabeza, en orden` y el comando
de rollback. Sólo entonces se puede revertir por conteo.

**Fail:** sale con 1, nombra la migración que apareció encima y las de Reuniones
que se cayeron de la cabeza, y dice explícitamente que **no** ejecutes `down 5`.
En ese caso hay que revertir por nombre, de arriba abajo, comprobando cada paso.

Es sólo lectura: no revierte nada, dice cuándo es seguro revertir. Probado
contra la base desechable en los tres casos — cabeza correcta, migración
intrusa encima, y las cinco en orden distinto.

Las cuatro guardas del `down` están probadas (4/4 en la suite de esquema): con
datos presentes bloquean, y revierten en cuanto la tabla se vacía. El `down` no
es una vía de borrado: es la retirada del esquema **después** de limpiar.

### 8.2 · Limpieza completa

**Está en un script, con tres cerrojos:**

```bash
# inventario, sin borrar nada — el DEFECTO
MEETINGS_ENV_KIND=staging DATABASE_URL=… npm run w3:cleanup -- --tenant-id <uuid>

# borrado de verdad
MEETINGS_ENV_KIND=staging DATABASE_URL=… npm run w3:cleanup -- \
  --tenant-id <uuid> --execute --confirm "BORRAR <el mismo uuid>"
```

1. `MEETINGS_ENV_KIND=staging`, la puerta común.
2. `--tenant-id` explícito. No hay defecto, no hay «el último», no hay `--all`.
3. `--execute` **y** `--confirm "BORRAR <uuid>"`. La frase lleva el uuid dentro,
   así que copiarla del runbook o del historial **no sirve para otro tenant**, y
   se valida antes de abrir la conexión.

Imprime un inventario de quince conteos antes y después, avisa si existe algún
pool `internal` (que no alcanza, porque tiene `tenant_id NULL`) y recuerda el
prefijo de R2 que no puede borrar.

Comprobado contra PostgreSQL 18 desechable: dry-run → frase de otro tenant (no
borra, el tenant sigue ahí) → frase correcta (los quince conteos a 0).

**Y el orden es explícito, no confiando en el cascade.** Verifiqué que
`DELETE FROM tenants` sobrevive hoy al `ON DELETE RESTRICT` de las
credenciales (el cascade retira jobs y eventos antes), pero ese orden depende
de en qué secuencia se crearon las constraints, y no es algo sobre lo que
apoyar una limpieza. El script hace, y tú puedes hacer a mano:

```sql
-- 1 · revocar la credencial (nunca borrarla para liberar jobs)
UPDATE worker_credentials
   SET revoked_at = now(), revoked_actor = 'system',
       revoked_actor_label = 'w3-cleanup', revoked_reason = 'fin de la validación W-3'
 WHERE pool_id = (SELECT id FROM worker_pools WHERE slug = :pool_slug)
   AND revoked_at IS NULL;

-- 2 · las reuniones: cascada a runs, jobs, media, eventos, uploads y transcripts
DELETE FROM meetings WHERE tenant_id = :t;

-- 3 · ahora sí, credenciales y pool (ya no hay jobs que los referencien)
DELETE FROM worker_credentials WHERE pool_id = (SELECT id FROM worker_pools WHERE slug = :pool_slug);
DELETE FROM worker_pools WHERE slug = :pool_slug;

-- 4 · módulo, cliente, tenant
DELETE FROM client_modules WHERE tenant_id = :t;
DELETE FROM clients WHERE tenant_id = :t;
DELETE FROM tenants WHERE id = :t;
```

**Pass:** las siete consultas de conteo dan `0`.

```sql
SELECT
  (SELECT count(*) FROM meetings WHERE tenant_id = :t) AS reuniones,
  (SELECT count(*) FROM meeting_media WHERE tenant_id = :t) AS medios,
  (SELECT count(*) FROM meeting_processing_jobs WHERE tenant_id = :t) AS jobs,
  (SELECT count(*) FROM meeting_result_uploads WHERE tenant_id = :t) AS subidas,
  (SELECT count(*) FROM worker_pools WHERE tenant_id = :t) AS pools,
  (SELECT count(*) FROM clients WHERE tenant_id = :t) AS clientes,
  (SELECT count(*) FROM tenants WHERE id = :t) AS tenants;
```

**Un pool que este script NO alcanza:** uno con `scope='internal'` tiene
`tenant_id NULL` y ningún borrado por tenant lo toca. W-3 no crea ninguno; si en
algún momento se crea, hay que borrarlo por `slug` a mano.

### 8.3 · Objetos en R2

Los objetos **no** se borran solos: `deleted_at` en `meeting_media` es lógico y
el barrido de retención está apagado. Todas las claves de la prueba comparten
prefijo:

```
t/{tenant_uuid}/
```

```bash
# tú, con rclone o el panel de Cloudflare
rclone delete "r2-staging:$BUCKET/t/$TENANT_UUID/" --dry-run   # revisa
rclone delete "r2-staging:$BUCKET/t/$TENANT_UUID/"             # ejecuta
rclone ls     "r2-staging:$BUCKET/t/$TENANT_UUID/"             # debe salir vacío
```

**Pass:** el listado del prefijo sale vacío.
**Lo más limpio:** si el bucket se creó **sólo** para W-3, bórralo entero al
terminar y con él cualquier objeto que se me haya pasado.

### 8.4 · La PC Linux

```bash
systemctl --user disable --now mai-meetings-pull
rm ~/.config/systemd/user/mai-meetings-pull.service
systemctl --user daemon-reload
shred -u ~/Transcript-Project/transcript-worker/.env.w3   # el token
rm -rf ~/Transcript-Project/transcript-worker/.venv-w3
# los directorios de trabajo por job se limpian solos en éxito, fallo y apagado;
# comprueba que no quedó ninguno:
ls -d "${MEETINGS_PULL_WORKSPACE:-/tmp}"/mai-meetings-* 2>/dev/null || echo "sin restos"
```

La caché de modelos de HuggingFace (`~/.cache/huggingface`) **se conserva**: no
es dato de la prueba y volver a bajar `medium` cuesta tiempo.

### 8.5 · Railway y Cloudflare

- Borra las variables `MEETINGS_STORAGE_*` del servicio de staging si el bucket
  desaparece; dejarlas apuntando a un bucket inexistente hace que mai arranque y
  falle en la primera subida, que es peor que no arrancar.
- Revoca el token S3 del bucket privado en Cloudflare.

---

## 9 · Quién ejecuta qué

### Requieren que entres tú (yo no tengo ni debo tener acceso)

| # | acción | dónde |
|---|---|---|
| 1 | crear/confirmar el PostgreSQL de staging y su `DATABASE_URL` | Railway |
| 2 | crear el servicio web de staging y su dominio | Railway |
| 3 | poner **todas** las variables de entorno de S2 | Railway |
| 4 | desplegar la rama (después de aprobar B-1) | Railway |
| 5 | crear el **bucket R2 privado** y su token S3 | Cloudflare |
| 6 | confirmar que el bucket **no** tiene dominio público ni acceso anónimo | Cloudflare |
| 7 | instalar Python 3.11, torch/CUDA, ffmpeg, los modelos | PC Linux |
| 8 | crear `.env.w3` con el token y ponerle `0600` | PC Linux |
| 9 | instalar y arrancar la unidad systemd | PC Linux |
| 10 | extraer tu cookie de sesión para el paso 7 | tu navegador |
| 11 | grabar/aportar el audio real de dos voces | — |
| 12 | borrar los objetos de R2 y revocar el token S3 | Cloudflare |

### Ya hecho, en local, sin push

| # | acción | commit |
|---|---|---|
| 1 | B-1: los dos prefijos de máquina en el middleware, con 9 pruebas | `1dee6a7` |
| 2 | B-3: dependencias declaradas, `inspect_gpu.sh`, preflight, 24 pruebas | `d0bb600` (worker) |
| 3 | `meetingsStagingSeed.ts` | `52600c7` |
| 4 | `meetingsStagingVerify.ts` (sólo lectura) | `52600c7` |
| 5 | `meetingsStagingCleanup.ts` (tres cerrojos) | `52600c7` |
| 6 | `test/e2e/w3HttpChecks.sh` | `52600c7` |
| 7 | todo el SQL de este documento, ejecutado contra el esquema real | `4183d0b` |

### Puedo ejecutar yo cuando lo autorices

| # | acción | riesgo |
|---|---|---|
| 1 | `npm run meetings:preflight` contra S2 | ninguno, sólo lee |
| 2 | `node-pg-migrate up` contra S2 | **primera acción irreversible** |
| 3 | `npm run w3:seed` contra S2 | crea datos en el tenant que le indiques |
| 4 | `npm run w3:verify` durante el recorrido | ninguno, sólo lee |
| 5 | `npm run w3:http` contra el mai desplegado | ninguno destructivo; crea una reunión de prueba si le das la cookie |
| 6 | `npm run w3:cleanup --execute` al terminar | **borra**; tres cerrojos |

### No haré sin que lo pidas explícitamente

`git push` · deploy en Railway · `node-pg-migrate up` contra una base remota ·
crear el bucket · tocar la PC Linux · ver o manejar un token, una cookie o un
secreto real.

---

## 10 · Orden de ejecución y puertas

```
0 ·  apruebas este runbook                                   ✓ hecho
1 ·  B-1 y B-3 corregidos · suites locales verdes            ✓ 1dee6a7 · d0bb600
2 ·  los cuatro scripts, escritos y probados                 ✓ 52600c7
     el SQL del runbook, validado contra el esquema real     ✓ 4183d0b
     ── PUERTA: los revisas ← ESTAMOS AQUÍ ──
3 ·  tú: PostgreSQL de staging + variables                   Railway
4 ·  yo: `npm run meetings:preflight` contra S2              → PostgreSQL ≥ 15, gen_random_uuid, SET NULL por columna
     ── PUERTA: preflight verde ──
5 ·  yo (o tú): `node-pg-migrate up` contra S2               35 migraciones, contadas en `pgmigrations`
6 ·  tú: bucket R2 privado + token                           Cloudflare
7 ·  tú: variables MEETINGS_STORAGE_* + deploy                Railway
8 ·  yo: seed del tenant/client/módulo/credencial            → token impreso una vez, para ti
9 ·  tú: `.env.w3` + systemd en la PC Linux
     ── PUERTA: la negativa del §4.3 da 404 ──
10 · recorrido §5 + verificaciones §6
11 · pruebas de Next en producción §7
12 · limpieza §8
```

**El paso 5 es el primero irreversible** sobre una base remota. Antes de él, el
preflight del paso 4 tiene que estar verde: es el que comprueba que
`ON DELETE SET NULL (columna)` funciona de verdad en ese PostgreSQL, no sólo
que la versión lo dice.

---

## 11 · Riesgos que quedan, dichos antes de empezar

| riesgo | por qué existe | cómo se detecta |
|---|---|---|
| **R2 nunca ha recibido una petición firmada por este adaptador** | no hay bucket; el SDK oficial firma bien según sus propias pruebas, pero R2 tiene su implementación | primer PUT del paso 2. El candidato más probable es el trato del `Content-Length` firmado |
| **Whisper y wespeaker reales nunca han corrido en este pipeline** | el cruzado usa etapas instantáneas | pasos 7–8. Riesgo principal: el lease caduca en un audio largo → ajustar `MEETINGS_LEASE_SECONDS` |
| **el arreglo de B-1 amplía la superficie pública del middleware** | dos prefijos dejan de rebotar a `/login` | 9 pruebas en `web/tests/meetings-middleware.test.ts` + §7.2 (c) en vivo. Cada una de las seis llama `authenticateWorker`, y eso también tiene prueba |
| **`requirements/lock.txt` está vacío** | fijar versiones sin haberlas ejecutado sería una suposición con formato de certeza | se llena con el `pip freeze` de la PC Linux en cuanto el preflight salga verde (§3.4). Hasta entonces, la instalación no es bit-a-bit reproducible y hay que decirlo |
| **la rueda de torch se elige a mano en la PC Linux** | `inspect_gpu.sh` inventaría pero no decide, y `requirements/torch.txt` no fija nada: cualquier tabla driver→CUDA en el repositorio envejecería en silencio | el preflight es la validación definitiva: comprueba la pareja tocando su extensión y CUDA de verdad, y sale con código 2 antes de reclamar ningún job |
| **`jobs_claimable_idx` no incluye `tenant_id` ni `requires`** | decisión anterior, no corregida | con un solo tenant y una GPU no se nota; anotado para cuando haya volumen |
| **9 errores de `eslint` preexistentes en `web/`** | ficheros que nunca toqué | no bloquean el build |
| **el audio de la prueba es real** | contiene voces de personas | limpieza §8.3, y bucket dedicado que se borra entero |

---

## 12 · Definición de W-3 superado

Todo lo siguiente, o W-3 no está superado:

1. las once rutas responden por `next start` con los códigos del §7.2;
2. una reunión llega a `transcript_state='ready'` con audio real, Whisper real y
   diarización real;
3. `meeting_media` tiene el original (`run_id` nulo, sin sondeo) y el
   normalizado (`run_id` puesto, 16 kHz mono `pcm_s16le`, `probe_ok=true`);
4. los tres artefactos tienen `observed_checksum_sha256 = declared_…` y estado
   `ingested`/`verified`;
5. **una sola** versión de transcript, activa, con `segmentos = segment_count` y
   **≥ 2** hablantes con `talk_share_pct` sumando ≈ **100**;
6. el heartbeat renovó el lease durante la etapa larga;
7. un `result/complete` repetido idéntico devuelve `200` sin cambiar nada, y uno
   distinto `409 terminal_conflict`;
8. el fallo controlado reencoló con backoff y, agotados los intentos, dejó
   `failed` con su código, la reunión con aviso y **cero** filas de medio
   normalizado;
9. la credencial `single_tenant` recibió `404` en `/maintenance/requeue-expired`;
10. con `client_modules.enabled = false`, las rutas de sesión dan `404`;
11. ningún log de mai ni del worker contiene el token, una URL firmada completa
    ni una credencial de R2;
12. la limpieza del §8 deja los siete conteos en `0` y el prefijo de R2 vacío.
