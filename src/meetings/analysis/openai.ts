import { ANALYSIS_PROMPT_VERSION, RawAnalysis, analysisJsonSchema } from './contract.js';
import { SYSTEM_PROMPT, type RenderedTranscript, userMessage } from './prompt.js';

/**
 * El proveedor. Server-only, con límites, y sin registrar una sola palabra del
 * contenido.
 *
 * ── Qué endpoint, exactamente ──────────────────────────────────────────────
 *
 *   POST https://api.openai.com/v1/chat/completions
 *
 * Es Chat Completions, NO la Responses API. Se manda `store: false` de todos
 * modos: en Chat Completions el valor por omisión ya es no almacenar, pero
 * «por omisión» es una propiedad del proveedor que puede cambiar y que la
 * organización puede tener configurada de otra forma. Escribirlo es barato y
 * convierte una suposición en una instrucción.
 *
 * ── Reintentos: uno, y es el único ─────────────────────────────────────────
 *
 * No se usa el SDK de OpenAI —no está instalado— sino `fetch` directamente. Eso
 * importa: el SDK reintenta 2 veces por su cuenta además de lo que haga quien
 * lo llame, así que «un reintento» con el SDK serían tres llamadas. Con `fetch`
 * el número es exactamente el que dice `retries`.
 *
 * ── La clave ───────────────────────────────────────────────────────────────
 *
 * `OPENAI_API_KEY` se lee del entorno del proceso y no sale de él. No se escribe
 * en ningún log, ni en el mensaje de ningún error —los errores reportan estado
 * HTTP y tipo, nunca cabeceras—, y este módulo no se importa nunca desde el
 * navegador: vive bajo `src/`, que sólo se ejecuta en el servidor.
 *
 * ── Qué se registra ────────────────────────────────────────────────────────
 *
 * Tokens, coste, duración y modelo. NUNCA el prompt, la transcripción ni la
 * respuesta. El contenido privado ya vive en la base; repetirlo en un log lo
 * pondría en un sitio con otra retención y otros permisos.
 */

export class AnalysisError extends Error {
  readonly code: 'no_key' | 'http' | 'timeout' | 'malformed' | 'refused';
  readonly status?: number;
  constructor(code: AnalysisError['code'], message: string, status?: number) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Precio por millón de tokens. SE DEBE CONFIRMAR contra la página de precios del
 * proveedor antes de fiarse del número: una tabla escrita en el código envejece
 * y nadie se entera hasta que la factura no cuadra. Por eso el coste estimado se
 * enseña ANTES de llamar, y el real se guarda después.
 */
export const PRICING: Record<string, { inPerM: number; outPerM: number }> = {
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.60 },
  'gpt-4o': { inPerM: 2.50, outPerM: 10.00 },
};

/** El económico, y suficiente para esto: extraer y clasificar, no redactar prosa. */
export const DEFAULT_MODEL = 'gpt-4o-mini';

/** Tope de salida. El esquema ya acota las listas; esto acota el gasto. */
export const MAX_OUTPUT_TOKENS = 2000;

/**
 * Coste ESTIMADO, o `null` si no conocemos el precio del modelo.
 *
 * Nunca 0 para un modelo desconocido: un cero se lee como «gratis» y se suma sin
 * ruido a un total que entonces miente. `null` obliga a decir «no disponible».
 */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (inputTokens / 1e6) * p.inPerM + (outputTokens / 1e6) * p.outPerM;
}

/**
 * Estimación de tokens sin llamar a nadie: ~4 caracteres por token en español.
 * Es aproximada a propósito — sirve para decidir si una llamada es cara, no para
 * facturar. El número real viene en la respuesta y es el que se guarda.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface EstimatedCost {
  readonly model: string;
  readonly inputTokens: number;
  readonly maxOutputTokens: number;
  /** `null` cuando el modelo no está en la tabla de precios. */
  readonly minUsd: number | null;
  readonly maxUsd: number | null;
  /** Siempre true: es una estimación, nunca el importe facturado. */
  readonly estimated: true;
}

export function estimateCost(rendered: RenderedTranscript, model = DEFAULT_MODEL): EstimatedCost {
  const inputTokens = estimateTokens(SYSTEM_PROMPT) + estimateTokens(userMessage(rendered));
  return {
    model,
    inputTokens,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // El mínimo supone una salida corta; el máximo, que se agota el tope. Los dos
    // son aproximados: el recuento de tokens real lo da el proveedor al responder.
    minUsd: costUsd(model, inputTokens, 200),
    maxUsd: costUsd(model, inputTokens, MAX_OUTPUT_TOKENS),
    estimated: true,
  };
}

export interface AnalyzeResult {
  readonly raw: RawAnalysis;
  /** El que se pidió. */
  readonly model: string;
  /** El que el proveedor dice haber usado: un alias se resuelve a una versión. */
  readonly modelReturned: string | null;
  readonly promptVersion: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** ESTIMADO a partir de la tabla local. `null` si el modelo no está en ella. */
  readonly costUsd: number | null;
  readonly durationMs: number;
}

