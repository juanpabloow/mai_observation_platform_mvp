import { logger } from '../logger.js';
import { resolveMeetingsStorage } from '../storage/meetingsStorage.js';
import type { PrivateObjectStore } from '../storage/privateObjectStore.js';
import { purgeDeletedMeetings, PURGE_BATCH } from './deletion.js';

/**
 * El proceso periódico que TERMINA las eliminaciones.
 *
 * ── Por qué hace falta, y por qué vive aquí ────────────────────────────────
 *
 * `POST /maintenance/purge-deleted` existe, pero un endpoint que nadie llama
 * no es un mecanismo: hasta ahora `requeue-expired` sólo se invocaba a mano
 * con `curl` desde el runbook, y no había ningún scheduler en el repositorio.
 * Una reunión cuyo plazo vence dentro de quince minutos tiene que quedar
 * borrada aunque el usuario cierre el navegador, nadie vuelva a abrirla, el
 * servidor web se reinicie y nadie pulse «Reintentar».
 *
 * El sitio honesto es el servicio `worker` de Railway, que ya es un proceso
 * permanente (`railway.worker.json` → `node dist/index.js`) con su propio
 * bucle. Se engancha ahí y no en el servicio web por tres razones:
 *
 *   · El web escala a varias instancias y puede dormirse; el worker es uno y
 *     está siempre levantado.
 *   · En proceso NO hay credencial que viaje: se llama a la función, no al
 *     HTTP. Ni cookie de usuario, ni token de worker, ni red. La ruta HTTP se
 *     queda para operación manual, y ésa sí exige ámbito `internal` más la
 *     capacidad `meetings.maintenance`.
 *   · Un fallo aquí no puede degradar una petición de usuario, porque no hay
 *     ninguna esperando.
 *
 * ── Lo que este bucle NO garantiza por sí solo ─────────────────────────────
 *
 * Nada sobre corrección. La atomicidad, la idempotencia y el que dos pasadas
 * no se pisen viven en SQL (`claimMeetingsToPurge` con `FOR UPDATE SKIP
 * LOCKED` y un lease en columna). Esto es sólo el reloj. Si el reloj se para,
 * se reanuda; si corre dos veces, no pasa nada. Por eso la guarda de
 * reentrada de abajo es una cortesía —evita apilar pasadas en el mismo
 * proceso— y no la defensa.
 */

/** Cada cuánto se mira si hay eliminaciones que terminar. */
export const DEFAULT_PURGE_INTERVAL_SECONDS = 300; // 5 min

function intervalSeconds(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MEETINGS_PURGE_INTERVAL_SECONDS ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PURGE_INTERVAL_SECONDS;
}

function batchSize(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MEETINGS_PURGE_BATCH ?? '');
  return Number.isInteger(raw) && raw > 0 ? raw : PURGE_BATCH;
}

export interface PurgeCycleSummary {
  readonly ran: boolean;
  readonly processed: number;
  readonly purged: number;
  readonly failed: number;
  readonly tooEarly: number;
  readonly durationMs: number;
  /** Motivo por el que no se ejecutó. Sólo cuando `ran` es false. */
  readonly skipped?: 'storage_not_configured' | 'already_running';
}

let enCurso = false;

/**
 * UNA pasada. Exportada para poder probarla sin esperar al reloj, y para que
 * la ruta HTTP y el bucle compartan exactamente el mismo camino.
 *
 * Nunca lanza: es un temporizador, y una excepción sin capturar en un
 * `setInterval` tumba el proceso.
 */
export async function runPurgeCycle(
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Almacenamiento explícito. Sólo lo usan las pruebas, y sustituye la ÚNICA
   * frontera que tiene sentido sustituir: el bucket. Los lotes, el resumen, el
   * registro y el camino de fallo se ejercitan igual que en producción, que es
   * lo que hace que la prueba diga algo.
   */
  storeOverride?: PrivateObjectStore,
): Promise<PurgeCycleSummary> {
  const t0 = Date.now();
  const vacio = { processed: 0, purged: 0, failed: 0, tooEarly: 0 };

  if (enCurso) {
    // Cortesía, no corrección: el lease de la base ya impide el solapamiento
    // entre procesos. Esto sólo evita apilar pasadas dentro de éste.
    return { ran: false, ...vacio, durationMs: 0, skipped: 'already_running' };
  }
  enCurso = true;
  try {
    const store = storeOverride ?? resolveMeetingsStorage(env).store;
    if (!store) {
      const resolution = resolveMeetingsStorage(env);
      // Sin almacenamiento no se puede vaciar ningún prefijo, y borrar la fila
      // sin vaciarlo dejaría el audio huérfano. Se avisa y no se hace nada.
      logger.warn(
        { problems: resolution.problems },
        'meetings: barrido de eliminación omitido, almacenamiento no configurado',
      );
      return { ran: false, ...vacio, durationMs: Date.now() - t0, skipped: 'storage_not_configured' };
    }

    const { reports } = await purgeDeletedMeetings({ store }, batchSize(env));
    const resumen: PurgeCycleSummary = {
      ran: true,
      processed: reports.length,
      purged: reports.filter((r) => r.outcome === 'purged').length,
      failed: reports.filter((r) => r.outcome !== 'purged' && r.outcome !== 'too_early').length,
      tooEarly: reports.filter((r) => r.outcome === 'too_early').length,
      durationMs: Date.now() - t0,
    };

    // Ids, conteos, duración y códigos. Ninguna clave de R2, ninguna URL
    // firmada, ningún título, nada del contenido.
    for (const r of reports) {
      // Ids, conteos, duración y códigos. El re-listado se registra aparte de
      // los borrados porque `remaining` es la condición que autoriza el DELETE:
      // si no sale 0, la fila sigue ahí y hay que poder verlo sin abrir la base.
      logger.info(
        {
          meetingId: r.meetingId,
          outcome: r.outcome,
          found: r.objectsFound,
          deleted: r.objectsDeleted,
          remaining: r.objectsRemaining,
          batches: r.batches,
          ms: r.durationMs,
        },
        'meetings: eliminación procesada',
      );
    }
    if (resumen.processed > 0) {
      logger.info({ ...resumen }, 'meetings: pasada de eliminación');
    }
    return resumen;
  } catch (err) {
    logger.error({ err }, 'meetings: la pasada de eliminación falló entera');
    return { ran: true, ...vacio, durationMs: Date.now() - t0 };
  } finally {
    enCurso = false;
  }
}

let handle: NodeJS.Timeout | null = null;
let pasadaActual: Promise<unknown> | null = null;

/** Arranca el reloj. Idempotente: llamarlo dos veces no hace nada. */
export function startMeetingsMaintenance(env: NodeJS.ProcessEnv = process.env): void {
  if (handle) {
    logger.warn('meetings: el barrido de eliminación ya estaba en marcha');
    return;
  }
  const segundos = intervalSeconds(env);
  logger.info(
    { intervalSeconds: segundos, batch: batchSize(env) },
    'meetings: barrido de eliminación en marcha',
  );
  const tick = (): void => {
    pasadaActual = runPurgeCycle(env);
  };
  // No se ejecuta inmediatamente, al contrario que el bucle de ingesta: al
  // arrancar hay un despliegue en curso y no es momento de tocar el bucket.
  handle = setInterval(tick, segundos * 1000);
  // Que el temporizador no mantenga vivo el proceso por sí solo.
  handle.unref?.();
}

/** Para el reloj y espera a que termine la pasada en vuelo. */
export async function stopMeetingsMaintenance(): Promise<void> {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
  if (pasadaActual) {
    await pasadaActual;
    pasadaActual = null;
  }
}
