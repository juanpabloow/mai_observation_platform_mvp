import {
  authenticateWorker,
  meetingsDeps,
  readValidated,
  requireUuidParam,
  toResponse,
} from '@/lib/meetingsApi';
import { HeartbeatBody } from '@/lib/meetingsValidation';
import { heartbeat } from '@worker/meetings/service.js';

/**
 * POST … /heartbeat — renueva el lease y devuelve la señal de cancelación.
 *
 * La duración la decide el SERVIDOR. El worker no puede pedir su propia
 * caducidad: uno roto pediría una hora y ningún barrido lo recuperaría antes.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const { jobId } = await context.params;
    const body = await readValidated(request, HeartbeatBody);
    return Response.json(
      await heartbeat(
        identity,
        {
          jobId: requireUuidParam(jobId, 'jobId'),
          attempt: body.attempt,
          leaseToken: body.leaseToken,
          progressPct: body.progressPct ?? null,
        },
        meetingsDeps(),
      ),
    );
  } catch (error) {
    return toResponse(error);
  }
}