export interface AnalyzeDeps {
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** Reintentos ADICIONALES. 1 por omisión, y sólo ante fallos transitorios. */
  readonly retries?: number;
  /** Sólo identificadores y números. Jamás contenido. */
  readonly onUsage?: (u: {
    model: string;
    modelReturned: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    durationMs: number;
    attempt: number;
  }) => void;
}

const TRANSITORIOS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export async function analyze(
  rendered: RenderedTranscript,
  deps: AnalyzeDeps = {},
): Promise<AnalyzeResult> {
  const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey.trim()) {
    throw new AnalysisError('no_key', 'Falta OPENAI_API_KEY en el entorno del servidor.');
  }
  const model = deps.model ?? process.env.MEETINGS_ANALYSIS_MODEL ?? DEFAULT_MODEL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;
  const maxRetries = deps.retries ?? 1;

  const body = {
    model,
    // La transcripción va en su propio mensaje, separada de las instrucciones.
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage(rendered) },
    ],
    // Salida estructurada e impuesta por el proveedor, no «pídele que devuelva
    // JSON y cruza los dedos». Aun así se vuelve a validar al recibirla.
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'meeting_analysis', strict: true, schema: analysisJsonSchema() },
    },
    max_completion_tokens: MAX_OUTPUT_TOKENS,
    // No conservar la conversación del lado del proveedor. La transcripción es
    // material privado de un tercero; se envía para obtener el resumen y no para
    // que quede almacenada.
    store: false,
    // Determinista en lo posible: dos resúmenes del mismo texto no deberían
    // diferir por azar, porque entonces «se actualizó» y «cambió el modelo» se
    // vuelven indistinguibles.
    temperature: 0,
  };

  let ultimo: AnalysisError | null = null;
  for (let intento = 0; intento <= maxRetries; intento += 1) {
    const empezó = Date.now();
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), timeoutMs);
    try {
      const respuesta = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: control.signal,
      });
      if (!respuesta.ok) {
        // El cuerpo del error NO se propaga tal cual: puede repetir el prompt.
        const err = new AnalysisError('http', `El proveedor respondió ${respuesta.status}.`, respuesta.status);
        if (TRANSITORIOS.has(respuesta.status) && intento < maxRetries) {
          ultimo = err;
          continue;
        }
        throw err;
      }
      const datos = (await respuesta.json()) as {
        model?: string;
        choices?: { message?: { content?: string; refusal?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const mensaje = datos.choices?.[0]?.message;
      if (mensaje?.refusal) {
        throw new AnalysisError('refused', 'El modelo rechazó la petición.');
      }
      const contenido = mensaje?.content;
      if (typeof contenido !== 'string' || contenido.trim() === '') {
        throw new AnalysisError('malformed', 'El proveedor devolvió una respuesta vacía.');
      }
      let json: unknown;
      try {
        json = JSON.parse(contenido);
      } catch {
        throw new AnalysisError('malformed', 'La respuesta no era JSON válido.');
      }
      const parsed = RawAnalysis.safeParse(json);
      if (!parsed.success) {
        // Se nombran los CAMPOS que fallan, nunca sus valores.
        const campos = parsed.error.issues.map((i) => i.path.join('.')).slice(0, 6).join(', ');
        throw new AnalysisError('malformed', `La respuesta no cumple el esquema (${campos}).`);
      }
      const inputTokens = datos.usage?.prompt_tokens ?? 0;
      const outputTokens = datos.usage?.completion_tokens ?? 0;
      const durationMs = Date.now() - empezó;
      // El precio se calcula con el modelo que el proveedor dice haber usado, no
      // con el alias que pedimos: es el que factura.
      const modelReturned = typeof datos.model === 'string' ? datos.model : null;
      const coste = costUsd(modelReturned ?? model, inputTokens, outputTokens);
      deps.onUsage?.({
        model, modelReturned, inputTokens, outputTokens, costUsd: coste,
        durationMs, attempt: intento + 1,
      });
      return {
        raw: parsed.data,
        model,
        modelReturned,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        inputTokens,
        outputTokens,
        costUsd: coste,
        durationMs,
      };
    } catch (causa) {
      if (causa instanceof AnalysisError) {
        if (causa.code === 'http' && intento < maxRetries && TRANSITORIOS.has(causa.status ?? 0)) {
          ultimo = causa;
          continue;
        }
        throw causa;
      }
      const abortado = (causa as { name?: string })?.name === 'AbortError';
      const err = new AnalysisError(abortado ? 'timeout' : 'http', abortado ? `Sin respuesta en ${timeoutMs} ms.` : 'Fallo de red hablando con el proveedor.');
      if (intento < maxRetries) {
        ultimo = err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(reloj);
    }
  }
  throw ultimo ?? new AnalysisError('http', 'No se pudo completar la llamada.');
}
