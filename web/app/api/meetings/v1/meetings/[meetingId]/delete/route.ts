import { meetingsDeps, readValidated, requireUuidParam, toResponse } from '@/lib/meetingsApi';
import { ClientScopedBody } from '@/lib/meetingsValidation';
import { requestMeetingDeletion } from '@worker/meetings/deletion.js';
import { logger } from '@worker/logger.js';

/**
 * POST … /delete — «Eliminar reunión». Destruye audio, transcripciones,
 * análisis y todos los artefactos.
 *
 * Es POST y no el verbo DELETE sobre el recurso por una razón concreta: la
 * respuesta es **202**, no 204. Lo que esta llamada hace es RESERVAR la
 * eliminación; la limpieza del bucket la termina una tarea después de que
 * venzan las URLs de escritura que ya estaban firmadas. Devolver 204 a un
 * DELETE afirmaría que ya está hecho, y no lo está.
 *
 * ── Lo que el servidor NO acepta del navegador ────────────────────────────
 *
 * El cuerpo lleva `clientId` y nada más. El `tenantId` sale de la sesión, el
 * `meetingId` de la ruta y se valida dentro del ámbito, y el prefijo de
 * almacenamiento lo deriva `meetingPrefix()` de esos tres. **No existe ningún
 * campo `storageKey`**, ni aquí ni en el esquema: si el navegador pudiera
 * proponer una clave, podría proponer la de otro cliente.
 *
 * Cambiar el `meetingId` de la URL por el de otro tenant devuelve 404 —
 * `resolveAppScope` no llega a mirar la reunión— y el UPDATE de reserva repite
 * `tenant_id` y `client_id` en el WHERE aunque el uuid ya sea único.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readValidated(request, ClientScopedBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    const id = requireUuidParam(meetingId, 'meetingId');

    const result = await requestMeetingDeletion(scope, id, meetingsDeps());

    // Sin título, sin claves, sin URLs. Quién y qué, no el contenido.
    logger.info(
      {
        meetingId: id,
        tenantId: scope.tenantId,
        clientId: scope.clientId,
        reserved: result.reserved,
        notBefore: result.notBefore,
      },
      'meetings: eliminación reservada',
    );
    return Response.json(result, { status: 202 });
  } catch (error) {
    return toResponse(error);
  }
}

async function appScope() {
  return import('@/lib/meetingsAppScope');
}
