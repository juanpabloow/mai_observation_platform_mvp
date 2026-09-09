import {
  authenticateWorker,
  meetingsDeps,
  readJsonBody,
  readLeaseProof,
  requireInt,
  requireString,
  toResponse,
} from '@/lib/meetingsApi';
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
    const body = await readJsonBody(request);
    const probe = (body.probe ?? null) as Record<string, unknown> | null;
    const result = await resultComplete(
      identity,
      {
        ...readLeaseProof(body, jobId),
        bytes: requireInt(body, 'bytes'),
        checksumSha256: requireString(body, 'checksumSha256'),
        ...(probe
          ? {
              probe: {
                durationSeconds: typeof probe.durationSeconds === 'number' ? probe.durationSeconds : null,
                sampleRate: typeof probe.sampleRate === 'number' ? probe.sampleRate : null,
                channels: typeof probe.channels === 'number' ? probe.channels : null,
                codec: typeof probe.codec === 'string' ? probe.codec : null,
              },
            }
          : {}),
      },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
