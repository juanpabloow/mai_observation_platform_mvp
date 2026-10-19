# AT-1 origin fix — organic WhatsApp contacts stuck at `unknown`

**Finding (production).** 11 WhatsApp contacts created after `attribution_tracking_started_at`
(2026-10-16 19:38 -05) still had `origin_kind = 'unknown'`, and `npm run attribution:backfill`
(dry-run, run *after* the tracking start was corrected) reported **"contacts origin to set: 0"**.
Meanwhile 6 contacts that came from ads correctly got `meta_ad`.

## Root cause — two bugs on the SAME path

The Gallery n8n workflow creates the contact via `POST /api/crm/v1/contacts/upsert` (the
"CRM – sincronizar perfil WhatsApp" node) **before** it pushes the first message to
`/handoff/v1/messages`. That path (`resolveContactByIdentity → insertContact`) never sets
`origin_kind`, so the contact is born with `origin_kind = NULL`. When the first message then
arrives, the contact **already exists**, so `ensureContactForInboundMessage` returned
`created = false`.

1. **Live capture was gated on "this message created the contact."** `ingestLiveReferral` only set
   origin `if (contactWasNew)`. For a CRM-upsert-first contact `contactWasNew` is always `false`,
   so:
   - an **organic** first message set no origin at all (it was never even an ad message, and the
     organic branch only ran via the backfill); origin stayed `NULL`.
   - an **ad** first message wrote the ad + touch but **skipped the origin**; origin stayed `NULL`.

   So for this workflow, origin was **never** set live — everything fell to the backfill/reconcile.

