# Platform Audit — 2026-10 (AUDIT-2, report only)

**Date:** 2026-10-15 · **Commit:** `1b49a6c` (branch `main`) · **Method:** code-authoritative read of `src/`, `web/`, `migrations/`, `docs/`, plus the local test/lint/tsc suites run for counts only. No production access — where production data matters, a READ-ONLY (`SELECT`) query is given for the operator to run in the Railway console. Where a doc and the code disagree, **the code wins** and the discrepancy is flagged. Claims cite `file:symbol`/`file:line`.

This file is the deliverable. The chat reply carries only the executive summary, top-10 risks, the booking verdict (C.9), and the answers to D.1/D.2.

---

## A. INVENTORY

### A1. Architecture

**Four deployable services** (not three — `DEPLOY.md`'s summary table is stale, says three):

| Service | Start | Runs | Source |
|---|---|---|---|
| Postgres | Railway plugin | managed DB (postgres:16 locally, `docker-compose.yml`) | — |
| **worker** | `start:worker` → `node dist/index.js` | n8n ingestion poll loop ONLY | `railway.worker.json`, `src/index.ts` → `src/ingestion/worker.ts` |
| **web** | `start:web` → `cd web && npm run start` | Next.js 16 dashboard + ALL HTTP APIs | `railway.web.json`, `web/` |
| **maintenance** | `start:maintenance` → `node dist/maintenanceMain.js` | meetings "purge-deleted" sweep ONLY | `railway.maintenance.json`, `src/maintenanceMain.ts` → `src/meetings/maintenance.ts` |

`src/index.ts` (lines 35-38) deliberately starts only `startWorker()`; the meetings sweep has its own entrypoint (`src/maintenanceMain.ts`, with its own config validation `loadMaintenanceConfig` + a DB guard `assertMaintenanceDatabase`).

**Directory map.** `src/` = shared TS data layer + worker (compiled to `dist/`): `db/repositories/**` (raw parameterized SQL per domain), `ingestion/`, `n8n/`, `meetings/`, `scheduling/`, `storage/`, `modules/registry.ts`, `crypto.ts`, `config.ts`, `conversations/deriveTurns.ts`, `scripts/`. `web/app/` = Next.js App Router UI + `app/api/*` HTTP routes. `web/lib/` = ~109 server-action/data/validation modules (reaches `src/` via the `@worker/*` → `../src/*` alias, `web/tsconfig.json`). `web/components/` = React UI.

**Stack / key versions.** Root: `type:module`, Node ≥20, `typescript ^6.0.3`, `tsx ^4.22.4`, `node-pg-migrate ^8.0.4`, `pg ^8.21.0`, `pino ^10`, `zod ^4.4.3`, `@aws-sdk/client-s3 ^3.1128.0`. Web: `next 16.2.7`, `react`/`react-dom 19.2.4`, `better-auth ^1.6.18`, `tailwindcss ^4`, `eslint 9`, `@tanstack/react-table ^8`, `recharts ^3`, `next-themes`. (`web/AGENTS.md` warns this Next.js diverges from training data — read `node_modules/next/dist/docs/` before editing.)

**Deploys.** Auto-deploy on push to `main` (web + worker rebuild, NIXPACKS). **Migrations are NOT automatic** (`DEPLOY.md:26`, bold) — no `preDeployCommand`/release command in any `railway.*.json`; production procedure is manual in the worker console: `npm run migrate:prod up`. Automating it is an explicit TODO (`DEPLOY.md:186`, `scaling-todo.md`).

**Latest migration.** `migrations/1798000000001_products.ts`. **46 migration files** total.

**Env var NAMES** (grepped, values never read; what each is for):
- Core/worker (`src/config.ts`): `DATABASE_URL`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `ENCRYPTION_KEY` (64-hex AES key), `LOG_LEVEL`, `POLL_INTERVAL_SECONDS` (n8n poll, default 30), `TEST_N8N_BASE_URL`, `TEST_N8N_API_KEY`.
- Auth (`web/lib/auth.ts`): `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (optional social), `NODE_ENV`, `RAILWAY_ENVIRONMENT*`, `RAILWAY_PROJECT_ID`.
- Email (`web/lib/email.ts`): `RESEND_API_KEY`, `INVITE_FROM_EMAIL`, `RESEND_FROM_NAME`.
- Public-logo storage R2 (`web/lib/r2.ts`): `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`.
- Meetings private storage (`src/storage/meetingsStorage.ts`): `MEETINGS_STORAGE_DRIVER` (s3|fake), `..._ENDPOINT/_BUCKET/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY/_REGION/_SESSION_TOKEN/_FORCE_PATH_STYLE/_PUT_TTL_SECONDS/_GET_TTL_SECONDS/_PUBLIC_URL`.
- Meetings behaviour/maintenance: `MEETINGS_ANALYSIS_MODEL`, `OPENAI_API_KEY`, `MEETINGS_LEASE_SECONDS`, `MEETINGS_MAX_DURATION_SECONDS`, `MEETINGS_MAX_MEDIA_BYTES`, `MEETINGS_ALLOWED_CONTENT_TYPES`, `MEETINGS_ALLOWED_EXTENSIONS`, `MEETINGS_MAINTENANCE_EXPECTED_DB`, `MEETINGS_PURGE_INTERVAL_SECONDS` (300), `MEETINGS_PURGE_BATCH` (10).
- Public booking (`web/lib/publicBooking*`): `PUBLIC_BOOKING_DISABLED`, `PUBLIC_BOOKING_HASH_SECRET`, `PUBLIC_BOOKING_RATE_LIMIT_IP_MAX/_IP_WINDOW_SECONDS/_PHONE_MAX/_PHONE_WINDOW_SECONDS`, `PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE`, `PUBLIC_BOOKING_TURNSTILE_ENABLED`, `PUBLIC_BOOKING_TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `PUBLIC_BOOKING_PRIVACY_POLICY_URL`.
- Dev seeds: `ALLOW_DEV_SEED`, `DEV_SEED_TENANT_ID`.
- **DISCREPANCY:** `.env.example` omits most `MEETINGS_*`, `OPENAI_API_KEY`, `RESEND_*`, `INVITE_FROM_EMAIL`, and most `PUBLIC_BOOKING_*` that the code actually reads.

### A2. Background work

Two independent `setInterval` loops, in two services. **No generic cron/timed-job framework** (no `node-cron`/`bullmq`/`agenda`/`node-schedule` in either `package.json`).
- **n8n ingestion** — `src/ingestion/worker.ts:startWorker` → `runCycle` immediately then every `POLL_INTERVAL_SECONDS` (default **30s**), overlap-guarded. Per cycle: `listActiveConnections` → (concurrency 5) `syncWorkflowsForConnection` → `ingestExecutionsForConnection` (paged, cursor in `ingestion_state`, detail concurrency 10) → `deriveTurnsForExecutionIds` (best-effort). Cycles never throw.
- **Meetings purge sweep** — `src/meetings/maintenance.ts:startMeetingsMaintenance` → `setInterval` (default **300s**, `.unref()`), only in the `maintenance` service; correctness is in SQL (`FOR UPDATE SKIP LOCKED` + lease).
- Meetings transcription/analysis is a **pull model**: external GPU workers claim jobs over HTTP. Lease recovery (`/api/meetings/v1/maintenance/requeue-expired`) is **HTTP-only, nothing schedules it**.
- Web "realtime" = light client polling (inbox list ~5s, thread ~4s, pending-count ~5s, executions table).

**A generic "every hour do X" would live in the worker service** — `src/meetings/maintenance.ts` (lines 18-30) argues the honest home for periodic jobs is the always-on single-instance worker. No reusable job framework exists to plug into; one would be built from scratch (a sibling interval in `src/ingestion/worker.ts`, or a new service modeled on `src/maintenanceMain.ts`).

### A3. Third-party integrations

- **n8n** — single client `src/n8n/client.ts:createN8nClient` (REST `/api/v1`, `X-N8N-API-KEY`, 30s, zod-validated, tolerant per-row parsing). Workflows/executions pulled by the worker.
- **Resend (email)** — `web/lib/email.ts:sendEmail` raw REST (no SDK), `server-only`. Three emails only (invitation, verification, password reset — see B/Team). A second copy in `src/scripts/rbac2CreateInvite.ts`.
- **Google auth** — `web/lib/auth.ts` (Better Auth) registers `socialProviders.google` only when both `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET` are set; implicit linking disabled.
- **S3 / aws-sdk — two separate uses.** (a) Public logos: `web/lib/r2.ts` (Cloudflare R2, public bucket). (b) **Meetings = a private meeting-media pipeline**: `src/storage/s3PrivateStore.ts` stores original media, normalized audio, transcript + diarization NDJSON in a **separate private bucket** (asserts distinct from the logo bucket), access only via short-lived presigned URLs; analysis via **OpenAI** (`src/meetings/analysis/openai.ts`).
- **Credential storage / encryption** — `src/crypto.ts` = **AES-256-GCM**, 12-byte random IV, `base64(iv):base64(tag):base64(ct)`, 32-byte key from `ENCRYPTION_KEY`. Used for `n8n_connections.n8n_api_key_encrypted` (encrypt `src/connections/createConnection.ts`, decrypt in ingestion) and outbound webhook HMAC secrets (`src/db/repositories/webhooks.ts`). Worker tokens are SHA-256 **hashed**, not encrypted. **Reusable for a new provider's OAuth tokens: YES** — `src/crypto.ts` is a generic string helper already reachable from `web/` via `@worker/*`; a new server action can `encrypt(token)` into a new column with no new mechanism. Caveat: no key rotation (single static key, no key-id in the envelope).

### A4. Modules

`src/modules/registry.ts`: `CLIENT_MODULE_KEYS = ["crm","scheduling","inbox","meetings","catalog"]`. Table `client_modules` (`migrations/1782100000000_client-modules.ts`): `(tenant_id, client_id, module_key, enabled DEFAULT true, settings jsonb)`, composite FK to clients, UNIQUE `(tenant,client,module_key)`, CHECK on `module_key` (widened per module by later migrations). **Absence of a row = disabled; disabling flips `enabled=false`, never deletes.** Defaults/backfill: crm (clients with ≥1 contact), scheduling (clients with ≥1 site; requires non-default client), inbox (backfilled ON for all existing non-default clients), meetings (opt-in, no backfill), catalog (opt-in, no backfill).

### A5. Roles & permissions (as implemented)

Authority: `web/lib/access.ts`. Tenant `Role = owner | admin | member` (`:39`); owner/admin = **agency** (full data, `memberClientId===null`). A `member` is pinned to one `member_client_id` with a `ClientRole = owner | setter | staff` (`src/db/repositories/tenantMembers.ts:48`). `buildScope` (`access.ts:177`) fails closed. Two entry points: `getAccessScope` (redirects on failure — data pages/actions) and `getSessionScope` (returns null — chrome/JSON routes).

Exported predicates: `hasFullAccess`, `isClientOwner`, `canAccessClient` (owner+setter+agency; **staff denied**), `canSeeWorkflowInsights` (agency+CO only), `canManageClient` (agency or CO), `canReadCatalog` (=canAccessClient), `canManageCatalog` (=canManageClient), `isSchedulingStaff`, `canOperateScheduling` (any client role + agency), `canAccessSchedulingSite`/`canAccessSchedulingStaff` (staff pinned), `memberLandingHref`, `requireFullAccessOrLand`, `requireFullAccessForAction`.

**Matrix (VIEW / MODIFY, enforcement):**

| Surface | VIEW | MODIFY | Gate |
|---|---|---|---|
| Hub `/`, `/clients`, `/settings/*`, Modules, Machine tokens | agency | agency | `requireFullAccessOrLand` (pages) / `requireFullAccessForAction` (actions) |
| Workflows / Analytics / Executions / conv-settings | agency, CO | agency (roles/webhook) | `requireWorkflowInsights` → `canSeeWorkflowInsights` (setter/staff 404) |
| `workflows/all/settings` | **agency only** | agency | `hasFullAccess`→404 (asymmetric vs per-wf settings which allow CO) |
| Inbox | agency, CO, setter | same | `requireClientModulePage("inbox")`→`canAccessClient`; actions `canAccessClient` |
| Contacts/CRM | agency, CO, setter | same | `requireClientModulePage("crm")`; actions `resolveClientModuleContext("crm")` **+ fine-grained `crmPermissions.ts`** |
| Custom fields | agency, CO | agency, CO | `requireClientModulePage("crm")` + `canManageClient` |
| Agenda | agency, CO, setter, **staff** | agency/CO/setter any column; staff own column | `requireClientModulePage("scheduling")` + `canOperateScheduling` + site/staff predicates |
| Scheduling admin / staff | agency, CO | agency, CO | `requireClientModulePage("scheduling")` + `canManageClient` |
| Time off | — | site closure: agency/CO; staff block: agency/CO/setter | `timeOffActions.ts` `canManageClient`/`canAccessClient` |
| Catalog/products | agency, CO, setter | create/edit: agency/CO; stock toggle: +setter | `requireClientModulePage("catalog")` + `canReadCatalog`/`canManageCatalog` |
| Reuniones (meetings) | agency, CO, setter | same (delete = owner/admin) | `requireClientModulePage("meetings")`→`canAccessClient`; `resolveAppScope` |
| Team (client) | agency, CO | agency, CO | `canManageClient`; only agency assigns `owner`; last-owner guard |
| Security `/settings/security` | any logged-in | self | `getServerSession` only (deliberate self-service) |
| Billing | — | — | **no billing surface exists** |

**UI-only protections:** none found that lack a matching server gate. Two weaker-than-expected but not-UI-only gates: `connectionActions.ts` (`addConnectionAction`, `setConnectionActiveAction`) gate only `requireTenant()` not `requireFullAccessForAction` (no member UI exposes it, but the action is not agency-gated); `getFieldCatalogAction` returns `[]` for non-agency (graceful).

**DISCREPANCY (CRM fine-grained rules key on TENANT role):** `web/lib/crmPermissions.ts:isFullAccess` keys on `owner/admin`, so a **Client Owner is treated as a limited "member"** for note/task/tag-catalog granularity (edit only own notes, manage own/assigned tasks, cannot manage the tag catalogue) — despite being described as "full control of their client." The module gate still admits them.

### A6. Routes inventory

- **Machine API families** (Bearer handoff token via `authenticateHandoffRequest`, capability chokepoint `src/db/repositories/handoffTokens.ts`; capabilities = `handoff, scheduling.read, scheduling.write, crm.read, crm.write, catalog.read`; scheduling/crm/catalog also require `X-Workflow-Ref`): `/api/handoff/v1/{messages,mode,escalations}` (`handoff`); `/api/scheduling/v1/{appointments(+[id]/{cancel,complete,confirm,no-show,reschedule}),availability,services,sites,staff}` (`scheduling.read`/`write`); `/api/crm/v1/contacts/{[id],[id]/notes,[id]/tags(+/[tag]),lookup,upsert}` + `/field-definitions` (`crm.read`/`write`); `/api/catalog/v1/products` (`catalog.read`, GET only).
- **Separate worker-token family** (`authenticateWorker`, hash-only creds in `meetings/credentials.ts`): `/api/meetings/v1/jobs/*`, `/api/meetings/v1/maintenance/*`.
- **Session JSON routes:** `/api/inbox/[clientId]/{conversations,.../messages,.../contact,pending-count}` (`resolveInboxAccess`); `/api/scheduling/internal/{availability,events}` (`getSessionScope` + predicates); **`/api/crm/v1/contacts/export/[clientId]`** and all **`/api/meetings/v1/meetings|report-templates/**`** are **session-authed despite the `/v1/` namespace** (`resolveClientModuleContext`/`resolveAppScope`).
- **Server-action families** (`web/lib/*Actions.ts`): client/clientModule/column/conversation/webhook/handoffToken/invite/member/inbox/send/inboxContact/contact/crm/fieldDefinition/catalog/scheduling/schedulingAdmin/timeOff/connection — gates per the matrix.
- **PUBLIC (unauthenticated) routes** (middleware is NOT the gate, CVE-2025-29927-aware; real gate at the data layer): `/api/health` (liveness), `/api/auth/[...all]` (Better Auth), `/api/booking/[slug]` POST + `/availability|/services|/staff` GET (rate-limit → kill switch → slug gate → strict zod → Turnstile), `/book/[siteSlug]` page, the auth UI pages, `/invite/accept` (token-hash validated). `/invite`, `/api/handoff`, `/api/scheduling`, `/api/crm`, `/api/catalog`, `/api/meetings/v1/{jobs,maintenance}` are middleware-cookieless but each enforces its own auth at the handler.

### A7. Docs inventory (vs code)

`docs/overview.md` (current), **`docs/schema.md` STALE** ("31 migraciones / 40 tablas" — repo has 46 migrations), `docs/public-booking.md` (matches), `docs/handoff-contract-v1.md` (matches code; **its n8n mapping is the D.1 landmine — §D.1**), `docs/machine-api-v1.md` + `machine-api-output-catalog.md`, the scheduling set (`scheduling-v1.md`, `scheduling-n8n-contract.md`, `scheduling-openapi.yaml`), the meetings set (`meetings-technical-design.md` rev 5 + stage/runbook/evidence), `docs/ops/*` (incl. `gallery-identity-diagnostic.sql` + runner — read-only identity diagnostics), `docs/proposals/gallery-*`. `DEPLOY.md` under-counts services (3 vs 4). Top-level `gallery_system_prompt_optimized.md` + `whatsapp_barber_bot_qa_report_*` are untracked client artifacts, not platform docs.

### A8. Tests & lint (counts)

- **Unit:** 1025 tests, **1024 pass / 1 fail** — the 1 is `test/unit/meetingsStorage.test.ts`, which imports `@aws-sdk/client-s3`. **Root `node_modules/@aws-sdk` does not exist** (the package is declared in root `package.json` but installed only under `web/node_modules`); this single missing install is the root cause of every "meetings" test/tsc failure.
- **Integration:** 374 tests. The reliable code-level baseline (same code, earlier same-session run against a migrated local Postgres) is **~315 pass / 46 fail**, where **all 46 failures are the four `meetings*` files** failing to import `@aws-sdk/client-s3`. ENV NOTE: in the final audit run local Postgres was down (`ECONNREFUSED 5432`), which inflated failures to 359 — an environment artifact, not a code regression.
- **tsc:** worker (`npm run typecheck`) and web (`tsc -p web/tsconfig.json`) both clean after filtering the pre-existing aws-sdk/meetings errors.
- **Lint:** `cd web && npm run lint` → **18 problems (14 errors, 4 warnings)** — the standing baseline (react-hooks `set-state-in-effect` / `refs-during-render` in agenda/booking-link/admin components).
- **Untested:** the public booking POST path has integration coverage; the meetings suites cannot run at the repo root until aws-sdk is installed there. No test exercises the session-authed server actions through a real Next request (they are source-contract + mocked-session tested).

### A9. scaling-todo + code markers

`scaling-todo.md` groups: automate migrations (preDeployCommand); wire health monitoring; replace polling with one SSE/WS channel; handoff/inbox H-2 (Human Agent role, cross-client hub inbox); conversation grid H-7; CRM D-2 lead/noise split; outbound send H-3 (**SSRF egress hardening in `web/lib/sendToWebhook.ts`** + durable queue); Setter billing/meetings policy; catalog deferrals; scheduling time-off/staff follow-ups.

Code markers: **0 FIXME / 0 HACK / 0 XXX.** ~20 real `TODO(...)` (most in `web/components/scheduling/AgendaView.tsx` — Month/Staff views, blocked-time/waitlist/KPI-delta models, `staff_id NOT NULL` so no unassigned walk-in; plus `StaffTab`/inbox TODOs). **`web/lib/auth.ts:101` carries a `DEBT` marker: `requireEmailVerification` is deliberately OFF — unverified accounts can sign in.**

---

## B. FEATURES (as implemented)

### B1. Observability
Ingestion is a **poller, not an endpoint** (A2). `executions` (`migrations/1780806820634` + `1780900000000` remodel): `tenant_id`, `n8n_connection_id`, `n8n_execution_id`, `n8n_workflow_id`, `status` (free text, not an enum), `started_at`, `duration_ms`, full `raw_data jsonb`; idempotency via `UNIQUE(n8n_connection_id, n8n_execution_id)` + `ON CONFLICT DO NOTHING`. Executions resolve to a client through `workflows.client_id` (not denormalized). **Analytics is computed on the fly per request — no materialized views anywhere** (`src/db/repositories/analytics.ts`; each page fires ~5 concurrent aggregate queries). Scaling hotspots: (1) `all_time_total`/`all_time_turns` subqueries have **no time bound** (full-history count every page load, `analytics.ts:121-122,173-174`); (2) no `(tenant_id, n8n_workflow_id)` index for per-workflow analytics; (3) full `raw_data` JSONB retained per execution grows the scanned table; (4) nothing cached/rolled-up.

### B2. Inbox / handoff
Contract (`docs/handoff-contract-v1.md`) matches code. Machine endpoints (Bearer, cap `handoff`): `POST /messages` (record inbound; dedup by `(conversation_id, external_message_id)`; also fires CRM auto-create), `GET /mode`, `POST /escalations` (bot→pending, inbox-module-gated). Modes `bot|pending|human` (`conversations.mode` CHECK, `migrations/1781700000000`); transitions enforced by the single chokepoint `src/db/repositories/handoff.ts:transitionMode` (row-locked, idempotent, one audit row in `conversation_mode_transitions`). Attention queue: `listConversationsFor{Workflow,Client}` float `mode='pending'` first; `active` flag derived at read (`last_user_message_at >= now - 24h`), never stored; pending-count endpoints feed the sidebar badge (~5s poll). **Conversation keying:** `UNIQUE(tenant_id, n8n_workflow_id, conversation_ref)` (`handoff.ts:getOrCreateConversation`). **`conversation_ref` is opaque, chosen by the n8n workflow — the platform never parses it** (contract §2). A conversation (`conversation_ref`) is distinct from a contact (resolved separately — B3). Gaps: no WhatsApp delivery receipts ingested; outbound webhook (exchange 4) has no retries; `conversation_ref` collisions possible if a workflow reuses a ref (see §D.1).

### B3. CRM
`contacts` (`1782000000000` + spine `1782600000000`): `tenant_id`, `client_id`, `channel` (free-text acquisition origin), `channel_user_id`, `phone_e164` (E.164 CHECK), `name`, `email`, `stage`, `assigned_to`, `messaging_consent`, `custom_fields jsonb`, `preferred_channel`, `do_not_contact`. **`contact_identities`** (recognition spine, `1782600000000:46`): `kind text CHECK IN ('phone','email','external')`, `UNIQUE(tenant,client,kind,value)`; classified by value (`classifyIdentity`). **Stage** = stored `contacts.stage NOT NULL DEFAULT 'new' CHECK IN ('new','active','customer','archived')`; "customer-ness" is additionally **derived** at read (≥1 completed appointment). Custom fields: definitions in `client_field_definitions` (type CHECK text/number/date/select/boolean), values in the `contacts.custom_fields` JSONB. Notes (`contact_notes`, soft-delete), **tasks (`crm_tasks` exists** — status open/completed/cancelled, priority, due_at), tags (`contact_tags`+`contact_tag_links`). Timeline unions 4 sources at read (`contactTimeline.ts`) + `crm_activity_events` (append-only; event types incl. `stage_changed`, `owner_changed`, `contact_merged`, `consent_changed`).
**Gaps (important):** (a) **Merge data loss** — `mergeContacts` (`contactIdentities.ts:802`) moves identities/appointments/conversations but **does NOT move notes/tasks/tags**, which then **CASCADE-delete** with the dropped contact; and it writes **no `contact_merged` timeline event**. (b) **Stage/owner changes via the web UI write no history** — `stage_changed`/`owner_changed` are recorded **only** at the machine PATCH route (`crm/v1/contacts/[contactId]/route.ts:88`), not in the repo `updateContact` or `updateContactAction`; a stage change in the CRM UI leaves no timeline entry. (c) consent/do_not_contact are **store-only** (nothing gates sends). (d) contact delete is a hard delete.

### B4. Scheduling
Tables (`1782000000001_scheduling-core` + follow-ups): `sites` (per-client, globally-unique `slug`, `opening_hours`/`scheduling_config` jsonb, `timezone` default America/Bogota), `services` (per-client after `1782200000000`; `description` ≤500 CHECK `1797000000000`; `price numeric(10,2)`; `featured`; `category ∈ {color,grooming,cut,feature}`), `staff` (an agendable resource; `working_hours` where `{}` = inherit site hours; PII `phone/email/emergency_*`; `title/employment_type/weekly_hours/start_date/skills/takes_bookings`; **PII projection: `StaffRow` vs admin-only `StaffAdminRow`**, enforced by `test/unit/staffPiiContract.test.ts`), `site_services`/`staff_services` (enablement + overrides), `schedule_exceptions` (time off: `staff_id NULL` = site closure, else one staff; `[starts_at,ends_at)`; `type` CHECK only `'blocked'`).
**Appointments** (`1782000000002_appointments.ts`): `public_reference uuid` (exposed; internal `id` never), snapshots `service_name_snapshot`/`duration_min_snapshot`/`price_snapshot`/buffer snapshots, `status`, `origin`, `created_by_type`, `version`. **Anti-double-book is Postgres-enforced** — GiST `EXCLUDE` on `(staff_id, tstzrange(blocked_from,blocked_until)) WHERE status IN ('scheduled','confirmed')` → 23P01 → `conflict_slot` 409; per-staff advisory lock serializes.
**Statuses — exactly five:** `scheduled | confirmed | completed | cancelled | no_show` (DB CHECK = `AppointmentStatus` type). State machine (`src/scheduling/booking.ts:LEGAL_STATUS`): scheduled→{confirmed,completed,cancelled,no_show}; confirmed→{completed,cancelled,no_show}; completed/cancelled/no_show terminal. **Who sets each:** `scheduled` = every create (public `origin:public`, n8n `origin:n8n` cap `scheduling.write`, internal `createManualAppointmentAction` `origin:internal|walk_in`); `confirmed/completed/cancelled/no_show` = n8n `/api/scheduling/v1/appointments/[id]/*` OR internal `{confirm,complete,cancel,noShow}AppointmentAction` via `transitionStatus`; reschedule keeps the id. **No cron auto-transitions** (nothing auto-completes/no-shows). **Status changes ARE logged, two ways:** `appointment_events` (append-only audit, written inside the booking txn — created/confirmed/completed/cancelled/no_show/rescheduled, with `{from,to,reason}`) and `scheduling_events` (realtime poll feed, after commit). There are **no per-status timestamp columns**; `updated_at`/`version` bump on each transition. **Price IS snapshotted** (`price_snapshot` copied at booking via `resolveEffectivePrice`; reschedule reuses the snapshot, never re-reads live service).
**Gaps:** reschedule has no public path and captures no reason; `schedule_exceptions.type` only `'blocked'` (no vacation/holiday typing); **two parallel exception-writing paths** — the newer `timeOffActions.ts` (conflict flow, staff/site tiers, Spanish) vs the older `schedulingAdminActions.ts:createException/deleteException` (no conflict flow, English).

### B5. Catalog (products)
`products` (`1798000000001`): per-client, `price numeric(10,2) NOT NULL CHECK (>0)`, `category` free text, `in_stock` boolean (manual, not a quantity), `is_active` (soft-delete), `sort_order`, description ≤500 CHECK, partial UNIQUE on active folded name. Machine API `/api/catalog/v1/products` **GET only** (`catalog.read`; returns out-of-stock so the bot can say "agotado"; capped 200). INFORM-ONLY — no orders/stock-counts/payments. Gap: `sort_order` not reachable from the UI; `name` 200-char cap is app-only. No currency column (COP hard-coded via `priceLabelCOP`).

### B6. Team / invitations / emails
Server actions only (no REST). `invitations` (`1781600000000`): `role admin|member`, `token_hash` (SHA-256; raw token 256-bit, shown once), `status pending|accepted|revoked|expired`, 7-day TTL, partial UNIQUE `(tenant,email) WHERE pending`. Client roles via `1790000000000_client-roles` (+`client_role`, drops `scheduling_access`) then `1795000000000` (editor→setter); live values `owner|setter|staff`. Flow: `createInvitationAction` (escalation gate `canGrantClientRole`) → email → `/invite/accept` (re-validates hash/status/expiry/session-email) → transactional single-use accept. **Three Resend emails** (invitation, email-verification, password-reset; raw REST, inline HTML, degrade gracefully). Gaps: email verification OFF; `status='expired'` never written (computed live); stale `editor` comments; per-replica in-memory rate limiting; single-tenant-per-user.

### B7. Meetings ("Reuniones")
A per-client module: browser uploads a recording via presigned PUT → external GPU worker pipeline (normalize→transcribe→diarize) over the HTTP job queue → `mai` aligns + persists `meeting_segments` → **OpenAI** summary/reports generated **synchronously in the web request** → UI tabs Resumen/Transcript/Reportes/Evidencia. ~10 tables (`1783400000000`–`1784300000000`): `meetings`, `meeting_media` (+`storage_key`), `meeting_processing_{runs,jobs}` (the queue), `meeting_job_events`, `meeting_transcript_versions`, `meeting_segments` (transcript text), `meeting_speakers`, `worker_pools`/`worker_credentials` (hash-only tokens), `meeting_result_uploads` (+`storage_key`), `meeting_analyses`, `meeting_report_templates`. Fully wired UI, module-gated. **Depends on `@aws-sdk/client-s3`** (A8/E). The GPU worker is external (`tools/w3/worker/` holds only deploy artifacts). Gaps: only `source_kind='file'` is wired; no "chat with the meeting"; retention `delete_after` not yet computed.

### B8. Design system + i18n
Tailwind v4 (no `tailwind.config.*`), tokens as CSS vars in `web/app/globals.css` exposed via `@theme inline`; class-based light/**dark** (`next-themes`). Bespoke primitives (`web/components/ui/controls.tsx`, `primitives.tsx`) — **no Radix/shadcn/cva/lucide**; icons are inline SVG; fonts Geist/Geist Mono. **i18n: NONE.** No i18n library/layer; every string is hardcoded inline. The UI is **Spanish-first but genuinely mixed with English** with no switch: e.g. `AppSidebar.tsx` shows `"Workflows"/"Inbox"/"Contacts"/"Staff"` beside `"Reuniones"/"Catálogo"/"Productos"`; `web/components/scheduling/staff/StaffCreateDrawer.tsx` is entirely English while sibling `StaffTab.tsx` is Spanish; server-action errors are mixed (`schedulingActions.ts` Spanish, `schedulingAdminActions.ts` English). Routes mix too (`reuniones` vs API `meetings`).

---

## C. THE PUBLIC BOOKING PAGE (deep dive)

### C1. Structure
UI `web/app/book/[siteSlug]/page.tsx` (server component, `force-dynamic`, `generateMetadata`); public API (no auth/cookies) `web/app/api/booking/[slug]/{route(POST),availability,services,staff}`. Components `web/components/booking/*` (`BookingFlow` orchestrator + `ServiceList`/`StaffChooser`/`MonthCalendar`/`SlotPicker`/`BookingSummary`/`TurnstileField`/`BookingConfirmation`). **Slug is per-SITE, globally unique** (`sites.slug NOT NULL UNIQUE`, `1782000000001:39`). Resolver `getPublicBookingSiteBySlug` (`src/db/repositories/scheduling/sites.ts:62`) returns a site only when active + client non-default + scheduling module enabled; any failure → one generic 404. A `PUBLIC_BOOKING_DISABLED` kill switch short-circuits first. One client may own many sites; each is its own `/book/{slug}`.

### C2. Configurable per business vs hardcoded
| Item | Source |
|---|---|
| Site **name** | DB `sites.name` |
| **Logo** | DB `clients.logo_url` (per client, https-only; monogram fallback) |
| Colors/theme | **HARDCODED** platform tokens (no per-business color column) |
| Fonts | **HARDCODED** Geist |
| Hero/images | **ABSENT** (logo thumbnail only) |
| Section copy | **HARDCODED inline Spanish** |
| Policies | **ABSENT** as content; only a privacy-policy LINK from env (global) |
| Address | DB `sites.address` (text; no map) |
| Social links | **ABSENT** |
| Services/staff + order | DB (`site_services`/`services` `featured DESC,name`; active `takes_bookings` staff) |
| Language | **HARDCODED es-CO** |
| Currency | **HARDCODED COP** (`web/lib/money.ts:priceLabelCOP`) |
| Timezone | DB `sites.timezone` |
| Domain | **HARDCODED path** `/book/{slug}` on current origin |
| SEO title/desc | semi-config (interpolates `site.name`, Spanish copy) |
| OG image | **ABSENT** |
| Favicon | **HARDCODED** single platform favicon |
| Indexing | **HARDCODED noindex** (by design) |

### C3. Hardcoding grep
**"Gallery" appears nowhere on the public booking surface** (only tests, ops docs, internal-admin doc-comments). Business-vertical/locale literals that DO ship: `web/components/booking/ServiceList.tsx:28-34` barbershop section labels ("Cortes/Barba y cuidado/Color/Tratamientos"); `web/lib/agendaCategory.ts:74-87` grooming keyword classifier; `web/lib/money.ts` COP; `BookingFlow.tsx:77-82` country codes default +57; locale literals (`es_CO`, `lang="es"`, `"a. m."/"p. m."`, city map) in `page.tsx`/`siteCalendar.ts`/`TurnstileField.tsx`/`bookingIcs.ts`. All customer-facing strings are inline literals (no strings layer).

### C4. Booking flow
3 steps (service+optional staff → slot → name/phone/optional email/required privacy checkbox/optional Turnstile) → `POST`. Server-side pipeline (`route.ts`): IP burst limit → kill switch → **gate-before-body** (`getPublicBookingSiteBySlug`) → fail-closed if no hash secret → persistent IP+site rate bucket (Postgres, HMAC) → **strict zod** (`.strict()`, `privacy_accepted: z.literal(true)`, unknown keys rejected) → future-time check → Idempotency-Key → **Turnstile fail-closed** (only if enabled) → phone+site bucket (normalized E.164) → `createAppointment`. **Contact create/reuse: by phone only** — phone normalized to E.164 against the site's region; match via `resolveContactByIdentity`; email is an attribute, not a match key. A public booking always has a phone (zod min 7; engine refuses no-phone public). **Confirmation: on-screen + .ics only** — no email/SMS/WhatsApp to the customer. **Business notification: none** beyond the in-app `scheduling_event` `appointment.created`. Responses carry no customer PII; logs hash everything.

### C5. Reviews / ratings — **ABSENT**
Exhaustive grep (review/rating/reseña/calificación/stars/feedback/nps, accents) across the booking surface and `src/` returns **zero functional hits** — only false positives (rate-**limit** logs, "opinion" comment). There is **no reviews/ratings table or migration** anywhere. The success screen offers only "Añadir a mi calendario" (.ics) and "Reservar otra cita." **No review link/token, no storage, no tie to appointment/staff, no moderation, no display, no external (Google) integration.** **A per-staff average rating cannot be computed — the data does not exist.** The operator's "rating link" is not produced by this codebase (likely a manual link elsewhere). This is a greenfield feature.

### C6. Attribution readiness — essentially ABSENT
No UTM capture (POST body is `.strict()`, lists only booking fields; client never collects UTMs). No referrer capture (`Referrer-Policy: strict-origin-when-cross-origin`). Source on the appointment is only coarse `origin:"public"`/`created_by_type:"public"`/`channel:"public"`; `source_conversation_id` stays null for public bookings. **No Meta Pixel / GA / PostHog / any analytics script** on the booking path (only Cloudflare Turnstile when enabled).

### C7. Abuse & privacy — strong
Two-layer rate limiting (in-memory burst + **persistent cross-instance Postgres HMAC buckets**, `migrations/1796000000000`; IP/phone never stored in clear; fails closed without a hash secret). Strict zod validation, uuid pre-checks, future-time check. Cloudflare Turnstile, server-verified, fail-closed (off by default). Minimal PII in responses (random `public_reference`, no name/phone/email echoed; `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`); staff public list excludes PII.

### C8. Quality
Server component + `force-dynamic`, services pre-loaded server-side; all API routes `no-store`; availability 60s client cache. Built for Instagram/WhatsApp in-app browsers (no popups/cookies, 44px targets, `autocomplete`/`inputMode`, zoom not blocked). Solid a11y basics (focus management, `aria-live`, labeled inputs). No N+1 (single-statement public queries, bounded payloads).

### C9. VERDICT
**Another Colombian, Spanish-speaking, peso-priced barbershop → CONFIG ONLY (no code):** create client row + logo, enable `scheduling`, create a site with a unique slug/name/address/timezone/hours, add services + staff. `/book/{slug}` serves its own brand immediately. **Code changes required if the brand differs on vertical/locale:** language (no i18n layer — edit all `web/components/booking/*`, `page.tsx`, `publicBookingApi.ts`, `route.ts`, `siteCalendar.ts`, `bookingIcs.ts`), currency (`web/lib/money.ts` + a currency column), service-category labels (`ServiceList.tsx`, `agendaCategory.ts`), country default (`BookingFlow.tsx`), per-business theme color (new column + token injection), OG image/favicon/custom domain (absent). **Greenfield the operator may assume exists:** reviews/ratings, customer confirmations beyond on-screen, business notifications, marketing attribution/pixels. **Scalability: MEDIUM-HIGH for the target vertical, LOW for a different vertical/locale** — the identity-safe resolver + leak-free projections + shared engine + persistent rate limiting + zero client-name hardcoding make onboarding another Spanish/COP barbershop pure data entry; the hard-wired Spanish+COP+barbershop assumptions cap it below "high" for arbitrary brands.

---

## D. READINESS FOR THE NEXT ARC

### D.1 WhatsApp identity (highest priority)
**The BSUID fix (`1444d5a`) is sound but incomplete.** It added `src/scheduling/phone.ts:isBsuid` (`^[A-Za-z]{2}\.[A-Za-z0-9]+$`) and made `normalizeE164` return `null` for a BSUID **before** digit logic (previously it invented a phone `+2405…` that could collide with a real customer); `classifyIdentity` now files a BSUID as `external` verbatim; read-only legacy compat (`legacyBsuidPhone`) still finds contacts the old code mis-created. The "invented-phone collision" class is fixed.

Trace of a no-phone message (`user_id="CO.2405…"`, username set, no phone):
- **`POST /api/handoff/v1/messages`** — phone is **not a field**; required are `workflow_ref` + `conversation_ref` + `sender`. A no-phone message **passes** as long as `conversation_ref` is non-empty.
- **Contact resolution** — `ensureContactForInboundMessage` → `resolveContactByIdentity({channelUserId: conversation_ref, identities})`; `CO.2405…` → `external` value = the BSUID → correct, distinct per BSUID. Missing phone fails nothing. `contact_identities` **can store a BSUID and a username today — both as kind `external`** (the enum is `phone|email|external`; no dedicated kind; `label` is display-only).
- **Conversation** — keyed on `(tenant, n8n_workflow_id, conversation_ref)`.
- **Scheduling phone paths** — create with a BSUID as `customer_phone` → `normalizeE164` null → **`invalid_phone`, zero writes (fails loud)**. Create with BSUID as `channel_user_id` (no phone) → resolves by `external` → works. Create with neither phone nor channel_user_id → a **no-contact walk-in** appointment (silent, not a collapse). GET `?phone=`/`?external_id=` → empty match → 0 rows (never the whole client). by-time/by-id transitions use the appointment id → unaffected.

**PRIVACY DEFECT — sentinel-string collapse (unfixed, flagged hard).** There is **no guard against a literal `"undefined"`/`"null"` identifier anywhere.** The still-documented n8n mapping `conversation_ref = {{ ...contacts[0].wa_id }}` (`docs/handoff-contract-v1.md:250,283`) renders the **string `"undefined"`** when Meta omits `wa_id`. Because that string has length ≥ 1: (a) every no-phone user's messages key to `(tenant, workflow, "undefined")` → **one shared conversation = strangers' chats merged**; (b) `resolveContactByIdentity` stores `external` value `"undefined"` under a UNIQUE → **one shared contact**. Even sending a real phone in `identities` fixes the contact but **not** the conversation (still keyed on the sentinel ref). **Action items:** remap `conversation_ref` AND the primary identity to `user_id` (BSUID), pass `wa_id`/phone + `username` as extra `identities`; and add a platform-side sentinel-reject (`undefined`/`null`/empty-after-trim) in the `/messages` zod body and/or `classifyIdentity` (absent today).

**READ-ONLY production checks** (any row in Q1/Q2 = active privacy collapse; `docs/ops/gallery-identity-diagnostic.sql` covers the legacy-phone angle):
```sql
-- Q1. Identity values that are empty or sentinel strings (collapse magnets).
SELECT ci.kind, ci.value, count(*) AS rows, count(DISTINCT ci.contact_id) AS contacts
FROM contact_identities ci
WHERE btrim(ci.value) = ''
   OR lower(btrim(ci.value)) IN ('undefined','null','nan','none','false','true')
GROUP BY ci.kind, ci.value ORDER BY contacts DESC, rows DESC;

-- Q2. Conversations keyed on a sentinel/empty ref, and how many DISTINCT contacts they mix.
SELECT btrim(coalesce(c.conversation_ref,'(null)')) AS ref, c.n8n_workflow_id,
       count(*) AS conversations, count(DISTINCT c.contact_id) AS distinct_contacts
FROM conversations c
WHERE c.conversation_ref IS NULL OR btrim(c.conversation_ref) = ''
   OR lower(btrim(c.conversation_ref)) IN ('undefined','null','nan','none')
GROUP BY ref, c.n8n_workflow_id ORDER BY conversations DESC;

-- Q3. Contacts whose channel_user_id is empty/sentinel.
SELECT id, client_id, channel, channel_user_id, phone_e164, email, name, created_at
FROM contacts
WHERE btrim(coalesce(channel_user_id,'')) = ''
   OR lower(btrim(channel_user_id)) IN ('undefined','null','nan','none') ORDER BY created_at;

-- Q4. One contact linked to many distinct conversation refs (collapse bucket).
SELECT contact_id, count(*) AS conversations, count(DISTINCT conversation_ref) AS distinct_refs
FROM conversations WHERE contact_id IS NOT NULL
GROUP BY contact_id HAVING count(DISTINCT conversation_ref) > 3 ORDER BY distinct_refs DESC;
```

### D.2 Inbound metadata / referral + source field
`/api/handoff/v1/messages` `Body` is a plain `z.object` (**no `.strict()`, no `.passthrough()`**) → Zod's default **strips** unknown top-level keys. A top-level Meta `referral` object is **silently dropped** (not rejected, not stored). It survives today **only if nested inside the existing `metadata: z.record(...)`** (stored on the message row, but nothing parses/indexes it). (Contrast: `crm/v1/contacts/upsert` IS `.strict()` → 422 on unknown; `scheduling/v1/appointments` is non-strict → strips.) **Source/origin fields today:** `contacts.channel` (free-text acquisition origin), `contact_identities.label`, `appointments.origin` (`public|n8n|internal|walk_in`). **No UTM/ad_id/campaign/referral column exists anywhere** — per-ad attribution is net-new (a column or a typed `metadata`/`custom_fields` convention).

### D.3 Pipeline (Lead→Qualified→Booked→Attended→Paid + Lost)
**Reuse:** `contacts.stage` exists (`new|active|customer|archived`, indexed) — a 5-stage funnel needs the CHECK widened/replaced (current values don't map), and must reconcile with the derived "customer = ≥1 completed appt." `crm_activity_events` already records `stage_changed` and reuses cleanly for stage history (but note B3 gap — the web UI doesn't write it today). **Conflict:** migration comment is explicit — "NO companies/deals/pipelines" (`1782700000000:5`); `contacts.stage` is **per-person, not per-deal**, so a repeat customer can't be both "Lead" and "Paid." A real funnel likely needs a deal/opportunity entity (does not exist).
```sql
-- Current stage distribution per client.
SELECT client_id, stage, count(*) AS contacts FROM contacts GROUP BY client_id, stage ORDER BY client_id, stage;
```

### D.4 Payments — essentially absent
Only money fields: `appointments.price_snapshot` (price as booked), `services.price`, `products.price`. **No payments/orders/invoices/transactions table; no tips, methods, deposits, amount-paid, or checkout/Stripe/Wompi/MercadoPago.** "Paid" and "Attended" are indistinguishable today (both = `status='completed'`; there is no record money changed hands). A Paid stage / revenue-collected dashboard is net-new.

### D.5 Staff commission/compensation — absent
No commission/rate/pay/payout field on `staff` (`1783200000000`). Per-staff **revenue** is derivable from `price_snapshot` grouped by `staff_id` (already used for staff metrics); **commission %/payout is net-new.**

### D.6 Consent / opt-out — present, store-only
`contacts.messaging_consent` (`unknown|opted_in|opted_out`, +`consent_updated_at/source`) and a separate `contacts.do_not_contact boolean` + `preferred_channel`. **Store-only by design — nothing gates sends on them today** (`contacts.ts:36`, migration headers). Any marketing-send feature must add the opt-out/`do_not_contact` gate; the data is there, the enforcement is not.

### D.7 Outbound events / webhooks
The only real outbound to n8n is the **handoff webhook** (`handoff_webhooks`, HMAC-signed), firing **only when a human agent replies** in a `human`-mode conversation (`web/lib/sendToWebhook.ts`); **no retries**. **`scheduling_events` is internal-only** — written after commit by `recordSchedulingEvent`, read by exactly one consumer (the session-authed agenda poll route `scheduling/internal/events`); it is **not** pushed to n8n. There is **no "appointment.completed → n8n" / "stage changed → n8n" channel** — a lifecycle flow (booked→reminder→attended→review→paid) needs a new outbound webhook or a pollable read API.

### D.8 Fresha import — dry-run planner, writes nothing
`src/scheduling/reconcile/freshaPlan.ts` is a **pure planner** ("never writes, never reads a database, never calls Fresha"); `src/scripts/freshaReconcileDryRun.ts` feeds it from files. It can **represent** historical appointments with staff + price (`MaiSnapshot.appointments[].priceSnapshot/staffId`) and match by idempotency key `fresha:<loc>:appointment:<id>`, but every outcome is a `PlanAction` with `needsDecision`/`dryRun:true` — **nothing is applied.** Loading historical appointments (with staff+price) into the DB is net-new (the write side + contact resolution + idempotent insert); the idempotency keys are already designed for it.

### D.9 Other things the arc will trip over
1. The **sentinel-string collapse** (D.1) corrupts attribution/pipeline/per-ad metrics at the source if `conversation_ref` ever degrades — fix before building dashboards.
2. **Attribution is forward-only** (`handoff-contract-v1.md:121` — I-1 never retro-joins history); pre-remap leads won't backfill.
3. `contacts.stage` is **per-person, not per-visit/deal** (D.3).
4. **"Paid" needs a payments table** (D.4) — can't be derived from completed appointments.
5. **No per-ad/per-staff dashboard primitives** beyond `price_snapshot` (commission + ad dimension absent).
6. **Loyalty**: no points/membership/rewards/voucher tables — fully net-new.
7. **Outbound automation gap** (D.7) — no lifecycle event leaves the platform.
8. **Consent not enforced** (D.6) — a marketing send today would message opted-out contacts.

---

## E. RISKS & DEBT (ordered by severity)

1. **[Privacy, HIGH] Sentinel-string identity collapse for no-phone WhatsApp users.** No guard against `conversation_ref`/identity value = literal `"undefined"`/`"null"`; with the still-documented `wa_id` mapping, no-phone strangers merge into one conversation + one contact. Evidence: `handoff.ts:getOrCreateConversation` (key), `contactIdentities.ts:29-38,156-184,442-485` (no sentinel check), `docs/handoff-contract-v1.md:250`. Run D.1 Q1/Q2 in prod. The `1444d5a` fix addressed invented phones, **not** this.
2. **[Data loss, HIGH] CRM merge deletes notes/tasks/tags.** `mergeContacts` (`contactIdentities.ts:802`) moves identities/appointments/conversations but not `contact_notes`/`crm_tasks`/`contact_tag_links`, which CASCADE-delete with the dropped contact; no `contact_merged` timeline event is written. A user-facing "merge duplicates" action silently loses history.
3. **[Availability/runtime, HIGH] `@aws-sdk/client-s3` not installed at the repo root.** Declared in root `package.json` but absent from root `node_modules` (present only under `web/`). Breaks all meetings unit/integration tests AND would **crash the `maintenance` service at runtime** (`src/maintenanceMain.ts` → `s3PrivateStore` → `@aws-sdk`) if it runs from the root install. Fix: `npm install` at root (verify the maintenance service build includes aws-sdk).
4. **[AuthN, MEDIUM-HIGH] Email verification is OFF by design.** `web/lib/auth.ts:101` `DEBT`: `requireEmailVerification=false` — unverified accounts can sign in. Combined with self-service `/settings/security`, review before onboarding external users.
5. **[Audit gap, MEDIUM] Stage/owner changes via the web UI write no timeline history.** Only the machine PATCH records `stage_changed`/`owner_changed` (`crm/v1/contacts/[contactId]/route.ts`), not `updateContact`/`updateContactAction`. The pipeline arc depends on stage history being complete.
6. **[Scaling, MEDIUM] Analytics are per-request with unbounded all-time subqueries and no materialization.** `analytics.ts` fires ~5 live aggregates per page; `all_time_*` subqueries scan full history each load; no `(tenant, workflow)` index; full `raw_data` JSONB retained. Fine now, degrades with execution volume (`scaling-todo.md` acknowledges, nothing built).
7. **[AuthZ, MEDIUM] `connectionActions.ts` gated only by `requireTenant`.** `addConnectionAction`/`setConnectionActiveAction` aren't `requireFullAccessForAction` though the page is agency-only; any authenticated tenant member could invoke them (no member UI exposes it). Tighten to full-access.
8. **[Deliverability/compliance, MEDIUM] Consent is store-only.** `messaging_consent`/`do_not_contact` gate nothing; a marketing-send built now would message opted-out contacts. Add the gate when sends ship.
9. **[Ops, MEDIUM] Migrations are not auto-applied.** `code-outruns-schema` outage class (has happened once per `scaling-todo.md`). Add `preDeployCommand: npm run migrate:prod up` to `railway.worker.json`.
10. **[Consistency/debt, LOW-MEDIUM] Divergences & doc drift.** Two parallel `schedule_exceptions` writers (`timeOffActions` vs `schedulingAdminActions.createException`); CRM fine-grained rules key on tenant role so a Client Owner is a limited "member" for notes/tasks/tag-catalogue (`crmPermissions.ts`); session-authed routes under `/v1/` namespaces (`crm/v1/.../export`, `meetings/v1/meetings`); mixed Spanish/English UI with no i18n layer; stale docs (`schema.md` 31→46 migrations, `DEPLOY.md` 3→4 services, `editor`→`setter` comments); handoff outbound webhook has no retries; SSRF egress not hardened in `web/lib/sendToWebhook.ts` (scaling-todo); catalog `sort_order` not reachable from the UI.

**Recent contributor changes to identity/permissions/public routes** (for context): `1444d5a` (BSUID = opaque identity, never a phone — identity fix, §D.1); the `public-booking-v2` + `gallery-incidents` + `platform-redesign` merges reworked the booking page and agenda/staff UI (multi-tenant, identity-safe — §C) and added the Fresha dry-run planner (§D.8); `1790000000000`/`1795000000000` introduced client roles and renamed editor→setter. None introduced a UI-only-protected surface (§A5).
