import { z } from 'zod';

/**
 * La configuración del SERVICIO DE MANTENIMIENTO, y sólo la suya.
 *
 * Seis obligatorias y dos opcionales. Nada de `ENCRYPTION_KEY`, nada de
 * Better Auth, nada de n8n, nada del servidor web: este proceso abre una
 * conexión a PostgreSQL, lista y borra objetos de un bucket, y no hace nada
 * más. Pedirle un secreto que no usa sería ampliar su superficie sin función.
 *
 * ── Por qué se valida al arrancar y no al primer ciclo ────────────────────
 *
 * `runPurgeCycle` ya se abstiene —y lo registra— si el almacenamiento no se
 * puede resolver, porque borrar la fila sin haber vaciado el prefijo es el
 * único fallo irreversible. Pero un servicio que arranca «bien» y se queda
 * cinco minutos en silencio para después avisar de que le falta el bucket es
 * un servicio que parece sano y no lo está. Con la validación aquí, una
 * variable ausente se ve en el primer segundo del despliegue.
 *
 * La abstención en el ciclo se CONSERVA: protege del caso en que la
 * configuración se rompa en caliente, que la validación de arranque no cubre.
 */

const schema = z.object({
  // La base. La referencia por defecto de un proyecto de Railway apunta a
  // `railway`, no a la de W-3; la guarda de `maintenanceGuard.ts` lo comprueba
  // contra el servidor, esto sólo exige que exista.
  DATABASE_URL: z.string().min(1, 'requerida: la cadena de conexión'),
  // La base que se AFIRMA esperar. Obligatoria en este servicio a propósito:
  // es un proceso que borra, y operar sin declarar el destino es el accidente
  // que la guarda existe para impedir.
  MEETINGS_MAINTENANCE_EXPECTED_DB: z.string().min(1, 'requerida: declara la base esperada'),
  // El bucket privado. Sin estas cuatro no hay prefijo que vaciar.
  MEETINGS_STORAGE_ENDPOINT: z.string().min(1, 'requerida'),
  MEETINGS_STORAGE_BUCKET: z.string().min(1, 'requerida'),
  MEETINGS_STORAGE_ACCESS_KEY_ID: z.string().min(1, 'requerida'),
  MEETINGS_STORAGE_SECRET_ACCESS_KEY: z.string().min(1, 'requerida'),

  // Opcionales con defecto. No hace falta declararlas en el servicio.
  MEETINGS_PURGE_INTERVAL_SECONDS: z.coerce.number().int().positive().optional(),
  MEETINGS_PURGE_BATCH: z.coerce.number().int().positive().optional(),
});

export type MaintenanceConfig = z.infer<typeof schema>;

/** Las obligatorias, para poder enumerarlas en un mensaje y en una prueba. */
export const REQUIRED_VARS = [
  'DATABASE_URL',
  'MEETINGS_MAINTENANCE_EXPECTED_DB',
  'MEETINGS_STORAGE_ENDPOINT',
  'MEETINGS_STORAGE_BUCKET',
  'MEETINGS_STORAGE_ACCESS_KEY_ID',
  'MEETINGS_STORAGE_SECRET_ACCESS_KEY',
] as const;

/** Las que este proceso NO debe necesitar. Se comprueba en una prueba. */
export const FOREIGN_VARS = [
  'ENCRYPTION_KEY',
  'OPENAI_API_KEY',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'RESEND_API_KEY',
  'TEST_N8N_BASE_URL',
  'TEST_N8N_API_KEY',
] as const;

export class MaintenanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConfigError';
  }
}

/**
 * Valida y devuelve la configuración. Lanza con los NOMBRES de lo que falta y
 * nunca con valores: un mensaje de error acaba en un log agregado.
 */
export function loadMaintenanceConfig(env: NodeJS.ProcessEnv = process.env): MaintenanceConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const faltan = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new MaintenanceConfigError(
      `El mantenimiento NO arranca: falta o es inválida la configuración de ` +
        `${[...new Set(faltan)].join(', ')}. Este servicio necesita exactamente ` +
        `${REQUIRED_VARS.join(', ')} y nada más.`,
    );
  }
  return parsed.data;
}
