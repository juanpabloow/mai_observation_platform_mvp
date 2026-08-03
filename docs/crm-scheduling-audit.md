# CRM + Scheduling Audit (Phase C-0)

**Read-only audit.** No code was changed. Purpose: establish exactly what exists today so a build plan can be written against reality. Where docs and code disagree, the **code is trusted**. "Not built" / "unclear" is preferred over guessing.

- **Date:** 2026-07-28
- **Commit audited:** `c00e8e7` (HEAD of `main`)
- **Method:** read of migrations + `src/scheduling/**` + `src/db/repositories/**` + `web/app/api/**` + UI components + `docs/`, plus live introspection of the dev DB (`observability-postgres` / db `observability`) via `pg_dump --schema-only` and `\d+`. The live schema matches the migrations exactly.

---

## ⚠️ Critical finding read first: the CRM "operational" layer was merged, then REVERTED

The current HEAD `c00e8e7` is **`Revert "Merge pull request #2 … feature/crm-operational-v1"`**. The branch `feat(crm): add operational contact workspace` (commit `1e9f07c`, merged at `b410797`) added contact **notes, tasks, tags, and an activity-timeline workspace**, and was then reverted in full. Consequently the following are **NOT in the current tree** (do not assume they exist):

- migration `migrations/1782400000000_crm-operational.ts` (gone)
- repositories `src/db/repositories/{crmTasks,crmActivityEvents,contactTimeline,contactNotes,contactTags,contactCrm}.ts` (gone)
- components `web/components/crm/*` (`ContactHeader`, `NotesPanel`, `TasksPanel`, `TimelinePanel`, `tagColors`, `types`) (gone)
- server actions `web/lib/{crmActions,crmPermissions,crmValidation}.ts` (gone)
- tests `test/integration/crmOperational.test.ts`, `test/unit/{crmPermissions,crmValidation}.test.ts` (gone)

The dev DB confirms this: its last applied migration is `1782300000000_inbox-module` (via `pgmigrations`); there are **no** `crm_tasks` / `crm_notes` / `contact_timeline` / `crm_activity` tables. **What exists today = the *basic* contacts layer (`1782000000000_crm-contacts`) + the full scheduling engine.**

> Historical note: on 2026-07-27 the operational migration was briefly present locally (the user asked for the Railway migrate command); it has since been reverted on `main`. If a future build plan wants notes/tasks/tags, that reverted work is recoverable from git history (`git show 1e9f07c`) but is not the current baseline.

---

## A. SCHEMA

Source of truth: migrations in `migrations/` + live dev-DB introspection (matches exactly). All timestamps are `timestamptz` (UTC) throughout.

### Dev-DB row counts (HEAD `c00e8e7`)

Every CRM/scheduling table is **empty** — the features have never been exercised with data in this dev DB.

| Table | Rows | | Table | Rows |
|---|---|---|---|---|
| contacts | **0** | | appointment_events | **0** |
| sites | **0** | | scheduling_events | **0** |
| staff | **0** | | client_modules | 2 |
| services | **0** | | conversations | 0 |
| site_services | **0** | | conversation_turns | 105 |
| staff_services | **0** | | handoff_webhooks | 1 |
| schedule_exceptions | **0** | | workflows | 6 |
| appointments | **0** | | clients | 7 |
| — | | | tenants | 5 · user 3 |

### 1. `contacts` — canonical person entity — `1782000000000_crm-contacts.ts:40-68`

Columns: `id` uuid PK `gen_random_uuid()`; `tenant_id` uuid NN; `client_id` uuid NN; `channel` text NN (**free text, no CHECK**); `channel_user_id` text NN; `phone_e164` text NULL; `name` text NULL; `email` text NULL; `bot_human_mode` text NN `'bot'`; `stage` text NN `'new'`; `assigned_to` text NULL; `first_contact_at`/`last_contact_at` timestamptz NN `now()`; `message_count` int NN `0`; `created_at`/`updated_at` timestamptz NN `now()`.
- **PK** `(id)`. **UNIQUE** `(tenant_id, client_id, channel, channel_user_id)`.
- **FK**: `tenant_id`→`tenants(id)` **CASCADE**; `(client_id,tenant_id)`→`clients(id,tenant_id)` **NO ACTION**; `assigned_to`→`"user"(id)` **SET NULL**.
- **CHECK**: `bot_human_mode IN ('bot','human')`; `stage IN ('new','active','customer','archived')`; `phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$'`.
- **Indexes**: `(tenant_id,client_id)`; `(tenant_id,client_id,phone_e164)`; `(tenant_id,client_id,stage)`; `(assigned_to)`.
- Same migration added `conversations.contact_id uuid` NULL → `contacts(id)` **SET NULL** (+ index).

### 2. `sites` — `1782000000001_scheduling-core.ts:32-51`
`id` PK; `tenant_id` NN; `client_id` NN; `slug` text NN; `name` NN; `address` NULL; `timezone` text NN `'America/Bogota'` (IANA); `opening_hours` jsonb NN `'{}'`; `scheduling_config` jsonb NN (default `{slot_interval_min:15,min_notice_min:120,booking_horizon_days:30,default_buffer_before_min:0,default_buffer_after_min:0}`); `active` bool NN `true`; timestamps.
- **UNIQUE** `slug` (**globally unique**, not per-tenant). **FK**: `tenant_id` CASCADE; `(client_id,tenant_id)` NO ACTION. **CHECK** slug regex. **Indexes** `(tenant_id)`, `(tenant_id,client_id)`.

### 3. `staff` — `scheduling-core.ts:56-65`
`id` PK; `tenant_id` NN; `site_id` NN; `name` NN; `working_hours` jsonb NN `'{}'` (`{}` = inherit site opening hours); `active` bool NN `true`; timestamps.
- **FK**: `tenant_id` CASCADE; `site_id`→`sites(id)` **CASCADE**. No UNIQUE, no CHECK. **Index** `(tenant_id,site_id)`.
- **One staff belongs to exactly one site** (single `site_id` FK; no staff↔site join). **No `timezone` column.**

