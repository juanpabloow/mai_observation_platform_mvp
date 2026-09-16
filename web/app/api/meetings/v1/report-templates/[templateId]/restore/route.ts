import { readValidated, requireUuidParam, toResponse } from '@/lib/meetingsApi';
import { RestoreTemplateBody } from '@/lib/meetingsValidation';
import { restoreTemplate } from '@worker/meetings/analysis/reports/service.js';

/**
 * POST … /report-templates/{id}/restore — volver al predeterminado.
 *
 * Ruta propia y no un PATCH con el texto del predeterminado dentro, por dos
 * razones: el texto por omisión vive en el SERVIDOR y el navegador no tiene por
 * qué conocerlo ni poder proponerlo, y la auditoría distingue `restore` de
 * `edit`, que es información que se perdería si las dos acciones entraran por
 * el mismo sitio.
 *
 * Restaurar crea una versión NUEVA. No revierte el historial ni baja el
 * contador: dos versiones distintas no pueden compartir número.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  try {
    const { templateId } = await context.params;
    const body = await readValidated(request, RestoreTemplateBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    const template = await restoreTemplate(
      scope,
      requireUuidParam(templateId, 'templateId'),
      body.expectedVersion,
    );
    return Response.json({ template }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toResponse(error);
  }
}

async function appScope() {
  return import('@/lib/meetingsAppScope');
}
