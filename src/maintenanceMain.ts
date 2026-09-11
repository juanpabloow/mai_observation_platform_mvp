import { closePool } from './db/client.js';
import { logger } from './logger.js';
import { assertMaintenanceDatabase, MaintenanceGuardError } from './meetings/maintenanceGuard.js';
import { startMeetingsMaintenance, stopMeetingsMaintenance } from './meetings/maintenance.js';

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
 * ── Sin puerto ────────────────────────────────────────────────────────────
 *
 * No escucha nada. Un servicio que sólo tiene un `setInterval` no necesita
 * abrir un socket, y abrirlo sólo para satisfacer un healthcheck sería
 * superficie sin función. La ruta HTTP de mantenimiento sigue existiendo en el
 * servicio web para operación manual, y ejecuta la misma función.
 *
 * ── La guarda va ANTES del primer ciclo ───────────────────────────────────
 *
 * Se le pregunta a PostgreSQL a qué base está conectado y se aborta si no es la
 * declarada. No después de arrancar el reloj: un ciclo contra la base
 * equivocada ya habría vaciado prefijos.
 */

async function main(): Promise<void> {
  logger.info('meetings: arrancando el servicio de mantenimiento');

  const guard = await assertMaintenanceDatabase();
  // SÓLO el nombre de la base. Ni host, ni usuario, ni URL.
  logger.info(
    { database: guard.database, verified: guard.verified },
    guard.verified
      ? 'meetings: base verificada contra lo declarado'
      : 'meetings: base SIN verificar — declara MEETINGS_MAINTENANCE_EXPECTED_DB para comprobarla',
  );

  startMeetingsMaintenance();

  let cerrando = false;
  const apagar = async (signal: NodeJS.Signals): Promise<void> => {
    if (cerrando) return;
    cerrando = true;
    logger.info({ signal }, 'meetings: apagando el mantenimiento');
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
