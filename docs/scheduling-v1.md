# CRM + Scheduling V1

MT_AI is the **single source of truth** for schedules. No Fresha / Google Calendar
/ external calendars are consulted — availability is computed from the platform's
own data and stored in PostgreSQL, with double-booking made impossible at the
database level.

This document covers setup, local run, Railway deploy, the n8n API, the public
booking page, how to test a double-booking race, and V1 decisions/limitations.

---

## 1. What was built

- **Contacts (CRM)** — the canonical person entity, `UNIQUE (tenant_id, channel,
  channel_user_id)`. A person has many conversations and many appointments.
  "Customer" is **derived** (≥1 completed appointment), never a stored flag.
- **Scheduling model** — `sites`, `staff`, `services` with explicit enablement via
  `site_services` and `staff_services`, `schedule_exceptions`, `appointments`
  (with time snapshots), `appointment_events` (audit), `scheduling_events`
  (realtime feed).
- **Availability engine** — pure, timezone-correct, buffer/notice/horizon-aware,
  with a deterministic "any barber" pick.
- **Booking engine** — transactional create/reschedule/status, per-tenant
  idempotency, and a Postgres GiST **exclusion constraint** that guarantees no two
  active appointments overlap for the same staff.
- **n8n API** — `/api/scheduling/v1/*` (Bearer token).
- **Public booking page** — `/book/{site_slug}` (+ public `/api/booking/*`).
- **Internal UI** — Agenda (day view, column per barber), Contacts, and Scheduling
  admin (CRUD sites/services/staff/exceptions).
- **Realtime** — see §8.

Tenant model: the canonical top-level account is **`tenant_id`**. A tenant can
contain **multiple businesses** via `clients` (a workflow belongs to exactly one
client; a tenant `member` is hard-scoped to ONE client by DB constraints — see
`migrations/1781400000000_client-model.ts` + `1781500000000_rbac-roles.ts`).
Scheduling is therefore scoped by **`client_id` within `tenant_id`**: `sites`
belong to a client (composite FK enforces same-tenant), and `staff` / `services`
enablement / `appointments` / `contacts` / realtime events resolve to that client.
This is the existing tenant→client sub-scope — NOT a second tenant concept.

Permissions:

