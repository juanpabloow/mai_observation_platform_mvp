import {
  loadMaintenanceConfig,
  MaintenanceConfigError,
  type MaintenanceConfig,
} from './meetings/maintenanceConfig.js';

/*
  La configuración se valida ANTES de importar cualquier cosa que toque la base
  o el registro. Con `await import` dinámico, un entorno incompleto falla con el
  mensaje de este servicio en vez de con el de otro módulo.

  El `catch` va aquí y no en `main()`: esto corre en la carga del módulo, cuando
  el logger todavía no existe —importarlo antes volvería a arrastrar la
  configuración de la aplicación—, así que el mensaje sale por `console.error`.
  Es la única línea de este proceso que no pasa por pino, y es a propósito.
*/
function cargar(): MaintenanceConfig {
  try {
    return loadMaintenanceConfig();
  } catch (err) {
    console.error(err instanceof MaintenanceConfigError ? err.message : String(err));
    process.exit(1);
  }
}
const cfg = cargar();

const { closePool } = await import('./db/client.js');
const { logger } = await import('./logger.js');
const { assertMaintenanceDatabase, MaintenanceGuardError } = await import('./meetings/maintenanceGuard.js');
const { startMeetingsMaintenance, stopMeetingsMaintenance } = await import('./meetings/maintenance.js');

/**
 * ENTRYPOINT EXCLUSIVO del servicio de mantenimiento de Reuniones.
 *
 * Arranca UNA cosa: el reloj que termina las eliminaciones. Ni la ingesta de
 * n8n, ni un servidor HTTP, ni nada más.
 *
 * ── Por qué no reutiliza `dist/index.js` ──────────────────────────────────
 *
 * `src/index.ts` arranca el bucle de ingesta de n8n, que es el trabajo del
 * servicio `worker` de OTRO proyecto. Apuntar el servicio nuevo a ese binario
 * habría puesto a sondear n8n a un proceso cuyo único trabajo es vaciar
 * prefijos de R2 — y habría duplicado la ingesta si algún día los dos
 * coexisten. Un entrypoint por trabajo es lo que hace que «reiniciar el
 * mantenimiento» no signifique «reiniciar la ingesta».
 *
 * ── QUÉ MANTIENE VIVO ESTE PROCESO ────────────────────────────────────────
 *
 * El temporizador del barrido lleva `.unref()`, para no impedir que un proceso
 * que lo hospeda termine cuando quiera. En el bucle de ingesta eso da igual,
 * porque ahí hay otro temporizador con referencia que sostiene el bucle de
 * eventos. Aquí NO había ninguno: tras resolverse `main()` no quedaba nada
 * pendiente, Node salía con código 0 y Railway marcaba el despliegue como
 * `Completed` justo después de escribir «barrido de eliminación en marcha».
 * El servicio nunca llegaba al primer ciclo.
 *
 * Así que la vida del proceso la sostiene ESTE entrypoint, explícitamente, con
 * un temporizador con referencia que no hace nada más que existir. Se cancela
 * en el apagado, y por eso `process.exit()` no es lo que termina el proceso
 * tras un SIGTERM: es que ya no queda nada que lo retenga.
 *
 * Se resuelve aquí y no quitando el `.unref()` del planificador porque ése es
 * reutilizable: quien lo hospede decide si quiere que lo mantenga vivo, y un
 * servicio exclusivo no debe depender de esa decisión ajena.
 *
 * ── Sin puerto ────────────────────────────────────────────────────────────
 *
 * No escucha nada. Un servicio que sólo tiene un `setInterval` no necesita
 * abrir un socket, y abrirlo sólo para satisfacer un healthcheck sería
 * superficie sin función. La ruta HTTP de mantenimiento sigue existiendo en el
 * servicio web para operación manual, y ejecuta la misma función.
 *
 * ── Su configuración es SUYA ──────────────────────────────────────────────
 *
 * `loadMaintenanceConfig` exige seis variables y ninguna más. No pasa por
 * `config.ts`, que valida la configuración de la aplicación entera y mataba
 * este proceso por no tener `ENCRYPTION_KEY` — una clave que no usa y que no
 * debe tener. Se valida antes de importar la base y el registro, para que un
 * entorno incompleto falle con el mensaje de este servicio.
 *
 * ── La guarda va ANTES del primer ciclo ───────────────────────────────────
 *
 * Se le pregunta a PostgreSQL a qué base está conectado y se aborta si no es la
 * declarada. No después de arrancar el reloj: un ciclo contra la base
 * equivocada ya habría vaciado prefijos.
 */

async function main(): Promise<void> {
  logger.info(
    {
      // Sólo NOMBRES y números. Ninguna variable con valor sensible.
      intervalSeconds: cfg.MEETINGS_PURGE_INTERVAL_SECONDS ?? 'defecto',
      batch: cfg.MEETINGS_PURGE_BATCH ?? 'defecto',
    },
    'meetings: arrancando el servicio de mantenimiento',
  );

  const guard = await assertMaintenanceDatabase();
  // SÓLO el nombre de la base. Ni host, ni usuario, ni URL.
  logger.info(
    { database: guard.database, verified: guard.verified },
    guard.verified
      ? 'meetings: base verificada contra lo declarado'
      : 'meetings: base SIN verificar — declara MEETINGS_MAINTENANCE_EXPECTED_DB para comprobarla',
  );

  startMeetingsMaintenance();

  /*
    EL PESTILLO. Un temporizador CON referencia, que es lo que mantiene vivo el
    bucle de eventos. No hace nada: no registra, no consulta, no abre nada. Su
    única función es que Node no considere que ya no hay trabajo pendiente.

    Un minuto es un compromiso sin consecuencias: el temporizador no hace nada
    al disparar, así que el periodo sólo decide cada cuánto Node se despierta
    para nada. Más corto sería ruido; más largo, indistinguible.
  */
  const pestillo = setInterval(() => {}, 60_000);

  let cerrando = false;
  const apagar = async (signal: NodeJS.Signals): Promise<void> => {
    if (cerrando) return;
    cerrando = true;
    logger.info({ signal }, 'meetings: apagando el mantenimiento');
    // Se suelta el pestillo primero: a partir de aquí lo único que retiene el
    // proceso es el trabajo que queda por cerrar.
    clearInterval(pestillo);
    try {
      // Se espera la pasada en vuelo: cortarla a mitad podría dejar un prefijo
      // vaciado con la fila todavía puesta. Eso es recuperable —el siguiente
      // ciclo la retoma— pero esperar es gratis y más limpio.
      await stopMeetingsMaintenance();
      await closePool();
    } catch (err) {
      logger.error({ err }, 'meetings: error al apagar');
    } finally {
      logger.info('meetings: apagado completo');
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void apagar('SIGINT'));
  process.on('SIGTERM', () => void apagar('SIGTERM'));
}

main().catch((err) => {
  if (err instanceof MaintenanceGuardError) {
    // El mensaje de la guarda es la información útil y no lleva secretos: se
    // registra tal cual, sin el stack, que aquí no aporta nada.
    logger.error(err.message);
  } else {
    logger.error({ err }, 'meetings: el mantenimiento no pudo arrancar');
  }
  process.exit(1);
});
