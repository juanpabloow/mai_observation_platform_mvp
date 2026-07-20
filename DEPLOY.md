# Deploying to Railway

This repo runs as **three Railway services in one project**, all from this single
GitHub repo:

| Service | What it is | Code |
| --- | --- | --- |
| **Postgres** | Managed database (Railway plugin) | — |
| **worker** | Ingestion loop (polls n8n, derives turns) | `src/` → compiled to `dist/` |
| **web** | Next.js dashboard | `web/` (imports the shared data layer in `../src`) |

> Initial setup is manual (this runbook). Once set up, the app **auto-deploys on
> push to `main`** — read **[Deploying changes](#deploying-changes-ongoing-deploys)**
> first before shipping. No secrets are committed; set them in each service's
> **Variables** tab.

## Deploying changes (ongoing deploys)

> **Read this first when shipping a change. `main` is production.**

**Auto-deploy:** Railway is connected to this GitHub repo and auto-deploys on every
push to `main` (rebuild + redeploy). Because both services share one repo, a push
redeploys **both** `worker` and `web` — so even a web-only change briefly restarts
the worker. That's harmless and expected.

**⚠️ Migrations are NOT automatic.** Pushing code does **not** run DB migrations.

> **🔒 HARD RULE — schema must never lag deployed code.** Any push containing a
> migration **requires `npm run migrate:prod up` (back up first — see
> [Database migrations](#database-migrations)) BEFORE or immediately after the push.**
> Never leave migrated code deployed against an un-migrated database.
> This is not hypothetical: H-2/H-3 code auto-deployed while its two handoff migrations
> sat unapplied, and the sidebar's `conversations` query then `500`'d **every**
> authenticated page until they were run. If you can't run the migration right after
> the push, don't push the schema-dependent code yet.

- **Code-only change (no new migration):** just push to `main`. Done.
- **Change that adds a NEW migration** (new table / column / index / etc.) — run it
  **manually, AFTER the deploy finishes**:
  1. Push to `main`; wait for the redeploy to complete.
  2. Railway → **worker** service → **Console** → run:  `npm run migrate:prod up`
  3. Verify (migration reports applied; spot-check the app).
- **Sequence for a schema-changing deploy:** push → wait for redeploy → run
  `npm run migrate:prod up` in the worker Console → verify.
- **Do NOT** deploy schema-dependent code without running its migration first —
  production will throw `relation/column does not exist` errors until it's applied.

**Safety / discipline:**

- `main` = production. **Verify locally before pushing**: `npm run dev` + `npm run web`
  work, and the production builds pass (`npm run build:worker`, `npm run build:web`).
- A **failed build does NOT take down the live site** — Railway keeps the last
  successful deployment serving; the failed build just doesn't go live until fixed.
- **`ENCRYPTION_KEY` must stay identical on `web` and `worker`** (web encrypts n8n
  API keys, worker decrypts them). Never rotate it on one service without the other,
  or ingestion breaks.

**Future improvements** (not yet implemented; tracked in `scaling-todo.md`):

- Automate migrations as a Railway pre-deploy / release command, so schema changes
  apply automatically on deploy instead of the manual Console step.
- Add a staging environment / non-`main` branch workflow before production, once
  there are real users.

## Key fact: both Node services use the **repo root** as their Railway "Root Directory"

The web app imports the shared data layer from `../src` (alias `@worker/*`), and
the shared `src/` code's runtime deps (`pg`, `pino`, `zod`, `dotenv`) live in the
**root** `package.json`. So **both** services must see the whole repo — set each
service's *Root Directory* to the repository root (the default), not `web/`.
They differ only in build/start commands (provided as per-service config files).

## Node version

Pinned to **Node 22 (LTS "Jod")** via [`.nvmrc`](.nvmrc) (Nixpacks reads it),
with `engines.node: ">=20"` in both `package.json` files. Local dev is on Node 24;
22 is the safe, broadly-supported LTS for the host and is fully compatible with
Next 16, Better Auth, and `pg`. Bump `.nvmrc` to `24` if you want to match local
exactly.

## Per-service configuration

Each Node service reads its build/start from a committed config file. In the
Railway service **Settings → Config-as-code**, set the config file path:

### worker  →  `railway.worker.json`
- **Root Directory:** repo root
- **Build:** `npm ci && npm run build:worker`  (`tsc` → `dist/`)
- **Start:** `npm run start:worker`  (`node dist/index.js` — plain Node, NOT tsx/watch)
- **No public port** (background worker).
- **Variables:** `DATABASE_URL`, `ENCRYPTION_KEY`, `POLL_INTERVAL_SECONDS`, `LOG_LEVEL`

### web  →  `railway.web.json`
- **Root Directory:** repo root
- **Build (paste this EXACT string into Railway's Custom Build Command):**

  ```
  npm ci && cd web && npm ci && npm run build
  ```

  Root `npm ci` installs the shared `../src` runtime deps (`pg`, `pino`, `zod`,
  `dotenv`) so the build can resolve `@worker/*`; **`cd web && npm ci` installs
  the web deps (including `next`)**; then `npm run build` runs `next build`.
- **Start:** `npm run start:web`  (`cd web && next start`, serves on Railway's `$PORT`)
- **Variables:** `DATABASE_URL`, `ENCRYPTION_KEY`, `LOG_LEVEL`, `BETTER_AUTH_SECRET`,
  `BETTER_AUTH_URL`, and optionally `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`

> ⚠️ **Do NOT set the web build command to `npm run build:web`.** That script is
> `cd web && npm run build` — a *local* convenience that assumes web deps are
> already installed. On Railway it runs `next build` without ever installing
> web/'s deps, so the build fails with `sh: next: not found` (exit 127). The
> build command MUST include `cd web && npm ci` (as above). Same applies if you
> point the service at `railway.web.json` — its `buildCommand` already does this.

> If you'd rather not use the config files, type the same Build/Start commands
> directly into each service's Settings → Build/Deploy.

## Environment variables

See [`.env.production.example`](.env.production.example) for the full, commented
list grouped by service. Highlights:

- **`DATABASE_URL`** (both services): reference the managed DB, not a literal —
  set it to `${{ Postgres.DATABASE_URL }}` so Railway injects the internal URL.
- **`ENCRYPTION_KEY`** (both services, **identical**): the web app *encrypts*
  saved n8n keys and the worker *decrypts* them, so the value **must match** on
  both, or ingestion can't read stored keys. Generate once: `openssl rand -hex 32`.
- **`BETTER_AUTH_SECRET`** (web): `openssl rand -base64 32`.
- **`BETTER_AUTH_URL`** (web): the public web URL, e.g.
  `https://your-app.up.railway.app` (no trailing slash).
- Generate **fresh** `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` for production —
  never reuse dev values.

## Database migrations

Schema is managed by `node-pg-migrate` (TypeScript migrations in `migrations/`).
Production migrate command (reads `DATABASE_URL` from the environment, no `.env`):

```
npm run migrate:prod up
```

**Back up FIRST — canonical method.** Before any production migration, dump the DB
from your laptop using the Postgres service's **public proxy URL** (Railway → Postgres
→ *Connect* → the **public** `DATABASE_PUBLIC_URL` / proxy `…proxy.rlwy.net` URL — the
internal `${{ Postgres.DATABASE_URL }}` is not reachable off-Railway, and the
dashboard **Backups** tab is plan-gated so we don't rely on it):

```
pg_dump "<public proxy DATABASE_URL>" > ~/obs-backups/obs-$(date +%F-%H%M).sql
```

Keep the dump **outside the repo** (it contains real data + secrets — never commit it).
Restore, if ever needed, with `psql "<public url>" < that-file.sql`. Only after the
backup succeeds, run `npm run migrate:prod up`.

**Recommended for the first deploy (simplest + reliable):** run it as a **one-off
command in the Railway `worker` service** (Railway dashboard → worker → run a
command). That runs *inside* Railway's network, so the internal `DATABASE_URL`
reaches Postgres, and `node-pg-migrate` + `tsx` are present (the worker build runs
a full `npm ci`). Run it **once, before** the worker/web first start, and watch it
succeed.

Notes / alternatives:
- Run it on **one** service only (the worker) to avoid two services migrating at once.
- `railway run npm run migrate:prod up` from your laptop uses the **internal**
  `DATABASE_URL`, which isn't reachable from outside Railway — if you want to
  migrate from local, use the Postgres service's **public** URL instead.
- To automate later, add `"deploy": { "preDeployCommand": "npm run migrate:prod up" }`
  to `railway.worker.json` so migrations run before each worker deploy. Manual is
  recommended until the deploy is stable.
- Do **not** use `npm run migrate` in prod — it loads the local `.env` and would
  target the wrong database.

## Google OAuth (optional)

Email/password works without Google. To enable it, set `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` on the **web** service, and in Google Cloud Console add the
Authorized redirect URI:

```
<BETTER_AUTH_URL>/api/auth/callback/google
```

## Suggested first-deploy order

1. Create the project and add **Postgres** (managed plugin).
2. Create the **worker** and **web** services from this repo (Root Directory =
   repo root; set each one's config file path).
3. Set Variables on both services (see above). Reference `${{ Postgres.DATABASE_URL }}`.
4. **Run migrations** once (worker one-off: `npm run migrate:prod up`).
5. Deploy. The worker begins polling; the web app serves on its Railway domain.
6. Set `BETTER_AUTH_URL` to the web's public domain (and, if using Google, the
   redirect URI), then redeploy web if it changed.

## Local development is unchanged

`npm run dev` (worker, tsx watch) and `npm run web` (Next dev) still work exactly
as before, loading the repo-root `.env`. The production scripts (`build:worker`,
`start:worker`, `build:web`, `start:web`, `migrate:prod`) are additive.
