import 'server-only';
import { authenticateWorkerToken, type WorkerIdentity } from '@worker/db/repositories/meetings/credentials.js';
import { MeetingsApiError, unauthorized } from '@worker/meetings/errors.js';
import { DEFAULT_LEASE_SECONDS, type MeetingsServiceDeps } from '@worker/meetings/service.js';
import { parseMediaLimits } from '@worker/meetings/mediaLimits.js';
import { redactSignedUrl, resolveMeetingsStorage } from '@worker/storage/meetingsStorage.js';
import { logger } from '@worker/logger.js';
import { parseBody, type ParseResult } from './meetingsValidation';
import type { z } from 'zod';

/**
 * Adaptadores HTTP de `/api/meetings/v1`. Las rutas de Next son finas a
 * propósito: leen el cuerpo, llaman al servicio y traducen la excepción. Toda
 * la lógica —claim atómico, idempotencia, transiciones— vive en
 * `src/meetings/service.ts`, donde se prueba contra una base desechable sin
 * levantar un servidor.
 *
 * ── Lo que este módulo garantiza ────────────────────────────────────────────
 *
 *   · El worker se identifica SÓLO por su token. `tenant_id`, `client_id`,
 *     `pool`, `environment`, `scope` y `capabilities` salen de la credencial.
 *     Ninguna de esas cosas se lee del cuerpo, ni de la query, ni de una
 *     cabecera.
 *   · Ningún error revela la existencia de recursos ajenos: el 404 y el 401 son
 *     únicos (ver `errors.ts`).
 *   · Ninguna URL firmada entra en un log: `logMeetingsError` pasa por
 *     `redactSignedUrl` cualquier cosa que parezca una URL.
 *
 * ── Sin sesión ──────────────────────────────────────────────────────────────
 *
 * Este módulo NO importa nada de la pila de sesión. `resolveAppScope` vive
 * aparte (`meetingsAppScope.ts`) por dos razones: la primera es que un endpoint
 * de worker no tiene nada que ver con `getAccessScope`, y la segunda es que
 * importarlo aquí arrastraba better-auth y React a los seis handlers de worker
 * — que entonces no se podían ni cargar fuera del runtime de Next, y por tanto
 * tampoco probar.
 */

/** Cuerpo JSON, o error si no es un objeto. Nunca lanza sin traducir. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new MeetingsApiError('invalid_request', 'El cuerpo debe ser JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MeetingsApiError('invalid_request', 'El cuerpo debe ser un objeto JSON.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Autentica al worker. El `Bearer` se lee de `Authorization` y nada más: no hay
 * variante por query string, porque un token en una URL acaba en los logs del
 * proxy que la sirvió.
 */
export async function authenticateWorker(request: Request): Promise<WorkerIdentity> {
  const header = (request.headers.get('authorization') ?? '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const raw = match?.[1]?.trim();
  if (!raw) throw unauthorized();
  const identity = await authenticateWorkerToken(raw);
  if (!identity) throw unauthorized();
  return identity;
}

/**
 * Resuelve el almacenamiento y los límites una vez por proceso.
 *
 * `storage_not_configured` es un 503 y no un 500: el servicio está bien, falta
 * configuración. Distinguirlos importa porque un 500 manda a buscar un bug y un
 * 503 con este código manda a mirar las variables de entorno.
 */
export function meetingsDeps(): MeetingsServiceDeps {
  const resolution = resolveMeetingsStorage(process.env);
  if (!resolution.store) {
    logger.error({ problems: resolution.problems }, 'meetings: almacenamiento privado no configurado');
    throw new MeetingsApiError(
      'storage_not_configured',
      'El almacenamiento privado de reuniones no está configurado.',
    );
  }
  const leaseSeconds = Number(process.env.MEETINGS_LEASE_SECONDS ?? '') || DEFAULT_LEASE_SECONDS;
  return {
    store: resolution.store,
    limits: parseMediaLimits(process.env).limits,
    leaseSeconds,
  };
}

/**
 * Traduce cualquier excepción a una respuesta. Un error que NO es
 * `MeetingsApiError` se registra completo y se responde como `internal` sin
 * detalle: un stack trace en el cuerpo le cuenta al cliente la estructura del
 * servidor.
 */
export function toResponse(error: unknown): Response {
  if (error instanceof MeetingsApiError) {
    if (error.code === 'no_work') return new Response(null, { status: 204 });
    return Response.json(error.body(), { status: error.status, headers: error.headers });
  }
  logMeetingsError(error);
  return Response.json(
    { error: { code: 'internal', message: 'Error interno.' } },
    { status: 500 },
  );
}

/**
 * Registra un error sin filtrar secretos. Cualquier `https://…` que aparezca en
 * el mensaje se recorta a origen + ruta: los mensajes del almacenamiento a veces
 * incluyen la URL que falló, y esa URL es una credencial de acceso al objeto
 * mientras esté vigente.
 */
export function logMeetingsError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const safe = message.replace(/https?:\/\/\S+/g, (url) => redactSignedUrl(url));
  logger.error({ err: { message: safe, name: (error as Error)?.name } }, 'meetings api error');
}

/**
 * Lee el cuerpo y lo valida con un esquema. Un cuerpo inválido es un 400 con el
 * campo nombrado, nunca un 500: los helpers campo-a-campo que había antes
 * dejaban pasar un enum inválido con un cast y la violación de CHECK de la base
 * salía como error interno.
 */
export async function readValidated<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const body = await readJsonBody(request);
  return unwrap(parseBody(schema, body));
}

/** Igual, para la query string. */
export function validateQuery<T extends z.ZodTypeAny>(request: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  return unwrap(parseBody(schema, params));
}

function unwrap<T>(result: ParseResult<T>): T {
  if (result.ok) return result.value;
  throw new MeetingsApiError('invalid_request', result.error);
}

/** El uuid de un parámetro de ruta. Un `[meetingId]` que no es uuid es un 400,
 *  no una consulta que PostgreSQL rechaza por tipo. */
export function requireUuidParam(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new MeetingsApiError('invalid_request', `${name}: se esperaba un uuid.`);
  }
  return value;
}
