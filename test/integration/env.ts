/**
 * Integration-test env preload (run via `node --import`). Points the shared pool
 * at TEST_DATABASE_URL so integration tests never touch the dev/prod database.
 * dotenv does not override already-set vars, so setting DATABASE_URL here before
 * src/config.ts loads wins.
 */
import dotenv from 'dotenv';

dotenv.config();
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
