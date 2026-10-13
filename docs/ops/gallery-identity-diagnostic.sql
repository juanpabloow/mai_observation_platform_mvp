-- ============================================================================
-- Gallery identity diagnostic — BSUID-derived phones and possible duplicates.
--
-- READ-ONLY: every statement is a plain SELECT inside a READ ONLY transaction.
-- Not executed by the author. Run only with authorisation, against the intended
-- database. Two variables (psql):
--   \set client_id '6790e355-9048-47d0-99c2-7822419aa526'   -- Gallery
--   \set since     '2026-10-14 00:00:00-05'                 -- start of the window (Q6s, Q7, Q8)
-- Before the deploy: `since` = 30 days ago (baseline). After each stage: `since` = the
-- deploy time. The stop and rollback criteria in docs/ops/gallery-incidents-deploy-plan.md
-- are read from Q6s–Q10. Q6s, Q8, Q9 and Q10 print no ids or values (shareable). Run it ONLY through docs/ops/run-gallery-identity-diagnostic.sh,
-- which opens a read-only session; the guards below abort otherwise. The output holds
-- personal data (names, phones, channel ids): keep it out of the repo and out of chats.
--
-- Why: until fix/gallery-incidents-v1, normalizeE164 stripped letters, so a WhatsApp
-- business-scoped user id such as "CO.1234567890" was classified as the PHONE
-- "+1234567890" — but ONLY when 7–15 digits remained (first digit not 0); longer BSUIDs
-- (16–17 digits, most of production) were already kept as `external`. Query 1 measures whether production holds such invented phones BEFORE
-- the fix ships (after it, a BSUID stays an `external` identity; the fix keeps finding
-- the legacy contact, see legacyBsuidPhone). Query 5 lists BSUID conversations the old
-- digit-based link may have attached to someone else. Nothing here merges, deletes or
-- rewrites anything. (The fix's INGESTION path does write — this script does not.)
-- ============================================================================
\set ON_ERROR_STOP on

-- ── Guards: abort (psql exit 3, ON_ERROR_STOP) before reading anything unless ALL hold ──
-- 1. Both variables are set.
\if :{?client_id}
\else
  DO $abort$ BEGIN RAISE EXCEPTION 'ABORT: client_id is not set (-v client_id=...)'; END $abort$;
\endif
\if :{?since}
\else
  DO $abort$ BEGIN RAISE EXCEPTION 'ABORT: since is not set (-v since=...)'; END $abort$;
\endif
-- 2. The SESSION is read-only (PGOPTIONS='-c default_transaction_read_only=on'), not
--    only the transaction below — so nothing typed or sourced after this can write.
SELECT current_setting('default_transaction_read_only') = 'on' AS session_read_only \gset
\if :session_read_only
\else
  DO $abort$ BEGIN RAISE EXCEPTION 'ABORT: the session is not read-only. Run through docs/ops/run-gallery-identity-diagnostic.sh.'; END $abort$;
\endif
-- 3. This database actually holds that client (a wrong or empty database aborts).
SELECT EXISTS (SELECT 1 FROM clients WHERE id = :'client_id') AS client_found \gset
\if :client_found
\else
  DO $abort$ BEGIN RAISE EXCEPTION 'ABORT: client_id not found in this database (wrong or empty database?).'; END $abort$;
\endif
-- What was read, and when (no host, user or credentials are printed).
SELECT current_database() AS database, now() AS run_at, :'since'::timestamptz AS since,
       current_setting('default_transaction_read_only') AS session_read_only;

BEGIN READ ONLY;

-- ── Query 1 — phone identities that are the digits of the contact's BSUID ──────
-- A row = a phone identity (or contacts.phone_e164) that equals '+' || the digits of a
-- BSUID-shaped channel_user_id (isBsuid: "XX.<alphanumeric>"). These were invented, not given.
SELECT c.id AS contact_id,
       c.channel,
       c.channel_user_id,
       ci.kind AS identity_kind,
       ci.value AS identity_value,
       c.phone_e164,
       ci.created_at AS identity_created_at
  FROM contacts c
  LEFT JOIN contact_identities ci
    ON ci.contact_id = c.id AND ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id
 WHERE c.client_id = :'client_id'
   AND c.channel_user_id ~ '^[[:space:]]*[A-Za-z]{2}[.][A-Za-z0-9]+[[:space:]]*$'
   AND (
         (ci.kind = 'phone' AND ci.value = '+' || regexp_replace(c.channel_user_id, '[^0-9]', '', 'g'))
      OR c.phone_e164 = '+' || regexp_replace(c.channel_user_id, '[^0-9]', '', 'g')
       )
 ORDER BY c.created_at;

-- ── Query 2 — how many BSUID contacts exist at all, and how they are stored ─────
SELECT count(*) FILTER (WHERE c.channel_user_id ~ '^[A-Za-z]{2}\.')                                       AS bsuid_contacts,
       count(*) FILTER (WHERE c.channel_user_id ~ '^[A-Za-z]{2}\.' AND c.phone_e164 IS NULL)              AS bsuid_without_phone,
       count(*) FILTER (WHERE c.channel_user_id ~ '^[A-Za-z]{2}\.' AND c.phone_e164 IS NOT NULL)          AS bsuid_with_phone
  FROM contacts c
 WHERE c.client_id = :'client_id';

-- ── Query 5 — BSUID conversations linked to a contact NOT created from that BSUID ─
-- The old link/backfill compared the ref's DIGITS to phone identities, so a BSUID
-- conversation could be linked to whoever owns those digits as a real phone. A row here
-- is a link to REVIEW (the contact's own channel id differs), not proof of an error.
SELECT cv.id AS conversation_id,
       cv.n8n_workflow_id,
       cv.conversation_ref,
       ct.id AS contact_id,
       ct.channel_user_id AS contact_channel_user_id,
       ct.phone_e164
  FROM conversations cv
  JOIN contacts ct ON ct.id = cv.contact_id AND ct.tenant_id = cv.tenant_id
 WHERE ct.client_id = :'client_id'
   AND cv.conversation_ref ~ '^[[:space:]]*[A-Za-z]{2}[.][A-Za-z0-9]+[[:space:]]*$'
   AND btrim(coalesce(ct.channel_user_id, '')) <> btrim(cv.conversation_ref)
   AND NOT EXISTS (
         SELECT 1 FROM contact_identities ci
          WHERE ci.contact_id = ct.id AND ci.tenant_id = ct.tenant_id AND ci.client_id = ct.client_id
            AND ci.kind = 'external' AND ci.value = btrim(cv.conversation_ref))
 ORDER BY cv.created_at;

-- ── Query 3 — POSSIBLE duplicates (diagnosis only; never merge by name) ─────────
-- Same normalised name, more than one contact. Each candidate pair still needs a
-- RELIABLE shared identifier (phone, email, BSUID, a booking) before anyone merges.
SELECT lower(trim(c.name)) AS normalised_name,
       count(*)            AS contacts,
       array_agg(c.id ORDER BY c.created_at)              AS contact_ids,
       array_agg(c.channel ORDER BY c.created_at)         AS channels,
       array_agg(c.phone_e164 ORDER BY c.created_at)      AS phones,
       array_agg((SELECT count(*) FROM appointments a WHERE a.contact_id = c.id) ORDER BY c.created_at) AS appointments
  FROM contacts c
 WHERE c.client_id = :'client_id' AND c.name IS NOT NULL AND trim(c.name) <> ''
 GROUP BY lower(trim(c.name))
HAVING count(*) > 1
 ORDER BY contacts DESC, normalised_name;

-- ── Query 4 — the platform's own collision record (identity-based, not name) ───
SELECT d.*
  FROM duplicate_contact_candidates d
 WHERE d.client_id = :'client_id'
 ORDER BY d.detected_at DESC
 LIMIT 50;

-- ── Query 6 — BSUID contacts the PREVIOUS image (R0) would not find (rollback gate) ──
-- R0's rule, reproduced EXACTLY (f7c4cf7 classifyIdentity → normalizeE164 default path):
-- strip EVERY non-digit; 7–15 digits whose first is not 0 → the phone '+<digits>';
-- anything else is NOT a phone and R0 already keeps the value as an `external` identity —
-- exactly what the fix does. So for most BSUIDs (16–17 digits) R0 and the fix agree.
-- A row = an external BSUID identity that R0 would read as a PHONE, on a contact that
-- does not hold that phone itself: R0 looks it up as '+<digits>' and misses it — UNLESS
-- the push also DECLARES the BSUID as an external identity (I-1, supported by R0), in which
-- case R0 still finds it. `phone_held_by_contact` set = R0 would resolve to THAT contact.
-- Rows are candidates to check (Query 10), not proven splits. Personal data: private file.
WITH bsuid_ext AS (
  SELECT ci.contact_id, ci.tenant_id, ci.client_id, ci.value, ci.label,
         regexp_replace(ci.value, '[^0-9]', '', 'g') AS digits
    FROM contact_identities ci
   WHERE ci.client_id = :'client_id' AND ci.kind = 'external'
     AND ci.value ~ '^[A-Za-z]{2}[.][A-Za-z0-9]+$'
)
SELECT b.contact_id,
       b.value AS bsuid,
       length(b.digits) AS digit_length,
       c.created_at,
       owner.contact_id AS phone_held_by_contact,
       (btrim(coalesce(c.channel_user_id, '')) = b.value) AS channel_user_id_is_bsuid,
       b.label AS external_identity_label
  FROM bsuid_ext b
  JOIN contacts c ON c.id = b.contact_id AND c.tenant_id = b.tenant_id AND c.client_id = b.client_id
  LEFT JOIN contact_identities owner
    ON owner.tenant_id = b.tenant_id AND owner.client_id = b.client_id AND owner.kind = 'phone'
   AND owner.value = '+' || b.digits
 WHERE length(b.digits) BETWEEN 7 AND 15 AND left(b.digits, 1) <> '0'
   AND (owner.contact_id IS NULL OR owner.contact_id <> b.contact_id)
 ORDER BY c.created_at;

-- ── Query 6s — the same, as SHAREABLE counters (no ids, no values) ─────────────────
WITH bsuid_ext AS (
  SELECT ci.contact_id, ci.tenant_id, ci.client_id, c.created_at,
         regexp_replace(ci.value, '[^0-9]', '', 'g') AS digits
    FROM contact_identities ci
    JOIN contacts c ON c.id = ci.contact_id AND c.tenant_id = ci.tenant_id AND c.client_id = ci.client_id
   WHERE ci.client_id = :'client_id' AND ci.kind = 'external'
     AND ci.value ~ '^[A-Za-z]{2}[.][A-Za-z0-9]+$'
), judged AS (
  SELECT b.*,
         (length(b.digits) BETWEEN 7 AND 15 AND left(b.digits, 1) <> '0') AS r0_reads_as_phone,
         EXISTS (SELECT 1 FROM contact_identities o
                  WHERE o.tenant_id = b.tenant_id AND o.client_id = b.client_id AND o.kind = 'phone'
                    AND o.value = '+' || b.digits AND o.contact_id = b.contact_id) AS holds_own_phone
    FROM bsuid_ext b
)
SELECT count(*)                                                                   AS external_bsuid_identities,
       count(*) FILTER (WHERE NOT r0_reads_as_phone)                              AS r0_keeps_external_same_as_fix,
       count(*) FILTER (WHERE r0_reads_as_phone AND holds_own_phone)              AS r0_phone_found_by_own_phone,
       count(*) FILTER (WHERE r0_reads_as_phone AND NOT holds_own_phone)          AS r0_phone_candidates_q6,
       count(*) FILTER (WHERE r0_reads_as_phone AND NOT holds_own_phone
                          AND created_at >= :'since'::timestamptz)                AS r0_phone_candidates_in_window,
       (SELECT jsonb_object_agg(len, n) FROM (
          SELECT length(digits) AS len, count(*) AS n FROM judged GROUP BY 1) d)  AS digit_length_distribution
  FROM judged;

-- ── Query 7 — one BSUID, more than one contact (a split) — STOP signal ────────────
-- Groups every contact that carries a BSUID (as channel_user_id or as external
-- identity). Rows whose newest contact is after :since appeared during the window.
WITH bsuid_contacts AS (
  SELECT btrim(c.channel_user_id) AS bsuid, c.id AS contact_id, c.created_at
    FROM contacts c
   WHERE c.client_id = :'client_id'
     AND c.channel_user_id ~ '^[[:space:]]*[A-Za-z]{2}[.][A-Za-z0-9]+[[:space:]]*$'
  UNION
  SELECT ci.value, c.id, c.created_at
    FROM contact_identities ci
    JOIN contacts c ON c.id = ci.contact_id AND c.tenant_id = ci.tenant_id AND c.client_id = ci.client_id
   WHERE ci.client_id = :'client_id' AND ci.kind = 'external'
     AND ci.value ~ '^[A-Za-z]{2}[.][A-Za-z0-9]+$'
)
SELECT bsuid,
       count(DISTINCT contact_id)                          AS contacts,
       array_agg(DISTINCT contact_id)                      AS contact_ids,
       max(created_at)                                     AS newest_created_at,
       max(created_at) >= :'since'::timestamptz            AS new_in_window
  FROM bsuid_contacts
 GROUP BY bsuid
HAVING count(DISTINCT contact_id) > 1
 ORDER BY newest_created_at DESC;

-- ── Query 8 — window counters (compare against the same-length window before) ─────
SELECT 'contacts_created'                 AS metric,
       count(*) FILTER (WHERE created_at >= :'since'::timestamptz)                                   AS in_window,
       count(*) FILTER (WHERE created_at <  :'since'::timestamptz
                          AND created_at >= :'since'::timestamptz - (now() - :'since'::timestamptz)) AS previous_window
  FROM contacts WHERE client_id = :'client_id'
UNION ALL
SELECT 'bsuid_contacts_created',
       count(*) FILTER (WHERE created_at >= :'since'::timestamptz),
       count(*) FILTER (WHERE created_at <  :'since'::timestamptz
                          AND created_at >= :'since'::timestamptz - (now() - :'since'::timestamptz))
  FROM contacts WHERE client_id = :'client_id'
   AND channel_user_id ~ '^[[:space:]]*[A-Za-z]{2}[.][A-Za-z0-9]+[[:space:]]*$'
UNION ALL
SELECT 'duplicate_candidates_detected',
       count(*) FILTER (WHERE detected_at >= :'since'::timestamptz),
       count(*) FILTER (WHERE detected_at <  :'since'::timestamptz
                          AND detected_at >= :'since'::timestamptz - (now() - :'since'::timestamptz))
  FROM duplicate_contact_candidates WHERE client_id = :'client_id';

-- ── Query 9 — the Query 1 candidate(s), characterised — SHAREABLE (no ids, no values) ──
-- Evidence for a HUMAN decision about the phone identity whose value equals the digits of
-- the contact's own BSUID. Nothing here changes it. Read:
--   r0_reads_as_phone = t and ref_is_phone_digits = 0 and other_contacts_same_digits = 0
--     → most likely invented by R0 from the BSUID (no real chat or person behind that number);
--   ref_is_phone_digits > 0 or appointments_with_that_phone > 0 or other contacts
--     → a REAL person may use that number: do not touch it without checking by hand.
WITH q1 AS (
  SELECT DISTINCT c.id, c.tenant_id, c.client_id, c.created_at, c.phone_e164,
         btrim(c.channel_user_id) AS bsuid,
         regexp_replace(c.channel_user_id, '[^0-9]', '', 'g') AS digits
    FROM contacts c
    JOIN contact_identities ci ON ci.contact_id = c.id AND ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id
   WHERE c.client_id = :'client_id'
     AND c.channel_user_id ~ '^[[:space:]]*[A-Za-z]{2}[.][A-Za-z0-9]+[[:space:]]*$'
     AND ci.kind = 'phone' AND ci.value = '+' || regexp_replace(c.channel_user_id, '[^0-9]', '', 'g')
)
SELECT row_number() OVER (ORDER BY q.created_at)                                      AS candidate,
       length(q.digits)                                                               AS bsuid_digit_length,
       (length(q.digits) BETWEEN 7 AND 15 AND left(q.digits, 1) <> '0')               AS r0_reads_as_phone,
       EXISTS (SELECT 1 FROM contact_identities e WHERE e.contact_id = q.id AND e.kind = 'external' AND e.value = q.bsuid) AS has_external_identity_for_bsuid,
       (SELECT array_agg(DISTINCT coalesce(p.label, '∅')) FROM contact_identities p
         WHERE p.contact_id = q.id AND p.kind = 'phone' AND p.value = '+' || q.digits) AS phone_identity_labels,
       (SELECT min(p.created_at) FROM contact_identities p
         WHERE p.contact_id = q.id AND p.kind = 'phone' AND p.value = '+' || q.digits) - q.created_at AS phone_identity_age_vs_contact,
       (q.phone_e164 IS NOT NULL)                                                     AS scalar_phone_set,
       (SELECT count(*) FROM conversations v WHERE v.contact_id = q.id)               AS linked_conversations,
       (SELECT count(*) FROM conversations v WHERE v.contact_id = q.id AND btrim(v.conversation_ref) = q.bsuid) AS linked_ref_is_bsuid,
       (SELECT count(*) FROM conversations v WHERE v.tenant_id = q.tenant_id
           AND v.conversation_ref !~ '[A-Za-z]' AND regexp_replace(v.conversation_ref, '[^0-9]', '', 'g') = q.digits) AS ref_is_phone_digits,
       (SELECT count(*) FROM appointments a WHERE a.contact_id = q.id)                AS appointments,
       (SELECT count(*) FROM contacts o WHERE o.client_id = q.client_id AND o.id <> q.id
           AND (regexp_replace(coalesce(o.phone_e164, ''), '[^0-9]', '', 'g') = q.digits
             OR (o.channel_user_id !~ '[A-Za-z]' AND regexp_replace(coalesce(o.channel_user_id, ''), '[^0-9]', '', 'g') = q.digits))) AS other_contacts_same_digits
  FROM q1 q
 ORDER BY q.created_at;

-- ── Query 10 — the Query 6 candidate(s), characterised — SHAREABLE (no ids, no values) ──
-- Does R0 still find this contact on its next message? R0 resolves the push's
-- conversation_ref (as a phone, for these) PLUS any identities the workflow DECLARES (I-1).
-- Read:
--   channel_user_id_is_bsuid = f  → the contact was NOT created from the BSUID as the
--     conversation ref; with R0 a BSUID of this length can only have become `external` by
--     being DECLARED. If the workflow keeps declaring it, R0 finds the contact: no split.
--   channel_user_id_is_bsuid = t  → R0 created it from the BSUID yet holds no phone for
--     it: unexpected for R0 — check the entry path by hand before any rollback to R0.
WITH bsuid_ext AS (
  SELECT ci.contact_id, ci.tenant_id, ci.client_id, ci.value, ci.label, ci.created_at AS identity_created_at,
         regexp_replace(ci.value, '[^0-9]', '', 'g') AS digits
    FROM contact_identities ci
   WHERE ci.client_id = :'client_id' AND ci.kind = 'external'
     AND ci.value ~ '^[A-Za-z]{2}[.][A-Za-z0-9]+$'
), cand AS (
  SELECT b.*, c.created_at AS contact_created_at, c.channel_user_id, c.channel
    FROM bsuid_ext b
    JOIN contacts c ON c.id = b.contact_id AND c.tenant_id = b.tenant_id AND c.client_id = b.client_id
   WHERE length(b.digits) BETWEEN 7 AND 15 AND left(b.digits, 1) <> '0'
     AND NOT EXISTS (SELECT 1 FROM contact_identities o
                      WHERE o.tenant_id = b.tenant_id AND o.client_id = b.client_id AND o.kind = 'phone'
                        AND o.value = '+' || b.digits AND o.contact_id = b.contact_id)
)
SELECT row_number() OVER (ORDER BY k.contact_created_at)                               AS candidate,
       length(k.digits)                                                                AS digit_length,
       (btrim(coalesce(k.channel_user_id, '')) = k.value)                              AS channel_user_id_is_bsuid,
       (coalesce(k.channel_user_id, '') !~ '[A-Za-z]')                                 AS channel_user_id_is_phone_like,
       k.channel                                                                       AS contact_source,
       k.label                                                                         AS external_identity_label,
       (k.identity_created_at - k.contact_created_at)                                  AS identity_age_vs_contact,
       (SELECT array_agg(i.kind ORDER BY i.kind) FROM contact_identities i WHERE i.contact_id = k.contact_id) AS identity_kinds,
       EXISTS (SELECT 1 FROM contact_identities o WHERE o.tenant_id = k.tenant_id AND o.client_id = k.client_id
                 AND o.kind = 'phone' AND o.value = '+' || k.digits)                  AS phone_held_by_another_contact,
       (SELECT count(*) FROM conversations v WHERE v.contact_id = k.contact_id)        AS linked_conversations,
       (SELECT count(*) FROM conversations v WHERE v.contact_id = k.contact_id AND btrim(v.conversation_ref) = k.value) AS linked_ref_is_bsuid,
       (SELECT count(*) FROM conversations v WHERE v.contact_id = k.contact_id AND v.conversation_ref !~ '[A-Za-z]') AS linked_ref_phone_like,
       (SELECT count(*) FROM appointments a WHERE a.contact_id = k.contact_id)         AS appointments
  FROM cand k
 ORDER BY k.contact_created_at;

ROLLBACK;
