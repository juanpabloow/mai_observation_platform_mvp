import { authenticateWorker, meetingsDeps, readValidated, toResponse } from '@/lib/meetingsApi';
import { ClaimBody } from '@/lib/meetingsValidation';
import { claim } from '@worker/meetings/service.js';

/**
 * POST /api/meetings/v1/jobs/claim — reclama trabajo.
 *
 * 204 sin cuerpo cuando no hay nada: «cola vacía» es el estado normal de una
 * cola, no un error, y devolver un 404 o un 200 con `{job: null}` obligaría al
 * worker a distinguir dos formas de la misma nada.
 *
 * El cuerpo sólo lleva telemetría (`workerLabel`) y una restricción voluntaria
 * de capacidades. Nada de él autoriza.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const body = await readValidated(request, ClaimBody);
    const job = await claim(
      identity,
      {
        workerLabel: body.workerLabel ?? null,
        ...(body.capabilities ? { capabilities: body.capabilities } : {}),
      },
      meetingsDeps(),
    );
    if (!job) return new Response(null, { status: 204 });
    return Response.json(job);
  } catch (error) {
    return toResponse(error);
  }
}
