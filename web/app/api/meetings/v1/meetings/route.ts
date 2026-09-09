import {
  meetingsDeps,
  readJsonBody,
  requireString,
  resolveAppScope,
  toResponse,
} from '@/lib/meetingsApi';
import { createMeeting } from '@worker/meetings/service.js';

/** POST /api/meetings/v1/meetings — crea una reunión (idempotente por clave). */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const scope = await resolveAppScope(requireString(body, 'clientId'));
    // meetingsDeps se llama para que una configuración de almacenamiento
    // ausente falle AQUÍ y no dos peticiones más tarde, cuando el usuario ya
    // tiene una reunión creada que no puede subir nada.
    meetingsDeps();
    const result = await createMeeting(scope, {
      title: requireString(body, 'title'),
      idempotencyKey: requireString(body, 'idempotencyKey'),
      sourceKind: (body.sourceKind as never) ?? undefined,
      startedAt: (body.startedAt as string | null) ?? null,
      languageHint: (body.languageHint as string | null) ?? null,
    });
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    return toResponse(error);
  }
}