### 4. `services` — per-client catalogue — `scheduling-core.ts:69-81` + `1782200000000_services-per-client.ts`
`id` PK; `tenant_id` NN; `client_id` NN (added later, backfilled); `name` NN; `description` NULL; `duration_min` int NN; `price` numeric(10,2) NULL; `buffer_before_min`/`buffer_after_min` int NN `0`; `active` bool NN `true`; timestamps.
- **FK**: `tenant_id` CASCADE; `(client_id,tenant_id)` NO ACTION. **No UNIQUE** (two clients may share a service name). **CHECK** `duration_min>0`, `price>=0 or null`, buffers `>=0`. **Index** `(tenant_id,client_id)`.

### 5. `site_services` — enable a service at a site — `scheduling-core.ts:85-96`
`id` PK; `tenant_id` NN; `site_id` NN; `service_id` NN; `active` bool NN `true`; `duration_override_min` int NULL; `price_override` numeric(10,2) NULL; timestamps.
- **UNIQUE** `(site_id,service_id)`. **FK** all CASCADE. **CHECK** overrides null-or-positive. **Indexes** `(tenant_id)`, `(service_id)`.

### 6. `staff_services` — a staff member can perform a service — `scheduling-core.ts:101-112`
Same shape as `site_services` but `staff_id` instead of `site_id`. **UNIQUE** `(staff_id,service_id)`; FKs CASCADE; `duration_override_min` / `price_override`; indexes `(tenant_id)`, `(service_id)`.

### 7. `schedule_exceptions` — blocked time — `scheduling-core.ts:117-129`
`id` PK; `tenant_id` NN; `site_id` NN; `staff_id` uuid **NULL** (NULL = whole-site block; else that staff only); `starts_at`/`ends_at` timestamptz NN; `reason` text NULL; `type` text NN `'blocked'`; timestamps.
- **FK** all CASCADE. **CHECK** `ends_at>starts_at`; `type IN ('blocked')` (single value). **Indexes** `(tenant_id,site_id,starts_at)`, `(staff_id,starts_at)`.
- **One-off intervals only** — two absolute `timestamptz` bounds, **no recurrence columns**.

### 8. `appointments` — `1782000000002_appointments.ts:39-96`
`id` PK; `public_reference` uuid NN `gen_random_uuid()` (**UNIQUE**, safe to expose); `tenant_id` NN; `client_id` NN (denormalized); `site_id` NN; `contact_id` uuid **NULL**; `source_conversation_id` uuid NULL; `staff_id` NN; `service_id` NN; `start_at`/`service_end_at`/`blocked_from`/`blocked_until` timestamptz NN; `service_name_snapshot` text NN; `duration_min_snapshot` int NN; `price_snapshot` numeric(10,2) NULL; `buffer_before_min_snapshot`/`buffer_after_min_snapshot` int NN `0`; `status` text NN `'scheduled'`; `origin` text NN; `created_by_type` text NN; `created_by_user_id` text NULL; `idempotency_key` text NULL; `version` int NN `1`; timestamps.
- **UNIQUE**: `public_reference`; partial `(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL` (`appointments_idempotency_key_uniq`).
- **EXCLUSION (anti-double-book)**: `appointments_no_overlap EXCLUDE USING gist (staff_id WITH =, tstzrange(blocked_from, blocked_until, '[)') WITH &&) WHERE (status IN ('scheduled','confirmed'))` — Postgres-enforced, raises SQLSTATE `23P01` → HTTP 409. Requires `btree_gist`.
- **FK**: `tenant_id` CASCADE; `(client_id,tenant_id)` NO ACTION; `site_id` CASCADE; `contact_id`→`contacts(id)` **SET NULL**; `source_conversation_id`→`conversations(id)` **SET NULL**; `staff_id` CASCADE; `service_id` CASCADE; `created_by_user_id`→`"user"(id)` **SET NULL**.
- **CHECK**: `service_end_at>start_at`; `blocked_until>blocked_from`; `blocked_from<=start_at AND blocked_until>=service_end_at`; `status IN (scheduled,confirmed,completed,cancelled,no_show)`; `origin IN (public,n8n,internal,walk_in)`; `created_by_type IN (system,agent,public,n8n)`; snapshot duration>0, buffers>=0.
- **Indexes**: `(tenant,client,start_at)`, `(tenant,site,start_at)`, `(tenant,staff,start_at)`, `(tenant,status)`, `(tenant,start_at)`, `(contact_id)`, `(source_conversation_id)`.

### 9. `appointment_events` — durable per-appointment audit — `appointments.ts:107-122`
`id` PK; `tenant_id` NN; `appointment_id` NN; `event_type` text NN; `actor_type` text NN; `actor_user_id` text NULL; `detail` jsonb NN `'{}'`; `created_at` timestamptz NN.
- **FK**: `tenant_id` CASCADE; `appointment_id`→`appointments(id)` **CASCADE**; `actor_user_id`→`"user"(id)` **SET NULL**.
- **CHECK** `event_type IN (appointment_created, appointment_rescheduled, appointment_cancelled, appointment_confirmed, appointment_completed, appointment_no_show, manual_note, mode_changed, escalation)`; `actor_type IN (system,agent,public,n8n)`. **Index** `(tenant,appointment,created_at)`.

