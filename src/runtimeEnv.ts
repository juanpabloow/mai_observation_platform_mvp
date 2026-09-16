import dotenv from 'dotenv';
import { z } from 'zod';

// `.env` se carga igual que en `config.ts`, y por el mismo motivo: el desarrollo
// y las pruebas locales leen de ahí. `dotenv` no sobrescribe lo que ya está en
// el entorno, así que en Railway —donde las variables vienen del servicio— no
// cambia nada. `quiet` silencia el banner de arranque de dotenv 17.
dotenv.config({ quiet: true });

/**
 * Lo MÍNIMO que necesita la capa de datos y el registro para funcionar.
 *
 * ── Por qué existe este fichero ────────────────────────────────────────────
 *
 * `config.ts` valida la configuración de la APLICACIÓN entera —clave de
 * cifrado, Better Auth, n8n— y mata el proceso si falta algo. `db/client.ts` y
 * `logger.ts` lo importaban para leer un campo cada uno: la cadena de conexión
 * y el nivel de log. El efecto es que cualquier proceso que toque la base
 * heredaba la configuración completa del web, y el servicio de mantenimiento
 * —cuyo único trabajo es vaciar prefijos de R2— no arrancaba porque le faltaba
 * `ENCRYPTION_KEY`, una variable que no usa ni debe tener.
 *
 * Arreglarlo poniéndole esa clave al servicio habría sido darle un secreto que
 * no necesita para descifrar algo que nunca va a leer. Lo correcto es que la
 * capa de datos dependa de lo que usa y de nada más.
 *
 * ── Qué NO cambia ─────────────────────────────────────────────────────────
 *
 * `config.ts` sigue exigiendo todo lo que exigía. El web y el proceso de
 * ingesta lo importan desde sus propios entrypoints, así que sus garantías
 * quedan intactas: `ENCRYPTION_KEY` sigue siendo obligatoria donde de verdad
 * se usa (`crypto.ts`, la ingesta de n8n). Lo único que deja de arrastrarla es
 * abrir una conexión a PostgreSQL.
 */

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type RuntimeEnv = z.infer<typeof schema>;

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Mismo formato que `config.ts`: un mensaje accionable y parada. Un proceso
  // que sigue sin saber a qué base apunta no tiene forma segura de continuar.
  console.error('\n✖ Invalid runtime environment:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('');
  process.exit(1);
}

export const runtimeEnv: RuntimeEnv = Object.freeze(parsed.data);
