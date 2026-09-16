import { readValidated, requireUuidParam, toResponse } from '@/lib/meetingsApi';
import { EditTemplateBody } from '@/lib/meetingsValidation';
import { editTemplate } from '@worker/meetings/analysis/reports/service.js';

/**
 * PATCH … /report-templates/{id} — guardar instrucciones nuevas.
 *
 * Es PATCH y no PUT porque sólo se reemplaza el texto editable: el nombre, la
 * descripción y el `slug` no los toca el usuario.
 *
 * ── Dos protecciones, las dos en el servidor ───────────────────────────────
 *
 *   1. PERMISO. Sólo `owner` y `admin`. El servicio lo exige; esconder el botón
 *      en la interfaz es cortesía con quien no puede, no una defensa contra
 *      quien llama a la ruta a mano.
 *   2. TESTIGO. `expectedVersion` es obligatorio y el UPDATE lo exige en su
 *      WHERE. Si alguien guardó antes, esto responde 409 en vez de pisar su
 *      versión — que es la diferencia entre «vuelve a mirarlo» y perder el
 *      trabajo de otro en silencio.
 *
 * Editar NO altera ningún reporte ya generado: cada uno guarda el snapshot
 * exacto de las instrucciones con las que se hizo y no vuelve a leer la
 * plantilla nunca.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ templateId: string }> },
): Promise<Response> {
  try {
    const { templateId } = await context.params;
    const body = await readValidated(request, EditTemplateBody);
    const scope = await (await appScope()).resolveAppScope(body.clientId);
    const template = await editTemplate(scope, {
      templateId: requireUuidParam(templateId, 'templateId'),
      instructions: body.instructions,
      expectedVersion: body.expectedVersion,
    });
    return Response.json({ template }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toResponse(error);
  }
}

async function appScope() {
  return import('@/lib/meetingsAppScope');
}