### 10. `scheduling_events` — append-only realtime/poll feed — `1782000000003_scheduling-events.ts:22-35`
`seq` bigint **GENERATED ALWAYS AS IDENTITY, PK** (poll cursor); `id` uuid NN; `tenant_id` NN; `client_id` uuid **NULL** (no FK); `site_id` uuid NULL; `event_type` text NN; `payload` jsonb NN `'{}'`; `created_at` timestamptz NN.
- **FK**: `tenant_id` CASCADE; `site_id` CASCADE. **CHECK** `event_type IN (appointment.created, appointment.rescheduled, appointment.cancelled, appointment.status_changed, schedule.changed)`. **Indexes** `(tenant,seq)`, `(tenant,client,seq)`, `(tenant,site,seq)`.

### 11. `client_modules` — per-client module enablement — `1782100000000_client-modules.ts` (+ inbox-module widen)
`id` PK; `tenant_id` NN; `client_id` NN; `module_key` text NN; `enabled` bool NN `true`; `settings` jsonb NN `'{}'`; timestamps.
- **UNIQUE** `(tenant_id,client_id,module_key)`. **FK** `(client_id,tenant_id)`→`clients` **CASCADE** (the only composite→clients FK that cascades). **CHECK** `module_key IN ('crm','scheduling','inbox')`; settings is object. **Index** partial `(tenant,client,module_key) WHERE enabled`.

### ER diagram (relationships to each other + pre-existing tables)

```
 tenants ──CASCADE (tenant_id on ~every table)──────────────────────────────┐
   │                                                                        │
 clients (UNIQUE (id,tenant_id))         "user" (Better Auth; id = TEXT)    │
   ▲  composite FK (client_id,tenant_id)    ▲ assigned_to / created_by_user_id /
   │  NO ACTION  (client_modules = CASCADE) │ actor_user_id   (all SET NULL)
   │                                        │
   ├── client_modules (crm|scheduling|inbox, enabled)
   ├── contacts ──SET NULL──► conversations.contact_id (pre-existing handoff table)
   │       ▲ SET NULL
   ├── sites ──CASCADE──► staff ──CASCADE──► staff_services ──► services
   │     │                                                        ▲
   │     ├── site_services (site,service) ──────────────────────┘
   │     └── schedule_exceptions (site; staff_id NULL = whole site)
   ├── services (per-client catalogue; price)
   └── appointments (client_id,tenant_id NO ACTION)
          ├─ site_id/staff_id/service_id ─► CASCADE
          ├─ contact_id  ─► contacts   SET NULL   (NULLABLE → walk-in / no contact)
          ├─ source_conversation_id ─► conversations  SET NULL
          ├─ EXCLUDE gist: no overlapping [blocked_from,blocked_until) per staff
          │              while status ∈ {scheduled,confirmed}
          └─ appointment_id ◄─CASCADE─ appointment_events (in-txn audit)

 scheduling_events (append-only; seq = bigint identity poll cursor; tenant/site CASCADE,
                    client_id has NO FK) — written AFTER commit, read only by the UI poll route
 workflows.client_id ─► clients   (how machine X-Workflow-Ref resolves to a client)
```

---

## B. THE SCHEDULING ENGINE (`src/scheduling/`)

Split into a **pure core** (`src/scheduling/`, no DB/no clock) and a **loader + orchestration** layer (`src/db/repositories/scheduling/` + `src/scheduling/booking.ts`). All times are UTC `Date`/`timestamptz`; the site IANA timezone only interprets local wall-clock hours.

### B.1 `computeAvailability` (`availability.ts:51`) — step by step

Input `AvailabilityRequest` is assembled from the DB by `loadAvailability` (`availabilityData.ts:121`) — the single loader shared by the availability API, the public booking page, and the booking service's revalidation, so every path uses identical rules.

1. Read config + derive bounds (`:52-59`): `slotMs = slot_interval_min*60000`; `minStart = now + min_notice_min`; `maxStart = now + booking_horizon_days`.
2. Enumerate local dates the UTC window touches, in the site tz (`localDatesInRange`).
3. Precompute per-staff per-local-day busy counts for the "any staff" tie-break (`:64-77`).
4. Per local date: weekday via local-noon → parts; convert that weekday's opening-hours ranges to UTC spans (`hoursToSpans`); skip if closed. `24:00` handled as offset from local midnight.
5. Per staff on that date (`:90-104`): resolve `dur/bufBefore/bufAfter` from **that staff's** timing; `working_hours = {}` ⇒ inherit site opening. Free set = `intersect(siteOpen, staffWork)` then `subtract` site exceptions, staff exceptions, staff busy. (Half-open `[start,end)` epoch-ms set algebra in `intervals.ts`.)
6. Discretize candidate starts on a grid **aligned to local midnight** (`:106-121`); keep a start only if the **full blocked window** `[s−bufBefore, s+dur+bufAfter)` fits inside the free interval AND s is within the requested window AND within `[minStart,maxStart]`.
7. Merge across staff (`:118-141`): a start offered by multiple staff is emitted once; `staff_id` chosen by `chooseStaff` = fewest active appts that local day, then lowest id. Output carries `available_staff_ids` + per-staff `candidates` (each with its own `service_end_at`).

**Configuration knobs**

| Knob | Stored at | Level | Default |
|---|---|---|---|
| `slot_interval_min` | `sites.scheduling_config` (jsonb) | per-site | 15 |
| `min_notice_min` | `sites.scheduling_config` | per-site | 120 |
| `booking_horizon_days` | `sites.scheduling_config` | per-site | 30 (hard walk cap 400d) |
| buffer before/after | `services.buffer_before_min`/`after`, falling back to `sites.scheduling_config.default_buffer_*` when the service value is 0 | **per-service** (site default fallback) — applied identically to all staff | 0 |
| service duration | `COALESCE(staff_services.duration_override_min, site_services.duration_override_min, services.duration_min)` | **per-staff → per-site → base** | — |
| opening hours | `sites.opening_hours` jsonb (weekday map) | per-site | missing weekday = closed |
| working hours | `staff.working_hours` jsonb (`{}`=inherit) | per-staff | inherit |
| "any staff" pick | **hardcoded** `chooseStaff` (`availability.ts:144-158`) | global behavior | fewest same-day appts, then lowest id |

