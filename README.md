# MAI — Observation Platform

A **multi-tenant platform** for [n8n](https://n8n.io/) automations that grew past
observability: it is also the **operational system of record** for appointment-based
service businesses — the agenda, the contacts, and the inbox where a human takes over
a conversation a bot was handling.

> **New here?** Read **[docs/overview.md](docs/overview.md)** first — what the product
> does and why, in one pass. For the data model, **[docs/schema.md](docs/schema.md)**
> (40 tables, ER diagrams, constraints, known debt). This file is setup and operation.

## What it does

| Capability | In one line |
|---|---|
| **n8n observability** | Polls each connected n8n instance and ingests executions. Meaning comes from user-defined `field_mappings`, never hardcoded — connecting a new workflow needs no code and no migration. |
| **Inbox + human handoff** | Conversations are stateful (`bot → pending → human`). A human can take over the thread; the bot goes quiet. Every mode change is audited. |
| **CRM** | The person is a first-class entity, distinct from a conversation. A multi-identity spine makes a WhatsApp `wa_id` and a typed phone resolve to the **same** contact. Notes, tasks, tags, timeline, per-business custom fields. |
| **Scheduling** | Sites, staff, services, appointments, computed availability. **Double-booking is impossible at the database level** — a Postgres GiST exclusion constraint, not an application check. |
| **Machine API** | Bearer-token API for n8n with explicit, deny-by-default capabilities, plus a public booking page at `/book/{site_slug}`. |

Tenancy is **two levels**: `tenant_id` is the account, `client_id` is a business
within it. Almost every domain table carries both, and belonging is enforced by
**composite foreign keys** — a row cannot point at another tenant's business even if
the application layer is wrong. Each business enables only the modules it uses
(`crm` / `scheduling` / `inbox`).

## Architecture: two processes, one shared data layer

The repo contains **two separate processes that share one Postgres database and one
data-access layer**:

1. **Ingestion worker** (`src/`) — long-running; polls each active n8n connection on
   an interval and ingests executions. Runs via `npm run dev`.
2. **Web app** (`web/`) — Next.js (App Router). Serves every internal surface, the
   public booking page, and all APIs. Runs via `npm run web`.

```
            ┌───────────────────────┐        ┌───────────────────────┐
            │  Ingestion worker     │        │  Web app (web/)       │
            │  (src/, tsx process)  │        │  (Next.js process)    │
            └───────────┬───────────┘        └───────────┬───────────┘
                        │      both import the same      │
                        ▼      data-access layer ────────▼
                        ┌───────────────────────────────────┐
                        │  src/db  (pg Pool, repositories,  │
                        │          row types)               │
                        └──────────────────┬────────────────┘
                                           ▼
                                   PostgreSQL (one DB)
```

There is **no duplicated data-access logic**: the web app imports `src/db` directly
(e.g. `@worker/db/repositories/stats.js`), so there is one set of row types and one
definition of each query. In production they deploy as two independent services from
this one repo. See [How the shared db code is wired](#how-the-shared-db-code-is-wired).

## Tech stack

- **Node.js 20+** with **TypeScript** (strict mode)
- **PostgreSQL 16** via the `pg` driver — plain SQL, no ORM
- **node-pg-migrate** for schema migrations
- **dotenv** / **zod** for env loading + validation, **pino** for logging
- **tsx** for running the worker and the scripts
- **Next.js 16** (App Router) + **Tailwind CSS** for the web app
- **Better Auth** for sessions (email+password, optional Google OAuth)

Required Postgres extensions (created by migrations): **`btree_gist`** (the
appointment overlap constraint) and **`pg_trgm`** (contact substring search).

## Prerequisites

- Node.js 20 or newer
- Docker (for the local PostgreSQL instance)

## Setup

```bash
cp .env.example .env                 # then fill in the required values below
openssl rand -hex 32                 # generate ENCRYPTION_KEY (32-byte hex)
openssl rand -base64 32              # generate BETTER_AUTH_SECRET
docker compose up -d                 # start Postgres 16 on localhost:5432
npm install                          # worker (root) dependencies
npm run migrate up                   # apply database migrations
npm run web:install                  # web app dependencies (installs into web/)
```

> `ENCRYPTION_KEY` must be a 32-byte hex string (64 hex chars) and
> `BETTER_AUTH_SECRET` must be set, or the app fails at runtime. The placeholders in
> `.env.example` will not work — replace them.

Optional seed data:

```bash
npm run seed:scheduling              # sites, staff, services, appointments
npm run seed:agenda-dev              # a fuller agenda for UI work
npm run seed:machine-demo            # machine tokens with varied capabilities
```

## Running the two processes

They are independent — run each in **its own terminal**.

**Terminal 1 — ingestion worker:**

```bash
npm run dev
```

Polls every active connection every `POLL_INTERVAL_SECONDS` and ingests new
executions. Structured JSON logs; `Ctrl+C` for graceful shutdown.

**Terminal 2 — web app:**

```bash
npm run web
```

Serves the app at <http://localhost:3000>, reading from the same database.

## Tests

```bash
npm test                             # auth + unit + integration
```

| Script | Covers |
|---|---|
| `npm run test:unit` | The pure engines and static contracts — availability grid, timezone, money, validation, handler-order contracts. No database. |
| `npm run test:integration` | Real Postgres. Booking **concurrency** (two simultaneous bookings, exactly one wins), idempotency, tenant isolation, cross-client read defense, module gating, the contact identity spine. |
| `npm run test:auth` | The web auth surface (`web/tests/`). |

Integration tests need a **separate** database in `TEST_DATABASE_URL`, migrated with:

```bash
npm run test:db:migrate
```

## Scripts

### Development

| Script | Process | Description |
| --- | --- | --- |
| `npm run dev` | worker | Run the ingestion worker (`tsx watch`) |
| `npm run web` | web | Run the Next.js dev server (webpack) |
| `npm run typecheck` | worker | Type-check without emitting |
| `npm run build` / `build:worker` | worker | Type-check + compile (`tsc` → `dist/`) |
| `npm run web:build` / `build:web` | web | Build the Next.js app |
| `npm run web:install` | web | Install the web app's dependencies |
| `npm run start:worker` | worker | Run the compiled worker (`dist/`) |
| `npm run start:web` | web | Run the built Next.js app |

### Database

| Script | Description |
| --- | --- |
| `npm run migrate up` | Apply migrations (loads `.env`) |
| `npm run migrate:prod` | Apply migrations without loading `.env` (env comes from the platform) |
| `npm run test:db:migrate` | Migrate the test database (`TEST_DATABASE_URL`) |

### Seeds

| Script | Description |
| --- | --- |
| `npm run seed:scheduling` | Demo scheduling data |
| `npm run seed:agenda-dev` | A fuller agenda for UI work (`:clean` variant removes it) |
| `npm run seed:machine-demo` | Machine tokens across the capability vocabulary |

### Operational / one-off

| Script | Description |
| --- | --- |
| `npm run backfill:contact-spine` | Create `contact_identities` rows for pre-spine contacts and record duplicate candidates. **Idempotent.** Needed on any database with legacy contacts — see [docs/schema.md](docs/schema.md) § Deuda conocida. |
| `npm run backfill:conversation-contacts` | Link unlinked conversations to contacts by normalized phone |
| `npm run backfill:token-capabilities` | Confirm/print machine-token capability backfill |
| `npm run derive:backfill` | Re-derive `conversation_turns` from executions + mappings |
| `npm run link:founder` | Attach a user to a tenant as owner |
| `npm run rbac:set-role` | Change a member's role |
| `npm run rbac2:invite` | Create a tenant invitation |

> `src/scripts/backfillServiceCategory.ts` has **no npm script** — invoke it with
> `tsx` directly.

## Environment variables

A **single** `.env` at the repo root is the source of truth for both processes. The
worker loads and validates it via `src/config.ts` (zod — it exits with a clear error
on invalid config); the web app loads the same file via `web/next.config.ts`.

### Required

| Variable | Used by | Description |
| --- | --- | --- |
| `DATABASE_URL` | both | Postgres connection string |
| `ENCRYPTION_KEY` | both | 32-byte hex (64 chars). Encrypts n8n API keys and webhook secrets at rest. The **web app needs it too**: it imports repositories that reach `src/crypto.ts`, which validates config at import time. |
| `BETTER_AUTH_SECRET` | web | Signs sessions. Generate with `openssl rand -base64 32`. |

### Optional

| Variable | Default | Used by | Description |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | worker | `trace` … `fatal` |
| `POLL_INTERVAL_SECONDS` | `30` | worker | Worker polling cadence |
| `PORT` | `3000` | web | Dev server port |
| `DB_USER` | `postgres` | compose | Postgres user (docker-compose) |
| `DB_PASSWORD` | `postgres` | compose | Postgres password (docker-compose) |
| `DB_NAME` | `observability` | compose | Postgres database (docker-compose) |
| `TEST_DATABASE_URL` | — | tests | Separate database for integration tests |
| `BETTER_AUTH_URL` | `http://localhost:3000` | web | Public base URL of the web app (OAuth callbacks). **Required in deployed production** — it must be set and https there, and the app refuses to start otherwise. Locally it falls back to the default. |

### Optional feature groups — all-or-nothing

**Google OAuth.** Email+password works without these; the "Continue with Google"
button only activates when **both** are set. Redirect URI:
`<BETTER_AUTH_URL>/api/auth/callback/google`.

| Variable | Description |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

**Client logo upload (Cloudflare R2).** With these unset the Clients view works
fully minus logo upload. Set **all** of them to enable it. Server-only secrets —
only `R2_PUBLIC_URL` is ever embedded in a page.

| Variable | Description |
| --- | --- |
| `R2_ACCOUNT_ID` | R2 account id (or provide a full `R2_ENDPOINT` instead) |
| `R2_ACCESS_KEY_ID` | R2 S3 access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3 secret |
| `R2_BUCKET_NAME` | Bucket logos are stored in |
| `R2_PUBLIC_URL` | Bucket's public base URL, e.g. `https://pub-<hash>.r2.dev` |

## How the shared db code is wired

The web app **imports the existing `src/db` repositories directly** rather than
duplicating the data layer or moving it. The worker's source under `src/` is
unchanged.

`web/next.config.ts` enables this with three settings:

- `experimental.externalDir: true` — allow importing from `../src` (outside `web/`).
- a `webpack` config with `resolve.extensionAlias` mapping `.js` → `.ts` — the worker
  uses NodeNext-style `.js` import specifiers that point at `.ts` sources. This
  requires the **webpack** bundler, so `web`'s `dev`/`build` scripts pass `--webpack`
  (Next 16 defaults to Turbopack).
- `serverExternalPackages: ["pg", "pino"]` — keep native/Node-only deps external.

`web/tsconfig.json` adds the path alias `@worker/* → ../src/*`.

**Why this over a refactor/monorepo:** keeping `src/db` as the single shared location
means the ingestion worker stays completely untouched and runnable exactly as before,
with zero duplication and one set of row types. The data access stays in the
repository layer (`src/db/repositories`), cleanly separated from the Next.js UI. A
workspaces split can come later without changing this import boundary.

## Project structure

```
.
├── src/                     # Ingestion worker + SHARED data layer
│   ├── config.ts            # env validation (zod)
│   ├── logger.ts            # pino logger
│   ├── crypto.ts            # AES-256-GCM for API keys + webhook secrets
│   ├── db/                  # SHARED: pg Pool, repositories, row types
│   │   └── repositories/    # one module per aggregate (+ scheduling/)
│   ├── n8n/                 # n8n REST client (worker only)
│   ├── ingestion/           # execution ingest + workflow sync + poll loop
│   ├── conversations/       # derive conversation turns from executions
│   ├── scheduling/          # availability engine, booking, timezone, phone
│   ├── modules/             # the per-client module registry
│   ├── connections/         # n8n connection creation
│   ├── index.ts             # worker entry point
│   └── scripts/             # seeds, backfills, RBAC one-offs
├── web/                     # Next.js app (separate process)
│   ├── app/                 # App Router — surfaces + API routes
│   ├── components/          # UI (contacts/, scheduling/, booking/, ui/)
│   ├── lib/                 # server actions, validation, formatting
│   ├── tests/               # auth tests
│   ├── next.config.ts       # loads root .env; wires ../src imports
│   └── package.json         # web's own dependencies
├── migrations/              # node-pg-migrate migrations (chronological)
├── test/
│   ├── unit/                # pure engines + static contracts (no DB)
│   └── integration/         # real Postgres: concurrency, isolation, gating
├── docs/                    # see the table below
├── docker-compose.yml       # local Postgres 16
├── .env / .env.example      # single source of truth for both processes
└── package.json             # worker scripts + web:* convenience scripts
```

## Documentation

| Document | Covers |
|---|---|
| [docs/overview.md](docs/overview.md) | **Start here.** What the product does and why: the five capabilities, the tenancy model, how n8n connects, design principles, honest limits. |
| [docs/schema.md](docs/schema.md) | The full data model: 40 tables, 6 ER diagrams, modeling rationale, constraints, derived-vs-stored, known debt. |
| [docs/scheduling-v1.md](docs/scheduling-v1.md) | Scheduling in depth: setup, the n8n API, curl and n8n payload examples, how to test a double-booking race, V1 decisions and limitations. |
| [docs/scheduling-openapi.yaml](docs/scheduling-openapi.yaml) | OpenAPI spec. ⚠️ Does not document the **mandatory** `X-Workflow-Ref` header. |
| [docs/machine-api-v1.md](docs/machine-api-v1.md) | The machine API and the token capability model. |
| [docs/machine-api-output-catalog.md](docs/machine-api-output-catalog.md) | What each machine endpoint returns. |
| [docs/handoff-contract-v1.md](docs/handoff-contract-v1.md) | The handoff contract with workflows. |
| [docs/scheduling-n8n-contract.md](docs/scheduling-n8n-contract.md) | The scheduling side of the n8n contract. |
| [docs/crm-scheduling-audit.md](docs/crm-scheduling-audit.md) | Deep audit of CRM + scheduling. Some debt items are now closed — cross-check against [docs/schema.md](docs/schema.md). |
| [DEPLOY.md](DEPLOY.md) | Deployment (Railway: web + worker services). |
