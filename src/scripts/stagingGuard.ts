/**
 * La puerta común de los scripts de W-3.
 *
 * ── Por qué una declaración explícita y no una heurística ───────────────────
 *
 * Estos tres scripts siembran datos, emiten una credencial y borran un tenant
 * entero. Adivinar «esto parece staging» a partir del nombre de la base o del
 * host es exactamente el tipo de comprobación que acierta noventa y nueve veces
 * y a la centésima borra producción. Así que no se adivina: quien ejecuta
 * **declara**, y sin la declaración el script no arranca.
 *
 * `NODE_ENV` no sirve para esto: staging corre con `NODE_ENV=production`, que es
 * el punto de que staging se parezca a producción. Hace falta una variable
 * propia que nadie tenga puesta por defecto.
 *
 * ── Y por qué la declaración NO basta ───────────────────────────────────────
 *
 * `MEETINGS_ENV_KIND=staging` dice qué CREE quien ejecuta, no a dónde apunta
 * `DATABASE_URL`. Las dos variables se ponen a mano, en la misma línea de
 * shell o en el mismo panel de Railway, y equivocar una es exactamente el
 * accidente que hay que impedir: `MEETINGS_ENV_KIND=staging` con la
 * `DATABASE_URL` de producción pegada del portapapeles es una sola tecla de
 * distancia.
 *
 * Así que hay una SEGUNDA afirmación, independiente: quien ejecuta declara el
 * host y el nombre de base que espera (`MEETINGS_EXPECTED_DB_HOST`,
 * `MEETINGS_EXPECTED_DB_NAME`) y el guardián los compara con `DATABASE_URL`
 * ANTES de conectar. Para que un script destructivo arranque contra producción
 * hay que equivocarse en tres variables de forma coherente, no en una.
 *
 * Y **después** de conectar se comprueba `current_database()` contra el nombre
 * esperado: una `DATABASE_URL` puede llevar el nombre en la query, resolverse
 * por un `search_path` raro o pasar por un pooler que redirige. Comparar la
 * cadena y comparar el servidor son dos comprobaciones distintas, y la que
 * vale de verdad es la segunda.
 *
 * Lo que NO se puede verificar tras conectar es el HOST: `inet_server_addr()`
 * es nulo por socket unix y con un pooler devuelve el del pooler. Se dice en
 * vez de fingir que se comprueba.
 *
 * ── Y por qué nada de esto imprime la conexión ──────────────────────────────
 *
 * `DATABASE_URL` lleva usuario y contraseña. Un script de operaciones se corre
 * con la salida redirigida a un fichero, se pega en un chat para pedir ayuda y
 * acaba en un backup. `describeDatabase()` devuelve lo único que hace falta para
 * responder «¿estoy apuntando a la base correcta?» —host y nombre— y nada más.
 */

/** El nombre de la variable que declara el entorno. */
export const ENV_KIND_VAR = 'MEETINGS_ENV_KIND';
/** El único valor que estos scripts aceptan. */
export const REQUIRED_ENV_KIND = 'staging';
/** El destino que quien ejecuta AFIRMA esperar. Se compara con DATABASE_URL. */
export const EXPECTED_HOST_VAR = 'MEETINGS_EXPECTED_DB_HOST';
export const EXPECTED_NAME_VAR = 'MEETINGS_EXPECTED_DB_NAME';

export class StagingGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingGuardError';
  }
}

export interface DatabaseDescription {
  readonly host: string;
  readonly database: string;
  /** `true` si apunta a un host local; útil para distinguir una prueba. */
  readonly local: boolean;
}

/**
 * Host y nombre de la base, **sin** usuario, contraseña ni query.
 *
 * Nunca devuelve la URL. Si no se puede parsear, devuelve marcadores en vez de
 * lanzar con el texto dentro: un mensaje de error que interpola una URL de
 * conexión es la misma fuga por otra puerta.
 */