`DEFAULT_SCHEDULING_CONFIG` code fallback is a constant at `types.ts:21-27`.

### B.2 Timezone / DST

Computed in the **site timezone**, converted to UTC via the platform `Intl` API — **no tz library** (`timezone.ts`). Local→UTC (`zonedPartsToUtc`) is a **two-pass** conversion correct across DST transitions (`timezone.ts:54-61`); date walking advances ~26h then snaps to local midnight to cross DST days. Admin exception times anchor to the **site** tz, not the browser. Default site tz `America/Bogota` (no DST) but the math is general. **All appointment/exception times are `timestamptz` (UTC), not naive.**

### B.3 Booking service (`booking.ts:119` `createAppointment`)

**Order** (most work OUTSIDE the txn): fail-closed scope check → idempotency short-circuit (`findByIdempotencyKey`) → availability revalidation (`loadAvailability`, on the pool) → resolve staff/price/snapshots → **then** open transaction.

**Transaction** (`withTransaction` = BEGIN…COMMIT/ROLLBACK): (1) `isSchedulingEnabledForUpdate` re-checks the client's scheduling module with `FOR SHARE OF cm` so a concurrent disable serializes; (2) resolve/create contact + conversation link; (3) `insertAppointment` (exclusion-guarded); (4) `recordAppointmentEvent(appointment_created)`. The realtime `scheduling_event` is emitted **only after commit**.

**Locking — 3 layers:**
- Per-staff **transaction advisory lock** taken first in `insertAppointment`: `pg_advisory_xact_lock(hashtextextended(staff_id,0))` (`appointments.ts:86`) — same-staff inserts serialize to a clean `23P01`; different staff never contend.
- **GiST exclusion constraint** `appointments_no_overlap` = the real guarantee (compares the *blocked* range = service + buffers).
- `SELECT … FOR UPDATE` row lock for status transitions / reschedule.

**Conflict → 409:** exclusion `23P01` → `isExclusionViolation` → `{ok:false,error:'conflict_slot'}` → `bookingErrorStatus` maps to **409** (`schedulingApi.ts:106-111`). Deadlock `40P01` defensively mapped to the same.

**Idempotency:** `Idempotency-Key` header — **required** on the machine POST, **optional** on public (generates `pub_<uuid>`), `null` on internal actions. Enforced by the partial unique index on `(tenant_id, idempotency_key)`. **Tenant-scoped, no TTL / dedupe window.** `replayOrConflict` (`booking.ts:100-117`): cross-client hit or different payload → `conflict_idempotency` (409); scheduling disabled → `module_disabled`; else returns existing row `deduped:true`.

### B.4 Appointment state machine

Statuses (`scheduled, confirmed, completed, cancelled, no_show`); new rows insert `scheduled`.

| From | Allowed → |
|---|---|
| scheduled | confirmed, completed, cancelled, no_show |
| confirmed | completed, cancelled, no_show |
| completed / cancelled / no_show | — (terminal) |

Illegal → `invalid_transition` → 409 (`booking.ts:293-301,339`). Cancel is a status change, never a delete. **Reschedule** is separate (`rescheduleAppointment`): same id, non-terminal only, revalidates slot, `moveInterval` bumps `version`; status unchanged.

**Who may trigger** — the engine imposes **no per-transition role restriction**; the distinction is the calling surface:

| Surface | Create | Confirm/Complete/Cancel/NoShow/Reschedule | actor/origin |
|---|---|---|---|
| Machine (n8n) `/api/scheduling/v1/*` | yes | yes (all 5 routes) | `n8n` / `n8n` |
| Public `/api/booking/{slug}` | yes (create only) | **no** | `public` / `public` |
| Internal agenda actions | yes (manual/walk-in) | yes | `agent` / `internal` or `walk_in` |

**Audit — two tables:** every transition writes one `appointment_events` row **in-txn** (durable audit; `actor_type/actor_user_id/detail`), and post-commit one `scheduling_events` row (realtime feed for the UI poll).

---

## C. EVERY ENDPOINT

There is **no dedicated CRM machine or public endpoint** — contacts are created/read only as a side-effect of scheduling. Shared machine/public error body: `{ "error": { "code", "message" } }` (`schedulingApi.ts:38`); internal routes use a bare `{ "error": "..." }`.

### C.1 Machine API `/api/scheduling/v1/*` (Bearer handoff token + `X-Workflow-Ref`)

**Auth + scope** (`schedulingApi.ts:51` → `handoffApi.ts:45`): `Authorization: Bearer <token>` → SHA-256 → `findActiveByHash` (`WHERE token_hash=$1 AND revoked_at IS NULL`); miss → **401** `unauthorized`. Token row yields `tenant_id` + `n8n_connection_id` (**no capability column**). `X-Workflow-Ref` (n8n `{{$workflow.id}}`) missing → **400** `workflow_ref_required`.

**Tenant/client derivation & no-client case** (`machineScope.ts:30-38`): tenant = token's `tenant_id`; client = the workflow matched on **tenant + connection + n8n workflow id** (`resolveWorkflowForConnection`) → its `client_id`. `workflows.client_id` is NOT NULL and new workflows land in the tenant's **default ("Unassigned") client**, so "maps to no client" is structurally impossible — instead an unassigned workflow's client `is_default=true` ⇒ `module_disabled` → **403**. Unknown/foreign/wrong-connection ref ⇒ **404** `not_found`. **No rate limiting on any machine endpoint.**

