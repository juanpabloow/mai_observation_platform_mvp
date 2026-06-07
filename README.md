# Observability Platform

A multi-tenant observability platform for [n8n](https://n8n.io/) automations.

This repository is the **foundation / scaffolding** for the platform. It does
not yet contain ingestion logic, database tables, or n8n API calls — those land
in later phases. What exists today:

- Typed, validated configuration loaded from the environment (`src/config.ts`)
- A structured logger (`src/logger.ts`)
- A worker entry point that boots, logs its configuration (secrets redacted),
  and stays alive (`src/index.ts`)
- Placeholder modules: `src/db/`, `src/n8n/`, `src/ingestion/`

## Tech stack

- **Node.js 20+** with **TypeScript** (strict mode)
- **PostgreSQL 16** accessed via the `pg` driver — plain SQL, no ORM
- **node-pg-migrate** for schema migrations
- **dotenv** for environment loading
- **zod** for configuration validation
- **pino** for structured logging
- **tsx** for running TypeScript in development

## Prerequisites

- Node.js 20 or newer
- Docker (for the local PostgreSQL instance)

## Running locally

1. **Create your environment file**

   ```bash
   cp .env.example .env
   ```

   Then generate a real `ENCRYPTION_KEY` (a 32-byte value as a 64-character hex
   string) and paste it into `.env`:

   ```bash
   openssl rand -hex 32
   ```

   > `ENCRYPTION_KEY` will be used in a later phase to encrypt client API keys.
   > It **must** be a 32-byte hex string (64 hex characters). The value shipped
   > in `.env.example` is a placeholder and will fail at runtime if used as-is —
   > replace it.

2. **Start PostgreSQL**

   ```bash
   docker compose up -d
   ```

   This starts a single Postgres 16 container on `localhost:5432` using the
   `DB_USER` / `DB_PASSWORD` / `DB_NAME` values from your `.env`
   (defaults: `postgres` / `postgres` / `observability`).

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Run the worker in development (watch mode)**

   ```bash
   npm run dev
   ```

   You should see structured JSON logs for `starting worker` and
   `loaded configuration` (with secrets redacted), after which the process
   stays running. Press `Ctrl+C` to stop.

## Scripts

| Script            | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `npm run dev`     | Run the worker with `tsx` in watch mode                |
| `npm run build`   | Type-check and compile TypeScript to `dist/` via `tsc` |
| `npm run migrate` | Run database migrations with `node-pg-migrate`         |

## Environment variables

| Variable                | Required | Default          | Description                                                       |
| ----------------------- | -------- | ---------------- | ----------------------------------------------------------------- |
| `DATABASE_URL`          | yes      | —                | Full PostgreSQL connection string used by the app                 |
| `DB_USER`               | no       | `postgres`       | Postgres user (used by docker-compose)                            |
| `DB_PASSWORD`           | no       | `postgres`       | Postgres password (used by docker-compose)                        |
| `DB_NAME`               | no       | `observability`  | Postgres database name (used by docker-compose)                   |
| `ENCRYPTION_KEY`        | yes      | —                | 32-byte hex string (64 chars) for encrypting client API keys      |
| `LOG_LEVEL`             | no       | `info`           | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`      |
| `POLL_INTERVAL_SECONDS` | no       | `30`             | How often to poll n8n instances (used in a later phase)           |

Configuration is validated on startup. If any variable is missing or invalid,
the process prints a clear error and exits.

## Project structure

```
.
├── src/
│   ├── config.ts      # loads + validates env vars (zod), exports typed config
│   ├── logger.ts      # configured pino logger instance
│   ├── db/            # database access (placeholder)
│   ├── n8n/           # n8n API client (placeholder)
│   ├── ingestion/     # ingestion logic (placeholder)
│   └── index.ts       # worker entry point
├── .env.example       # environment template (no real secrets)
├── docker-compose.yml # local Postgres 16
├── package.json
├── tsconfig.json
└── README.md
```
