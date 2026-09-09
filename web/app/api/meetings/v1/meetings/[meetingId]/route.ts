import {
  requireUuidParam,
  toResponse,
  validateQuery
} from '@/lib/meetingsApi';
import { MeetingStateQuery } from '@/lib/meetingsValidation';
import { getMeetingState } from '@worker/meetings/service.js';

/**
 * GET /api/meetings/v1/meetings/{id}?clientId=… — el estado para la UI.
 *
 * `clientId` va en la query y no se deduce de la reunión: el ámbito lo aporta
 * el llamador y se verifica contra su sesión y contra el entitlement del
 * módulo, así que un uuid de reunión de otro cliente no devuelve nada aunque se
 * acierte.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    return Response.json(await getMeetingState(scope, requireUuidParam(meetingId, 'meetingId')));
  } catch (error) {
    return toResponse(error);
  }
}

/**
 * El resolutor de ámbito se carga DESPUÉS de validar el cuerpo.
 *
 * No es un detalle de estilo. `meetingsAppScope` importa la pila de sesión
 * (better-auth, y con ella React), así que cargarlo arriba significaba que una
 * petición con el cuerpo mal formado inicializaba todo eso antes de poder
 * rechazarla — y que el handler no se podía ni cargar fuera del runtime de
 * Next, y por tanto tampoco probar. Con el import dinámico, un 400 de
 * validación no toca la sesión, y esa propiedad tiene prueba.
 */
async function appScope() {
  return import('@/lib/meetingsAppScope');
}
