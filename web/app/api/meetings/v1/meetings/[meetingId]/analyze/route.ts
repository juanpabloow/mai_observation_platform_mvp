import { meetingsDeps, requireUuidParam, toResponse, validateQuery } from '@/lib/meetingsApi';
import { MeetingStateQuery } from '@/lib/meetingsValidation';
import { generateAnalysis, getAnalysis, previewCost } from '@worker/meetings/analysis/service.js';

/**
 * El resumen de una reunión: estimar su coste (GET) y generarlo (POST).
 *
 * ── Las tres comprobaciones, iguales que en las demás rutas de sesión ──────
 *
 *   1. TENANT y CLIENTE: `resolveAppScope(clientId)` — sesión, membresía,
 *      `canAccessClient`, cliente real y módulo `meetings` habilitado. Es el
 *      mismo resolutor, no una comprobación paralela.
 *   2. REUNIÓN: se lee acotada por `tenant_id` y `client_id`, así que el uuid de
 *      otra reunión no existe.
 *   3. TRANSCRIPCIÓN: el resumen se ata a la versión ACTIVA de esa reunión, que
 *      se resuelve desde la propia reunión y no la elige quien llama.
 *
 * `clientId` va en la query y no se deduce de la reunión: el ámbito lo aporta
 * quien llama y se verifica contra su sesión.
 *
 * ── Por qué GET estima y POST genera ──────────────────────────────────────
 *
 * Generar cuesta dinero. Un GET que gastara convertiría una recarga, un
 * prefetch del navegador o un rastreador en una factura. El GET es de sólo
 * lectura: devuelve el resumen si existe y, si no, lo que costaría hacerlo.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    const id = requireUuidParam(meetingId, 'meetingId');
    const [analysis, estimate] = await Promise.all([
      getAnalysis(scope, id),
      previewCost(scope, id).catch(() => null),
    ]);
    return Response.json(
      { analysis, estimate },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return toResponse(error);
  }
}

/**
 * Genera el resumen. Idempotente por VERSIÓN de transcripción: si ya hay uno para
 * la versión activa, se devuelve ese y NO se llama al proveedor. Es lo que hace
 * que un doble clic, una recarga o un reintento no cuesten dos veces.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    const result = await generateAnalysis(scope, requireUuidParam(meetingId, 'meetingId'), {
      // El consumo se registra; el contenido, nunca.
      onUsage: (u) =>
        console.info(
          '[meetings.analysis] modelo=%s in=%d out=%d usd=%s ms=%d intento=%d',
          u.model, u.inputTokens, u.outputTokens, u.costUsd.toFixed(6), u.durationMs, u.attempt,
        ),
    });
    return Response.json(
      {
        analysis: result.view,
        reused: result.reused,
        droppedRefs: result.droppedRefs,
        decided: result.decided,
        proposed: result.proposed,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return toResponse(error);
  }
}

async function appScope() {
  return import('@/lib/meetingsAppScope');
}
