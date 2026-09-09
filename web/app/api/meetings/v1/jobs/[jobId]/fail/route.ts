import {
  authenticateWorker,
  meetingsDeps,
  readJsonBody,
  readLeaseProof,
  requireString,
  toResponse,
} from '@/lib/meetingsApi';
import { fail } from '@worker/meetings/service.js';

/** POST … /fail — declara el fallo de un intento. Idempotente. */
export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    const { jobId } = await context.params;
    const body = await readJsonBody(request);
    const result = await fail(
      identity,
      {
        ...readLeaseProof(body, jobId),
        failureCode: requireString(body, 'failureCode'),
        failureDetail: typeof body.failureDetail === 'string' ? body.failureDetail : null,
      },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
