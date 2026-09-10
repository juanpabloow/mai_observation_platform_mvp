import { checkMedia, type MediaLimits } from "@worker/meetings/mediaLimits.js";
import { sha256HexOfBlob } from "./sha256";

/**
 * La subida de una reunión desde el navegador, contra la API que ya existe.
 *
 * ── El orden, y por qué es ese ─────────────────────────────────────────────
 *
 *   1. validar en local     — extensión, tipo y tamaño, con los MISMOS límites
 *                             que el servidor, para no firmar nada que se vaya
 *                             a rechazar;
 *   2. hashear              — `upload-complete` exige el SHA-256, así que hay
 *                             que calcularlo de todas formas; hacerlo ANTES de
 *                             crear la reunión es lo que permite el punto 3;
 *   3. crear la reunión     — con `idempotencyKey` derivada del CONTENIDO;
 *   4. `upload-init`        — firma el PUT;
 *   5. PUT a R2             — con progreso real, por XHR;
 *   6. `upload-complete`    — confirma y arranca el pipeline;
 *   7. sondear el estado    — hasta que haya transcripción o falle.
 *
 * ── Reintentar no duplica reuniones ────────────────────────────────────────
 *
 * `idempotencyKey = upload:{sha256}:{bytes}` sale del contenido del fichero, y
 * `meetings_idem_key UNIQUE (tenant_id, client_id, idempotency_key)` con el
 * `ON CONFLICT DO NOTHING` de `createMeeting` hace que la segunda llamada
 * devuelva LA MISMA reunión con `created: false`.
 *
 * Eso cubre el caso que importa: se cae la red a mitad del PUT, se reintenta y
 * se sigue con la reunión que ya estaba, sin dejar una huérfana por intento. Un
 * uuid aleatorio por intento habría creado una reunión nueva cada vez, y la
 * pantalla se habría llenado de filas a medias.
 *
 * Y cubre el otro caso de forma útil: subir dos veces la misma grabación a
 * propósito devuelve la existente en vez de duplicar el audio en R2. No es un
 * error, así que no se presenta como tal — se dice y se ofrece abrirla.
 */

export type UploadStage =
  | "idle"
  | "hashing"
  | "creating"
  | "signing"
  | "uploading"
  | "confirming"
  | "processing"
  | "ready"
  | "error";

export interface UploadState {
  readonly stage: UploadStage;
  /** 0–100 de la etapa en curso, o null cuando no se puede saber. */
  readonly percent: number | null;
  readonly meetingId: string | null;
  /** true cuando la reunión ya existía con este mismo contenido. */
  readonly reused: boolean;
  /** La etapa del pipeline mientras `stage === "processing"`. */
  readonly pipelineStage: string | null;
  readonly message: string | null;
  /** Código estable del error, para las pruebas y los logs. */
  readonly code: string | null;
  /** `true` si volver a intentarlo tiene sentido con el mismo fichero. */
  readonly retryable: boolean;
  /** Sale cuando hay transcripción que abrir. */
  readonly transcriptReady: boolean;
}

export const IDLE: UploadState = {
  stage: "idle",
  percent: null,
  meetingId: null,
  reused: false,
  pipelineStage: null,
  message: null,
  code: null,
  retryable: false,
  transcriptReady: false,
};

/** Lo que la zona de arrastre dice que acepta. Derivado, nunca escrito a mano. */
export function describeLimits(limits: MediaLimits): string {
  const exts = limits.allowedExtensions
    .map((extension) => extension.replace(/^\./, "").toUpperCase())
    .join(", ");
  const gib = limits.maxBytes / (1024 * 1024 * 1024);
  const size = gib >= 1 ? `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GB` :
    `${Math.round(limits.maxBytes / (1024 * 1024))} MB`;
  return `${exts} · hasta ${size}`;
}

/** El atributo `accept` del input, a partir de los mismos límites. */
export function acceptAttribute(limits: MediaLimits): string {
  return [...limits.allowedExtensions, ...limits.allowedContentTypes]
    .filter((item) => item !== "application/octet-stream")
    .join(",");
}

