import { toResponse, validateQuery } from '@/lib/meetingsApi';
import { MeetingStateQuery } from '@/lib/meetingsValidation';
import { listTemplates } from '@worker/meetings/analysis/reports/service.js';

/**
 * GET … /report-templates?clientId= — el catálogo de plantillas del cliente.
 *
 * Materializa las predeterminadas que falten, así que la primera visita de un
 * cliente nuevo ya ve las cuatro. Es idempotente: el UNIQUE por
 * `(tenant, cliente, slug)` hace inofensivas dos pestañas abiertas a la vez.
 *
 * ── Qué sale por aquí y qué NO ─────────────────────────────────────────────
 *
 * Sale lo EDITABLE: nombre, descripción, instrucciones, versión y si está
 * modificada respecto a su predeterminado. No sale —ni por esta ruta ni por
 * ninguna— el system prompt, el esquema JSON, las reglas antiinvención, la
 * lista cerrada de responsables ni nada del coste. Eso no es configuración: es
 * la parte que hace verificable el resultado, y vive sólo en el servidor.
 *
 * Cualquier miembro con acceso al cliente puede LEER el catálogo y generar. El
 * rol sólo se exige para editar y restaurar, y eso ocurre en las otras rutas.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const { clientId } = validateQuery(request, MeetingStateQuery);
    const scope = await (await appScope()).resolveAppScope(clientId);
    const templates = await listTemplates(scope);
    return Response.json(
      { templates },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return toResponse(error);
  }
}

async function appScope() {
  return import('@/lib/meetingsAppScope');
}
