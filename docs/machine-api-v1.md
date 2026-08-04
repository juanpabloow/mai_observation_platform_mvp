# Machine API v1 — the automation-facing contract

**Project:** MT_AI observability + CRM/scheduling platform
**Phase:** C-5 (machine API for automations)
**Status:** ✅ Locked — v1. The spec outranks the code: if an implementation disagrees
with this document, the implementation is wrong.
**Audience:** builders of n8n workflows / AI tool-calling loops.

> **Structure.** §1 is the shared contract for the whole machine surface. §2 indexes the
> three API families (handoff, scheduling, CRM) and their required capabilities. §3 is a
> runnable "getting started" booking sequence. §4 explains how a business's schedule is
> configured (not coded). Every request/response in this document was **executed against a
> local server** on 2026-08-03 and pasted verbatim (tokens redacted to `hk_…`); ids are
> from a throwaway demo tenant.

---

## 1. Shared conventions

### 1.1 Base paths and versioning
Three families, each versioned in its path:

| Family | Base path | Capability vocabulary it uses |
|---|---|---|
| Handoff | `/api/handoff/v1` | `handoff` |
| Scheduling | `/api/scheduling/v1` | `scheduling.read`, `scheduling.write` |
| CRM | `/api/crm/v1` | `crm.read`, `crm.write` |

**Evolution.** Within `v1`, changes are **additive only** — new endpoints, new optional
request fields, new response fields. A caller MUST ignore response fields it does not
recognize. Removing or renaming a field, making an optional field required, or changing a
status code for an existing case is **breaking** and ships as `/v2`. `v1` is not retired
while any workflow still uses it.

### 1.2 Authentication — Bearer machine token
Every request carries `Authorization: Bearer <token>`. Tokens look like `hk_…`, are minted
per **n8n connection** (owner/admin, in Settings → n8n connections → Machine tokens), and
are stored **hash-only** (SHA-256) — the raw value is shown once, at creation. A token
resolves server-side to its **tenant + connection**; the request never sends a tenant or
client id.

A missing, malformed, unknown, or revoked token → **401** with a single body (never
revealing which):

```
→ 401
{ "error": { "code": "unauthorized", "message": "Invalid or missing credentials." } }
```

### 1.3 Capabilities — deny-by-default
Each token grants an explicit set from exactly these five, dot-separated:

| Capability | Grants |
|---|---|
| `handoff` | the handoff exchanges (messages, mode, escalations) |
| `scheduling.read` | services, staff, sites, availability, appointment reads |
| `scheduling.write` | create / cancel / reschedule / confirm / complete / no-show |
| `crm.read` | contact lookup and reads |
| `crm.write` | contact upsert, notes, tags, field + consent writes |

A token grants **only** what it lists. An unknown/removed capability string is treated as
**absent** — never a wildcard. Each route declares the ONE capability it requires; the
capability is checked in the auth chokepoint **before** the workflow is resolved.

**Reconnaissance resistance (verified live).** A token that lacks the required capability
is refused with the **exact same 401 body** as a bad or revoked token, and — because the
capability is checked before scope — it gets that 401 regardless of the workflow ref it
sends. So "no capability", "unknown token", "revoked token", and "foreign workflow ref"
are indistinguishable to an un-capable caller. A *capable* token that names a workflow
outside its connection gets the standard **404** (see 1.5).

### 1.4 `X-Workflow-Ref` and how tenant + client are derived
Scheduling and CRM requests MUST send `X-Workflow-Ref: <n8n workflow id>`. The server:

1. resolves the **token** → its tenant + connection,
2. resolves `X-Workflow-Ref` → the workflow **synced under that connection**,
3. reads that workflow's owning **client**.

So a token can only ever act on the ONE client its workflow ref resolves to; it can never
reach another connection's workflow or another client's data. **`tenant_id` and
`client_id` are never accepted from the request.** (The handoff family carries the ref as
`workflow_ref` in the body/query instead of the header — see handoff-contract-v1.md.)

