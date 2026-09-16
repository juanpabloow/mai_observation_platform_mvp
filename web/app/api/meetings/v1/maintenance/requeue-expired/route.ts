import { authenticateWorker, readValidated, toResponse } from '@/lib/meetingsApi';
import { MaintenanceBody } from '@/lib/meetingsValidation';
import { requeueExpiredLeases } from '@worker/meetings/service.js';

/**
 * POST /api/meetings/v1/maintenance/requeue-expired — barrido de leases muertos.
 *
 * **Exige ámbito `internal` Y la capacidad `meetings.maintenance`.** Es una
 * operación de instalación, no de tenant: recorre los jobs colgados de todos
 * los clientes y devuelve recuentos globales. Una credencial de proceso atada a
 * un tenant no debe poder ejecutarla ni leer su resultado, y la comprobación
 * vive en el servicio para que cualquier llamador futuro —un cron, un script—
 * la herede en vez de tener que recordarla.
 *
 * Que la base impida además emitir esa capacidad en un pool `single_tenant`
 * (`pools_scope_allows_capabilities`) no hace redundante la comprobación del
 * servicio: el CHECK cubre las credenciales emitidas, el servicio cubre las
 * identidades que un llamador interno construya sin pasar por `worker_pools`.
 *
 * Una credencial a la que le falte cualquiera de las dos cosas recibe el MISMO
 * 404 que un recurso inexistente, y el mismo para las dos: saber que el
 * endpoint existe pero no le corresponde ya es información, y distinguir qué
 * pieza le falta le diría cuál conseguir.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    await readValidated(request, MaintenanceBody);
    const result = await requeueExpiredLeases(identity);
    return Response.json({ requeued: result.requeued, abandoned: result.abandoned });
  } catch (error) {
    return toResponse(error);
  }
}
