import 'server-only';
import { authenticateWorkerToken, type WorkerIdentity } from '@worker/db/repositories/meetings/credentials.js';
import { MeetingsApiError, unauthorized } from '@worker/meetings/errors.js';
import { DEFAULT_LEASE_SECONDS, type MeetingsServiceDeps } from '@worker/meetings/service.js';
import { parseMediaLimits } from '@worker/meetings/mediaLimits.js';
import { redactSignedUrl, resolveMeetingsStorage } from '@worker/storage/meetingsStorage.js';
import { logger } from '@worker/logger.js';
import { getAccessScope, canAccessClient } from './access';

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
 * Ámbito de un llamador con sesión (la UI). Gatea por pertenencia al tenant y
 * acceso al cliente.
 *
 * COSTURA PENDIENTE: falta la comprobación de módulo
 * (`isClientModuleEnabled(tenant, client, 'meetings')`). No está porque en esta
 * rama ni `CLIENT_MODULE_KEYS` incluye `'meetings'` ni el CHECK de
 * `client_modules` lo admite: las dos cosas viven en el conjunto de registro del
 * módulo, que quedó deliberadamente fuera del commit de T-1. Se añade aquí, en
 * una línea, cuando ese conjunto entre — y hasta entonces la restricción
 * efectiva es la de ámbito, que es la que impide el acceso cruzado entre
 * clientes y tenants.
 */
export async function resolveAppScope(clientId: string): Promise<{
  tenantId: string;
  clientId: string;
  userId: string | null;
  userLabel: string | null;
}> {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) {
    // El mismo 404 que un cliente inexistente: probar uuids no distingue.
    throw new MeetingsApiError('not_found', 'No encontrado.');
  }
  return {
    tenantId: scope.tenantId,
    clientId,
    userId: scope.userId,
    // La etiqueta de atribución: el id del usuario, que es lo que AccessScope
    // trae. No el correo — no está en el scope y buscarlo sólo para un log
    // añadiría una consulta a cada operación.
    userLabel: scope.userId,
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

/** Lecturas tipadas del cuerpo, con el error ya traducido. */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MeetingsApiError('invalid_request', `'${field}' es obligatorio.`);
  }
  return value;
}

export function requireInt(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new MeetingsApiError('invalid_request', `'${field}' debe ser un entero.`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** La prueba de lease que acompaña a toda operación sobre un job reclamado. */
export function readLeaseProof(
  body: Record<string, unknown>,
  jobId: string,
): { jobId: string; attempt: number; leaseToken: string } {
  return {
    jobId,
    attempt: requireInt(body, 'attempt'),
    leaseToken: requireString(body, 'leaseToken'),
  };
}