/**
 * Mensajes para persona, por código estable.
 *
 * Se traduce el CÓDIGO y no el texto del servidor: los códigos son vocabulario
 * cerrado (`MeetingsErrorCode`, `MediaRejectCode`) y el texto puede cambiar.
 * Un código que no esté aquí se muestra con su detalle en vez de convertirse en
 * «error desconocido»: el detalle es lo único que permite diagnosticarlo.
 */
export function humanMessage(code: string, detail?: string): string {
  const known: Record<string, string> = {
    extension_not_allowed: "Ese tipo de fichero no se admite.",
    content_type_not_allowed: "El navegador declara un tipo de contenido que no se admite.",
    size_too_large: "El fichero es demasiado grande.",
    size_not_positive: "El fichero está vacío.",
    filename_missing: "El fichero no tiene nombre.",
    media_rejected: detail ?? "El fichero no se admite.",
    not_found: "Esta reunión ya no está disponible para este cliente.",
    unauthorized: "Tu sesión ha caducado. Vuelve a entrar y reinténtalo.",
    module_disabled: "El módulo de Reuniones no está habilitado para este cliente.",
    invalid_request: detail ?? "La petición no era válida.",
    invalid_transition:
      "Esta reunión ya tiene su audio. Ábrela en vez de volver a subirlo.",
    object_missing: "R2 no encontró el fichero subido. Vuelve a intentarlo.",
    size_mismatch: "El fichero llegó incompleto. Vuelve a intentarlo.",
    checksum_mismatch: "El fichero llegó corrupto. Vuelve a intentarlo.",
    content_type_mismatch: "El tipo de contenido no coincide con el declarado.",
    storage_unavailable: "El almacenamiento no responde. Inténtalo en un momento.",
    storage_not_configured: "El almacenamiento de Reuniones no está configurado.",
    rate_limited: "Demasiados intentos. Espera unos segundos.",
    internal: "Error interno del servidor.",
    network: "Se perdió la conexión durante la subida.",
    cors: "R2 rechazó la subida desde el navegador: falta la configuración CORS del bucket.",
    aborted: "Subida cancelada.",
    put_failed: detail ?? "R2 rechazó la subida.",
  };
  return known[code] ?? `${code}${detail ? `: ${detail}` : ""}`;
}

/** Los códigos con los que reintentar el MISMO fichero tiene sentido. */
const RETRYABLE = new Set([
  "network",
  "put_failed",
  "object_missing",
  "size_mismatch",
  "checksum_mismatch",
  "storage_unavailable",
  "rate_limited",
  "internal",
]);

export class UploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** El título por defecto: el nombre del fichero sin extensión. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return stem.trim() === "" ? base : stem.trim();
}

export function idempotencyKeyFor(checksumSha256: string, bytes: number): string {
  return `upload:${checksumSha256}:${bytes}`;
}

// ── Las dependencias inyectables ───────────────────────────────────────────
//
// El PUT va por XHR porque `fetch` no reporta progreso de SUBIDA (sólo de
// descarga), y sin progreso una subida de 200 MB es una barra parada. Se
// inyecta para que las pruebas puedan ejercitar la máquina de estados entera
// sin un navegador.

export interface PutRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Blob;
  readonly onProgress: (sent: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export type PutFn = (request: PutRequest) => Promise<void>;

export const xhrPut: PutFn = ({ url, headers, body, onProgress, signal }) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    for (const [name, value] of Object.entries(headers)) {
      // `content-length` es cabecera prohibida para XHR: el navegador la pone
      // él con el tamaño del Blob, que es exactamente el valor firmado.
      // Intentar ponerla a mano lanza en algunos navegadores y se ignora en
      // otros; en los dos casos el valor correcto acaba en la petición.
      if (name.toLowerCase() === "content-length") continue;
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        /* cabecera prohibida: la pone el navegador */
      }
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else
        reject(
          new UploadError(
            "put_failed",
            `R2 respondió ${xhr.status}.`,
            xhr.status === 403
              ? "Puede ser la firma caducada o una cabecera que CORS no permite."
              : undefined,
          ),
        );
    };
    // Un fallo de CORS llega aquí SIN código: el navegador no expone la
    // respuesta. Es indistinguible de una caída de red desde JavaScript, así
    // que se nombran las dos posibilidades en vez de adivinar una.
    xhr.onerror = () =>
      reject(
        new UploadError(
          "cors",
          "La petición a R2 no se pudo completar.",
          "Sin respuesta legible: o el bucket no tiene CORS para este origen, o se cortó la red.",
        ),
      );
    xhr.onabort = () => reject(new UploadError("aborted", "Subida cancelada."));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });

