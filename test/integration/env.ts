/**
 * Integration-test env preload (run via `node --import`). Points the shared pool
 * at TEST_DATABASE_URL so integration tests never touch the dev/prod database.
 * dotenv does not override already-set vars, so setting DATABASE_URL here before
 * src/config.ts loads wins.
 *
 * MF-1 item 3: this FAILS LOUDLY when TEST_DATABASE_URL is missing or not a local
 * database, instead of silently falling through to the dev/prod DATABASE_URL. A
 * silent fall-through is exactly how a suite "passes" without ever running against
 * the test database — the class of silent pass this preload exists to prevent.
 */
import dotenv from 'dotenv';

dotenv.config();

const raw = process.env.TEST_DATABASE_URL;
if (!raw) {
  throw new Error(
    'TEST_DATABASE_URL is required to run the integration suite (set it to the local ' +
      'observability_test database). Refusing to run against DATABASE_URL to avoid a silent ' +
      'pass against the wrong database.',
  );
}
let host: string;
try {
  host = new URL(raw).hostname;
} catch {
  throw new Error(`TEST_DATABASE_URL is not a valid URL: ${JSON.stringify(raw)}`);
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
  throw new Error(`TEST_DATABASE_URL must point at a LOCAL database (got host ${JSON.stringify(host)}).`);
}
process.env.DATABASE_URL = raw;
