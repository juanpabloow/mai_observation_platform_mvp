import * as deletionRepo from '../db/repositories/meetings/deletion.js';
import { meetingPrefix } from './storageKeys.js';
import { MeetingsApiError } from './errors.js';
import { DELETE_BATCH_MAX, type PrivateObjectStore } from '../storage/privateObjectStore.js';

/**
 * «Eliminar reunión»: desaparecen el audio original, las transcripciones, los
 * análisis y todos los artefactos. El nombre dice `reunión` y no
 * `transcripción` porque lo que se destruye incluye la grabación.
 *
 * ── El orden, y por qué ────────────────────────────────────────────────────
 *
 *   1. Reservar (`deleting`). Desde aquí no se emite ninguna URL de escritura
 *      nueva ni se reclama ningún trabajo.
 *   2. Esperar a `deletion_not_before`: el instante tras el cual ninguna URL
 *      PUT ya firmada puede seguir viva.
 *   3. Vaciar el prefijo en R2, paginando y por lotes.
 *   4. Volver a listar. Vacío significa vacío: R2 es fuertemente consistente
 *      en escritura, borrado y listado, así que esa lista refleja el estado
 *      real en ese instante y no hay ninguna ventana que esperar.
 *   5. Borrar la fila. Las hijas se van en cascada.
 *
 * R2 antes que PostgreSQL, nunca al revés: la fila es lo único que dice qué
 * prefijo hay que vaciar. Un objeto huérfano con la fila ya borrada no lo
 * encuentra nadie nunca; una fila en `deleting` con los objetos ya fuera se
 * retoma sola.
 *
 * ── Lo que NO se registra ──────────────────────────────────────────────────
 *
 * Ni el título, ni las claves, ni URLs firmadas, ni cookies. Una clave de
 * objeto lleva dentro tenant, cliente y reunión; un mensaje de error del SDK
 * puede arrastrarla. Por eso lo que se guarda del fallo es un CÓDIGO.
 */

/** Cuántas reuniones limpia un barrido como mucho. */
export const PURGE_BATCH = 10;

export interface DeletionDeps {
  readonly store: PrivateObjectStore;
  /** Tope de páginas por reunión y barrido, para que un prefijo enorme no
   *  monopolice la tarea: lo que quede se retoma en el siguiente. */
  readonly maxPagesPerRun?: number;
}

export interface DeletionScope {
  readonly tenantId: string;
  readonly clientId: string;
  readonly userId: string | null;
  readonly userLabel: string | null;
  /** Sólo `owner` y `admin` eliminan definitivamente. */
  readonly role: 'owner' | 'admin' | 'member';
}

export interface RequestDeletionResult {
  readonly state: 'deleting';
  /** Antes de este instante la limpieza NO se completa. ISO-8601. */
  readonly notBefore: string;
  /** false = ya estaba en curso; la respuesta es la misma. */
  readonly reserved: boolean;
}

/**
 * Paso 1: reservar. Devuelve 202 tanto si la reserva es nueva como si ya
 * estaba en curso — esa es la idempotencia, y es real y no declarada: la
 * condición `deletion_state IN ('live','delete_failed')` del UPDATE hace que
 * sólo una de N llamadas simultáneas reserve.
 *
 * Una reunión que ya se terminó de eliminar devuelve 404, que es la respuesta
 * correcta a «borra esto» cuando esto ya no está.
 */
export async function requestMeetingDeletion(
  scope: DeletionScope,
  meetingId: string,
  deps: DeletionDeps,
): Promise<RequestDeletionResult> {
  if (scope.role === 'member') {
    // 403 y no 404: quien llega aquí ya tiene acceso al cliente y está mirando
    // la reunión. Ocultársela no protege nada y disfraza un permiso de un bug.
    throw new MeetingsApiError(
      'forbidden',
      'Eliminar una reunión definitivamente requiere permisos de administrador.',
    );
  }

  const r = await deletionRepo.reserveDeletion({
    meetingId,
    tenantId: scope.tenantId,
    clientId: scope.clientId,
    byUserId: scope.userId,
    byLabel: scope.userLabel ?? scope.userId ?? 'desconocido',
    fallbackPutTtlSeconds: deps.store.putTtlSeconds,
  });

  if (r.outcome === 'not_found') {
    throw new MeetingsApiError('not_found', 'No encontrado.');
  }
  return {
    state: 'deleting',
    notBefore: r.row.deletion_not_before!.toISOString(),
    reserved: r.outcome === 'reserved',
  };
}

