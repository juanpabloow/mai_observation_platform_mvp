import {
  authenticateWorker,
  meetingsDeps,
  readJsonBody,
  readLeaseProof,
  toResponse,
} from '@/lib/meetingsApi';
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
    const body = await readJsonBody(request);
    const result = await heartbeat(
      identity,
      {
        ...readLeaseProof(body, jobId),
        progressPct: typeof body.progressPct === 'number' ? body.progressPct : null,
      },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