interface ApiError {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") {
      throw new UploadError("aborted", "Subida cancelada.");
    }
    throw new UploadError("network", "No se pudo hablar con el servidor.");
  }
  if (response.ok) return (await response.json()) as T;
  // Una redirección al login llega aquí como 200 de HTML tras seguirla, o como
  // 307 si no. Las dos significan lo mismo para quien mira la pantalla.
  if (response.status === 307 || response.status === 401 || response.redirected) {
    throw new UploadError("unauthorized", humanMessage("unauthorized"));
  }
  let payload: ApiError = {};
  try {
    payload = (await response.json()) as ApiError;
  } catch {
    /* el cuerpo no era JSON */
  }
  const code = payload.error?.code ?? `http_${response.status}`;
  throw new UploadError(code, humanMessage(code, payload.error?.message), payload.error?.message);
}

export interface UploadInput {
  readonly file: File;
  readonly clientId: string;
  readonly title: string;
  readonly limits: MediaLimits;
  readonly onState: (state: UploadState) => void;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly put?: PutFn;
  /** Sólo para pruebas: acorta el sondeo. */
  readonly pollMs?: number;
  readonly now?: () => number;
}

interface CreateResponse {
  readonly meetingId: string;
  readonly created: boolean;
  readonly mediaState: string;
}
interface InitResponse {
  readonly url: string;
  readonly requiredHeaders: Record<string, string>;
  readonly expiresAt: string;
}
interface StateResponse {
  readonly transcriptState: string;
  readonly mediaState: string;
  readonly activeTranscript: { readonly id: string } | null;
  readonly jobs: readonly {
    readonly stage: string;
    readonly status: string;
    readonly progressPct: number | null;
    readonly failureCode: string | null;
  }[];
}

/**
 * Ejecuta el flujo completo. Lanza `UploadError` con un código estable; la
 * interfaz sólo tiene que pintar `state`.
 */