export type PurgeOutcome =
  | 'purged'
  /** El plazo de las URLs PUT todavía no venció. No es un fallo. */
  | 'too_early'
  | 'storage_failed'
  | 'prefix_not_empty'
  | 'row_not_deleted';

export interface PurgeReport {
  readonly meetingId: string;
  /**
   * Objetos que el listado ENCONTRÓ bajo el prefijo, sumando todas las páginas.
   * Se registra aparte de los borrados porque «encontré 3 y borré 3» y
   * «encontré 0 y borré 0» describen situaciones distintas: la segunda puede
   * ser una reunión que nunca subió nada, o un prefijo mal derivado.
   */
  readonly objectsFound: number;
  readonly outcome: PurgeOutcome;
  readonly objectsDeleted: number;
  /**
   * Lo que quedaba en el RE-LISTADO posterior al borrado. Tiene que ser 0 para
   * que se toque PostgreSQL; cualquier otro valor deja la reunión en
   * `delete_failed` con la fila intacta. `null` = no se llegó a re-listar.
   */
  readonly objectsRemaining: number | null;
  readonly batches: number;
  readonly durationMs: number;
}

/**
 * Paso 2-5 para UNA reunión ya reservada. Idempotente y reentrante: si se cae
 * a mitad, el siguiente barrido encuentra la fila en `deleting` o
 * `delete_failed` y vuelve a empezar sobre lo que quede.
 */
export async function purgeMeeting(
  row: deletionRepo.DeletionRow,
  deps: DeletionDeps,
  now: () => Date = () => new Date(),
): Promise<PurgeReport> {
  const t0 = Date.now();
  const base = { meetingId: row.id, objectsFound: 0, objectsDeleted: 0, objectsRemaining: null, batches: 0 };
  let encontrados = 0;

  // El plazo se comprueba aquí ADEMÁS de en el WHERE del claim y en el del
  // DELETE. Tres sitios porque es la invariante que impide que una URL PUT
  // viva recree un objeto después de borrar la fila, y una invariante que se
  // comprueba en un solo sitio es una invariante que un refactor se lleva.
  if (row.deletion_not_before !== null && row.deletion_not_before.getTime() > now().getTime()) {
    return { ...base, outcome: 'too_early', durationMs: Date.now() - t0 };
  }

  const prefijo = `${meetingPrefix({
    tenantId: row.tenant_id,
    clientId: row.client_id,
    meetingId: row.id,
  })}/`;

  let borrados = 0;
  let lotes = 0;
  // `null` hasta que el re-listado ocurre: distinguir «quedaban 0» de «no se
  // llegó a comprobar» importa, porque lo segundo NO autoriza el DELETE.
  let restantes: number | null = null;
  const maxPaginas = deps.maxPagesPerRun ?? 1000;

  try {
    let cursor: string | undefined;
    for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
      const page = await deps.store.listPrefix(prefijo, cursor);
      encontrados += page.keys.length;
      if (page.keys.length > 0) {
        for (let i = 0; i < page.keys.length; i += DELETE_BATCH_MAX) {
          const lote = page.keys.slice(i, i + DELETE_BATCH_MAX);
          const res = await deps.store.deleteMany(lote);
          borrados += res.deleted;
          lotes += 1;
          if (res.failed.length > 0) {
            await deletionRepo.markDeleteFailed(row.id, 'objects_not_deleted');
            return { ...base, outcome: 'storage_failed', objectsFound: encontrados, objectsDeleted: borrados, batches: lotes, durationMs: Date.now() - t0 };
          }
        }
        // Tras borrar, se vuelve a listar DESDE EL PRINCIPIO en vez de seguir
        // el cursor: las claves que había ya no están, así que el cursor
        // apuntaría a un sitio que dejó de existir.
        cursor = undefined;
        continue;
      }
      cursor = page.cursor ?? undefined;
      if (!cursor) break;
    }

    // La verificación. No es una espera por consistencia —R2 no la necesita—
    // sino la comprobación de que el prefijo quedó vacío de verdad, incluidos
    // los objetos que ninguna fila mencionaba.
    const verificacion = await deps.store.listPrefix(prefijo);
    restantes = verificacion.keys.length;
    if (restantes > 0) {
      await deletionRepo.markDeleteFailed(row.id, 'prefix_not_empty');
      return { ...base, outcome: 'prefix_not_empty', objectsFound: encontrados, objectsDeleted: borrados, objectsRemaining: restantes, batches: lotes, durationMs: Date.now() - t0 };
    }
  } catch {
    // El mensaje del SDK puede llevar dentro una clave, y una clave lleva
    // tenant, cliente y reunión. Sólo el código.
    await deletionRepo.markDeleteFailed(row.id, 'storage_unavailable');
    return { ...base, outcome: 'storage_failed', objectsFound: encontrados, objectsDeleted: borrados, objectsRemaining: restantes, batches: lotes, durationMs: Date.now() - t0 };
  }

  /*
    LA ÚLTIMA PUERTA, EXPLÍCITA.

    El camino de arriba ya vuelve antes si el re-listado encontró algo, así que
    llegar aquí con `restantes !== 0` debería ser imposible. Se comprueba de
    todas formas porque es la única condición que separa «borrar la fila» de
    «dejar audio huérfano en R2 sin nada que lo mencione», y una invariante que
    depende de que ningún `return` futuro se cuele por encima no es una
    invariante. `null` también bloquea: significa que no se llegó a comprobar.
  */
  if (restantes !== 0) {
    await deletionRepo.markDeleteFailed(row.id, 'verification_missing');
    return { ...base, outcome: 'prefix_not_empty', objectsFound: encontrados, objectsDeleted: borrados, objectsRemaining: restantes, batches: lotes, durationMs: Date.now() - t0 };
  }

  const borrada = await deletionRepo.deleteMeetingRow(row.id);
  if (!borrada) {
    await deletionRepo.markDeleteFailed(row.id, 'row_not_deleted');
    return { ...base, outcome: 'row_not_deleted', objectsFound: encontrados, objectsDeleted: borrados, objectsRemaining: restantes, batches: lotes, durationMs: Date.now() - t0 };
  }
  return { meetingId: row.id, outcome: 'purged', objectsFound: encontrados, objectsDeleted: borrados, objectsRemaining: restantes, batches: lotes, durationMs: Date.now() - t0 };
}

