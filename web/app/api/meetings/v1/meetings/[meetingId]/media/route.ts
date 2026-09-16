import { meetingsDeps, requireUuidParam, toResponse, validateQuery } from '@/lib/meetingsApi';
import { MeetingStateQuery } from '@/lib/meetingsValidation';
import { signMeetingAudio } from '@worker/meetings/uiRead.js';

/**
 * GET …/meetings/{id}/media?clientId=… — el audio normalizado, para el reproductor.
 *
 * ── Qué devuelve, y por qué una redirección ────────────────────────────────
 *
 * Responde **302** a una URL firmada que caduca. No hace proxy de los bytes por
 * la aplicación, y no es una optimización prematura: pasar el audio por Next
 * significaría que un `<audio>` con peticiones por rango mantenga abierta una
 * conexión del servidor de la aplicación por cada oyente, y que el rango tenga
 * que reimplementarse aquí. R2 ya hace las dos cosas.
 *
 * Y **el bucket sigue siendo privado**. No hay dominio público ni `r2.dev`: lo
 * único que existe es esta URL firmada, que vive lo que dure
 * `MEETINGS_STORAGE_GET_TTL_SECONDS` y se vuelve a firmar cada vez que alguien
 * la pide. Por eso la página no la resuelve al pintarse — la pediría el
 * servidor y caducaría contando desde entonces— sino que el navegador llama
 * aquí cuando el usuario da a reproducir.
 *
 * ── Las tres comprobaciones, antes de firmar ───────────────────────────────
 *
 *   1. TENANT y CLIENTE: `resolveAppScope(clientId)` — sesión, membresía,
 *      `canAccessClient`, cliente real no-default, y el módulo `meetings`
 *      habilitado para ese cliente. Es el mismo resolutor que usan las otras
 *      rutas de sesión, no una comprobación paralela.
 *   2. REUNIÓN: se lee acotada por `tenant_id` y `client_id`, así que el uuid de
 *      una reunión de otro cliente no existe.
 *   3. OBJETO: la clave del medio se verifica contra el prefijo derivado del
 *      ámbito antes de firmar. Cinturón sobre el tirante: firmar un GET es dar
 *      acceso al objeto durante toda su vigencia.
 *
 * Los tres fallos dan el MISMO 404 que un uuid inventado. `clientId` va en la
 * query y no se deduce de la reunión, igual que en la ruta de estado: el ámbito
 * lo aporta quien llama y se verifica contra su sesión.
 *
 * `Cache-Control: private, no-store` en la redirección. Una URL firmada en una
 * caché compartida es la misma fuga por otra puerta.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    const media = await signMeetingAudio(
      scope,
      requireUuidParam(meetingId, 'meetingId'),
      meetingsDeps(),
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: media.url,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return toResponse(error);
  }
}

/**
 * El resolutor de ámbito se carga DESPUÉS de validar la query, por la misma
 * razón que en las demás rutas: `meetingsAppScope` arrastra la pila de sesión, y
 * una petición sin `clientId` no debe inicializarla para poder rechazarla.
 */
async function appScope() {
  return import('@/lib/meetingsAppScope');
}