| Method Path | Required | Optional | Success | Errors |
|---|---|---|---|---|
| GET `/v1/sites` | — | — | `{sites:[{id,slug,name,address,timezone,scheduling_config}]}` (resolved client only) | 401/400/404/403 |
| GET `/v1/services?site_id=` | `site_id` | — | `{services:[{id,name,description,duration_min,price,buffer_before_min,buffer_after_min}]}` | +400 invalid_request; 404 (foreign site) |
| GET `/v1/staff?site_id=` | `site_id` | `service_id` | `{staff:[{id,name,site_id}]}` | 400; 404 |
| GET `/v1/availability?site_id&service_id&from&to` | those 4 | `staff_id` | `{site:{id,timezone}, slots:[{start_at,service_end_at,staff_id,available_staff_ids,candidates}]}` | 400 (missing / to<=from / **window >45d**); 404 |
| GET `/v1/appointments` | — | `status,from,to,site_id,staff_id,contact_id,conversation_id` | `{appointments:[…]}` (clientId filter mandatory, cap 500) | 400 (non-uuid); 404 |
| POST `/v1/appointments` | **`Idempotency-Key` header**; body `site_id,service_id,start_at` | body `staff_id,conversation_ref,channel,channel_user_id,customer_name,customer_phone,customer_email` | `{appointment:…}` **201** new / **200** deduped | 400 idempotency_key_required; 422 invalid_body; 404; 403; **409** conflict_slot/conflict_idempotency/unavailable/no_staff |
| POST `/v1/appointments/{id}/{cancel,confirm,complete,no-show}` | path `id` | body `reason` (cancel) | `{appointment:…}` | 404; 403; 409 invalid_transition |
| POST `/v1/appointments/{id}/reschedule` | path `id`, body `start_at` | body `staff_id` | `{appointment:…}` | 404;403;422;409 |

No `GET /v1/appointments/{id}`. `workflow_ref` is **never** a body field — only the header (`auth.workflowRef`).

### C.2 Public booking `/api/booking/[slug]/*` (no auth)

Site resolved via `getPublicBookingSiteBySlug` **before** any body read; returns a site only when slug active **AND** client non-default **AND** `client_modules(scheduling).enabled`. Unknown/inactive/default/disabled all collapse to the same **404** `not_found`. **Rate limiting** (in-memory per process, resets on deploy, not cross-instance): reads `book-read:{ip}` 120/60s; writes `book-write:{ip}` **8/60s** → 429.

