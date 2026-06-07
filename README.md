# Observability Platform

A multi-tenant observability platform for [n8n](https://n8n.io/) automations.

The repo contains **two separate processes that share one Postgres database and
one data-access layer**:

1. **Ingestion worker** (`src/`) — a long-running process that polls each active
   client's n8n instance on an interval and ingests executions into Postgres.
   Runs via `npm run dev`.
2. **Web dashboard** (`web/`) — a Next.js (App Router) app that reads from the
   same database and renders it. Runs via `npm run web`.

Both import the **same** pg connection pool, repositories, and row types from
`src/db` — there is no duplicated data-access logic. In production they deploy
as two independent services from this one repo.

## Tech stack

- **Node.js 20+** with **TypeScript** (strict mode)
- **PostgreSQL 16** via the `pg` driver — plain SQL, no ORM
- **node-pg-migrate** for schema migrations
- **dotenv** / **zod** for env loading + validation, **pino** for logging
- **tsx** for running the worker in dev
- **Next.js 16** (App Router) + **Tailwind CSS** for the web dashboard

## Architecture: shared data layer

```
            ┌───────────────────────┐        ┌───────────────────────┐
            │  Ingestion worker      │        │  Web dashboard (web/)  │
            │  (src/, tsx process)   │        │  (Next.js process)     │
            └───────────┬───────────┘        └───────────┬───────────┘
                        │      both import the same       │
                        ▼      data-access layer ─────────▼
                        ┌───────────────────────────────────┐
                        │  src/db  (pg Pool, repositories,    │
                        │          row types)                 │
                        └──────────────────┬──────────────────┘
                                           ▼
                                   PostgreSQL (one DB)
```

The web app imports `src/db` directly (e.g. `@worker/db/repositories/stats.js`).
See [How the shared db code is wired](#how-the-shared-db-code-is-wired).

## Prerequisites

- Node.js 20 or newer
- Docker (for the local PostgreSQL instance)

## Setup

```bash
cp .env.example .env                 # then set a real ENCRYPTION_KEY
openssl rand -hex 32                 # generate ENCRYPTION_KEY (32-byte hex)
docker compose up -d                 # start Postgres 16 on localhost:5432
npm install                          # worker (root) dependencies
npm run migrate up                   # apply database migrations
npm run web:install                  # web app dependencies (installs into web/)
```

> `ENCRYPTION_KEY` must be a 32-byte hex string (64 hex chars). The placeholder
> in `.env.example` will fail at runtime — replace it.

## Running the two processes

They are independent — run each in **its own terminal**.

**Terminal 1 — ingestion worker:**

```bash
npm run dev
```

Polls every active client every `POLL_INTERVAL_SECONDS` and ingests new
executions. Structured JSON logs; `Ctrl+C` for graceful shutdown.

**Terminal 2 — web dashboard:**

```bash
npm run web
```

Serves the dashboard at <http://localhost:3000>, reading live counts from the
same database.

## Scripts

| Script                | Process | Description                                       |
| --------------------- | ------- | ------------------------------------------------- |
| `npm run dev`         | worker  | Run the ingestion worker (`tsx watch`)            |
| `npm run build`       | worker  | Type-check + compile the worker (`tsc` → `dist/`) |
| `npm run migrate`     | worker  | Run database migrations (`node-pg-migrate`)       |
| `npm run web`         | web     | Run the Next.js dev server (webpack)              |
| `npm run web:build`   | web     | Build the Next.js app (webpack)                   |
| `npm run web:install` | web     | Install the web app's dependencies                |

(`verify:db`, `verify:n8n`, `verify:ingest` are throwaway verification scripts.)

## Environment variables

A **single** `.env` at the repo root is the source of truth for both processes.
The worker loads it via `src/config.ts`; the web app loads the same file via
`web/next.config.ts`.

| Variable                | Required | Default         | Used by | Description                                        |
| ----------------------- | -------- | --------------- | ------- | -------------------------------------------------- |
| `DATABASE_URL`          | yes      | —               | both    | Postgres connection string                         |
| `DB_USER`               | no       | `postgres`      | compose | Postgres user (docker-compose)                     |
| `DB_PASSWORD`           | no       | `postgres`      | compose | Postgres password (docker-compose)                 |
| `DB_NAME`               | no       | `observability` | compose | Postgres database (docker-compose)                 |
| `ENCRYPTION_KEY`        | yes      | —               | worker  | 32-byte hex (64 chars) to encrypt client API keys  |
| `LOG_LEVEL`             | no       | `info`          | worker  | `trace`…`fatal`                                    |
| `POLL_INTERVAL_SECONDS` | no       | `30`            | worker  | Worker polling cadence                             |
| `TEST_N8N_BASE_URL`     | no       | —               | scripts | Only for `verify:n8n` / `verify:ingest`            |
| `TEST_N8N_API_KEY`      | no       | —               | scripts | Only for `verify:n8n` / `verify:ingest`            |

## How the shared db code is wired

The web app **imports the existing `src/db` repositories directly** rather than
duplicating the data layer or moving it. The worker's source under `src/` is
unchanged.

`web/next.config.ts` enables this with three settings:

- `experimental.externalDir: true` — allow importing from `../src` (outside `web/`).
- a `webpack` config with `resolve.extensionAlias` mapping `.js` → `.ts` — the
  worker uses NodeNext-style `.js` import specifiers that point at `.ts` sources.
  This requires the **webpack** bundler, so `web`'s `dev`/`build` scripts pass
  `--webpack` (Next 16 defaults to Turbopack).
- `serverExternalPackages: ["pg", "pino"]` — keep native/Node-only deps external.

`web/tsconfig.json` adds the path alias `@worker/* → ../src/*`.

**Why this over a refactor/monorepo:** keeping `src/db` as the single shared
location means the ingestion worker stays completely untouched and runnable
exactly as before, with zero duplication and one set of row types. The data
access stays in the repository layer (`src/db/repositories`), cleanly separated
from the Next.js UI. A workspaces split can come later without changing this
import boundary.

## Project structure

```
.
├── src/                     # Ingestion worker + shared data layer
│   ├── config.ts            # env validation (zod)
│   ├── logger.ts            # pino logger
│   ├── crypto.ts            # AES-256-GCM for client API keys
│   ├── db/                  # SHARED: pg Pool, repositories, row types
│   ├── n8n/                 # n8n REST client (worker only)
│   ├── ingestion/           # ingest + polling worker
│   └── index.ts             # worker entry point
├── web/                     # Next.js dashboard (separate process)
│   ├── app/                 # App Router (home page = live counts)
│   ├── next.config.ts       # loads root .env; wires ../src imports
│   └── package.json         # web's own dependencies
├── migrations/              # node-pg-migrate migrations
├── docker-compose.yml       # local Postgres 16
├── .env / .env.example      # single source of truth for both processes
└── package.json             # worker scripts + web:* convenience scripts
```
