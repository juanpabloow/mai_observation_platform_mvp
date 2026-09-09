import {
  authenticateWorker,
  meetingsDeps,
  readValidated,
  requireUuidParam,
  toResponse,
} from '@/lib/meetingsApi';
import { FailBody } from '@/lib/meetingsValidation';
import { fail } from '@worker/meetings/service.js';

/** POST … /fail — declara el fallo de un intento. Idempotente. */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const { jobId } = await context.params;
    const body = await readValidated(request, FailBody);
    return Response.json(
      await fail(
        identity,
        {
          jobId: requireUuidParam(jobId, 'jobId'),
          attempt: body.attempt,
          leaseToken: body.leaseToken,
          failureCode: body.failureCode,
          failureDetail: body.failureDetail ?? null,
        },
        meetingsDeps(),
      ),
    );
  } catch (error) {
    return toResponse(error);
  }
}