| Method Path | Required | Optional | Success | Errors |
|---|---|---|---|---|
| GET `/{slug}/services` | slug | — | `{site:{name,timezone,address}, services:[{id,name,description,duration_min,price}]}` | 429/404 |
| GET `/{slug}/staff?service_id=` | slug,`service_id` | — | `{staff:[{id,name}]}` | 429/404/400 |
| GET `/{slug}/availability?service_id&from&to` | those | `staff_id` | `{timezone, slots:[…]}` (**window cap 14d**) | 429/404/400 |
| POST `/{slug}` | body `service_id,start_at,customer_name(1-256),customer_phone(1-64)` | `staff_id`, `customer_email(≤256)`; `Idempotency-Key` header (else `pub_<uuid>`) | `{confirmation:{reference,site,service,staff_name,start_at,service_end_at,timezone,status}}` **201**/**200** | 429 rate_limited; 404; 422; 409; **module_disabled collapsed to 404** |

### C.3 Session-authed (internal UI) — Better Auth session, no rate limiting

- GET `/api/scheduling/internal/availability` — gated by `resolveClientModuleForScope(scope, clientId, "scheduling")`; site must belong to the gated client. `{site:{id,timezone}, slots:[…]}`; 404 `not_found` for foreign/disabled/default/unknown.
- GET `/api/scheduling/internal/events?since=&site_id=` — session (member limited to their client); `{cursor, events:[…]}`; 403 forbidden if no session. **This is the only reader of `scheduling_events`.**
- **Server actions** (`"use server"`, not HTTP-routed), all through `resolveClientModuleContext` with a validated `scopeClientId`: `schedulingActions.ts` (createManual/cancel/confirm/complete/noShow/reschedule; walk-in with no identity ⇒ `contact_id=null`); `schedulingAdminActions.ts` (owner/admin CRUD for sites/services/staff/exceptions, `requireFullAccessForAction`); `contactActions.ts` (`updateContactAction`, strict whitelist, rejects `assigned_to` + unknown keys).

---

## D. THE UI SURFACES

(Basic contacts + full scheduling; the operational CRM panels were reverted — see the critical finding.)

### D.1 Contacts list — `contacts/page.tsx`
Columns: **Name** (`name ?? channel_user_id`, + derived **`customer` badge**), **Channel**, **Stage** (plain text), **Last conversation**, **Next appointment**, **Visits**. **Read-only** — only a server-side search form + click-through; `AutoRefresh` 30s. **No "New contact" button** (contacts are created only by the booking/conversation pipeline). No tags/filters.

### D.2 Contact detail — `contacts/[contactId]/page.tsx` + `components/contacts/ContactDetail.tsx`
4 tabs: **Data** (editable `name`, `phone (E.164)`, `email`, `stage` select of new/active/customer/archived; read-only `message_count`, `bot_human_mode`), **Conversations** (workflow/conversation ref, mode, last message), **Appointments** (`service_name, start_at, staff_name, site_name, origin, status`), **Activity** (read-only event list from `appointment_events` via `listEventsForContact` — `event_type, actor_type, created_at, detail`; **not** a CRM timeline). **Edit action** sends only `{name,phone,email,stage}` via `updateContactAction`. All other tabs read-only; no assign/delete/notes/tasks/tags.

### D.3 Scheduling Agenda — `scheduling/agenda` + `components/scheduling/AgendaView.tsx`
Per-staff day-column board for one site; site selector + date ± controls; `AutoRefresh` 20s. Cards: time (site tz), status badge, service, contact name (or "Walk-in"), origin, "View conversation" link. **Per-appointment actions** (scheduled/confirmed only): Confirm, Complete, No-show, Reschedule (modal), Cancel. Header: **Walk-in** / **New appointment** (→ `AppointmentModal`). **Gating quirk:** `canManage` (owner/admin) gates only the empty-state "Add staff" link — booking + confirm/cancel/etc. are available to **any member** with the scheduling module (server actions re-validate module+client, not role).

### D.4 Scheduling Admin — `scheduling/admin` + `components/scheduling/AdminPanel.tsx` — **owner/admin only** (`requireFullAccessOrLand`)
Four sections: **Sites** (name/slug/timezone + weekly opening-hours grid at creation; add / deactivate), **Services** (name/duration/price/buffers + per-site enablement toggles; add / deactivate), **Staff** (name/site + per-staff service toggles; add / deactivate), **Exceptions** (site/staff/start/end/reason; add / delete). **No in-place edit** of a site/service/staff; **no way to edit opening hours after site creation.**

### D.5 Inbox CustomerDetailsPanel — `web/components/CustomerDetailsPanel.tsx`
Deliberately minimal; by its own doc comment shows **only conversation-payload data, no contacts join**. Exact fields: (1) avatar initial, (2) `conversationRef`, (3) mode badge, (4) Status + Active/Inactive, (5) Handled-by (human only), (6) Waiting-since + reason (pending only), (7) Workflow, (8) Client, (9) First seen, (10) Last activity. **It does NOT show appointments** (no scheduling import, no appointment fields). Only action: optional close button.

---

## E. SPECIFIC QUESTIONS

**E1 — Appointments ↔ contacts.** Yes: `appointments.contact_id → contacts(id) ON DELETE SET NULL`, **NULLABLE**. Walk-in / public with no prior contact: the booking service resolves-or-creates a contact only when `channel && channel_user_id` are present, else `contact_id = null`. `origin` allows `walk_in`. In practice a named/phoned walk-in still gets a contact (channel `walk_in`); only a fully anonymous internal booking is contact-less. Deleting a contact detaches (not deletes) its appointments.

**E2 — Contact identity.** UNIQUE = **`(tenant_id, client_id, channel, channel_user_id)`** (exactly one). `channel` is **free text, no CHECK**; values are set in app code: `imported` (backfill), `public` (public booking), `walk_in`/`manual` (admin), `whatsapp` (n8n/seed), or whatever an n8n caller passes. **Phone normalization to E.164 exists** (`src/scheduling/phone.ts` `normalizeE164`, enforced by the DB regex CHECK; un-normalizable ⇒ stored null). **YES the same person can exist twice** — because `channel` is part of the unique key, a WhatsApp contact `(…,whatsapp,wa_id)` and a public-booking contact `(…,public,typed_phone)` are two distinct rows for the same human. **No merge/dedupe** capability of any kind (no `merged_into`, no merge fn).

**E3 — `stage` and "customer".** `stage` is a **stored** `text NN DEFAULT 'new'` with a fixed CHECK enum `new/active/customer/archived` — **not free text, not per-client configurable**. The **"customer" badge is DERIVED, never stored** = `≥1 completed appointment` (computed at read time). Nuance: the editable `stage` dropdown *also* has a `customer` value, which is independent of the derived badge (you can set stage=customer with zero completed appointments and the badge stays off).

**E4 — Custom/user-defined fields on contacts.** **None.** No JSONB custom-fields column, no EAV, no field-definitions table.

**E5 — Consent / opt-out / marketing-permission.** **None** on `contacts`.

**E6 — Owner/assignee.** **Yes:** `contacts.assigned_to text → "user"(id) ON DELETE SET NULL` (indexed). Settable via `updateContact`, **but the UI does not expose it** (the contact-edit action explicitly rejects `assigned_to`). So the column exists and is wired at the repo layer; there is no UI to assign.

**E7 — Notes / tasks / activities.** **None built** (the operational layer was reverted). What exists: `appointment_events` (per-appointment audit) and pre-existing `conversation_mode_transitions` (handoff audit). `appointment_events.event_type` includes `manual_note`, but that is a note *on an appointment*, not a contact notes table. No contact notes, no tasks, no generic contact activity/timeline table.

**E8 — Timezones.** Site tz: `sites.timezone text NN DEFAULT 'America/Bogota'` (IANA). Availability is **computed in the site tz** and converted to UTC (two-pass DST-safe, no tz library). Appointment/exception times are **`timestamptz`** (UTC), not naive. **No per-staff timezone** (staff hours are interpreted in the site tz).

**E9 — Staff schedules.** Recurring weekly hours = `staff.working_hours` jsonb (`{}` inherits `sites.opening_hours`), a weekday-keyed `{start,end}` "HH:MM" map — a JSONB template, not a table. **Per-staff duration override: YES** (`staff_services.duration_override_min`, also per-site). **Per-staff buffers: NO** (buffers live on `services` + site defaults; no buffer-override column). Exceptions: **one-off only** (absolute timestamptz bounds, no recurrence; `type` only `blocked`; `staff_id NULL` = whole site). **Multi-site staff: NO** — `staff.site_id` is a single NOT NULL FK; one staff = one site in V1.

**E10 — `scheduling_events` exposure.** Written in-code on booking/cancel/reschedule/status-change (after commit). Read **only** by the session-authed `GET /api/scheduling/internal/events` (UI poll cursor). **Not exposed on any machine or public endpoint** — n8n has no way to poll it. It cannot currently drive n8n reminders.

**E11 — Outbound events/webhooks (platform → n8n) for CRM/scheduling.** **None.** CRM/scheduling is **purely inbound** (n8n → platform). The only outbound webhook in the app is `handoff.send_message` (a human agent replying in the inbox) — a handoff feature, unrelated to CRM/scheduling. No POST/fetch anywhere in the scheduling or contacts code.

**E12 — Token model. ✅ CLOSED in C-5 (2026-08-03) — this was "risk ①".** ~~**No per-capability scoping.** `handoff_tokens` has no scope/capability column; scheduling auth calls the **same** `authenticateHandoffRequest` as the handoff API. So **a token minted "for handoff" can create/cancel/reschedule appointments.**~~ Fixed: `handoff_tokens.capabilities text[]` (GIN-indexed) now carries an explicit, deny-by-default set from a fixed vocabulary (`handoff`, `scheduling.read`, `scheduling.write`, `crm.read`, `crm.write`). The single chokepoint (`authenticateHandoffRequest`, used by handoff directly and by the scheduling + CRM wrappers) checks the route's declared capability right after resolving the token and refuses a missing capability with the identical 401 (indistinguishable from a bad token). Existing tokens were backfilled to exactly `{handoff, scheduling.read, scheduling.write}` — no `crm.*` — so no running workflow changed behavior, and legacy tokens cannot reach the new CRM API. Capabilities are editable per token (owner/admin, in the UI) without re-issuing the secret. See `docs/machine-api-v1.md` §1.3. The per-request `X-Workflow-Ref` scope gate is unchanged and still applies on top.

**E13 — Public booking.** Collects `service_id`(req), `start_at`(req), `customer_name`(1-256, req), `customer_phone`(1-64, req), optional `staff_id`, optional `customer_email`, optional `Idempotency-Key`. **Creates-or-reuses** a contact keyed on `(tenant,client,'public',customer_phone)` — first-time phone creates, repeat reuses and only back-fills previously-null name/email. Rate limit 8 writes/60s/IP. Response exposes only `reference, site name, service name, staff_name, start_at, service_end_at, timezone, status` — no internal ids, no other staff, no cross-client data; all failure modes collapse to a generic 404.

**E14 — Contacts list search/pagination.** Search is **server-side** (`?q=` → `listContacts(... search ...)`). Searchable columns (4): `name, phone_e164, email, channel_user_id`, all via wildcard `ILIKE '%…%'` (`contacts.ts:117-119`). Because the pattern is prefix-wildcarded, the existing b-tree indexes (`phone_e164`, `stage`) **cannot serve the search** — it is a seq-scan-per-query (would need `pg_trgm`). **Pagination is NOT built** — no offset/cursor/page; a hard `LIMIT` (page passes none ⇒ 200 rows) with `ORDER BY last_contact_at DESC` and no next-page UI.

**E15 — Reminders / notifications.** **Nothing built.** No cron, no queue, no outbound sender, no reminder config, no "send reminder" action, no notifications UI. Agenda actions are only confirm/complete/no-show/reschedule/cancel.

**E16 — Money.** `services.price numeric(10,2)` (nullable, ≥0), plus `site_services.price_override` / `staff_services.price_override`, and `appointments.price_snapshot` (copied at booking). **No currency column** (single implied currency), **no deposit, no payment/paid/payment-status columns, no payments table.**

---

## F. DOCS INVENTORY

Docs present: `docs/scheduling-v1.md` (320 lines), `docs/scheduling-n8n-contract.md` (108), `docs/scheduling-openapi.yaml` (224). (`docs/handoff-contract-v1.md` and `docs/prompts/*` exist but are handoff/planning docs, not CRM/scheduling API contracts.)

### F.1 `scheduling-n8n-contract.md` — MATCHES the code (the authoritative doc)
Correctly documents: machine API scoped to ONE client from Bearer token **+ `X-Workflow-Ref` header** (tenant/client never sent); the resolution chain token→tenant+connection→workflow→client→non-default→scheduling-enabled; the error table (`401 unauthorized`, `400 workflow_ref_required`, `404 not_found`, `403 module_disabled`, `409 conflict_*`, `422 invalid_body`); auth+scope run before body parsing; `workflow_ref` is header-only, never a body field; tenant-scoped idempotency. Verified against `schedulingApi.ts:51-115`, `machineScope.ts:25-39`, all `web/app/api/scheduling/v1/*`. **No material discrepancies.**

### F.2 `scheduling-openapi.yaml` — STALE / does NOT match the auth model
1. **`X-Workflow-Ref` is undocumented but MANDATORY** — the spec's `securitySchemes` is `bearerAuth` only with no header param; following it verbatim, every request fails with `400 workflow_ref_required` (`schedulingApi.ts:56-62`).
2. **`workflow_ref` shown as a request-body property** (`:161`) — code deliberately excludes it (`appointments/route.ts:72-85`); it is ignored if sent.
3. **Missing the entire scope/error layer** — no `400 workflow_ref_required`, no `404 "Workflow not found."`, no `403 module_disabled`.
4. **Security description wrong** (`:26`) — omits that the *client* + module gate come from the workflow ref, not the token alone.
5. **`/availability` 200 omits the `site` wrapper** — spec returns `{slots}` (`:120-127`); code returns `{site:{id,timezone}, slots}` (`availability/route.ts:61-72`).
6. **POST error set incomplete** — engine can return `403 module_disabled` / `404 not_found`, undocumented.
(Slot + Appointment schemas and the reschedule body DO match the code.)

### F.3 `scheduling-v1.md` — architecture mostly accurate; §6 examples & §3 migrations STALE
Accurate: contacts identity + derived "customer"; the model tables; the pure availability engine; GiST exclusion + idempotency unique index + per-staff advisory lock (§9 SQL matches `appointments.ts:90-96`); public booking + IP rate limiting; snapshots + per-staff duration COALESCE + staff-hours-default-to-site.
Discrepancies:
1. **§6 curl / n8n payload examples are wrong** — they put `workflow_ref` in the POST body and omit the `X-Workflow-Ref` header (`:169-213`); every one returns `400 workflow_ref_required` today. Only `scheduling-n8n-contract.md` shows the correct header usage.
2. **`schedule.changed` realtime events described (§1/§8) but NOT IMPLEMENTED** — the type + CHECK + indexes exist but there are **zero producers**; admin schedule edits push no realtime hint. (See G.2 / E10.)
3. **§3 migration list incomplete** — omits `1782100000000_client-modules` (the gate scheduling requires) and `1782200000000_services-per-client` (adds `services.client_id`, re-points FKs). "Roll back the four with `migrate down 4`" would not cleanly reverse the per-client refactor; the SCHED-1 header still calls services "tenant-level", superseded.
4. **§10 "stamps client from the site"** — partially right: the authoritative client is the *workflow's* client; the site's client must equal it or the create is `not_found` (`booking.ts:156-160`).
5. **Contacts require a separate `crm` module, undocumented** — the doc bundles "CRM + Scheduling", but contacts gate on module `crm` while scheduling gates on `scheduling` (independent toggles in `src/modules/registry.ts`).
Unclear (not executed): §5 Railway deploy steps, §4 "seed prints booking URL".

---

## G. GAPS & DEBT

### G.1 TODO / FIXME / HACK / XXX
**None** anywhere in the CRM + scheduling tree (independently grep-confirmed in both the audit and a direct cross-check). No inline debt markers.

### G.2 Stubbed / half-built / dormant
- **`schedule.changed` scheduling-event: defined, never emitted.** Type + CHECK + dedicated indexes exist (`events.ts:16`, migration `:31,36-38`) but no code path produces it — the clearest "wired-up-but-unfinished" item. Admin schedule CRUD (`schedulingAdminActions.ts`) notifies nothing.
- **Dormant `appointment_events` types** `manual_note`, `mode_changed`, `escalation` — allowed by the CHECK but have zero producers (likely leftovers for the reverted CRM-operational work).
- **`isSlotAvailable(..., client?)` ignores its `client` param** (`availabilityData.ts:211-213: void client;`) — reschedule revalidation reads on the pool, not the txn snapshot; deliberate, and the exclusion constraint is the real guard, so correctness holds.
- No throwing "not implemented", no commented-out routes, no feature flags beyond the legitimate `client_modules` gate.

### G.3 Test coverage
**Strong** where it matters most:
- `test/unit/availability.test.ts` — the pure engine: grid, staff-vs-site hours, full-day + partial exceptions, buffers, min_notice, horizon, service-crossing-close rejected, specific-staff, busy removal, **per-staff differing durations**.
- `test/integration/booking.test.ts` — **concurrency (exactly one of two concurrent bookings wins, other 409; raw 23P01)**, idempotency (same/diff payload), cancel frees slot, reschedule revalidation, terminal-transition rejection, snapshot immutability, tenant isolation, public+n8n share agenda + post-commit event.
- `machineScope.test.ts`, `publicBookingGate.test.ts`, `schedulingModuleGate.test.ts`, `crossClientReads.test.ts`, `servicesPerClient/siteServices/schedulingAdminScope/moduleScoping/servicesMigrationBackfill` — token→client resolution, slug gate, module gate (fail-closed on missing scopeClientId), cross-client read defense, per-client services + backfill.
- `schedulingV1HandlerContract.test.ts`, `publicBookingHandlerOrder.test.ts`, `schedulingAdminNavContract.test.ts`, `contactActionValidation.test.ts`, `timezone.test.ts`, `workflowRef.test.ts` — static handler-order/gating contracts + validation.

**Untested / thin:** DST-boundary end-to-end (Colombia has no DST, so seeds never cross one) + the 24:00 end-of-day path; the scheduling API's Bearer auth itself (starts after auth); **public-booking robustness on non-UUID ids** (R1); the rate limiter / 429 path; the realtime poll endpoint `/internal/events` (cursor/`since`/member filter); the `updateContactAction` `crm`-gate end-to-end (only the validation helper is unit-tested); reminders (nothing exists).

### G.4 Correctness risks
- **R1 (robustness) — public booking endpoints don't UUID-validate ids → 500 on malformed input.** `booking/[slug]/availability/route.ts:23-40` and `booking/[slug]/staff/route.ts:19-21` pass `service_id`/`staff_id` straight into uuid-column queries; a non-UUID raises Postgres `22P02`, uncaught → HTTP 500. The machine v1 routes DO guard with `isUuid` first; the public POST is safe (zod `.uuid()`). Low security impact (parameterized), but should be a clean 400/404.
- **R2 (robustness) — `/internal/events` `since` cursor unvalidated** — forwarded into `seq > $2` (bigint); a non-numeric value → `22P02` → 500. Session-authed, low impact.
- **R3 (perf) — per-row correlated subquery** in `listAppointments` (`appointments.ts:291-301`) and `listContacts` (`contacts.ts:143-190`) resolves each row's canonical-workflow client via a `DISTINCT ON` subquery; bounded by `LIMIT 500` but no composite index on `workflows(tenant_id, n8n_workflow_id, last_synced_at)` — a hot spot at volume.
- **R4 (perf, minor) — availability busy-scan** filters `appointments` on `blocked_until/blocked_from` while the B-tree indexes are on `start_at`; served by narrowing on `(tenant,site,staff)`. Fine at barbershop scale.
- **E14 hot query — contacts search is an unindexable `ILIKE '%…%'`** across 4 columns (seq scan per search; would need `pg_trgm`).
- **Tenant / FK integrity — no gaps found.** Every repo query is tenant-scoped + parameterized; composite FKs enforce same-tenant client on sites/contacts/appointments; cross-client read defense is explicit and tested; booking + transitions fail closed on a missing `scopeClientId`.
