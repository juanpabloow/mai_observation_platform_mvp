import dotenv from 'dotenv';
import { z } from 'zod';

// Load variables from .env into process.env before validation.
dotenv.config();

/**
 * Schema for all environment variables the application depends on.
 * Defaults mirror the local docker-compose setup described in the README.
 */
const envSchema = z.object({
  // Full PostgreSQL connection string used by the application.
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // PostgreSQL credentials (also consumed by docker-compose).
  DB_USER: z.string().min(1).default('postgres'),
  DB_PASSWORD: z.string().min(1).default('postgres'),
  DB_NAME: z.string().min(1).default('observability'),

  // 32-byte key (64 hex chars) used to encrypt client API keys later.
  ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with: openssl rand -hex 32',
    ),

  // Logging verbosity for pino.
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // Polling cadence for n8n instances (used in a later step).
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),

  // Optional — used ONLY by the throwaway verify:n8n script to hit a real
  // n8n instance. Left undefined in normal operation so the app still boots.
  TEST_N8N_BASE_URL: z.string().min(1).optional(),
  TEST_N8N_API_KEY: z.string().min(1).optional(),
});

/** Fully validated, typed shape of the application configuration. */
export type Config = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Surface a clear, actionable error and stop the process — there is no
  // safe way to run with invalid configuration.
  console.error('\n✖ Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.error(`  • ${path}: ${issue.message}`);
  }
  console.error('\nCheck your .env file against .env.example and try again.\n');
  process.exit(1);
}

/** Immutable, validated configuration object for use across the app. */
export const config: Config = Object.freeze(parsed.data);