### 1.5 Errors
One shape everywhere: `{ "error": { "code": <machine code>, "message": <human, Spanish-
paraphrasable> } }`. Never leak internals.

| Status | code | When |
|---|---|---|
| 401 | `unauthorized` | bad/missing/revoked token, or a token lacking the required capability |
| 400 | `workflow_ref_required` | `X-Workflow-Ref` missing/blank (scheduling, CRM) |
| 404 | `not_found` | workflow not under this token's connection; unknown contact/appointment; a foreign id |
| 403 | `module_disabled` | the resolved client has the family's module off (or is the default client) |
| 422 | `invalid_body` / `invalid_request` | malformed JSON / failed schema |
| 422 | `validation` | a custom-field value fails its definition (names the field) |
| 409 | `conflict_slot` / `unavailable` / `conflict_idempotency` / `no_staff` / `invalid_transition` | booking conflicts |

### 1.6 Idempotency-Key (agents retry)
Every **write** accepts an optional `Idempotency-Key` header. A retry with the same key
returns the **original** result, not a duplicate:

- **Scheduling create** and **CRM notes** enforce it via a stored key (fresh → `201`;
  replay → `200` with the same body).
- **CRM upsert / patch / tag attach·detach** are **naturally idempotent** (resolving the
  same identity returns the same contact; setting the same fields is a no-op;
  attach/detach are ON-CONFLICT no-ops), so they honor the header without a stored key.

### 1.7 Rate-limit posture
Public booking endpoints are IP-rate-limited (best-effort, per web instance). The machine
token routes are not per-token rate-limited today; treat generous but polite call volumes
as the contract and expect a future per-token limit (it will surface as `429 rate_limited`
with the standard error shape).

### 1.8 Local-time fields + `tz` / `locale` (C-6, additive)
Every timestamp is returned as UTC (`…Z`) — **that is the canonical value to pass back**
when booking (`start_at`). Alongside it, availability slots and appointment objects carry
**display-only** local fields so an agent never converts timezones itself:

