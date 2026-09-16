import { meetingsDeps, readValidated, toResponse } from '@/lib/meetingsApi';
import { CreateMeetingBody } from '@/lib/meetingsValidation';
import { createMeeting } from '@worker/meetings/service.js';

/** POST /api/meetings/v1/meetings — crea una reunión (idempotente por clave). */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readValidated(request, CreateMeetingBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    // meetingsDeps se llama para que una configuración de almacenamiento
    // ausente falle AQUÍ y no dos peticiones más tarde, cuando el usuario ya
    // tiene una reunión creada que no puede subir nada.
    meetingsDeps();
    const result = await createMeeting(scope, {
      title: body.title,
      idempotencyKey: body.idempotencyKey,
      // Enum ya validado: no hay cast a `never` que deje pasar 'loquesea' hasta
      // el INSERT y salga como violación de CHECK, es decir, como un 500.
      ...(body.sourceKind ? { sourceKind: body.sourceKind } : {}),
      startedAt: body.startedAt ?? null,
      languageHint: body.languageHint ?? null,
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
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
