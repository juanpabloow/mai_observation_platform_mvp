import {
  authenticateWorker,
  meetingsDeps,
  readJsonBody,
  readLeaseProof,
  requireInt,
  requireString,
  toResponse,
} from '@/lib/meetingsApi';
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
    const body = await readJsonBody(request);
    const result = await resultInit(
      identity,
      {
        ...readLeaseProof(body, jobId),
        bytes: requireInt(body, 'bytes'),
        checksumSha256: requireString(body, 'checksumSha256'),
        itemCount: typeof body.itemCount === 'number' ? body.itemCount : null,
        schemaVersion: typeof body.schemaVersion === 'number' ? body.schemaVersion : 1,
      },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
