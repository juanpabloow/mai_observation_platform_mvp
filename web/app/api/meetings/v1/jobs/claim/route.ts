import {
  authenticateWorker,
  meetingsDeps,
  optionalString,
  readJsonBody,
  toResponse,
} from '@/lib/meetingsApi';
import { claim } from '@worker/meetings/service.js';

/**
 * POST /api/meetings/v1/jobs/claim — reclama trabajo.
 *
 * 204 sin cuerpo cuando no hay nada: «cola vacía» es el estado normal de una
 * cola, no un error, y devolver un 404 o un 200 con `{job: null}` obligaría al
 * worker a distinguir dos formas de la misma nada.
 *
 * El cuerpo es opcional y sólo lleva telemetría (`workerLabel`) y una
 * restricción voluntaria de capacidades. Nada de él autoriza.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const body = request.headers.get('content-length') === '0' ? {} : await readJsonBody(request).catch(() => ({}));
    const job = await claim(
      identity,
      {
        workerLabel: optionalString(body as Record<string, unknown>, 'workerLabel'),
        capabilities: Array.isArray((body as Record<string, unknown>).capabilities)
          ? ((body as Record<string, unknown>).capabilities as string[])
          : undefined,
      },
      meetingsDeps(),
    );
    if (!job) return new Response(null, { status: 204 });
    return Response.json(job);
  } catch (error) {
    return toResponse(error);
  }
}
