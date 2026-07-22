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

Tenant model: the canonical tenant is **`tenant_id`** (the top-level account).
Everything scheduling-related is scoped by `tenant_id`; `clients` (groups of
workflows) are unchanged.

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

Roll back the four with `npm run migrate down 4`.

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

Auth: `Authorization: Bearer <handoff-token>`. Base URL:
`https://YOUR-APP/api/scheduling/v1`. Full spec: [`scheduling-openapi.yaml`](./scheduling-openapi.yaml).

Typical conversational flow (n8n):

1. `GET /sites` → pick `site_id`.
2. `GET /services?site_id=…` → pick `service_id`.
3. `GET /availability?site_id=…&service_id=…&from=…&to=…` (optionally `&staff_id=`).
4. `POST /appointments` with an `Idempotency-Key` header.

### curl examples

```bash
TOKEN=hk_xxx
BASE=http://localhost:3000/api/scheduling/v1

# Sites / services / staff
curl -H "Authorization: Bearer $TOKEN" "$BASE/sites"
curl -H "Authorization: Bearer $TOKEN" "$BASE/services?site_id=$SITE"
curl -H "Authorization: Bearer $TOKEN" "$BASE/staff?site_id=$SITE&service_id=$SVC"

# Availability (next 2 days)
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE/availability?site_id=$SITE&service_id=$SVC&from=2026-07-23T00:00:00Z&to=2026-07-25T00:00:00Z"

# Create (idempotent). Repeat with the SAME key+payload → 200 same appointment;
# SAME key + different payload → 409.
curl -X POST "$BASE/appointments" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: booking-abc-123" \
  -H "content-type: application/json" \
  -d '{
    "workflow_ref": "wf-123",
    "conversation_ref": "5730011122@wa",
    "channel": "whatsapp",
    "channel_user_id": "573001112233",
    "customer_name": "Carlos",
    "customer_phone": "+573001112233",
    "site_id": "SITE_UUID",
    "service_id": "SERVICE_UUID",
    "start_at": "2026-07-23T15:30:00.000Z"
  }'

# Lifecycle (no generic PATCH — explicit transitions only)
curl -X POST "$BASE/appointments/$ID/confirm"   -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/appointments/$ID/complete"  -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/appointments/$ID/no-show"   -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/appointments/$ID/cancel"    -H "Authorization: Bearer $TOKEN" \
     -H "content-type: application/json" -d '{"reason":"customer cancelled"}'
curl -X POST "$BASE/appointments/$ID/reschedule" -H "Authorization: Bearer $TOKEN" \
     -H "content-type: application/json" -d '{"start_at":"2026-07-24T16:00:00.000Z"}'
```

### n8n HTTP Request node payload

```json
{
  "method": "POST",
  "url": "https://YOUR-APP/api/scheduling/v1/appointments",
  "headers": {
    "Authorization": "Bearer {{$env.MTAI_SCHEDULING_TOKEN}}",
    "Idempotency-Key": "{{$json.conversation_ref}}-{{$json.chosen_slot}}",
    "Content-Type": "application/json"
  },
  "body": {
    "workflow_ref": "={{$workflow.id}}",
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
fresh data. Every committed mutation also appends a row to `scheduling_events`
(`appointment.created|rescheduled|cancelled|status_changed`, `schedule.changed`)
**after commit**; a session poll endpoint (`/api/scheduling/internal/events`) reads
"events since cursor" as a change hint. If a client misses an event, the next
refresh re-reads the authoritative tables — the feed is a hint, not the source of
truth.

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

- **Tenant = `tenant_id`.** Scheduling is a tenant-level, owner/admin capability;
  members (per-client) don't see it in V1.
- **Effective service duration is resolved per (site, service)** so the slot grid
  is uniform across staff (required for the "any barber" dedup). Per-staff
  *duration* overrides are stored but don't reshape the V1 grid; per-staff *price*
  overrides are honored at booking time.
- **Snapshots**: service name/duration/price/buffers are copied onto each
  appointment, so later catalogue edits never change historical bookings.
- **Staff working hours** default to the site's opening hours when left empty
  (`{}`); otherwise a missing weekday means the barber is off that day.
- **Backfill**: pre-existing conversations were linked to one imported contact per
  distinct `conversation_ref` (`channel = 'imported'`). Real channel identities
  arrive going forward via the API's resolve-or-create.
- **Admin exception times** are entered in the browser's local timezone in the V1
  UI (documented; site-tz-aware entry is a later refinement).
- **Rate limiting** for public endpoints is in-process (per web instance), enough
  for a single Railway instance; a shared limiter is future work.
- **Realtime** is polling (no WebSocket exists) — see §8.

### Explicitly out of scope for V1
Google Calendar sync, payments/deposits, recurring appointments, waitlists,
extra resources (chairs), staff rotating between sites, advanced week view,
drag-and-drop, full marketing CRM.