export function describeDatabase(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseDescription {
  const raw = (env.DATABASE_URL ?? '').trim();
  if (raw === '') return { host: '(sin DATABASE_URL)', database: '(desconocida)', local: false };
  try {
    const url = new URL(raw);
    const host = url.host || '(sin host)';
    return {
      host,
      database: url.pathname.replace(/^\//, '') || '(sin nombre)',
      local: /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host),
    };
  } catch {
    return { host: '(ilegible)', database: '(ilegible)', local: false };
  }
}

/**
 * Exige la declaración de entorno **y** que el destino sea el esperado.
 *
 * Se llama ANTES de abrir la conexión: un script que se niega a operar no debe
 * haber tocado la base ni para leer. La mitad que sólo se puede comprobar con
 * la conexión abierta está en `assertConnectedDatabase`, y los tres scripts
 * llaman a las dos.
 */
export function requireStagingEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseDescription {
  const declared = (env[ENV_KIND_VAR] ?? '').trim().toLowerCase();
  if (declared === '') {
    throw new StagingGuardError(
      `Falta ${ENV_KIND_VAR}. Estos scripts siembran, emiten credenciales y borran, ` +
        `así que exigen que el entorno se declare: ${ENV_KIND_VAR}=${REQUIRED_ENV_KIND}. ` +
        `No se deduce del nombre de la base ni de NODE_ENV — staging corre con ` +
        `NODE_ENV=production, que es justo el punto.`,
    );
  }
  if (declared !== REQUIRED_ENV_KIND) {
    throw new StagingGuardError(
      `${ENV_KIND_VAR}='${declared}' no es '${REQUIRED_ENV_KIND}'. Estos scripts sólo ` +
        `operan en staging.`,
    );
  }
  if ((env.DATABASE_URL ?? '').trim() === '') {
    throw new StagingGuardError('Falta DATABASE_URL.');
  }

  // ── La segunda afirmación, independiente de la primera ──────────────────
  const expectedHost = (env[EXPECTED_HOST_VAR] ?? '').trim();
  const expectedName = (env[EXPECTED_NAME_VAR] ?? '').trim();
  const missing = [
    ...(expectedHost === '' ? [EXPECTED_HOST_VAR] : []),
    ...(expectedName === '' ? [EXPECTED_NAME_VAR] : []),
  ];
  if (missing.length > 0) {
    throw new StagingGuardError(
      `Faltan ${missing.join(' y ')}. Declarar '${REQUIRED_ENV_KIND}' dice qué CREES, ` +
        `no a dónde apunta DATABASE_URL: son dos variables que se ponen a mano en la ` +
        `misma línea, y equivocar una es el accidente que esto impide. Declara el ` +
        `destino que esperas y se compara con la conexión antes de tocarla.`,
    );
  }

  const actual = describeDatabase(env);
  // El host se compara sin el puerto: la URL puede llevarlo o no, y obligar a
  // declararlo idéntico convierte la protección en una molestia que alguien
  // acabará rodeando.
  const hostOf = (value: string): string => value.split(':')[0].toLowerCase();
  if (hostOf(actual.host) !== hostOf(expectedHost)) {
    throw new StagingGuardError(
      `El host de DATABASE_URL no es el declarado.\n` +
        `  ${EXPECTED_HOST_VAR}: ${expectedHost}\n` +
        `  DATABASE_URL apunta a: ${actual.host}\n` +
        `  No se ha conectado. Si el destino correcto es el segundo, corrige la ` +
        `declaración a propósito; no al revés.`,
    );
  }
  if (actual.database.toLowerCase() !== expectedName.toLowerCase()) {
    throw new StagingGuardError(
      `El nombre de base de DATABASE_URL no es el declarado.\n` +
        `  ${EXPECTED_NAME_VAR}: ${expectedName}\n` +
        `  DATABASE_URL apunta a: ${actual.database}\n` +
        `  No se ha conectado.`,
    );
  }
  return actual;
}

/**
 * La mitad que sólo se puede comprobar con la conexión ABIERTA.
 *
 * `current_database()` lo responde el servidor, no la cadena de conexión. Una
 * `DATABASE_URL` puede llevar el nombre en un parámetro de query, resolverse por
 * un `search_path` inesperado, o pasar por un pooler que redirige a otra base
 * — y en los tres casos la comparación de cadenas de `requireStagingEnvironment`
 * habría dado por buena una base que no es.
 *
 * Se llama con la conexión ya abierta y ANTES de la primera escritura. Es una
 * lectura, así que llamarla en un script de sólo lectura tampoco cambia nada.
 */
export async function assertConnectedDatabase(
  executor: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const expectedName = (env[EXPECTED_NAME_VAR] ?? '').trim();
  if (expectedName === '') {
    throw new StagingGuardError(`Falta ${EXPECTED_NAME_VAR}.`);
  }
  const result = await executor.query('SELECT current_database() AS name');
  const actual = String(result.rows[0]?.name ?? '');
  if (actual.toLowerCase() !== expectedName.toLowerCase()) {
    throw new StagingGuardError(
      `Conectado a una base que NO es la declarada.\n` +
        `  ${EXPECTED_NAME_VAR}: ${expectedName}\n` +
        `  current_database(): ${actual}\n` +
        `  La cadena de conexión decía otra cosa que el servidor: puede ser un pooler ` +
        `que redirige. No se ha escrito nada.`,
    );
  }
  return actual;
}

/**
 * Un valor que NO debe salir por ningún flujo. Se usa para el aserto de
 * seguridad de los propios scripts: si el texto a imprimir contiene la
 * contraseña o el token, no se imprime.
 */
export function assertNoSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const candidates = [
    env.DATABASE_URL,
    env.MEETINGS_STORAGE_SECRET_ACCESS_KEY,
    env.MEETINGS_STORAGE_ACCESS_KEY_ID,
    env.BETTER_AUTH_SECRET,
    env.ENCRYPTION_KEY,
  ];
  for (const secret of candidates) {
    const value = (secret ?? '').trim();
    // El umbral evita que un valor corto y genérico (por ejemplo un
    // ENCRYPTION_KEY de prueba puesto a '0') haga saltar el aserto sobre
    // cualquier texto que contenga un cero.
    if (value.length >= 12 && text.includes(value)) {
      throw new StagingGuardError(
        'Se ha intentado imprimir un texto que contiene un secreto del entorno. ' +
          'Es un bug del script, no del entorno.',
      );
    }
  }
}

/** Lector de argumentos `--clave valor` y `--bandera`, sin dependencias. */
export function parseArgs(argv: readonly string[]): {
  readonly flags: ReadonlySet<string>;
  readonly values: Readonly<Record<string, string>>;
  readonly unknown: readonly string[];
} {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      unknown.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values[name] = next;
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, values, unknown };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(value: string | undefined, name: string): string {
  if (value === undefined || !UUID_RE.test(value)) {
    throw new StagingGuardError(`${name} debe ser un uuid.`);
  }
  return value;
}
