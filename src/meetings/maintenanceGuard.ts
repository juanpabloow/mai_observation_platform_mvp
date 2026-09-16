import { query } from '../db/client.js';

/**
 * LA GUARDA DE BASE del servicio de mantenimiento.
 *
 * Este proceso borra filas y objetos. La `DATABASE_URL` por defecto de un
 * proyecto de Railway apunta a la base `railway`, no a `mai_w3_staging`, y
 * pegar la referencia equivocada al crear el servicio es una sola tecla: ya
 * pasó una vez en este proyecto. Así que antes de ejecutar un solo ciclo, el
 * proceso pregunta al SERVIDOR a qué base está conectado y aborta si no es la
 * que se declaró.
 *
 * ── Por qué se le pregunta al servidor ─────────────────────────────────────
 *
 * `current_database()` lo responde PostgreSQL. Comparar la cadena de conexión
 * no sirve: puede llevar el nombre en un parámetro de query, resolverse por un
 * `search_path` raro o pasar por un pooler que redirige a otra base. La
 * comparación que vale es la del servidor.
 *
 * ── Y por qué es CONFIGURABLE y no «staging» a fuego ──────────────────────
 *
 * Acoplar el binario a un nombre de entorno significa que desplegarlo en
 * producción exige cambiar código. La expectativa se declara por variable;
 * quien crea el servicio dice a qué base cree que apunta, y el proceso lo
 * comprueba. Sin la variable no se aborta —eso dejaría el servicio sin
 * arrancar en cualquier entorno nuevo— pero se AVISA, y el nombre de la base
 * queda en el registro para que se pueda ver qué pasó.
 *
 * ── Lo que NO se registra ──────────────────────────────────────────────────
 *
 * Ni host, ni usuario, ni puerto, ni la URL. Sólo el nombre de la base, que sin
 * credenciales no da acceso a nada y es lo único que hace falta para responder
 * «¿estoy apuntando donde creo?».
 */

/** La base que quien despliega AFIRMA esperar. Sin ella se avisa y se sigue. */
export const EXPECTED_DB_VAR = 'MEETINGS_MAINTENANCE_EXPECTED_DB';

export class MaintenanceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceGuardError';
  }
}

export interface GuardResult {
  /** El nombre real, tal como lo dice el servidor. Se puede registrar. */
  readonly database: string;
  /** false = no se declaró expectativa; se avisó y se sigue. */
  readonly verified: boolean;
}

/**
 * Decide si la base conectada es aceptable. Pura, para poder probar los tres
 * casos sin una base delante.
 */
export function checkDatabaseName(
  actual: string,
  expected: string | undefined,
): GuardResult {
  const declarada = (expected ?? '').trim();
  if (declarada === '') return { database: actual, verified: false };
  if (actual.toLowerCase() !== declarada.toLowerCase()) {
    throw new MaintenanceGuardError(
      `El mantenimiento NO arranca: conectado a la base '${actual}', y ` +
        `${EXPECTED_DB_VAR} declara '${declarada}'. Este proceso borra filas y ` +
        `objetos, así que no opera sobre una base que no es la esperada. ` +
        `Revisa la referencia de DATABASE_URL del servicio.`,
    );
  }
  return { database: actual, verified: true };
}

/** Pregunta a PostgreSQL y aplica la comprobación. Lanza si no cuadra. */
export async function assertMaintenanceDatabase(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardResult> {
  const r = await query<{ db: string; recovery: boolean }>(
    'SELECT current_database() AS db, pg_is_in_recovery() AS recovery',
  );
  const fila = r.rows[0];
  if (!fila) throw new MaintenanceGuardError('No se pudo leer current_database().');
  if (fila.recovery !== false) {
    // Una réplica de lectura no puede borrar, y fallar al primer DELETE tras
    // haber vaciado el prefijo en R2 sería el peor orden posible.
    throw new MaintenanceGuardError(
      `El mantenimiento NO arranca: la base '${fila.db}' está en recuperación ` +
        `(réplica de lectura). No se puede completar una eliminación desde aquí.`,
    );
  }
  return checkDatabaseName(fila.db, env[EXPECTED_DB_VAR]);
}
