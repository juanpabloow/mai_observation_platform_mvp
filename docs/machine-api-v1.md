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

**Two error stages.** *Auth-stage* failures (before the client is resolved) are deliberately
**indistinguishable** — a bad/missing/revoked token and a token lacking the capability all
return the SAME `401`, and any unknown/foreign `X-Workflow-Ref` returns the SAME `404
not_found` "Workflow not found." — so a caller can't probe what exists. *Resource-stage*
failures (AFTER auth, within the caller's own client) are **specific and actionable**: the
caller already has full access to that client, so naming the missing resource leaks nothing,
and an LLM agent needs the code to recover. A foreign id is still indistinguishable from a
nonexistent one (both → the same `*_not_found`), so nothing cross-client leaks.

| Status | code | When |
|---|---|---|
| 401 | `unauthorized` | bad/missing/revoked token, or a token lacking the required capability (auth-stage; indistinguishable) |
| 400 | `workflow_ref_required` | `X-Workflow-Ref` missing/blank (scheduling, CRM) |
| 404 | `not_found` | workflow not under this token's connection / unknown / foreign (auth-stage, "Workflow not found.") |
| 400 | `invalid_request` | a **malformed** id (not a UUID) or bad query param — fails loudly, never a 404 or empty result |
| 404 | `site_not_found` · `service_not_found` · `staff_not_found` · `contact_not_found` · `appointment_not_found` | a **well-formed** id with no such resource for this client. Message names the recovery endpoint (e.g. "Call GET /api/scheduling/v1/services?site_id=… to get valid ids") |
| 409 | `site_inactive` | the site exists but is **deactivated** — distinct from `site_not_found` so an operator can tell "wrong id" from "deactivated". Reactivate it, or use another site_id |
| 400 | `ambiguous_match` | a `service`/`staff` name (or a `by-time` identity) matched more than one row — the message lists the candidates (E-1) |
| 400 | `param_conflict` | an id and a name, or `start_at` and `day`+`time`, were both sent and disagree — send only one (E-1) |
| 409 | `staff_service_mismatch` | availability: the requested `staff`/`staff_id` doesn't perform the requested service — the message names who does (never an empty slot list) (E-1) |
| 403 | `module_disabled` | the resolved client has the family's module off (or is the default client) |
| 422 | `invalid_body` | malformed JSON / failed schema (create/patch bodies — id shape enforced here → never a silent empty result) |
| 422 | `validation` | a custom-field value fails its definition (names the field) |
| 409 | `conflict_slot` / `unavailable` / `conflict_idempotency` / `no_staff` / `invalid_transition` | booking conflicts |

A **fabricated but well-formed** id never reads back as an empty success: a filter like
`GET /appointments?contact_id=<uuid that never existed>` returns `404 contact_not_found`,
not `{ "appointments": [] }` — so an agent learns the id is wrong instead of concluding
"no appointments". Reads of EXISTING data still show a deactivated resource's history: an
inactive site's appointments remain listable via `GET /appointments?site_id=…`.

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

### 1.10 Semantic parameters (E-1, additive)

An API consumed by a language model should accept the values a model handles reliably —
**names, local dates, clock times** — as an alternative to opaque UUIDs and ISO timestamps
(a one-character UUID typo has already told a customer they had no appointments, and failed
an availability call mid-conversation). Every id/ISO path is **unchanged**; these are
parallel, resolved server-side. Names match **case- and accent-insensitively** (trimmed,
whitespace-collapsed).

**Resolve by name** — availability, staff and booking accept, instead of the id:
- **`service`** — the service NAME (alternative to `service_id`).
- **`staff`** — the staff member's NAME (alternative to `staff_id`).

No match → `400 service_not_found` / `staff_not_found` whose message **lists the valid
names** for that site. Two names both matching → `400 ambiguous_match` listing the
candidates (never a silent pick). An id and a name that disagree → `400 param_conflict`.

**Staff in availability (E-1 addendum).** Every availability slot additionally carries
`staff_name` (for the chosen `staff_id`) and `available_staff` — an array of `{ id, name }`
(the id fields `staff_id` / `available_staff_ids` are unchanged) — so an agent can say
"5:00 p.m. with Padre G" without mapping ids. A `staff` (or `staff_id`) filter returns
**only** that staff's slots — the engine does the set membership, not the model. A staff
member who exists but **doesn't perform the requested service** returns a distinct
`409 staff_service_mismatch` naming who does — **not** an empty slot list (which reads as
"no availability" and would make the agent report the wrong thing). Executed:

```
GET /api/scheduling/v1/availability?site_id=…&service=Corte&staff=Beto&from=…&to=…
→ 200  { "slots": [ { "start_at": "2026-08-20T14:00:00.000Z", "start_label": "9:00 a. m.",
                      "staff_id": "3682…", "staff_name": "Beto",
                      "available_staff_ids": ["3682…"],
                      "available_staff": [ { "id": "3682…", "name": "Beto" } ], … }, … ] }

GET …/availability?site_id=…&service=Color&staff=Beto&from=…&to=…
→ 409  { "error": { "code": "staff_service_mismatch",
                    "message": "Beto doesn’t perform Color. Staff who do: Ana. Omit the staff
                                filter to see all availability, or pick a service Beto performs." } }

GET …/availability?site_id=…&service=Corte&staff=Simón&from=…&to=…
→ 400  { "error": { "code": "staff_not_found",
                    "message": "No staff named “Simón” at this site. Valid staff: Ana, Beto." } }
```

**Local day + time** — booking and reschedule accept, instead of `start_at`:
- **`day`** — `YYYY-MM-DD` in the SITE's timezone.
- **`time`** — a clock time. **Accepted:** 24-hour `"HH:MM"` / `"H:MM"` (e.g. `14:30`,
  `9:00`); 12-hour `"H[:MM] am|pm"` (e.g. `9 am`, `9:00am`, `5 pm`, `5:30 p.m.`, `12 am`→
  `00:00`, `12 pm`→`12:00`). A bare number (`"5"`) is rejected as ambiguous. The server
  combines them with the site timezone (DST-correct), so the caller never converts. The
  instant is still validated against real availability; if it isn't bookable, the
  `409 unavailable`/`conflict_slot` message names the **nearest available times that day**.
  `start_at` + `day`/`time` that disagree → `400 param_conflict`.

**Identify an appointment without its UUID** (the most destructive id to transcribe wrong)
— cancel and reschedule accept the path segment **`by-time`** in place of the `{id}`, then
the body carries `phone` (or `email` / `external_id`) + `current_day` + `current_time`,
resolved to that contact's **active** appointment at that local moment:
- exactly one → act on it;
- none → `404 appointment_not_found` listing the contact's active appointments (day/time/service);
- more than one → `400 ambiguous_match` listing them (never guess when a cancellation is at stake).

On reschedule via `by-time`, `current_day`/`current_time` identify the appointment and
`day`/`time` (or `start_at`) are the NEW slot. `POST /appointments/{uuid}/cancel|reschedule`
is unchanged. **`site_id` is the one parameter with no name alternative today** (there is
normally one site; a `site`/slug alternative is a candidate follow-up).

### 1.11 Featured services (E-2, additive)

An agent asked "quiero agendar mañana a las 11" must pick a service before it can check
availability (durations differ). To let a shop lead with 2–3 signature services instead of
dumping the whole catalogue (or guessing), `GET /api/scheduling/v1/services`:
- adds **`featured: true|false`** to each service object (no version bump);
- returns **featured services FIRST** (then the rest, each group name-ordered), so a caller
  reading in order naturally leads with them;
- accepts **`?featured=true`** to return only the featured ones.

**Empty-fallback (important):** if the client has marked NO service as featured,
`?featured=true` returns the **FULL list**, never an empty one — an agent must never be left
with nothing to offer because the operator hasn't configured anything yet. Executed:

```
GET /api/scheduling/v1/services?site_id=e5793e2a-…
→ 200  { "services": [ { "id":"…","name":"Color","featured":true,
                          "price":"120000.00","price_label":"$120.000", … },   # featured first; E-4 price_label
                        { "id":"…","name":"Barba","featured":false, … },
                        { "id":"…","name":"Corte","featured":false, … } ] }

GET /api/scheduling/v1/services?site_id=e5793e2a-…&featured=true
→ 200  { "services": [ { "name":"Color","featured":true, … } ] }             # only featured
        # …but with NONE marked featured, the same call returns all three (never []).
```

### 1.12 Readable availability (E-3, additive)

A one-day, one-staff availability response can be 26 slots × ~10 fields — mostly redundant
for a caller that only needs to know what is free, and the extra surface invites
hallucination (an agent claimed 11:00 was free when the slot list skipped it). Three
additive aids move the grouping into the engine, where it is deterministic:

- **`free_blocks`** — contiguous runs of free slots collapsed into ranges, per day + staff,
  with read-aloud labels. A run breaks wherever a slot in between is taken; `to_label` is the
  END of the last slot in the run (60-min slots starting 9:00…10:00 end at 11:00).
- **`has_availability`** — `{ "<day>": true|false }` for each requested local day, so a
  caller answers "¿hay cupo mañana?" by indexing, not by scanning the slot array.
- **`?compact=true`** — trims each slot to the fields needed to choose + book
  (`day`, `start_label`, `end_label`, `time` (24h HH:MM), `staff_name`), dropping
  `candidates`, `available_staff_ids`, `start_at`/`service_end_at`/`start_local`/`end_local`.
  The FULL slot shape is the default (existing callers unaffected). A conversational caller
  should use `compact=true` **plus** `free_blocks`.

Executed — a day with an 11:00–12:00 appointment (`Coneja`, 60-min service, 15-min grid):

```
GET /api/scheduling/v1/availability?site_id=…&service=Corte&staff=Coneja&from=…&to=…&compact=true
→ 200 {
  "site": { "id":"…","timezone":"America/Bogota","timezone_used":"America/Bogota" },
  "has_availability": { "2026-08-05": true },
  "free_blocks": [
    { "day":"2026-08-05","date_label":"miércoles, 5 de agosto","staff_name":"Coneja",
      "from_label":"9:00 a. m.","to_label":"11:00 a. m.",
      "first_start_at":"2026-08-05T14:00:00.000Z","first_start_local":"2026-08-05T09:00:00-05:00","first_time":"09:00" },
    { "day":"2026-08-05","date_label":"miércoles, 5 de agosto","staff_name":"Coneja",
      "from_label":"12:00 p. m.","to_label":"6:00 p. m.", "first_time":"12:00", … }
  ],
  "slots": [ { "day":"2026-08-05","start_label":"9:00 a. m.","end_label":"10:00 a. m.","time":"09:00","staff_name":"Coneja" }, … ]
}
```

### 1.13 Compact responses + labels for conversational callers (E-4, additive)

The SAFE trims from the output catalog (`docs/machine-api-output-catalog.md`). All additive —
the full shapes are unchanged, so programmatic callers are unaffected.

- **`?compact=true` on the appointments list** (`GET /api/scheduling/v1/appointments`) — each
  row trimmed to `id, status, service_name, staff_name, day, date_label, start_label,
  end_label, time, contact{name}`. Measured ~4 621 B → ~1 273 B (−74 %) for 5 rows.
- **`staff_name` on EVERY appointment object** (list, create, cancel, reschedule, confirm,
  complete, no-show) — so an agent says "con Ana" without mapping a UUID. Resolved in one
  lookup per response (the list gets it from its join).
- **`?compact=true` on the CRM contact summary** (`GET /contacts/{id}` and `/lookup`) — keeps
  id, name, stage, is_customer, visits, no_shows, consent, identities (kind+value), tags,
  custom_fields, and a labeled compact `next_appointment`; drops `owner_user_id`,
  `next_appointment.public_reference`, the raw `created_at`/`created_at_local` note pair, and
  identity labels. Measured ~1 266 B → ~795 B (−40 %).
- **`price_label` on service objects** (`GET /services`) — Colombian format from the raw
  `price` (`"35000.00"` → `"$35.000"`; cents kept as `"$2.500,50"`); raw `price` unchanged.

**Guidance for a conversational (LLM) caller:** **send `compact=true`** on availability,
appointments and contact reads; on availability **read `free_blocks` first** (it is the
PRIMARY availability surface — the ranges to offer aloud), falling back to the compact slots
only to pin an exact booking time; and **resolve by name and day+time, never by UUID**
(service/staff by name, appointments by `phone`+`current_day`+`current_time` via the
`by-time` path). UUIDs remain for programmatic callers.

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
`GET /contacts/{id}` and `/lookup` accept **`?compact=true`** for a conversational caller —
the leaner shape in §1.13 (drops `owner_user_id`, `next_appointment.public_reference`, the raw
note `created_at` pair, identity labels; keeps the spoken labels). The full shape below is the
default.
```json
{
  "id": "…", "name": "…|null", "stage": "new|active|customer|archived",
  "owner_user_id": "…|null", "is_customer": false, "visits": 0, "no_shows": 0,
  "consent": "unknown|opted_in|opted_out", "custom_fields": { },
  "identities": [ { "kind": "phone|email|external", "value": "…", "label": "…|null" } ],
  "tags": [ "…" ],
  "next_appointment": {
    "id","public_reference","service_name","staff_name","status",
    "start_at": "2026-08-05T16:00:00.000Z",          // canonical UTC
    "start_local": "2026-08-05T11:00:00-05:00",       // E-3: local labels (site tz unless ?tz)
    "start_label": "11:00 a. m.", "date_label": "miércoles, 5 de agosto", "day": "2026-08-05"
  } | null,
  "recent_notes": [ {
    "id", "body", "author": "user|automation|system",
    "created_at": "…Z", "created_at_local": "…-05:00", "created_at_label": "martes, 4 de agosto, 5:24 p. m."
  } ]
}
```
**Timestamp rule (E-3): no machine-API response exposes a timestamp without a local label
beside it** — a raw UTC value alone is a trap for an LLM consumer (an agent read a
`16:00Z` next_appointment and told the customer "4:00 p. m." instead of 11:00 a. m.). Every
`*_at` gets `*_local` (offset-ISO) + a spoken `*_label`, formatted with the SAME C-6 helper.
`next_appointment` uses the appointment's SITE timezone; site-less timestamps (notes) use
the client's site timezone. Both routes honor `?tz` / `?locale` to override. (The sole
exception is the handoff `mode` endpoint's `as_of`, a control-plane "evaluated-at now"
marker that is never read to a customer.)
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
