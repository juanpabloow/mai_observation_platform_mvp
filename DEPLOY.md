# Deploying to Railway

This repo runs as **four Railway services in one project**, all from this single
GitHub repo:

| Service | What it is | Code |
| --- | --- | --- |
| **Postgres** | Managed database (Railway plugin) | — |
| **worker** | Ingestion loop (polls n8n, derives turns) | `src/` → compiled to `dist/` |
| **web** | Next.js dashboard | `web/` (imports the shared data layer in `../src`) |
| **maintenance** | Meetings deletion-purge clock (no HTTP, no ingestion) | `railway.maintenance.json` → `dist/maintenanceMain.js` (see [Reuniones · servicio de mantenimiento](#reuniones--servicio-de-mantenimiento-y-vuelta-atrás-de-la-eliminación)) |

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

**✅ Migrations run on deploy via a pre-deploy command — SET IN THE RAILWAY DASHBOARD.** Both
`web` and `worker` run `npm run migrate:prod up` as their **Pre-deploy Command**, configured in
each service's **Railway dashboard → Settings → Deploy → Pre-deploy Command** (NOT from a repo
config file — see the next box). Railway runs it **after the build and BEFORE the new container
starts / takes traffic**, so pending migrations apply before any new code serves. You normally
just **push to `main`** — schema changes apply themselves.

> **⚠️ The `railway.*.json` files are NOT linked to the services.** Both services are configured
> entirely from the dashboard (start commands, build, deploy), and no service has a "Config as
> code" file path set. So anything in `railway.web.json` / `railway.worker.json` — including a
> `preDeployCommand` — is **inert**. This bit us: MF-1.1 added `preDeployCommand` ONLY to those
> (unlinked) json files, so it never ran, and migration `1808` (AT-1) sat unapplied for a day
> while the new code served. The fix was to add the Pre-deploy Command **in the dashboard** for
> web and worker (done 2026-10-18); `preDeployCommand` has been **removed from the json files** so
> they no longer imply an automation that isn't wired. The DASHBOARD is the single source of truth.

> **🔎 How to VERIFY the pre-deploy is actually wired (do this after any deploy with a migration):**
> In Railway → the service (web or worker) → the latest **Deploy → View logs**, there is a distinct
> **"Pre-deploy"** phase BEFORE "Starting Container", running `npm run migrate:prod up` and printing
> `Migrations complete!` (or `No migrations to run`). If there is **no Pre-deploy phase**, the
> command is not set on that service — add it in Settings → Deploy. Also spot-check the schema
> directly: `SELECT name FROM pgmigrations ORDER BY run_on DESC LIMIT 5;` should include the
> migration you just shipped.

> **🔒 A failing migration FAILS THE DEPLOY — the previous version keeps running.** Railway aborts
> the deployment if the pre-deploy command exits non-zero: the new container never goes live and
> the last good deployment keeps serving. So the schema can never lag deployed code — **as long as
> the command is actually set in the dashboard**. (The H-2/H-3 and the AT-1 `1808` incidents were
> both "the automation wasn't wired" — verify it per the box above, don't assume.)

**Why both services (not one):** `web` and `worker` redeploy in parallel on a push, and each
serves schema-dependent code, so **each must have the Pre-deploy Command** so it gates its own
start. Running the migration from two services at once is safe: `node-pg-migrate` takes a
**Postgres advisory lock** — the first migrates, the second blocks then finds nothing pending and
exits 0. No double-apply, no race. (The `maintenance` service does NOT run it — a narrow purge
service whose schema needs are a subset already applied by web + worker.)

- **Code-only change (no new migration):** push to `main`. Done.
- **Change that adds a NEW migration:** push to `main`. The pre-deploy applies it automatically;
  watch the deploy log confirm it, then spot-check the app.
- **Back up first for a risky migration** (data moves / drops) — the pre-deploy runs
  unattended, so take the dump BEFORE pushing (see [Database migrations](#database-migrations)).

**Manual console run is now the FALLBACK, not the procedure.** Use
`npm run migrate:prod up` in the Railway **worker** Console only to recover — e.g. to re-run
after fixing a failed pre-deploy, or to migrate out-of-band. The normal path is the automatic
pre-deploy above.

**Safety / discipline:**

- `main` = production. **Verify locally before pushing**: `npm run dev` + `npm run web`
  work, and the production builds pass (`npm run build:worker`, `npm run build:web`).
- A **failed build does NOT take down the live site** — Railway keeps the last
  successful deployment serving; the failed build just doesn't go live until fixed.
- **`ENCRYPTION_KEY` must stay identical on `web` and `worker`** (web encrypts n8n
  API keys, worker decrypts them). Never rotate it on one service without the other,
  or ingestion breaks.

- **El servicio `worker` necesita las variables `MEETINGS_STORAGE_*`.** Hasta
  ahora sólo las usaba `web`. Desde que el worker ejecuta el barrido que
  termina las eliminaciones (`startMeetingsMaintenance`), sin ellas se
  abstiene y lo registra como `storage_not_configured` — a propósito: borrar
  la fila sin haber vaciado el prefijo dejaría el audio huérfano en R2 y sin
  nada que lo mencione, que es el único fallo irreversible de la operación.
  Las reuniones se quedarían en `deleting` indefinidamente, visibles y
  reintentables, hasta que se configure.

  Variables: `MEETINGS_STORAGE_ENDPOINT`, `MEETINGS_STORAGE_BUCKET`,
  `MEETINGS_STORAGE_ACCESS_KEY_ID`, `MEETINGS_STORAGE_SECRET_ACCESS_KEY`
  (y opcionalmente `MEETINGS_STORAGE_REGION`). Las mismas que ya tiene `web`.

- **Cadencia del barrido de eliminaciones:** `MEETINGS_PURGE_INTERVAL_SECONDS`
  (por defecto 300, cinco minutos) y `MEETINGS_PURGE_BATCH` (por defecto 10
  reuniones por pasada). No hace falta tocarlas.

**Future improvements** (not yet implemented; tracked in `scaling-todo.md`):

- ~~Automate migrations as a Railway pre-deploy / release command~~ — **DONE**: the Pre-deploy
  Command `npm run migrate:prod up` is set in the **dashboard** for `web` + `worker` (NOT via the
  unlinked json files — MF-1.1's json-only change never ran). See
  [Deploying changes](#deploying-changes-ongoing-deploys) for how to verify it.
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

> **CURRENT STATE: the services are configured ENTIRELY in the Railway DASHBOARD. The
> `railway.*.json` files are NOT linked** (no "Config as code" file path is set on any service),
> so they are **reference only** — editing them changes nothing in production. The build/start/
> pre-deploy values below are what is (and must stay) set in each service's dashboard Settings.
>
> **If you ever DO want to link the json files** (one source of truth in the repo): set
> Settings → *Config as code* → file path to `railway.web.json` / `railway.worker.json` per
> service. Be aware this makes the file **authoritative** and OVERRIDES the dashboard for
> everything it specifies — `buildCommand`, `startCommand`, `restartPolicy*`, and (if you add
> them) `healthcheckPath`/`healthcheckTimeout` and `preDeployCommand`. Anything the dashboard has
> but the file omits may be dropped. Recommendation (2026-10): **keep using the dashboard** and do
> NOT link the files — linking trades one surprise (an unlinked json) for another (the json
> silently taking over start/healthcheck config). The json files intentionally no longer carry a
> `preDeployCommand` so they can't imply an automation that isn't wired.
>
> The build/start for each service (set these in the dashboard):

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

**Normally you do NOT run this by hand** — the dashboard **Pre-deploy Command** on `web` +
`worker` runs it on every deploy (see [Deploying changes](#deploying-changes-ongoing-deploys),
including how to VERIFY it is wired). The notes below are for a MANUAL/fallback run (recover from a
failed pre-deploy, or a one-off).

**Manual run (fallback), inside Railway's network:** run it as a **one-off command in the
Railway `worker` service** (Railway dashboard → worker → run a command). That runs *inside*
Railway's network, so the internal `DATABASE_URL` reaches Postgres, and `node-pg-migrate` +
`tsx` are present (the worker build runs a full `npm ci`).

Notes / alternatives:
- The dashboard pre-deploy runs on BOTH `web` and `worker`; `node-pg-migrate`'s advisory lock
  makes the concurrent runs safe (one migrates, the other waits then no-ops). A manual run shares
  the same lock, so it's safe alongside a deploy too.
- `railway run npm run migrate:prod up` from your laptop uses the **internal**
  `DATABASE_URL`, which isn't reachable from outside Railway — if you want to
  migrate from local, use the Postgres service's **public** URL instead.
- Do **not** use `npm run migrate` in prod — it loads the local `.env` and would
  target the wrong database.

### Migration numbering — the rule that keeps pre-deploy green

`node-pg-migrate` runs the files in `migrations/` **in order of their numeric prefix** and
**refuses to run a pending migration dated BEFORE one already applied** (it aborts with
`Not run migration … is preceding already run migration …`). Because that abort happens in the
**Pre-deploy Command**, it **fails the whole deploy** (the previous version keeps serving) — the
exact failure mode that blocked production when AT-2c shipped `1812000000000_ad-cover` next to the
already-merged, already-applied `1812000000000_value-dashboard`.

**THE RULE — when your branch adds a migration:**

1. **One prefix is one migration, forever unique.** Never reuse a timestamp another branch already
   used. Two branches cut from the same base can each add a migration; whichever **merges second**
   must be **renumbered to sort AFTER the latest migration already on `main`**. Check before pushing:
   ```
   ls migrations/ | sort | tail -5
   ```
   If your file isn't strictly last (or ties a prefix), renumber it with `git mv` to a prefix greater
   than the current last one, e.g. `…1813000000000_x.ts` → `…1814000000000_x.ts`.
2. **Renumbering is safe only while the migration has NOT run anywhere** (dev/test DBs can be reset;
   a renumber after it ran in prod would re-run it). If it already ran in prod, write a NEW migration
   instead of renumbering.
3. **A rebase onto `main` does not fix a prefix collision** — Git keeps both files; only renumbering does.
4. **The guard:** `test/unit/migrationOrder.test.ts` asserts every prefix is a unique 13-digit
   timestamp and that known-collided migrations keep their resolved order. It needs no database, so it
   runs in **CI on every push/PR to `main`** (`.github/workflows/unit-tests.yml`) — a collision fails
   the check, not production. Keep that check **required** on `main` (see that workflow's header).

After a deploy that ships a migration, confirm it applied:
```
SELECT name FROM pgmigrations ORDER BY run_on DESC LIMIT 5;
```

## Google OAuth (optional)

Email/password works without Google. To enable it, set `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` on the **web** service, and in Google Cloud Console add the
Authorized redirect URI:

```
<BETTER_AUTH_URL>/api/auth/callback/google
```

**Confirming identity with Google (Seguridad → Sesiones).** Google does not support
re-authentication requests; the only freshness proof is the ID token's `auth_time`, which Google
sends only when the app has **Session age claims** enabled (Google Auth Platform → Settings →
Advanced settings; the app must be *In production* and *Verified*). Only after enabling it, set
`GOOGLE_SESSION_AGE_CLAIMS=enabled` on the **web** service. Without it, Google sign-in works as
before, but a Google-only account cannot close its OTHER sessions (closing the current one always
works) — the app never treats a Google round-trip without a recent `auth_time` as proof.

## Acceso y sesiones (migración `1822000000000`) · despliegue y vuelta atrás

**Qué cambia en la base.** La migración solo AÑADE columnas a `session` (todas con valor por
defecto o nulas) y crea `user_profiles` / `user_avatars`. Las sesiones abiertas conservan su
vencimiento actual (marcadas `legacy`). No hay ninguna restricción que el código ANTERIOR pueda
violar: está comprobado que, con el esquema nuevo, el código anterior sigue iniciando sesión,
refrescando, listando, revocando y cerrando sesiones (`npm run test:migrations:acceso`, que
alterna el código real de `origin/main` y el de la rama sobre un PostgreSQL desechable propio de
cada ejecución, publicado solo en 127.0.0.1; `npm run test:migrations:acceso:selftest` prueba
que el arnés falla con código ≠ 0 —y sin «OK»— ante una migración o comprobación fallida, o un
PostgreSQL que no arranca, y que no toca contenedores ajenos).

**Secuencia (la de siempre, sin pasos manuales):**
1. Justo antes del merge: `ls migrations/ | sort | tail -5` contra `main` — `1822…` debe ser la
   última (renumerar con `git mv` si otra rama tomó el número). Hacer el `pg_dump` de siempre.
2. Merge a `main` → el pre-deploy aplica `1822`. Durante esa ventana el código anterior sigue
   sirviendo sin errores; las sesiones que crea o refresca quedan sin política.
3. El código nuevo arranca: `web/instrumentation-node.ts` concilia esas sesiones y
   `web/lib/session.ts` (→ `lib/sessionValidation.ts`) repite la conciliación por fila en cada
   lectura, para lo que el código anterior escriba mientras ambos conviven. Conciliar RECORTA,
   nunca alarga ni cuenta como actividad: una sesión sin «Mantener sesión» queda en
   min(su vencimiento, su límite de 12 h, ÚLTIMA ACTIVIDAD REGISTRADA + 2 h) — si eso ya pasó, la
   sesión termina. Tras conciliar, la sesión se RELEE y se juzga sobre su estado actual (otra
   petición pudo conciliarla, revocarla o vencerla): nunca se acepta una sesión vencida o
   revocada por haber usado la lectura anterior.
4. Comprobar: `SELECT name FROM pgmigrations ORDER BY run_on DESC LIMIT 3;`, iniciar sesión con y
   sin «Mantener sesión», y que el log del web muestre (si hubo) `session policy: reconciled N`.

**Vuelta atrás = SOLO código.** Redesplegar el commit anterior (Railway → web → deployments →
Redeploy del anterior, o revert en `main`). El esquema se queda: el código anterior funciona con
él (verificado). Mientras dure la vuelta atrás vuelve el comportamiento anterior (sesiones de 7
días que se deslizan, endpoints de Better Auth de listar/revocar abiertos); al volver a desplegar
el código nuevo, esas sesiones se recortan solas. Teléfonos y fotos quedan guardados, sin uso.

**Lo que NO se puede reconstruir (y por eso no se inventa):**
- El código anterior no registra la interacción de las personas: solo «refresca» al leer. Las
  sesiones que creó (incluidas las abiertas antes de este despliegue) quedan como `legacy`:
  persistentes, con su vencimiento actual como límite (máximo 30 días desde su creación) y SIN
  actividad registrada — en Seguridad → Sesiones aparecen como «Actividad no registrada».
- Si hay una vuelta atrás, lo que la persona trabajó mientras servía el código anterior tampoco
  queda registrado: al redesplegar, una sesión sin «Mantener sesión» se juzga por la última
  actividad que vio el código nuevo, y puede terminar en ese momento (la persona vuelve a entrar).

**No ejecutar `down` para volver atrás.** `down` BORRA los teléfonos (`user_profiles`) y las fotos
(`user_avatars`) de todas las personas, además de las columnas de política de sesión. Se niega a
correr mientras haya datos salvo con `ACCESO_DOWN_ALLOW_DATA_LOSS=1`; si de verdad hace falta,
exportar antes esas dos tablas.

## Suggested first-deploy order

1. Create the project and add **Postgres** (managed plugin).
2. Create the **worker** and **web** services from this repo (Root Directory = repo root). Set
   each service's Build/Start commands in the **dashboard** (see [Per-service
   configuration](#per-service-configuration)) — do NOT rely on the `railway.*.json` files, which
   are not linked.
3. Set Variables on both services (see above). Reference `${{ Postgres.DATABASE_URL }}`.
4. **Set the Pre-deploy Command** `npm run migrate:prod up` on BOTH web and worker (Settings →
   Deploy). Then deploy and **verify** a Pre-deploy phase appears in the logs (see [Deploying
   changes](#deploying-changes-ongoing-deploys)) — if it's missing, migrations are NOT running.
5. Deploy. The worker begins polling; the web app serves on its Railway domain.
6. Set `BETTER_AUTH_URL` to the web's public domain (and, if using Google, the
   redirect URI), then redeploy web if it changed.

## Local development is unchanged

`npm run dev` (worker, tsx watch) and `npm run web` (Next dev) still work exactly
as before, loading the repo-root `.env`. The production scripts (`build:worker`,
`start:worker`, `build:web`, `start:web`, `migrate:prod`) are additive.

## Reuniones · servicio de mantenimiento y vuelta atrás de la eliminación

### El servicio

Un tercer servicio Node, **aparte** del `web` y del `worker` de la ingesta:
`railway.maintenance.json` → `npm run start:maintenance` → `node
dist/maintenanceMain.js`. Arranca **sólo** el barrido que termina las
eliminaciones: ni la ingesta de n8n, ni un servidor HTTP, ni puerto abierto.
Una réplica, `restartPolicyType: ON_FAILURE`.

No es el worker GPU de Linux (`vanegas-w3-worker.service`), que vive fuera de
Railway y no se toca.

**Variables** (por referencia del proyecto, nunca pegadas a mano):

- `DATABASE_URL` — **la misma referencia efectiva que usa el servicio `web`**.
  La referencia por defecto de un proyecto de Railway apunta a la base
  `railway`, no a `mai_w3_staging`. Este proceso borra filas y objetos, así que
  apuntarlo mal es el accidente que hay que impedir.
- `MEETINGS_MAINTENANCE_EXPECTED_DB` — la base que se AFIRMA esperar
  (`mai_w3_staging` en staging). **Obligatoria en este servicio**: es un
  proceso que borra, y arrancar sin declarar el destino es el accidente que la
  guarda existe para impedir. Al arrancar pregunta a PostgreSQL
  `current_database()` y aborta si no coincide, o si la base está en
  recuperación. El valor no se acopla al código: se declara aquí, así que el
  mismo binario sirve para otro entorno cambiando la variable.
- `MEETINGS_STORAGE_ENDPOINT`, `MEETINGS_STORAGE_BUCKET`,
  `MEETINGS_STORAGE_ACCESS_KEY_ID`, `MEETINGS_STORAGE_SECRET_ACCESS_KEY` — las
  mismas del `web`. **Obligatorias**: el proceso aborta al arrancar si falta
  cualquiera, en vez de parecer sano y avisar cinco minutos después. Y si la
  configuración se rompiera en caliente, el ciclo se abstiene y lo registra sin
  borrar filas — quitar la fila sin haber vaciado el prefijo deja el audio
  huérfano en R2 y es el único fallo irreversible de la operación.

**Lo que este servicio NO debe tener**: `ENCRYPTION_KEY`, `OPENAI_API_KEY`,
nada de Better Auth, nada de n8n, nada del servidor web. Su configuración la
valida `src/meetings/maintenanceConfig.ts` —seis variables y dos opcionales—,
no `src/config.ts`, que valida la aplicación entera. Pedirle una clave de
cifrado a un proceso que sólo vacía prefijos sería darle un secreto que no usa.
- Opcionales: `MEETINGS_PURGE_INTERVAL_SECONDS` (300),
  `MEETINGS_PURGE_BATCH` (10).
- **NO** `OPENAI_API_KEY`: este proceso no llega al módulo de análisis.

Registra por reunión `meetingId`, `outcome`, `found`, `deleted`, `remaining`,
`batches` y `ms`. Nunca claves de R2, URLs firmadas, títulos ni contenido.

### Vuelta atrás

En este orden, y **nunca con force-push**:

1. **Detener el servicio de mantenimiento** en Railway. Mientras corra puede
   completar una eliminación a medias, y el paso siguiente cambia el código que
   la ejecuta.
2. **`git revert` del commit de integración** y publicarlo por fast-forward.
   Volver al SHA anterior con `--force` borraría del remoto commits ya
   desplegados; un revert deja la historia intacta y es igual de efectivo.
3. **Confirmar que no hay eliminaciones activas**:
   `SELECT count(*) FROM meetings WHERE deletion_state <> 'live'` debe ser 0.
   Si no lo es, hay reuniones a medio eliminar: terminarlas antes de seguir.
4. **Sólo entonces** considerar `npx node-pg-migrate down 1`.

Sobre ese último paso: la migración es **puramente aditiva** —diez columnas,
dos constraints y un índice; cero `DROP` en `up()`— así que dejarla aplicada no
rompe el código anterior. **Es preferible dejarla** a bajarla con procesos
pendientes: bajarla con una reunión en `deletion_state <> 'live'` destruiría el
estado que hace falta para terminarla, y ahí sí quedaría audio huérfano.
