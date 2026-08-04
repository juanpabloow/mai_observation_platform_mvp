-- ============================================================================
-- C-7 operator diagnostic — are the 5 contact_ids one human or several people?
--
-- Context: one GET /api/scheduling/v1/appointments call returned 11 appointments
-- spanning 5 distinct contact_id values (one of them NULL = a walk-in, which is
-- NOT a contact and is omitted below). The over-return itself is a route bug
-- (fixed in C-7); these queries answer the SEPARATE question of whether the 4
-- real contacts are duplicates of the SAME person or genuinely different people.
--
-- READ-ONLY: both statements are plain SELECTs. Safe to run on production.
-- Run in Railway's Postgres console (psql / the data tab). No parameters needed.
-- ============================================================================

-- ── Query 1 — identity dossier for the 4 contacts ───────────────────────────
-- One row per (contact, identity). Read it top-to-bottom: contacts are grouped,
-- and every phone/email/external id the contact is known by is listed.
--
-- HOW TO READ IT:
--   • Same person  → the SAME identity_value (e.g. one phone) appears under more
--     than one contact_id  → they are duplicates that should be merged.
--   • Different people → each contact has its OWN distinct phone/email values.
--   • A contact with NO identity rows (all identity_* NULL) was created without a
--     phone/email (e.g. a name-only/walk-in booking) — expected to look "empty".
SELECT
  c.id          AS contact_id,
  c.name        AS contact_name,
  c.created_at  AS contact_created_at,
  c.client_id,
  ci.kind       AS identity_kind,
  ci.value      AS identity_value,
  ci.label      AS identity_label,
  ci.created_at AS identity_created_at
FROM contacts c
LEFT JOIN contact_identities ci
       ON ci.contact_id = c.id
      AND ci.tenant_id  = c.tenant_id
      AND ci.client_id  = c.client_id
WHERE c.id IN (
  'd14a0537-8ac7-4c03-bceb-8527745d1e7d',
  '9e81662f-7e5d-4acb-9b85-804d3976a279',
  '005db42a-7c2e-4e62-8bbd-d6bf0a47606d',
  'f6d5a852-c32d-4fa3-8a20-31bad481fc65'
)
ORDER BY c.created_at, c.id, ci.kind, ci.value;


-- ── Query 2 — unresolved duplicate candidates for that client ────────────────
-- If the identity spine already FLAGGED any of these as duplicates awaiting a
-- human merge, they show here (resolved_at IS NULL = still open). The client is
-- derived from the 4 contacts above, so no id needs to be pasted twice. Empty
-- result = the system has not detected a duplicate pair for this client.
SELECT
  d.id,
  d.client_id,
  d.contact_id_keep,
  ck.name AS keep_name,
  d.contact_id_duplicate,
  cd.name AS duplicate_name,
  d.reason,
  d.detected_at,
  d.resolved_at
FROM duplicate_contact_candidates d
LEFT JOIN contacts ck
       ON ck.id = d.contact_id_keep
      AND ck.tenant_id = d.tenant_id
      AND ck.client_id = d.client_id
LEFT JOIN contacts cd
       ON cd.id = d.contact_id_duplicate
      AND cd.tenant_id = d.tenant_id
      AND cd.client_id = d.client_id
WHERE d.resolved_at IS NULL
  AND d.client_id IN (
    SELECT DISTINCT client_id
      FROM contacts
     WHERE id IN (
       'd14a0537-8ac7-4c03-bceb-8527745d1e7d',
       '9e81662f-7e5d-4acb-9b85-804d3976a279',
       '005db42a-7c2e-4e62-8bbd-d6bf0a47606d',
       'f6d5a852-c32d-4fa3-8a20-31bad481fc65'
     )
  )
ORDER BY d.detected_at DESC;
