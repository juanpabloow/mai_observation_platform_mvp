import { authenticateWorker, toResponse } from '@/lib/meetingsApi';
import { requeueExpiredLeases } from '@worker/meetings/service.js';

/**
 * POST /api/meetings/v1/maintenance/requeue-expired — barrido de leases muertos.
 *
 * Exige una credencial de worker válida, la que sea: no hay nada que enumerar
 * aquí y el efecto es idempotente. Lo que NO se hace es dejarlo abierto — un
 * endpoint que devuelve el recuento de jobs colgados de toda la instalación es
 * información operativa.
 *
 * Un worker que descubre que su propio lease caducó puede llamarlo para
 * devolver su trabajo a la cola sin esperar al cron.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await authenticateWorker(request);
    const result = await requeueExpiredLeases();
    return Response.json({ requeued: result.requeued, abandoned: result.abandoned });
  } catch (error) {
    return toResponse(error);
  }
}
