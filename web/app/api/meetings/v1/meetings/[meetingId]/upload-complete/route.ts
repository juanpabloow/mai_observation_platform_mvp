import {
  meetingsDeps,
  readJsonBody,
  requireInt,
  requireString,
  resolveAppScope,
  toResponse,
} from '@/lib/meetingsApi';
import { uploadComplete } from '@worker/meetings/service.js';

/** POST … /upload-complete — confirma el objeto y arranca el pipeline. */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readJsonBody(request);
    const scope = await resolveAppScope(requireString(body, 'clientId'));
    const result = await uploadComplete(
      scope,
      meetingId,
      { bytes: requireInt(body, 'bytes'), checksumSha256: requireString(body, 'checksumSha256') },
      meetingsDeps(),
    );
    return Response.json(result);
  } catch (error) {
    return toResponse(error);
  }
}