2. **The backfill froze a *provisional* `unknown` as if it were final.** When the reconcile job (or
   the CLI) first classified these `NULL` contacts, `attribution_tracking_started_at` was still the
   value seeded at the 1808 deploy (≈ Oct 18), which is **after** these contacts' first messages
   (Oct 16–17). So `classifyContactOrigin` returned the conservative `unknown` ("a message with no
   referral *before* tracking started proves nothing") and wrote it with `origin_set_by = 'system'`.
   Then the operator **corrected** `tracking_started_at` back to Oct 16 19:38 — but re-running the
   backfill did nothing, because it only looked at `origin_kind IS NULL` and `setContactOrigin`
   only overwrote an unset origin. A system-written `unknown` is not `NULL`, so it was skipped →
   **"contacts origin to set: 0."**

## Why the 6 ad contacts got `meta_ad` but the 11 organic ones didn't — one consistent rule

Both groups went through the **identical** path (CRM upsert creates the row with a `NULL` origin →
live never sets it because the contact already existed → the backfill classifies). They diverged at
exactly one place — `classifyContactOrigin`:

- A **referral is a positive, time-independent FACT**: "an ad/post brought this person." It does not
  depend on `tracking_started_at`, so the 6 ad contacts classified `meta_ad` correctly and
  permanently on the first pass.
- "**Organic**" is **not a fact but an inference**: "no referral **AND** the first message arrived
  at/after we started tracking." At classification time the tracking date was still the wrong
  (seeded) default — *after* their first messages — so the only honest answer the rule could give
  was the conservative `unknown`.

Same rule, same code; they differ only because one input was a durable fact and the other depended
on a setting that was wrong when it ran. The real defect is that the conservative `unknown` was then
treated as a **decided** origin and never revisited once the setting was fixed.

## The fix (code)

A contact's origin is now **decided by its FIRST inbound message** — referral → `meta_ad`/`meta_post`;
no referral, first message at/after tracking start → `organic_whatsapp`; before → `unknown` — **regardless
of which path created the row**, as long as the origin is still provisional and **was never set by a
person**. Applied **both live and in the backfill**, and a captured ad origin or a human's choice is
never overwritten.

- **`attribution.ts`** — `classifyContactOrigin` moved here so the live path and the backfill share
  ONE rule. `setContactOrigin` gained an **automation guard**: a `setBy: 'system'` write may only
  (re)write an **unset** origin or automation's own prior write (`origin_set_by` NULL or `'system'`),
  never a human-set one — this is what makes revisiting a provisional `unknown` safe.
- **`ingest.ts`** — `ingestLiveReferral` now only writes the ad + touch. New `ensureInboundOrigin`
  sets the origin from the contact's first inbound message, keyed on the **contact** (not on "the
  message created the contact"); it only touches a provisional origin and is idempotent + self-healing.
- **`handoff/v1/messages/route.ts`** — on an inbound user message it writes the touch (if a referral)
  then calls `ensureInboundOrigin`, dropping the `contactWasNew` gate. Still fully fail-safe.
- **`backfill.ts`** — now also revisits a provisional (`origin_set_by` NULL/`system`) `unknown`, and
  only writes when the origin actually **changes** (so repeated reconcile passes add no timeline churn).

A human-set origin (a manual origin, or a human-reviewed merge) is never revisited by automation.

## Read-only SQL for the operator

### 1. Confirm the cause — list the stuck organic contacts

These are WhatsApp contacts created at/after the (corrected) tracking start, still a provisional
(automation-written) `unknown`, whose **first inbound message carried no referral** — i.e. exactly
the ones that should be `organic_whatsapp`.

```sql
SELECT ct.id, ct.created_at, ct.channel, ct.origin_kind, ct.origin_set_by,
       s.tracking_started_at,
       fm.first_msg_at,
       (fm.metadata ? 'referral_source_id') AS first_msg_had_referral
  FROM contacts ct
  LEFT JOIN attribution_settings s
    ON s.tenant_id = ct.tenant_id AND s.client_id = ct.client_id
  LEFT JOIN LATERAL (
    SELECT m.occurred_at AS first_msg_at, m.metadata
      FROM handoff_messages m
      JOIN conversations cv ON cv.id = m.conversation_id
     WHERE cv.contact_id = ct.id AND m.sender = 'user'
     ORDER BY m.occurred_at ASC, m.id ASC
     LIMIT 1) fm ON true
 WHERE ct.origin_kind = 'unknown'
   AND (ct.origin_set_by IS NULL OR ct.origin_set_by = 'system')
   AND ct.channel = 'whatsapp'
   AND s.tracking_started_at IS NOT NULL
   AND ct.created_at >= s.tracking_started_at
 ORDER BY ct.created_at DESC;
```

Expectation: the ~11 rows, every `first_msg_had_referral = false`, every `first_msg_at >=
tracking_started_at` — which is why, now that tracking is corrected, they must become
`organic_whatsapp`.

### 2. The split (the 6 vs the 11), as origin + whether the first message had a referral

```sql
SELECT ct.origin_kind,
       (EXISTS (
          SELECT 1 FROM conversations cv
            JOIN handoff_messages m ON m.conversation_id = cv.id
           WHERE cv.contact_id = ct.id AND m.sender = 'user'
             AND m.metadata ? 'referral_source_id')) AS ever_had_referral,
       count(*) AS contacts
  FROM contacts ct
  LEFT JOIN attribution_settings s
    ON s.tenant_id = ct.tenant_id AND s.client_id = ct.client_id
 WHERE ct.channel = 'whatsapp'
   AND s.tracking_started_at IS NOT NULL
   AND ct.created_at >= s.tracking_started_at
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

Expectation: `meta_ad / true` ≈ 6, `unknown / false` ≈ 11 (before the fix is applied).

## Recovery — after this change deploys

1. Re-run the dry-run: `npm run attribution:backfill` — it now reports the organic contacts it will
   set (no longer 0). Then `npm run attribution:backfill -- --apply` to recover them. The worker
   reconcile job (every 5 min) also drains them automatically once the fixed code is live.
2. Confirm with SQL #1 (the stuck list should be empty) and that the contacts are now
   `organic_whatsapp` with `origin_set_by = 'system'`.
3. Going forward the live path sets origin on the first inbound message, so new CRM-upsert-first
   contacts no longer depend on the backfill.
