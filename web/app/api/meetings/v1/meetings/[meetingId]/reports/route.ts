import { readValidated, requireUuidParam, toResponse, validateQuery } from '@/lib/meetingsApi';
import { GenerateReportBody, MeetingStateQuery } from '@/lib/meetingsValidation';
import { generateReport, listReports, previewReportCost } from '@worker/meetings/analysis/reports/service.js';

/**
 * Los reportes de una reunión: consultarlos (GET) y generar uno (POST).
 *
 * ── Por qué GET lista y POST genera ───────────────────────────────────────
 *
 * Generar cuesta dinero. Un GET que gastara convertiría una recarga, un
 * prefetch del navegador o un rastreador en una factura. El GET es de sólo
 * lectura: devuelve el historial y no llama a nadie.
 *
 * ── Las tres comprobaciones, iguales que en el resto del módulo ───────────
 *
 *   1. TENANT y CLIENTE: `resolveAppScope(clientId)` — sesión, membresía,
 *      `canAccessClient`, cliente real y módulo `meetings` habilitado.
 *   2. REUNIÓN: se lee acotada por `tenant_id` y `client_id`, así que el uuid
 *      de otra reunión no existe.
 *   3. TRANSCRIPCIÓN: el reporte se ata a la versión ACTIVA de esa reunión,
 *      resuelta desde la propia reunión y no elegida por quien llama.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    const reports = await listReports(scope, requireUuidParam(meetingId, 'meetingId'));
    return Response.json({ reports }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toResponse(error);
  }
}

/**
 * Genera un reporte. Idempotente por ENTRADAS: si ya existe uno con esta
 * transcripción, esta plantilla, esta versión y estas instrucciones, se
 * devuelve ése y NO se llama al proveedor. Es lo que hace que un doble clic o
 * una recarga no cuesten dos veces.
 *
 * El cuerpo lleva `clientId` y `templateId`. NO lleva instrucciones: el texto
 * es el de la plantilla guardada, leído en el servidor. Si el navegador pudiera
 * proponerlo, el snapshot dejaría de ser auditable.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ meetingId: string }> },
): Promise<Response> {
  try {
    const { meetingId } = await context.params;
    const body = await readValidated(request, GenerateReportBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    const id = requireUuidParam(meetingId, 'meetingId');

    // EL TECHO DE COSTE, ANTES DE LLAMAR. Sólo números e identificadores: ni la
    // transcripción, ni las instrucciones, ni la clave.
    const estimate = await previewReportCost(scope, id, body.templateId).catch(() => null);
    if (estimate) {
      console.info(
        '[meetings.report] plantilla=%s modelo=%s in≈%d out≤%d usd_max≈%s segmentos=%d cortada=%s responsables=%d ya=%s',
        body.templateId, estimate.model, estimate.inputTokens, estimate.maxOutputTokens,
        estimate.maxUsd === null ? 'n/d' : estimate.maxUsd.toFixed(6),
        estimate.segments, estimate.truncated, estimate.allowedOwners, estimate.alreadyGenerated,
      );
    }

    const result = await generateReport(scope, id, body.templateId, {
      onUsage: (u) =>
        // Identificadores y números. Ni prompt, ni transcripción, ni respuesta.
        console.info(
          '[meetings.report] pedido=%s devuelto=%s in=%d out=%d usd=%s ms=%d intento=%d',
          u.model, u.modelReturned ?? '—', u.inputTokens, u.outputTokens,
          u.costUsd === null ? 'n/d' : u.costUsd.toFixed(6), u.durationMs, u.attempt,
        ),
    });

    console.info(
      '[meetings.report] resultado estado=%s reusado=%s elementos=%d citas_descartadas=%d responsables_rechazados=%d fechas_rechazadas=%d',
      result.state, result.reused, result.items, result.droppedRefs,
      result.rejectedOwners, result.rejectedDues,
    );

    return Response.json(
      {
        // `generating` = otra petición tiene la reserva. No se ha llamado al
        // proveedor por segunda vez.
        state: result.state,
        report: result.view,
        reused: result.reused,
        droppedRefs: result.droppedRefs,
        rejectedOwners: result.rejectedOwners,
        rejectedDues: result.rejectedDues,
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
