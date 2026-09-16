import {
  authenticateWorker,
  meetingsDeps,
  readValidated,
  requireUuidParam,
  toResponse,
} from '@/lib/meetingsApi';
import { ResultCompleteBody } from '@/lib/meetingsValidation';
import { resultComplete } from '@worker/meetings/service.js';

/**
 * POST … /result/complete — verifica el artefacto, cierra la etapa y crea la
 * siguiente EN LA MISMA TRANSACCIÓN.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const { jobId } = await context.params;
    const body = await readValidated(request, ResultCompleteBody);
    return Response.json(
      await resultComplete(
        identity,
        {
          jobId: requireUuidParam(jobId, 'jobId'),
          attempt: body.attempt,
          leaseToken: body.leaseToken,
          bytes: body.bytes,
          checksumSha256: body.checksumSha256,
          ...(body.probe
            ? {
                probe: {
                  durationSeconds: body.probe.durationSeconds ?? null,
                  sampleRate: body.probe.sampleRate ?? null,
                  channels: body.probe.channels ?? null,
                  codec: body.probe.codec ?? null,
                },
              }
            : {}),
        },
        meetingsDeps(),
      ),
    );
  } catch (error) {
    return toResponse(error);
  }
}
