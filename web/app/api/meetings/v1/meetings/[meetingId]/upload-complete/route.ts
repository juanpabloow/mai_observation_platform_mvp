import {
  meetingsDeps,
  readValidated,
  requireUuidParam,
  toResponse
} from '@/lib/meetingsApi';
import { UploadCompleteBody } from '@/lib/meetingsValidation';
import { uploadComplete } from '@worker/meetings/service.js';

/** POST … /upload-complete — confirma el objeto y arranca el pipeline. */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readValidated(request, UploadCompleteBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    return Response.json(
      await uploadComplete(
        scope,
        requireUuidParam(meetingId, 'meetingId'),
        { bytes: body.bytes, checksumSha256: body.checksumSha256 },
        meetingsDeps(),
      ),
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
