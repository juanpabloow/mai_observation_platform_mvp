# Run the app locally (Mac) — dev runbook

Run the **web dashboard** against a dedicated local Postgres database (`observability_dev`) with dev
seed data. This touches **no application code** — only local env + DB. Nothing here points at the
test DB (`observability_test`) or production.

> **The agency login created by this setup:** `dev@local.test` / `devpass1234` — **local only**.
> **URL:** http://localhost:3000

## What you need
- **PostgreSQL 16** running locally (Homebrew `postgresql@16`), role `postgres`/`postgres`.
  Put its CLI on PATH for the commands below: `export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"`.
- **Node** (the repo's version) with deps installed: `npm install` at the root **and** in `web/`
  (`npm run web:install`).
- **`web/.env.local`** (gitignored — matches `.env.*`) holding the local config. It is NOT committed.
  If it is missing, recreate it (see "First-time setup"). It must contain:
  ```
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/observability_dev
  BETTER_AUTH_URL=http://localhost:3000
  BETTER_AUTH_SECRET=<any long random string — openssl rand -base64 32>
  ENCRYPTION_KEY=<64 hex chars — openssl rand -hex 32>
  LOG_LEVEL=info
  ```
  The web app's `next.config.ts` loads the repo-root `.env`, but Next loads `web/.env.local` **first**
  and it wins — so this file is the single place that points the browser app at the dev DB. **Never
  put production secrets or a production `DATABASE_URL` here.**

### What's OFF without optional keys (and the dev workaround)
These stay unset locally; the app boots fine without them:
| Unset | What doesn't work | Dev workaround |
|---|---|---|
| `RESEND_API_KEY` / `INVITE_FROM_EMAIL` | No email sends — so **email verification, invitations, and password-reset emails never arrive**. New email/password sign-ups are created **unverified** and can't sign in. | Mark a user verified by hand: `psql "$DEV" -c "UPDATE \"user\" SET \"emailVerified\"=true WHERE email='you@local.test';"`. (The link is NOT printed to the console in this codebase, so this SQL is the local path.) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Continue with Google" is inert. | Use **email + password**. |
| `R2_*` | Client **logo upload** is unavailable (everything else in Clients works). | Skip it. |
| `OPENAI_API_KEY` / `MEETINGS_STORAGE_*` | The **Meetings** (transcription/analysis) feature. | Skip unless testing Meetings. |

`export DEV="postgres://postgres:postgres@localhost:5432/observability_dev"` for the `psql` snippets below.

## Start
```
npm run web          # from the repo root → next dev on http://localhost:3000
```
Open http://localhost:3000, log in with `dev@local.test` / `devpass1234`. (`Ctrl-C` stops it.)

The **worker** (`npm run dev`) is NOT needed to browse the dashboard, so don't start it. If you ever
need it, run it against the dev DB only and note there are no n8n connections seeded in
`observability_dev`, so it polls nothing and sends nothing outbound:
```
DATABASE_URL="$DEV" npm run dev
```

## Stop
- Web app: `Ctrl-C` in its terminal, or `pkill -f "next dev"`.
- Postgres keeps running (Homebrew service); leave it, or `brew services stop postgresql@16`.

## Reset the local dev DB (fresh schema + seed + login)
```
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
export DEV="postgres://postgres:postgres@localhost:5432/observability_dev"

# 1. Recreate the database (drops ALL local dev data — never touches test/prod).
dropdb --if-exists observability_dev && createdb -O postgres observability_dev

# 2. Migrate it.
DATABASE_URL="$DEV" npx node-pg-migrate --tsx up

# 3. Create the agency login (the sign-up hook gives it its own tenant = agency).
#    The web app must be running (npm run web) for this call.
curl -s -X POST http://localhost:3000/api/auth/sign-up/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:3000" \
  -d '{"email":"dev@local.test","password":"devpass1234","name":"Dev Agency"}'
psql "$DEV" -c "UPDATE \"user\" SET \"emailVerified\"=true WHERE email='dev@local.test';"

# 4. Seed the sandbox client (staff, services, 35 appointments, 10 contacts) INTO that tenant.
TENANT=$(psql "$DEV" -tA -c "SELECT tenant_id FROM tenant_members m JOIN \"user\" u ON u.id=m.user_id WHERE u.email='dev@local.test';")
ALLOW_DEV_SEED=true NODE_ENV=development DEV_SEED_TENANT_ID="$TENANT" DATABASE_URL="$DEV" npm run seed:agenda-dev
```
Re-seeding is idempotent (it cleans the sandbox client by name first). Remove just the sandbox:
```
ALLOW_DEV_SEED=true NODE_ENV=development DATABASE_URL="$DEV" npm run seed:agenda-dev:clean
```

## First-time setup (from scratch)
1. `npm install` and `npm run web:install`.
2. Create `web/.env.local` with the five vars above (fresh `BETTER_AUTH_SECRET` + `ENCRYPTION_KEY`).
3. Run the four "Reset the local dev DB" steps (createdb → migrate → sign-up+verify → seed).
4. `npm run web` and open http://localhost:3000.

## Notes
- `observability_dev` is deliberately separate from `observability_test` (the integration-test DB,
  wiped by the suite) and from any deployed database. Only Railway deploys; nothing here reaches prod.
- Dev secrets in `web/.env.local` are generated locally and are not production values.