| Capability | owner / admin | member (scoped to their client) |
| --- | --- | --- |
| View agenda, create/cancel/confirm/complete/no-show/reschedule, walk-ins | all clients | their client only |
| Contacts list + detail + edit | all clients | their client only |
| Sites / staff / services / exceptions CRUD (Scheduling admin) | ✅ | ❌ (not shown; actions fail closed) |
| n8n API (Bearer token) | tenant-level machine integration (stamps each appointment's client from the site) | — |

A member acting on another client's appointment/contact is treated as **not
found** (no cross-client action, no existence leak); enforced in the booking
domain service and the repos, not just the UI.

---

## 2. Environment variables

No **new** required variables. Scheduling reuses the existing config:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (worker + web share it). Required. |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Session auth for the internal UI. |
| `ENCRYPTION_KEY` | Existing — n8n connection key encryption. |
| `TEST_DATABASE_URL` | **Tests only** — a throwaway DB the integration tests run against. |

The n8n API reuses the existing **handoff token** (per-tenant machine credential),
so no new token type or secret is introduced.

---

## 3. Migrations

Additive and reversible. Apply with:

```bash
npm run migrate up      # local (reads .env)
npm run migrate:prod up # CI/Railway (reads DATABASE_URL from the env)
```

New migrations (in order):

1. `..._crm-contacts` — `contacts` + `conversations.contact_id` + safe backfill.
2. `..._scheduling-core` — sites, staff, services, site_services, staff_services, schedule_exceptions.
3. `..._appointments` — `btree_gist`, `appointments`, exclusion constraint, idempotency index, `appointment_events`.
4. `..._scheduling-events` — realtime feed table.

Later migrations this feature also depends on: `..._client-modules` (the per-client
`scheduling` gate this API enforces), `..._services-per-client` (adds `services.client_id`
and re-points the catalogue per client — the SCHED-1 "services are tenant-level" note
above is superseded by it), and `..._contacts-search` (C-1: pg_trgm + keyset indexes for
the contacts list). `npm run migrate down 4` only reverses the four core migrations, not
those — roll back the exact count you applied.

---

## 4. Local run

```bash
# 1. Postgres (docker) — or any Postgres reachable via DATABASE_URL
docker compose up -d postgres

# 2. Install + migrate + seed demo data
npm install && (cd web && npm install)
npm run migrate up
npm run seed:scheduling      # demo tenant, Bogotá site, 2 barbers, 3 services, 1 exception, sample appts

# 3. Run worker + web (separate terminals)
npm run dev                  # ingestion worker
npm run web                  # Next.js app on http://localhost:3000
```

The seed prints the public booking URL, e.g. `http://localhost:3000/book/demo-barbershop`.

To issue an n8n token: in the platform UI (owner/admin) go to **Settings →
Connections** and create a handoff token for the connection; use it as
`Authorization: Bearer <token>`.

---

## 5. Deploy on Railway

Same as the existing services (the app already deploys the worker + web on
Railway). For scheduling specifically:

1. Ensure `DATABASE_URL` points at the Railway Postgres.
2. Run migrations as a release/one-off step: `npm run migrate:prod up`
   (the `btree_gist` extension is created by the migration; the DB role must be
   allowed to `CREATE EXTENSION` — Railway's default Postgres role is).
3. Deploy web + worker as today (`railway.web.json` / `railway.worker.json`).
4. Set `BETTER_AUTH_URL` to the public web URL so the internal UI + public page
   resolve correctly.

The public booking page and `/api/booking/*` are internet-reachable and rate
limited per IP; keep the app behind Railway's proxy (the code reads
`x-forwarded-for`).

---

## 6. n8n integration

Auth: `Authorization: Bearer <handoff-token>` **and** `X-Workflow-Ref: <n8n workflow id>`
on every request. Base URL: `https://YOUR-APP/api/scheduling/v1`. Full spec:
[`scheduling-openapi.yaml`](./scheduling-openapi.yaml).

### Getting started for n8n

1. **Issue a token.** In the platform, issue a handoff token for the client's n8n
   connection (the same token the handoff API uses — there is no separate scheduling
   token). Store it in n8n as `MTAI_SCHEDULING_TOKEN`.
2. **Send both headers on every call.** `Authorization: Bearer {{$env.MTAI_SCHEDULING_TOKEN}}`
   and `X-Workflow-Ref: {{ $workflow.id }}`. The token gives the tenant; the workflow ref
   resolves the CLIENT (its workflow's owning client, which must be non-default with
   `scheduling` enabled). Never send `tenant_id`/`client_id`/`workflow_ref` in the body.
3. **The booking conversation, in order:**
   1. `GET /sites` → choose `site_id` (usually the client has one).
   2. `GET /services?site_id=…` → present options → `service_id`.
   3. `GET /staff?site_id=…&service_id=…` → let the customer pick a barber, or skip for "any".
   4. `GET /availability?site_id=…&service_id=…&from=…&to=…[&staff_id=…]` → offer real slots.
   5. `POST /appointments` with an **`Idempotency-Key`** (build it from something stable
      for the attempt, e.g. `conversation_ref + chosen_slot`, so a node retry can't
      double-book). Include `channel` + `channel_user_id` (e.g. `whatsapp` + the wa_id) to
      attach/create the CRM **contact**; omit them for an anonymous booking.
   6. Lifecycle as the conversation continues: `POST /appointments/{id}/confirm` |
      `complete` | `no-show` | `cancel` | `reschedule`.
4. **Handle 409 gracefully.** A slot can be taken between your availability read and the
   create. On `409` (`conflict_slot` / `unavailable` / `no_staff`) re-fetch `/availability`
   and offer a new slot — do NOT change the `Idempotency-Key` on a genuine retry of the
   *same* attempt (only a new attempt gets a new key). `409 conflict_idempotency` means you
   reused a key with a different payload — fix the payload or use a new key.

### curl examples

> Every example below was RUN against a local server (C-1) and its response pasted
> verbatim. Two headers are mandatory on every call: `Authorization: Bearer <token>`
> and **`X-Workflow-Ref: <n8n workflow id>`** (the client is resolved from them).
> `workflow_ref` is NOT a body field.

```bash
TOKEN=hk_xxx                       # issued in the platform
WF=demo-wf-1                       # the n8n workflow id; in n8n: {{ $workflow.id }}
BASE=http://localhost:3000/api/scheduling/v1
H=(-H "Authorization: Bearer $TOKEN" -H "X-Workflow-Ref: $WF")

# Sites / services / staff (client resolved from token + X-Workflow-Ref)
curl "${H[@]}" "$BASE/sites"
curl "${H[@]}" "$BASE/services?site_id=$SITE"
curl "${H[@]}" "$BASE/staff?site_id=$SITE&service_id=$SVC"

# Availability (window; max 45 days)
curl "${H[@]}" "$BASE/availability?site_id=$SITE&service_id=$SVC&from=2026-07-29T00:00:00Z&to=2026-07-31T00:00:00Z"

# Create (idempotent). NO workflow_ref in the body — it's the X-Workflow-Ref HEADER.
# channel + channel_user_id (optional) attach a CRM contact; omit for anonymous.
curl -X POST "$BASE/appointments" "${H[@]}" \
  -H "Idempotency-Key: booking-abc-123" -H "content-type: application/json" \
  -d "{
    \"conversation_ref\": \"573001112233@wa\",
    \"channel\": \"whatsapp\",
    \"channel_user_id\": \"573001112233\",
    \"customer_name\": \"Carlos\",
    \"customer_phone\": \"+573001112233\",
    \"site_id\": \"$SITE\",
    \"service_id\": \"$SVC\",
    \"start_at\": \"2026-07-29T14:00:00.000Z\"
  }"
# Repeat with the SAME key+payload → 200 + the same appointment; SAME key + a DIFFERENT
# payload → 409 conflict_idempotency.

# Lifecycle (no generic PATCH — explicit transitions only). All need both headers.
curl -X POST "${H[@]}" "$BASE/appointments/$ID/confirm"
curl -X POST "${H[@]}" "$BASE/appointments/$ID/complete"
curl -X POST "${H[@]}" "$BASE/appointments/$ID/no-show"
curl -X POST "${H[@]}" -H "content-type: application/json" -d '{"reason":"customer cancelled"}' "$BASE/appointments/$ID/cancel"
curl -X POST "${H[@]}" -H "content-type: application/json" -d '{"start_at":"2026-07-29T16:00:00.000Z"}' "$BASE/appointments/$ID/reschedule"
```

**Verified responses** (real output, C-1):

```jsonc
// GET /availability?... → 200  (note the `site` wrapper)
{ "site": { "id": "1a37f273-…", "timezone": "America/Bogota" },
  "slots": [ { "start_at": "2026-07-29T14:00:00.000Z",
               "service_end_at": "2026-07-29T14:45:00.000Z",
               "staff_id": "b8ded960-…",
               "available_staff_ids": ["b8ded960-…"] } ] }

// POST /appointments (Idempotency-Key: booking-abc-123) → 201
{ "appointment": { "id": "7747a035-…", "public_reference": "7ac59929-…",
    "status": "scheduled", "origin": "n8n", "service_name": "Corte de cabello",
    "duration_min": 45, "price": "35000.00", "contact_id": "ffb44579-…", "version": 1 } }

// Same key + same payload again        → 200  (the same appointment, not a duplicate)
// Same slot + a different key           → 409  { "error": { "code": "unavailable" } }
// No X-Workflow-Ref header              → 400  { "error": { "code": "workflow_ref_required" } }
// Unknown / foreign X-Workflow-Ref      → 404  { "error": { "code": "not_found", "message": "Workflow not found." } }
// Workflow on the default client / scheduling off → 403 { "error": { "code": "module_disabled" } }
```

### n8n HTTP Request node payload

```json
{
  "method": "POST",
  "url": "https://YOUR-APP/api/scheduling/v1/appointments",
  "headers": {
    "Authorization": "Bearer {{$env.MTAI_SCHEDULING_TOKEN}}",
    "X-Workflow-Ref": "={{$workflow.id}}",
    "Idempotency-Key": "={{$json.conversation_ref}}-{{$json.chosen_slot}}",
    "Content-Type": "application/json"
  },
  "body": {
    "conversation_ref": "={{$json.wa_id}}",
    "channel": "whatsapp",
    "channel_user_id": "={{$json.wa_id}}",
    "customer_name": "={{$json.profile_name}}",
    "customer_phone": "={{$json.wa_id}}",
    "site_id": "={{$json.site_id}}",
    "service_id": "={{$json.service_id}}",
    "start_at": "={{$json.chosen_slot}}"
  }
}
```

> Build the `Idempotency-Key` from something stable for the booking attempt (e.g.
> conversation + chosen slot) so a retried node run doesn't create a duplicate.

**n8n must never write to Postgres directly** — always go through this API, which
revalidates availability and enforces the anti-double-book guarantee.

---

## 7. Public booking page

`/book/{site_slug}` (e.g. `/book/demo-barbershop`). The slug is globally unique so
the URL carries no tenant id. The flow: service → barber or "any" → date → real
availability → time → name/phone/email → confirmation. It uses the **same** engine
as n8n and the internal agenda (public endpoints under `/api/booking/{slug}/*`,
IP rate limited).

---

## 8. Realtime

The platform has **no WebSocket** — realtime is the existing **poll** mechanism
(`AutoRefresh` → `router.refresh()`), which re-renders the server component with
fresh data. Every committed APPOINTMENT mutation appends a row to `scheduling_events`
**after commit** — `appointment.created | rescheduled | cancelled | status_changed`.
(The `schedule.changed` type exists in the schema but is **not emitted today**: admin
edits to sites/services/staff/hours/exceptions push no realtime hint — the agenda
still refreshes on its poll interval regardless.) A session poll endpoint
(`/api/scheduling/internal/events`) reads "events since cursor" as a change hint; it is
session-authed only (not exposed to the machine API, so n8n cannot poll it). If a client
misses an event, the next refresh re-reads the authoritative tables — the feed is a
hint, not the source of truth.

---

## 9. Testing a double-booking race

Automated (the canonical proof, run against `TEST_DATABASE_URL`):

```bash
# one-time: create + migrate the test DB
createdb observability_test   # or via your Postgres
npm run test:db:migrate
npm run test                  # unit + integration; includes the concurrency tests
```

- `#12` two concurrent `createAppointment` calls → exactly one succeeds.
- `#12b` two concurrent RAW inserts → exactly one raises SQLSTATE **23P01**.

Live (against a running server), fire two parallel bookings for the same staff+slot:

```bash
BODY='{"site_id":"SITE","service_id":"SVC","staff_id":"STAFF","start_at":"2026-07-27T18:00:00.000Z"}'
curl -s -o /dev/null -w "A %{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: A" -H "content-type: application/json" -d "$BODY" "$BASE/appointments" &
curl -s -o /dev/null -w "B %{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: B" -H "content-type: application/json" -d "$BODY" "$BASE/appointments" &
wait
# → one 201, one 409  (never two 201, never a 500)
```

The guarantee is enforced by Postgres:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCLUDE USING gist (
  staff_id WITH =,
  tstzrange(blocked_from, blocked_until, '[)') WITH &&
) WHERE (status IN ('scheduled','confirmed'));
```

A per-staff transaction advisory lock serializes same-staff inserts so the loser
gets a clean 23P01 → HTTP 409 (instead of a GiST deadlock).

---

## 10. Decisions & limitations (V1)

- **Tenant = `tenant_id`, scheduling scoped by `client_id`** (see the model +
  permissions matrix above). owner/admin span all clients; members are confined to
  their one client, enforced at the data/domain layer.
- **Per-staff service duration is honored**: effective duration =
  `COALESCE(staff_services.duration_override_min, site_services.duration_override_min,
  services.duration_min)`, so two barbers can offer the same service at different
  lengths — the engine reshapes only that staff's slots (each slot carries per-staff
  service windows in `candidates`). Buffers are service-level / site defaults.
- **Snapshots**: service name/duration/price/buffers are copied onto each
  appointment, so later catalogue edits never change historical bookings.
- **Staff working hours** default to the site's opening hours when left empty
  (`{}`); otherwise a missing weekday means the barber is off that day.
- **Backfill**: pre-existing conversations were linked to one imported contact per
  distinct `(client, conversation_ref)` (`channel = 'imported'`), the client
  resolved from the conversation's workflow (or the tenant's default client). Real
  channel identities arrive going forward via the API's resolve-or-create.
- **Admin exception times** are entered as local wall-clock and anchored to the
  **site's** IANA timezone server-side (never the browser's).
- **n8n token scope**: the Bearer token is tenant-level (the existing handoff
  token); appointments still get their `client_id` from the chosen site.
- **Rate limiting** for public endpoints is in-process (per web instance), enough
  for a single Railway instance; a shared limiter is future work.
- **Realtime** is polling (no WebSocket exists) — see §8.
- **Anti-deadlock**: a per-staff transaction advisory lock serializes same-staff
  inserts so the loser gets a clean 23P01 → 409 (not a GiST deadlock); a stray
  deadlock is logged with the original error before being mapped to a conflict.

### Explicitly out of scope for V1
Google Calendar sync, payments/deposits, recurring appointments, waitlists,
extra resources (chairs), staff rotating between sites, advanced week view,
drag-and-drop, full marketing CRM.
