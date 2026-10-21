import dotenv from 'dotenv';
import { StagingGuardError, requireStagingEnvironment } from './stagingGuard.js';

/**
 * La puerta de staging, EVALUADA ANTES QUE NADA. Va como primer `import` de los
 * scripts de W-3 que se ejecutan como proceso (seed, verify, cleanup,
 * rollback-check).
 *
 * ── Por qué existe este fichero ────────────────────────────────────────────
 *
 * Cada script ya llama a `requireStagingEnvironment()` en la primera línea de
 * `main()` («la puerta va PRIMERO, antes de leer argumentos y antes de
 * conectar»). Pero `main()` corre después de evaluar los imports, y el primero
 * de cada script es `../db/client.js`, que carga `runtimeEnv`: sin
 * `DATABASE_URL`, `runtimeEnv` termina el proceso con 1 («Invalid runtime
 * environment») antes de que la puerta se evalúe. El contrato del runbook y de
 * la prueba es otro: sin la declaración de entorno el script se niega con 2,
 * nombrando `MEETINGS_ENV_KIND`, y sin escribir nada en stdout.
 *
 * Los módulos ES se evalúan en el orden de sus `import`, así que importar este
 * primero hace que la puerta corra antes que la capa de datos.
 *
 * ── Qué NO cambia ─────────────────────────────────────────────────────────
 *
 * - La puerta es la misma función, con los mismos mensajes y el mismo 2.
 *   `main()` la vuelve a pedir igual que antes; aquí sólo se adelanta.
 * - El entorno que ve es el mismo: `.env` se carga igual que en
 *   `runtimeEnv` (`dotenv` no pisa lo que ya viene del proceso), como cuando la
 *   puerta corría después de importar la base.
 * - `runtimeEnv` sigue validando `DATABASE_URL` igual; sólo se evalúa después
 *   de la puerta, que ya exige esa variable.
 * - Sólo la puerta: los argumentos y las comprobaciones tras conectar siguen en
 *   cada `main()`.
 */
dotenv.config({ quiet: true });

try {
  requireStagingEnvironment();
} catch (error) {
  if (error instanceof StagingGuardError) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
