-- ============================================================================
-- D-2 sizing — how many contacts does "auto-create on first inbound message"
-- create, and how much of it is likely inbound noise (spam / wrong number /
-- one-word "hola")?
--
-- Context: D-2 makes a contact the moment a person writes (first inbound
-- sender='user' message on an unlinked conversation, CRM-enabled clients only).
-- That is exactly the traffic the CRM wants to capture — but it also creates a
-- nameless contact for every junk message. This query puts a real number on the
-- rate and on the junk fraction, so the deferred "separate leads from noise"
-- filter (see scaling-todo.md) is designed from observed data, not a guess.
--
-- READ-ONLY: plain SELECTs, safe to run on production. Run in Railway's Postgres
-- console. No parameters. Re-run any time to re-check the trigger thresholds.
--
-- How to read it:
--   • new_contacts_per_week — the D-2 contact-creation rate going forward.
--   • pct_single_msg        — % of those conversations with exactly ONE inbound
--     user message (the spam/wrong-number proxy). The scaling-todo trigger is
--     ~20%. Below that, and a few hundred rows total, the filter stays deferred:
--     a nameless, appointment-less contact is usually a real lead (asked a price,
--     hasn't booked yet), NOT noise — hiding it would hide the lead.
-- ============================================================================

WITH crm_conv AS (
  -- conversations on CRM-enabled clients that have at least one inbound user message
  SELECT c.id, date_trunc('week', c.created_at) AS wk
    FROM conversations c
    JOIN workflows w
      ON w.tenant_id = c.tenant_id
     AND w.n8n_workflow_id = c.n8n_workflow_id
    JOIN client_modules cm
      ON cm.tenant_id = w.tenant_id
     AND cm.client_id = w.client_id
     AND cm.module_key = 'crm'
     AND cm.enabled
   WHERE EXISTS (
           SELECT 1 FROM handoff_messages m
            WHERE m.conversation_id = c.id
              AND m.sender = 'user'
         )
),
msgcount AS (
  SELECT cc.id,
         cc.wk,
         (SELECT count(*) FROM handoff_messages m
           WHERE m.conversation_id = cc.id AND m.sender = 'user') AS user_msgs
    FROM crm_conv cc
)
SELECT wk,
       count(*)                                                        AS new_contacts_per_week,
       count(*) FILTER (WHERE user_msgs = 1)                           AS one_message_only,
       round(100.0 * count(*) FILTER (WHERE user_msgs = 1) / count(*), 1) AS pct_single_msg
  FROM msgcount
 GROUP BY wk
 ORDER BY wk DESC
 LIMIT 8;
