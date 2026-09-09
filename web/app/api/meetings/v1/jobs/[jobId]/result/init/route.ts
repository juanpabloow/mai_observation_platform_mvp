import {
  authenticateWorker,
  meetingsDeps,
  readValidated,
  requireUuidParam,
  toResponse,
} from '@/lib/meetingsApi';
import { ResultInitBody } from '@/lib/meetingsValidation';
import { resultInit } from '@worker/meetings/service.js';

/**
 * POST … /result/init — firma el PUT del artefacto de la etapa.
 *
 * El worker NO elige la clave ni el `kind`: los dos los deriva mai de la etapa
 * del job y del intento en curso.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const { jobId } = await context.params;
    const body = await readValidated(request, ResultInitBody);
    return Response.json(
      await resultInit(
        identity,
        {
          jobId: requireUuidParam(jobId, 'jobId'),
          attempt: body.attempt,
          leaseToken: body.leaseToken,
          bytes: body.bytes,
          checksumSha256: body.checksumSha256,
          itemCount: body.itemCount ?? null,
          schemaVersion: body.schemaVersion ?? 1,
        },
        meetingsDeps(),
      ),
    );
  } catch (error) {
    return toResponse(error);
  }
}
