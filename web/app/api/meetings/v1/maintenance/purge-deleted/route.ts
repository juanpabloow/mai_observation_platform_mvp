import { authenticateWorker, readValidated, toResponse } from '@/lib/meetingsApi';
import { MaintenanceBody } from '@/lib/meetingsValidation';
import { runPurgeCycle } from '@worker/meetings/maintenance.js';
import { MeetingsApiError } from '@worker/meetings/errors.js';

/**
 * POST /api/meetings/v1/maintenance/purge-deleted — termina las eliminaciones.
 *
 * **El camino automático NO pasa por aquí.** Quien ejecuta el barrido de
 * verdad es `startMeetingsMaintenance()` dentro del proceso `worker`, que
 * llama a `runPurgeCycle()` en memoria: sin cookie, sin token y sin red. Esta
 * ruta es la puerta MANUAL —para operación y para el runbook— y ejecuta
 * exactamente la misma función, de modo que no puede divergir del automático.
 *
 * Existe el barrido porque entre reservar la eliminación y poder completarla
 * pasan minutos: hay que esperar a que venzan las URLs PUT que ya estaban
 * firmadas. En esos minutos caben un despliegue y un reinicio, así que la
 * espera NO puede ser un `setTimeout` ni una promesa colgando. Todo el estado
 * necesario está en columnas de `meetings`, y el barrido retoma lo que
 * encuentre sin saber nada de la petición que lo originó.
 *
 * Misma autenticación que `requeue-expired`: ámbito `internal` y capacidad
 * `meetings.maintenance`. No es una operación de tenant — recorre las
 * eliminaciones pendientes de todos los clientes.
 *
 * Se puede llamar tantas veces como se quiera. Cada reunión se toma con un
 * lease, así que dos barridos simultáneos no trabajan sobre la misma, y una
 * caída a mitad no la deja tomada para siempre.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await authenticateWorker(request);
    if (identity.scope !== 'internal' || !identity.capabilities.includes('meetings.maintenance')) {
      // El MISMO 404 que un recurso inexistente, y el mismo para las dos
      // carencias: distinguirlas le diría a quien prueba cuál le falta.
      throw new MeetingsApiError('not_found', 'No encontrado.');
    }
    await readValidated(request, MaintenanceBody);
    return Response.json(await runPurgeCycle());
  } catch (error) {
    return toResponse(error);
  }
}
