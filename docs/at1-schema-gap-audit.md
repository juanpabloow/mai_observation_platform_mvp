# AT-1 schema-gap audit — migration 1808 unapplied for ~1 day

**What happened.** The Railway services are configured from the dashboard; the `railway.*.json`
files are NOT linked. MF-1.1 added the `preDeployCommand` only to those (inert) json files, so it
never ran. AT-1 code deployed (auto-deploy on push to `main`) while migration
`1808000000000_attribution` stayed unapplied — the attribution tables/columns did not exist while
code that references them served. Fixed by adding the Pre-deploy Command in the dashboard
(2026-10-18); `preDeployCommand` removed from the json files.

## Which code paths touch the new schema, and were they fail-safe?

New schema: tables `ads`, `attribution_touches`, `campaigns`, `attribution_settings`; `contacts`
columns `origin_kind` / `first_touch_id` / `latest_touch_id` / `origin_set_at` / `origin_set_by` /
`origin_ref_contact_id`; `crm_activity_events` event types `origin_set` / `attribution_touch`.

| Path | Touches new schema | Fail-safe? | Effect during the gap |
|---|---|---|---|
| **Message write** (`POST /handoff/v1/messages`) | no (the write itself) | n/a | **SAFE.** Every message stored; bot replied normally. |
| **Contact creation** (`resolveContactByIdentity`/`ensureContactForInboundMessage`) | no — `insertContact` uses only the original columns; the new `created` flag is computed in JS | n/a | **SAFE.** New contacts were created normally. |
| **Live attribution** (`ingestLiveReferral`, only when a referral is present) | yes (`ads`, `attribution_touches`, origin columns) | **YES** — runs in the `/messages` post-write `try/catch` on its own transaction | **SAFE for the push.** For a referral message it threw `relation "ads" does not exist`, was caught, counted, logged; the message + bot were unaffected. No touch/ad/origin was recorded → those are now the recoverable **backlog**. |
| **Reconciliation job** (worker, every 5 min) | yes | **YES** — `runAttributionReconcileOnce` wraps it in `try/catch` | **SAFE.** Threw every ~5 min (`relation "attribution_touches" does not exist`), caught + logged; the worker's n8n ingestion loop (a separate interval) was unaffected. No partial writes (it threw on the first read). |
| **Booking-path origin** (`createAppointment` → `setContactOrigin`) | yes (`contacts.origin_kind` …) | **NO** — runs INSIDE the booking transaction, BEFORE the appointment insert, with no savepoint | **⚠️ A booking that CREATED A NEW CONTACT would have FAILED.** The `UPDATE contacts SET origin_kind=…` hit `column "origin_kind" does not exist`, aborting the transaction → the whole booking rolled back (no appointment, no contact). Affects **first-time customers** via the public booking page and the scheduling-v1 (n8n) API. **Returning-customer bookings** (existing contact, no new-contact origin write) were unaffected. |
| **Contact merge** (`mergeContacts`) | yes (`attribution_touches`, origin columns) | **NO** (but rolls back cleanly) | A manual duplicate **merge would have failed** (rolled back, error shown). No data loss. |
| **New surfaces** (health endpoint, manual-origin action, `attribution:backfill` CLI) | yes | n/a | Only fail if invoked: the health endpoint 500s; the manual-origin action errors; the CLI is run by hand (not during the gap). |

### Bottom line
- **No message, and no contact-creation on the messaging path, could have failed.** The bot was never at risk — live attribution is fail-safe.
- **The one user-facing failure mode: new-customer bookings** (public booking page + scheduling-v1 API) would have rolled back for the duration of the gap, because the booking-path origin write is inside the booking transaction and is NOT isolated. Returning customers were fine.
- Manual merges would also have failed (rolled back; no corruption).
- Nothing wrote corrupt/partial data (every failing path rolled back or was caught before writing).

### Recommended hardening (NOT done here — flagged for a reviewed follow-up)
Make the booking-path origin write **isolated with a SAVEPOINT** (or move it post-commit) so that
an origin-write error — a future migration gap, or any failure — can never roll back a booking.
A plain `try/catch` inside the transaction is NOT enough: a Postgres error aborts the whole
transaction, so the subsequent appointment insert would fail anyway; a savepoint (rollback to it
on error, then continue) is the correct fix. This is a behavioral change to the booking engine and
should ship as its own change.

## Read-only SQL for the operator

Replace `<gap_start>` / `<gap_end>` with the window the AT-1 code served unmigrated (the first
AT-1 deploy → when the dashboard pre-deploy first applied `1808`).

```sql
-- 1. Confirm migration 1808 is NOW applied (and when).
SELECT name, run_on FROM pgmigrations WHERE name = '1808000000000_attribution';

-- 2. Capture backlog: referral messages with a linked contact but no touch — what the gap left
--    uncaptured, which the reconcile job / backfill will recover. Should trend to 0 after a run.
SELECT m.tenant_id, count(*) AS pending_referral_touches
  FROM handoff_messages m
  JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN attribution_touches t ON t.message_id = m.id
 WHERE m.sender = 'user' AND m.metadata ? 'referral_source_id'
   AND c.contact_id IS NOT NULL AND t.id IS NULL
 GROUP BY 1;

-- 3. Volume of ad-sourced inbound DURING the gap (how much attribution was missed live).
SELECT count(*) AS referral_messages_in_gap
  FROM handoff_messages
 WHERE sender = 'user' AND metadata ? 'referral_source_id'
   AND occurred_at >= '<gap_start>' AND occurred_at < '<gap_end>';

-- 4. Bookings that SUCCEEDED during the gap (returning customers; failed new-customer bookings
--    rolled back and left NO row, so this is a floor, not the true demand).
SELECT count(*) AS appts_in_gap, count(DISTINCT contact_id) AS distinct_contacts
  FROM appointments
 WHERE created_at >= '<gap_start>' AND created_at < '<gap_end>';

-- 5. New contacts created during the gap (messaging path was safe; booking path for NEW contacts
--    was not — a low count here next to expected demand is a hint bookings were failing).
SELECT count(*) AS new_contacts_in_gap
  FROM contacts
 WHERE created_at >= '<gap_start>' AND created_at < '<gap_end>';
```

**Failed bookings/merges are NOT in the database** (they rolled back). To confirm whether any
occurred, grep the Railway **deploy/runtime logs** for the window:
- `column "origin_kind" does not exist` → a **failed new-customer booking** (the material one).
- `relation "attribution_touches" does not exist` / `relation "ads" does not exist` → live
  attribution + reconcile attempts (expected; these were fail-safe, no user impact).

## Recovering the gap
The attribution tables now exist, so the worker **reconciliation job (every 5 min) drains the
backlog automatically** — SQL #2 should already be trending to 0. To recover immediately and get
counts, run in the worker console: `npm run attribution:backfill` (dry-run) then
`-- --apply`. Then confirm `GET /api/attribution/v1/health` shows `pending_attributions: 0`.
