# Scheduling API for n8n — `/api/scheduling/v1/*`

Machine-to-machine API. Every request is scoped to ONE client, resolved entirely
from the credentials + headers — **`tenant_id` and `client_id` are never sent by
n8n** (a request that includes them is ignored; they can't widen scope).

## Required headers (every endpoint)

```
Authorization: Bearer <scheduling token>     # the per-connection machine token
X-Workflow-Ref: {{$workflow.id}}             # the calling n8n workflow's id
```

`X-Workflow-Ref` is the only provenance authority: the workflow must be synced
under the token's own n8n connection, and its assigned **client** must be a
non-default client with the **scheduling module enabled**. That client is the
only one the request can read or write.

For `POST /appointments` also send:

```
Idempotency-Key: <uuid>                      # required; a retry with the same key
Content-Type: application/json               # + same payload returns the same appt
```

## Resolution chain

```
Bearer token → tenant + n8n connection
  → X-Workflow-Ref → the workflow synced under THAT connection
  → the workflow's client_id → non-default client → scheduling enabled
  → sites / services / staff / availability / appointments of THAT client only
```

## Error codes

| HTTP | body `error.code` | when |
| --- | --- | --- |
| 401 | `unauthorized` | token missing / invalid / revoked |
| 400 | `workflow_ref_required` | token ok but `X-Workflow-Ref` missing/blank |
| 404 | `not_found` (`Workflow not found.`) | workflow unknown / other connection / other tenant |
| 403 | `module_disabled` | workflow on the default (Unassigned) client, or scheduling absent/disabled |
| 404 | `not_found` (`Not found.`) | any `site_id` / `service_id` / `staff_id` / appointment id that is malformed, unknown, from another client, or (for service/staff) not enabled at / not part of the resolved site — one generic 404, never revealing it exists elsewhere |
| 409 | `conflict_slot` / `conflict_idempotency` / `unavailable` / `no_staff` / `invalid_transition` | slot taken, key reuse with different payload, slot gone, staff can't do it, illegal status change |
| 422 | `invalid_body` | malformed JSON / failed validation (only reached AFTER auth + scope pass) |

Auth + scope run **first**: an unauthenticated or wrongly-scoped request never
receives body/query validation errors.

Body shape: `{"error":{"code":"...","message":"..."}}` on every failure.

## Endpoints & examples

Base: `https://<your-web-host>/api/scheduling/v1`. Replace `$TOKEN` / `$WF` with
your Bearer token and workflow id. (Examples below use placeholders — never commit
real tokens or hosts.)

```bash
H=(-H "Authorization: Bearer $TOKEN" -H "X-Workflow-Ref: $WF")

# Sites of the resolved client
curl "${H[@]}" "$BASE/sites"

# Services enabled at a site
curl "${H[@]}" "$BASE/services?site_id=$SITE"

# Staff at a site who can perform a service
curl "${H[@]}" "$BASE/staff?site_id=$SITE&service_id=$SVC"

# Availability (staff_id optional = "any"); from/to are ISO-8601
curl "${H[@]}" "$BASE/availability?site_id=$SITE&service_id=$SVC&from=2026-08-05T00:00:00Z&to=2026-08-06T00:00:00Z"

# Create (Idempotency-Key required). conversation_ref MAY be sent; workflow_ref
# is NOT a body field — provenance is the X-Workflow-Ref header.
curl "${H[@]}" -H "Idempotency-Key: 4f0e...uuid" -H "Content-Type: application/json" \
  -d '{"site_id":"'"$SITE"'","service_id":"'"$SVC"'","staff_id":"'"$STAFF"'",
       "start_at":"2026-08-05T15:00:00Z",
       "conversation_ref":"wa:57300...","channel":"whatsapp","channel_user_id":"57300...",
       "customer_name":"Ana","customer_phone":"+57300..."}' \
  "$BASE/appointments"

# List (always scoped to the resolved client; filters can only narrow)
curl "${H[@]}" "$BASE/appointments?status=scheduled&from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z"

# Status changes / reschedule (id = appointment id of THIS client)
curl "${H[@]}" -X POST "$BASE/appointments/$ID/confirm"
curl "${H[@]}" -X POST "$BASE/appointments/$ID/cancel"     -H "Content-Type: application/json" -d '{"reason":"customer called"}'
curl "${H[@]}" -X POST "$BASE/appointments/$ID/complete"
curl "${H[@]}" -X POST "$BASE/appointments/$ID/no-show"
curl "${H[@]}" -X POST "$BASE/appointments/$ID/reschedule" -H "Content-Type: application/json" -d '{"start_at":"2026-08-05T16:00:00Z"}'
```

## Notes

- An appointment/site/service/staff id that is malformed, unknown, belongs to
  another client, or isn't enabled at / part of the resolved site returns the same
  generic `404 {"error":{"code":"not_found","message":"Not found."}}` — the API
  never confirms it exists elsewhere (and a malformed id never reaches PostgreSQL).
- `Idempotency-Key` is tenant-scoped; a key collision with **another client's**
  appointment returns `409 conflict_idempotency`, never that appointment.
- If scheduling is turned off for the client (even mid-request), writes return
  `403 module_disabled` and change nothing; re-enabling restores access to the
  existing data.
- `services` belong to a **single client** (`services.client_id`) and are enabled per
  site (`site_services`); a service can only be enabled at, assigned to staff of, or
  booked against a site of its OWN client. The API only ever exposes/uses services of
  the workflow's resolved client — a service id from another client returns the same
  generic `404 not_found`, never revealing it exists elsewhere.
