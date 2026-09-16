import { readValidated, requireUuidParam, toResponse } from '@/lib/meetingsApi';
import { ClientScopedBody } from '@/lib/meetingsValidation';
import { cancelMeeting } from '@worker/meetings/service.js';

/**
 * POST … /cancel — cancela la reunión y sus jobs.
 *
 * La cancelación es COOPERATIVA: los jobs en vuelo se marcan y el worker se
 * entera en su siguiente latido. mai no espera respuesta, porque una
 * cancelación que depende de que un proceso remoto conteste no es una
 * cancelación.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readValidated(request, ClientScopedBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    return Response.json(
      await cancelMeeting(scope, requireUuidParam(meetingId, 'meetingId')),
    );
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
