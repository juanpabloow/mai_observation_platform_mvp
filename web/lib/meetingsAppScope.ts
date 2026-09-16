import 'server-only';
import { MeetingsApiError } from '@worker/meetings/errors.js';
import { isClientModuleEnabled } from '@worker/db/repositories/clientModules.js';
import { getClientById } from '@worker/db/repositories/clients.js';
import { getAccessScope, canAccessClient, type Role } from './access';

/**
 * El ámbito de un llamador CON SESIÓN, con el entitlement del módulo.
 *
 * Módulo aparte de `meetingsApi.ts` a propósito: esto importa la pila de sesión
 * (better-auth, y con ella React), y los seis handlers de worker no tienen nada
 * que ver con ella. Tenerlo junto los hacía imposibles de cargar fuera del
 * runtime de Next.
 */

export interface AppScopeResolution {
  readonly tenantId: string;
  readonly clientId: string;
  readonly userId: string | null;
  readonly userLabel: string | null;
  /**
   * El rol de la sesión en este tenant. La mayoría de las operaciones no lo
   * miran —ver el cliente ya es autorización suficiente—, pero eliminar
   * definitivamente sí: destruir el audio original no tiene vuelta atrás.
   */
  readonly role: Role;
}

/**
 * Ámbito de un llamador con sesión (la UI), con el ENTITLEMENT del módulo.
 *
 * Cuatro condiciones, y las cuatro fallan igual — con el mismo 404:
 *
 *   1. `clientId` no es un uuid;
 *   2. la sesión no alcanza ese cliente;
 *   3. el cliente no existe, o es el cliente por defecto («Sin asignar», que
 *      por diseño no tiene módulos);
 *   4. el módulo `meetings` NO está habilitado para ese cliente.
 *
 * Que las cuatro sean indistinguibles es la convención que ya siguen el resto
 * de los módulos (`resolveClientModuleForScope`): un 404 que se convierte en
 * 403 al acertar el uuid le dice a quien prueba que el recurso existe, y un
 * `module_disabled` distinto de un `not_found` revela qué clientes de otro
 * tenant tienen Reuniones contratado.
 *
 * La comprobación va DESPUÉS del ámbito, no antes: consultar `client_modules`
 * de un cliente al que la sesión no llega sería una lectura que no le
 * corresponde.
 */
export async function resolveAppScope(clientId: string): Promise<AppScopeResolution> {
  const notFound = () => new MeetingsApiError('not_found', 'No encontrado.');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
    // Antes de tocar la sesión y antes de tocar PostgreSQL, como hace
    // `resolveClientModuleContext`.
    throw notFound();
  }
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) throw notFound();

  const client = await getClientById({ tenantId: scope.tenantId, clientId });
  // `is_default` se rechaza ANTES del módulo: una fila de client_modules para el
  // cliente por defecto sería residuo de un backfill y no una autorización.
  if (!client || client.is_default) throw notFound();
  if (!(await isClientModuleEnabled(scope.tenantId, clientId, 'meetings'))) throw notFound();

  return {
    tenantId: scope.tenantId,
    clientId,
    userId: scope.userId,
    // La etiqueta de atribución: el id del usuario, que es lo que AccessScope
    // trae. No el correo — no está en el scope y buscarlo sólo para un log
    // añadiría una consulta a cada operación.
    userLabel: scope.userId,
    role: scope.role,
  };
}
