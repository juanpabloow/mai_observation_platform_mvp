import { readJsonBody, requireString, resolveAppScope, toResponse } from '@/lib/meetingsApi';
import { cancelMeeting } from '@worker/meetings/service.js';

/**
 * POST … /cancel — cancela la reunión y sus jobs.
 *
 * La cancelación es COOPERATIVA: los jobs en vuelo se marcan y el worker se
 * entera en su siguiente latido. mai no espera respuesta, porque una cancelación
 * que depende de que un proceso remoto conteste no es una cancelación.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readJsonBody(request);
    const scope = await resolveAppScope(requireString(body, 'clientId'));
    return Response.json(await cancelMeeting(scope, meetingId));
  } catch (error) {
    return toResponse(error);
  }
}