/**
 * El barrido. Se puede llamar tantas veces como haga falta: toma las que ya
 * pasaron su plazo y nadie está limpiando, y termina lo que pueda.
 *
 * Que esto sea una tarea y no una continuación en memoria es lo que hace que
 * la operación sobreviva a un reinicio: el estado está en PostgreSQL y el
 * proceso que retoma no necesita haber visto la petición original.
 */
export async function purgeDeletedMeetings(
  deps: DeletionDeps,
  limit = PURGE_BATCH,
): Promise<{ readonly reports: readonly PurgeReport[] }> {
  const filas = await deletionRepo.claimMeetingsToPurge(limit);
  const reports: PurgeReport[] = [];
  for (const fila of filas) {
    try {
      reports.push(await purgeMeeting(fila, deps));
    } catch (causa) {
      // `purgeMeeting` ya captura los fallos del almacenamiento. Si algo se le
      // escapa —la base caída al marcar el fallo, por ejemplo— la pasada
      // SIGUE con las demás. Una reunión problemática no puede bloquear la
      // eliminación de las otras nueve.
      try {
        await deletionRepo.markDeleteFailed(fila.id, 'unexpected');
      } catch {
        // Si ni eso se puede escribir, el lease caduca solo y la siguiente
        // pasada la vuelve a tomar. No hay nada más que hacer aquí.
      }
      reports.push({
        meetingId: fila.id, outcome: 'storage_failed',
        objectsFound: 0, objectsDeleted: 0, objectsRemaining: null, batches: 0, durationMs: 0,
      });
      void causa;
    }
  }
  return { reports };
}

/**
 * La guarda que usan el resto de operaciones. Una reunión marcada para
 * eliminación no acepta escrituras nuevas de ningún tipo.
 */
export async function assertNotBeingDeleted(meetingId: string): Promise<void> {
  if (await deletionRepo.isBeingDeleted(meetingId)) {
    throw new MeetingsApiError(
      'invalid_transition',
      'Esta reunión está en proceso de eliminación.',
    );
  }
}

