import {
  meetingsDeps,
  readJsonBody,
  requireInt,
  requireString,
  resolveAppScope,
  toResponse,
} from '@/lib/meetingsApi';
import { uploadInit } from '@worker/meetings/service.js';

/** POST … /upload-init — firma el PUT del medio original. */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readJsonBody(request);
    const scope = await resolveAppScope(requireString(body, 'clientId'));
    const result = await uploadInit(
      scope,
      meetingId,
      {
        filename: requireString(body, 'filename'),
        contentType: requireString(body, 'contentType'),
        bytes: requireInt(body, 'bytes'),
        checksumSha256: typeof body.checksumSha256 === 'string' ? body.checksumSha256 : undefined,
      },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