| field | example | meaning |
|---|---|---|
| `start_local` / `end_local` | `2026-08-05T08:00:00-05:00` | ISO-8601 with the local offset (DST-correct for the instant) |
| `start_label` / `end_label` | `8:00 a. m.` | short spoken 12-hour time in `locale` |
| `date_label` | `miércoles, 5 de agosto` | spoken date (the START's local date) |
| `day` | `2026-08-05` | the LOCAL calendar date (group by day without parsing; can differ from the UTC date near midnight) |

Two optional query params tune presentation (they change NOTHING stored, available, or
computed):
- **`tz`** — an IANA name (e.g. `America/Mexico_City`). **Default: the site's own timezone**
  (an appointment happens at a physical place). An unknown IANA name → `400 invalid_request`
  naming `tz` — **never** a silent UTC fallback. Available on `/availability` and the
  appointments endpoints. The availability `site` object reports both `timezone` (the
  site's) and `timezone_used` (what the labels were formatted in).
- **`locale`** — label text; **default `es-CO`** (12-hour with a. m./p. m.; note es-CO
  renders a narrow space, "a. m."). An unsupported locale → `400` naming `locale`.

This is an **additive** change under §1.1: no version bump, `start_at`/`service_end_at`
are unchanged, and existing consumers keep working (they simply ignore the new fields).

### 1.9 Contact identification + list filters (C-7, additive)

**Contact object.** Every appointment object now carries a `contact` alongside the
unchanged `contact_id`, so a human/agent can tell *whose* appointment it is without a
second lookup:

```json
"contact": { "id": "0e40…", "name": "Camila Torres", "primary_identity": "+573001234567" } | null
```

`primary_identity` is the contact's main phone (else email). `contact` is `null` for a
walk-in (no `contact_id`). Additive — `contact_id` is unchanged, no version bump.

**`GET /api/scheduling/v1/appointments` filters.** The list is **always** scoped to the
token's one client; filters only narrow within it. **A filter is never silently
ignored** — an unrecognized or empty-valued param is a `400`, so a mistyped filter can
never widen the result to the whole client:

| param | meaning |
|---|---|
| `contact_id` | a single contact (UUID) |
| `phone` / `email` / `external_id` | resolve an identity → that contact's appointments; an identity matching nobody returns **0 rows** (never the whole list) and excludes walk-ins |
| `status` | one or more of `scheduled,confirmed,completed,cancelled,no_show` (comma-separated and/or repeated) |
| `active=true` | convenience for `scheduled`+`confirmed` |
| `site_id` / `staff_id` / `conversation_id` / `from` / `to` | as before |

Error bodies: `400 unknown_parameter` (an unsupported param, named), `400
empty_parameter` (a recognized param sent with an empty value, named), `400
invalid_request` (an unknown `status` value, a non-`true/false` `active`, or a bad
`from`/`to`). No identifying filter is *required* — a bare site/day listing stays valid.

---

## 2. The three families

### 2.1 Handoff — capability `handoff`
The conversation contract (inbound messages, mode checks, human escalation, outbound
send) is specified — authoritatively — in **[handoff-contract-v1.md](./handoff-contract-v1.md)**.
It is NOT restated here. C-5 only adds that these routes now require the `handoff`
capability; refusal bodies are unchanged. Zero-breakage smoke (legacy token), run live:

```
POST /api/handoff/v1/messages     → 201  { "message_id": "6c12…", "conversation": { "id": "656f…", "mode": "bot", "assigned_agent": null } }
GET  /api/handoff/v1/mode?…       → 200  { "mode": "bot", "as_of": "2026-08-03T19:47:05.710Z" }
POST /api/handoff/v1/escalations  → 201  { "conversation": { "id": "656f…", "mode": "pending", "assigned_agent": null } }
```

### 2.2 Scheduling — capability `scheduling.read` (reads) / `scheduling.write` (writes)
The machine-readable source of truth for request/response schemas is
**[scheduling-openapi.yaml](./scheduling-openapi.yaml)** (OpenAPI 3.1, reconciled with the
C-1 corrections — it documents the `X-Workflow-Ref` header and the workflow-ref scope
model). Endpoints:

| Method + path | Capability |
|---|---|
| `GET /api/scheduling/v1/sites` | `scheduling.read` |
| `GET /api/scheduling/v1/services?site_id=` | `scheduling.read` |
| `GET /api/scheduling/v1/staff?site_id=&service_id=` | `scheduling.read` |
| `GET /api/scheduling/v1/availability?site_id=&service_id=&from=&to=&staff_id=` | `scheduling.read` |
| `GET /api/scheduling/v1/appointments?…` | `scheduling.read` |
| `POST /api/scheduling/v1/appointments` (requires `Idempotency-Key`) | `scheduling.write` |
| `POST /api/scheduling/v1/appointments/{id}/{cancel,confirm,complete,no-show,reschedule}` | `scheduling.write` |

See §3 for a runnable end-to-end sequence.

### 2.3 CRM — capability `crm.read` (reads) / `crm.write` (writes)
Fully specified here (no other document). **Channel-blind**: no field or code names a
channel; identities are `phone` / `email` / `external`.

#### The contact summary (returned by lookup, GET, upsert, PATCH, tag writes)
```json
{
  "id": "…", "name": "…|null", "stage": "new|active|customer|archived",
  "owner_user_id": "…|null", "is_customer": false, "visits": 0, "no_shows": 0,
  "consent": "unknown|opted_in|opted_out", "custom_fields": { },
  "identities": [ { "kind": "phone|email|external", "value": "…", "label": "…|null" } ],
  "tags": [ "…" ],
  "next_appointment": { "id","public_reference","service_name","staff_name","start_at","status" } | null,
  "recent_notes": [ { "id", "body", "author": "user|automation|system", "created_at" } ]
}
```
`is_customer` / `visits` / `no_shows` / `next_appointment` are **derived** from the
contact's appointments (never stored). Every write records the `crm_activity_events` audit
fact C-3 defines, attributed to the **automation** — so the record's timeline shows
automation-driven changes as "Automation", not "System".

#### `GET /api/crm/v1/contacts/lookup?phone=&email=&external_id=` — `crm.read`
Read-only resolution through the identity model; the value is normalized before lookup;
**creates nothing**. `404` when unknown (so an agent can ask "do we know this person?").

```
GET /api/crm/v1/contacts/lookup?phone=%2B573001234567
Authorization: Bearer hk_…      X-Workflow-Ref: demo-crm-wf
→ 404
{ "error": { "code": "not_found", "message": "No contact matches that identity." } }
```

#### `POST /api/crm/v1/contacts/upsert` — `crm.write`
Body: `{ phone?, email?, external_id?, name?, custom_fields?, consent?, source_label? }`
(at least one identity required). The **only** path that may create a contact — through the
identity chokepoint (the same person can't fork into two contacts; duplicate candidates are
recorded, never silently merged). Profile fields are **fill-empty** (a non-empty name is
never overwritten); **consent overwrites** (an explicit opt-out sticks).

```
POST /api/crm/v1/contacts/upsert
Authorization: Bearer hk_…      X-Workflow-Ref: demo-crm-wf
{ "phone": "+57 300 123 4567", "name": "Camila Torres", "source_label": "whatsapp" }
→ 200
{ "contact": { "id": "0e40…", "name": "Camila Torres", "stage": "new", "consent": "unknown",
  "identities": [ { "kind": "phone", "value": "+573001234567", "label": "whatsapp" } ],
  "tags": [], "next_appointment": null, "recent_notes": [], … } }
```
Re-upserting with a **differently-formatted** phone resolves the SAME contact and does not
overwrite the name (verified live):
```
POST …/upsert   { "phone": "573-001-234-567", "name": "Should Not Overwrite" }
→ 200   contact id 0e40… unchanged, name still "Camila Torres"
```

#### `GET /api/crm/v1/contacts/{contact_id}` — `crm.read`
Returns the contact summary; `404` (indistinguishable) for an unknown or cross-client id.

#### `PATCH /api/crm/v1/contacts/{contact_id}` — `crm.write`
Body: `{ name?, email?, stage?, consent?, custom_fields? }`. Custom fields are validated
against the client's definitions — an unknown key or wrong type is `422 validation` naming
the field:
```
PATCH …/{id}   { "stage": "active", "consent": "opted_out", "custom_fields": { "barbero_preferido": "Ana" } }
→ 200   contact stage="active", consent="opted_out", custom_fields={ "barbero_preferido": "Ana" }

PATCH …/{id}   { "custom_fields": { "no_such_field": "x" } }
→ 422   { "error": { "code": "validation", "message": "unknown custom field: no_such_field" } }

PATCH …/{id}   { "custom_fields": { "barbero_preferido": 123 } }
→ 422   { "error": { "code": "validation", "message": "barbero_preferido must be text" } }
```

#### `POST /api/crm/v1/contacts/{contact_id}/notes` — `crm.write`
Body: `{ body }`. An **automation-authored** note (it renders in the timeline as
"Automation"). Replay-safe with `Idempotency-Key`:
```
POST …/{id}/notes   Idempotency-Key: note-key-1   { "body": "Cliente prefiere las mañanas." }
→ 201   { "note": { "id": "4c37…", "body": "Cliente prefiere las mañanas.", "author": "automation", "created_at": "…" } }
POST …/{id}/notes   Idempotency-Key: note-key-1   (same body)
→ 200   same note id (no duplicate)
```

#### `POST /api/crm/v1/contacts/{contact_id}/tags` — `crm.write`
Body: `{ tag }` **by name** (agents don't know ids): creates the tag for the client if
absent, then attaches idempotently. Returns the contact summary (now including the tag).
`DELETE /api/crm/v1/contacts/{contact_id}/tags/{tag}` (name, url-encoded) detaches
idempotently.
```
POST …/{id}/tags   { "tag": "VIP" }   → 200   contact.tags: [ "VIP" ]
POST …/{id}/tags   { "tag": "VIP" }   → 200   (idempotent no-op)
DELETE …/{id}/tags/VIP                 → 200   contact.tags: [ ]
```

#### `GET /api/crm/v1/field-definitions` — `crm.read`
The client's enabled contact field definitions — makes the API self-describing.
```
→ 200
{ "field_definitions": [ { "key": "barbero_preferido", "label": "Barbero preferido", "type": "text", "options": null } ] }
```

#### Isolation (verified live)
```
GET  /api/crm/v1/contacts/{tenant-B contact id}    (tenant-A token)  → 404 not_found
GET  /api/crm/v1/field-definitions  X-Workflow-Ref: <tenant-B wf>    → 404 not_found
GET  /api/crm/v1/field-definitions  X-Workflow-Ref: (blank)          → 400 workflow_ref_required
```

---

## 3. Getting started for an n8n AI agent — the booking conversation

The complete "customer wants a haircut" flow, as a numbered call sequence. Reads need
`scheduling.read` + `crm.read`; writes need `scheduling.write` + `crm.write`. Every call
sends `Authorization: Bearer hk_…` and `X-Workflow-Ref: demo-crm-wf`. Real outputs:

**1. Resolve or create the contact** (so the appointment attaches to a real person):
```
POST /api/crm/v1/contacts/upsert   { "phone": "+57 300 123 4567", "name": "Camila Torres", "source_label": "whatsapp" }
→ 200   contact id 0e4031df-…
```

**2. List services** for the site (the site id comes from `GET /api/scheduling/v1/sites`):
```
GET /api/scheduling/v1/services?site_id=e5793e2a-…
→ 200   { "services": [ { "id": "90767852-…", "name": "Corte de cabello", "duration_min": 45, "price": "35000.00", … }, … ] }
```

**3. List staff who can do that service:**
```
GET /api/scheduling/v1/staff?site_id=e5793e2a-…&service_id=90767852-…
→ 200   { "staff": [ { "id": "07d603c3-…", "name": "Ana Gómez" }, { "id": "…", "name": "Beto Ruiz" } ] }
```

**4. Ask for availability** (an ISO window; ≤ 45 days). Each slot carries UTC + local
(C-6). No `tz` was passed, so labels are in the site's own timezone (`timezone_used`):
```
GET /api/scheduling/v1/availability?site_id=e5793e2a-…&service_id=90767852-…&from=2026-08-05T12:00:00Z&to=2026-08-05T23:00:00Z
→ 200
{ "site": { "id": "e5793e2a-…", "timezone": "America/Bogota", "timezone_used": "America/Bogota" },
  "slots": [ { "start_at": "2026-08-05T13:00:00.000Z", "service_end_at": "2026-08-05T13:45:00.000Z",
               "start_local": "2026-08-05T08:00:00-05:00", "end_local": "2026-08-05T08:45:00-05:00",
               "start_label": "8:00 a. m.", "end_label": "8:45 a. m.", "date_label": "miércoles, 5 de agosto", "day": "2026-08-05",
               "staff_id": "07d603c3-…", "available_staff_ids": [ "07d603c3-…", "f64bda…" ], "candidates": [ … ] }, … ] }
```
Pass `&tz=America/Mexico_City` and the SAME slot returns identical `start_at` with
`start_local: "2026-08-05T07:00:00-06:00"`, `start_label: "7:00 a. m."`, and the same set
of slots — presentation only. An invalid `tz` → `400 { "error": { "code":
"invalid_request", "message": "tz is not a valid IANA timezone name: …" } }`.

**5. Create the appointment** with an `Idempotency-Key` (pick a slot's `start_at` +
`staff_id`):
```
POST /api/scheduling/v1/appointments   Idempotency-Key: book-key-1
{ "site_id": "e5793e2a-…", "service_id": "90767852-…", "staff_id": "07d603c3-…",
  "start_at": "2026-08-05T13:00:00.000Z", "customer_name": "Camila Torres",
  "customer_phone": "+573001234567", "channel": "whatsapp", "channel_user_id": "573001234567" }
→ 201
{ "appointment": { "id": "19bddd34-…", "public_reference": "e4bbb506-…", "status": "scheduled",
                   "service_name": "Corte de cabello", "start_at": "2026-08-05T13:00:00.000Z",
                   "start_local": "2026-08-05T08:00:00-05:00", "start_label": "8:00 a. m.",
                   "date_label": "miércoles, 5 de agosto", "day": "2026-08-05",
                   "contact_id": "0e40…",
                   "contact": { "id": "0e40…", "name": "Camila Torres", "primary_identity": "+573001234567" }, … } }
```
Round-trip verified live: the availability slot's `start_at` passed back verbatim books
that exact instant, and the appointment's local fields match the slot's.

**6. Retry safely** — the same key replays the original (no double-book):
```
POST /api/scheduling/v1/appointments   Idempotency-Key: book-key-1   (same body)
→ 200   same appointment id 19bddd34-…
```

**7. Handle a taken slot** — a different customer, same slot → re-offer availability:
```
POST /api/scheduling/v1/appointments   Idempotency-Key: book-key-2   { …same start_at, different customer… }
→ 409   { "error": { "code": "unavailable", "message": "That time is no longer available." } }
```
(A concurrent race that passes availability but loses the write returns `409 conflict_slot`
— the GiST exclusion constraint. Either way: re-offer slots from step 4.)

**8. Later reads — "when is my appointment?"**
```
GET /api/crm/v1/contacts/{id}   → 200   contact.next_appointment: { service_name, staff_name, start_at, status }
GET /api/scheduling/v1/appointments?contact_id={id}   → 200   { "appointments": [ … ] }
```

**9. Confirm / reschedule / cancel:**
```
POST /api/scheduling/v1/appointments/19bddd34-…/confirm      → 200   status "confirmed"
POST /api/scheduling/v1/appointments/19bddd34-…/reschedule   { "start_at": "2026-08-05T15:00:00.000Z", "staff_id": "07d603c3-…" }
→ 200   start_at moved, status "confirmed", version bumped
POST /api/scheduling/v1/appointments/19bddd34-…/cancel       { "reason": "customer request" }   → 200   status "cancelled"
```

---

## 4. How a business gets its own schedule (configuration, not code)

A barber's bookable times are **derived**, per staff member, from configuration — there is
no per-staff code:

```
bookable(staff) =  site opening hours
                 ∩ that staff member's working hours
                 − schedule exceptions (holidays, lunch, blocks)
                 − already-booked intervals (incl. service buffers)
```

The remaining free time is then **discretized into slots** using the site's
`scheduling_config`: `slot_interval_min` (the grid), `min_notice_min` (how soon is too
soon), `booking_horizon_days` (how far out), and per-service `buffer_before_min` /
`buffer_after_min` (cleanup/turnaround, added around the booked interval). Availability
(§3 step 4) applies all of this and returns only startable slots. So onboarding a business
is: create a site (hours + timezone + config) → add staff (working hours) → add services
(durations + buffers) → map which staff do which services. No code per business.

---

## Provenance

Every request/response above was executed against a local production build on 2026-08-03
(a throwaway two-tenant demo DB) and pasted verbatim; tokens are redacted to `hk_…`.
The full transcript (35 calls: capability enforcement, CRM behavior, isolation, the
scheduling smoke, and the handoff smoke) all returned the documented statuses.

**Superseded / reconciled:** `scheduling-openapi.yaml` remains the machine-readable schema
source for the scheduling family and is current (it already documents `X-Workflow-Ref`).
This document is the authoritative prose contract for the whole machine surface and the
sole specification for the CRM family.