export async function uploadMeeting(input: UploadInput): Promise<UploadState> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const put = input.put ?? xhrPut;
  const { file, clientId, limits, signal } = input;

  let state: UploadState = { ...IDLE };
  const emit = (patch: Partial<UploadState>): void => {
    state = { ...state, ...patch };
    input.onState(state);
  };

  const fail = (error: unknown): never => {
    const uploadError =
      error instanceof UploadError
        ? error
        : new UploadError("internal", (error as Error)?.message ?? "Error inesperado.");
    emit({
      stage: "error",
      percent: null,
      code: uploadError.code,
      message: uploadError.message,
      retryable: uploadError.retryable,
    });
    throw uploadError;
  };

  try {
    // ── 1 · el portero local, con los límites del servidor ────────────────
    const check = checkMedia(
      { filename: file.name, contentType: file.type || "application/octet-stream", bytes: file.size },
      limits,
    );
    if (!check.ok) throw new UploadError(check.code, humanMessage(check.code, check.detail), check.detail);

    // ── 2 · el checksum, que hace falta para confirmar y para no duplicar ──
    emit({ stage: "hashing", percent: 0 });
    const checksumSha256 = await sha256HexOfBlob(file, (progress) => {
      if (signal?.aborted) return;
      emit({
        stage: "hashing",
        percent: progress.totalBytes === 0 ? 100 : Math.round((progress.hashedBytes / progress.totalBytes) * 100),
      });
    });
    if (signal?.aborted) throw new UploadError("aborted", "Subida cancelada.");

    // ── 3 · la reunión, idempotente por contenido ─────────────────────────
    emit({ stage: "creating", percent: null });
    const created = await postJson<CreateResponse>(
      fetchImpl,
      "/api/meetings/v1/meetings",
      {
        clientId,
        title: input.title,
        idempotencyKey: idempotencyKeyFor(checksumSha256, file.size),
        sourceKind: "file",
      },
      signal,
    );
    emit({ meetingId: created.meetingId, reused: !created.created });

    // Ya tiene su audio: no hay nada que subir y volver a firmar daría
    // `invalid_transition`. Se salta al sondeo, que es lo que el usuario quiere.
    if (created.mediaState === "ready") {
      emit({ stage: "processing", percent: null });
      return await poll(created.meetingId);
    }

    // ── 4 · firmar el PUT ────────────────────────────────────────────────
    emit({ stage: "signing", percent: null });
    const signed = await postJson<InitResponse>(
      fetchImpl,
      `/api/meetings/v1/meetings/${created.meetingId}/upload-init`,
      {
        clientId,
        filename: file.name,
        contentType: check.contentType,
        bytes: file.size,
        // Se declara aquí para que R2 lo verifique al recibir el objeto: así
        // `upload-complete` puede responder `checksumVerified` en vez de
        // «el tamaño cuadra y del contenido no sé nada».
        checksumSha256,
      },
      signal,
    );

    // ── 5 · el PUT, con progreso de verdad ───────────────────────────────
    emit({ stage: "uploading", percent: 0 });
    await put({
      url: signed.url,
      headers: signed.requiredHeaders,
      body: file,
      onProgress: (sent, total) =>
        emit({ stage: "uploading", percent: total === 0 ? 100 : Math.round((sent / total) * 100) }),
      ...(signal ? { signal } : {}),
    });

    // ── 6 · confirmar: aquí arranca el pipeline ──────────────────────────
    emit({ stage: "confirming", percent: null });
    await postJson<{ mediaState: string }>(
      fetchImpl,
      `/api/meetings/v1/meetings/${created.meetingId}/upload-complete`,
      { clientId, bytes: file.size, checksumSha256 },
      signal,
    );

    // ── 7 · el procesamiento ─────────────────────────────────────────────
    emit({ stage: "processing", percent: null });
    return await poll(created.meetingId);
  } catch (error) {
    return fail(error);
  }

  /**
   * Sondea el estado hasta que haya transcripción, falle o se cancele.
   *
   * Sin tope de intentos a propósito: una reunión de cuatro horas tarda lo que
   * tarda, y un límite arbitrario haría que la pantalla dijera «se agotó el
   * tiempo» sobre un trabajo que sigue corriendo bien. El corte es el diálogo:
   * cerrarlo aborta el sondeo, no el procesamiento.
   */
  async function poll(meetingId: string): Promise<UploadState> {
    const wait = input.pollMs ?? 2500;
    for (;;) {
      if (signal?.aborted) throw new UploadError("aborted", "Subida cancelada.");
      let snapshot: StateResponse;
      try {
        const response = await fetchImpl(
          `/api/meetings/v1/meetings/${meetingId}?clientId=${encodeURIComponent(clientId)}`,
          signal ? { signal } : {},
        );
        if (!response.ok) throw new Error(String(response.status));
        snapshot = (await response.json()) as StateResponse;
      } catch (cause) {
        if ((cause as Error)?.name === "AbortError") {
          throw new UploadError("aborted", "Subida cancelada.");
        }
        // Un sondeo que falla NO es un fallo de la subida: el audio ya está en
        // R2 y el worker sigue. Se reintenta en silencio.
        await sleep(wait);
        continue;
      }

      const running = snapshot.jobs.find((job) =>
        ["queued", "leased", "uploading_result"].includes(job.status),
      );
      const failed = snapshot.jobs.find((job) => job.status === "failed");

      if (snapshot.transcriptState === "ready" && snapshot.activeTranscript !== null) {
        emit({ stage: "ready", percent: 100, pipelineStage: null, transcriptReady: true });
        return state;
      }
      if (snapshot.transcriptState === "failed" && failed) {
        throw new UploadError(
          failed.failureCode ?? "internal",
          `El procesamiento falló en la etapa ${failed.stage}.`,
          failed.failureCode ?? undefined,
        );
      }
      emit({
        stage: "processing",
        pipelineStage: running?.stage ?? null,
        percent: running?.progressPct ?? null,
      });
      await sleep(wait);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
