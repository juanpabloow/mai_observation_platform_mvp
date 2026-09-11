import { closePool, query } from '../db/client.js';
import {
  StagingGuardError,
  assertConnectedDatabase,
  parseArgs,
  requireStagingEnvironment,
} from './stagingGuard.js';

/**
 * ¿Es seguro revertir las migraciones de Reuniones **por conteo**?
 *
 *   MEETINGS_ENV_KIND=staging MEETINGS_EXPECTED_DB_HOST=… \
 *   MEETINGS_EXPECTED_DB_NAME=… DATABASE_URL=… \
 *     npx tsx src/scripts/meetingsRollbackPreflight.ts
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 *
 * El runbook decía «`npx node-pg-migrate down N`». `down N` no significa
 * «revierte las de Reuniones»: significa **«revierte las N últimas, sean las
 * que sean»**. Si entre la aplicación y el rollback alguien añade una
 * migración —otro agente, otra rama, un backfill— `down N` revierte esa y N−1
 * de Reuniones, dejando una aplicada y el esquema en un estado que nadie
 * diseñó. Y lo haría sin quejarse.
 *
 * Así que antes del rollback se comprueba que la CABEZA de `pgmigrations` sea
 * exactamente las esperadas, **en orden**. Si no lo es, este script sale con
 * error y dice qué apareció.
 *
 * ── Esto ya ha servido una vez ─────────────────────────────────────────────
 *
 * `1784000000000_meetings-speaker-uncertain` se añadió después de escribir esta
 * lista, y el script la rechazó — que es exactamente su trabajo. La lección no es
 * «relajar la comprobación»: es que añadir una migración de Reuniones OBLIGA a
 * añadirla aquí, y si alguien no lo hace, el rollback se detiene en vez de
 * inventar. Cuando esta lista crezca, `EXPECTED_STACK.length` mueve el `down`
 * solo.
 *
 * Sólo lectura. No revierte nada: imprime el comando cuando —y sólo cuando— es
 * seguro ejecutarlo.
 */

/**
 * Todas, de la más ANTIGUA a la más reciente. Es el orden en que se aplicaron, así
 * que la cabeza de `pgmigrations` tiene que ser esta lista al revés.
 *
 * AÑADIR UNA MIGRACIÓN DE REUNIONES EXIGE AÑADIRLA AQUÍ. No es burocracia: el
 * `down` se calcula con la longitud de esta lista, y una lista corta revertiría de
 * menos dejando el esquema a medias.
 */
const EXPECTED_STACK = [
  '1783400000000_meetings-module',
  '1783500000000_meetings-core',
  '1783600000000_meetings-transcript',
  '1783700000000_meetings-worker-pools',
  '1783800000000_meetings-result-uploads',
  '1784000000000_meetings-speaker-uncertain',
  '1784100000000_meetings-analysis',
  '1784200000000_meetings-deletion',
] as const;

interface MigrationRow {
  readonly id: number;
  readonly name: string;
}

async function main(): Promise<number> {
  try {
    const database = requireStagingEnvironment();
    parseArgs(process.argv.slice(2));
    process.stdout.write(`base: ${database.database} @ ${database.host}\n\n`);
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  try {
    await assertConnectedDatabase({ query });

    // La cabeza: las N últimas por `id`, que es el orden de aplicación real y
    // no el alfabético del nombre.
    const head = await query<MigrationRow>(
      `SELECT id, name FROM pgmigrations ORDER BY id DESC LIMIT $1`,
      [EXPECTED_STACK.length],
    );
    const actual = head.rows.map((row) => row.name).reverse();
    const expected = [...EXPECTED_STACK];

    process.stdout.write(`── la cabeza de pgmigrations (${actual.length} filas) ──\n`);
    for (let index = 0; index < Math.max(actual.length, expected.length); index += 1) {
      const got = actual[index];
      const want = expected[index];
      const mark = got === want ? '✓' : '✗';
      process.stdout.write(
        `  ${mark} ${String(index + 1).padStart(2)}  esperada: ${want ?? '—'}\n` +
          `        aplicada: ${got ?? '(no hay)'}\n`,
      );
    }
    process.stdout.write('\n');

    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
      // El caso concreto que motiva el script: identificar las intrusas.
      const intruders = actual.filter((name) => !expected.includes(name as never));
      const missing = expected.filter((name) => !actual.includes(name));
      process.stderr.write(
        `✗ La cabeza de pgmigrations NO son las ${EXPECTED_STACK.length} de Reuniones en orden.\n` +
          (intruders.length > 0
            ? `  Apareció encima: ${intruders.join(', ')}\n`
            : '') +
          (missing.length > 0 ? `  No están en la cabeza: ${missing.join(', ')}\n` : '') +
          `\n  NO ejecutes 'node-pg-migrate down ${EXPECTED_STACK.length}': revertiría la migración ajena y\n` +
          `  dejaría parte del esquema de Reuniones aplicado.\n` +
          `  Revierte por nombre, de arriba abajo, comprobando cada paso.\n`,
      );
      return 1;
    }

    const total = await query<{ n: string }>(`SELECT count(*)::text AS n FROM pgmigrations`);
    process.stdout.write(
      `✓ Las ${EXPECTED_STACK.length} de Reuniones son la cabeza, en orden.\n` +
        `  ${total.rows[0].n} migraciones aplicadas en total.\n\n` +
        `  Es seguro revertir por conteo:\n\n` +
        `    npx node-pg-migrate --tsx down ${EXPECTED_STACK.length}\n\n` +
        `  Las cuatro guardas del down abortan si quedan filas: limpia PRIMERO\n` +
        `  (§8.2 del runbook) o el revert se detendrá a medias.\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof StagingGuardError) {
      process.stderr.write(`✗ ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`✗ fallo al comprobar: ${(error as Error).message}\n`);
    return 1;
  } finally {
    await closePool();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`✗ ${(error as Error).message}\n`);
    process.exit(1);
  },
);
