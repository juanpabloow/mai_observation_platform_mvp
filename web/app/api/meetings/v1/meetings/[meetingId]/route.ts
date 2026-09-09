import { resolveAppScope, toResponse } from '@/lib/meetingsApi';
import { getMeetingState } from '@worker/meetings/service.js';
import { MeetingsApiError } from '@worker/meetings/errors.js';

/**
 * GET /api/meetings/v1/meetings/{id}?clientId=… — el estado para la UI.
 *
 * `clientId` va en la query y no se deduce de la reunión: el ámbito lo aporta
 * el llamador y se verifica contra su sesión, así que un uuid de reunión de otro
 * cliente no devuelve nada aunque se acierte.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const clientId = new URL(request.url).searchParams.get('clientId');
    if (!clientId) throw new MeetingsApiError('invalid_request', "'clientId' es obligatorio.");
    const scope = await resolveAppScope(clientId);
    return Response.json(await getMeetingState(scope, meetingId));
  } catch (error) {
    return toResponse(error);
  }
}
