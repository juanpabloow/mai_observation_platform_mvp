import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * H-1a: HUMAN HANDOFF data model — four tables the rest of the handoff feature
 * builds on. NO API here; migrations + repos only.
 *
 * - conversations — the STATEFUL handoff entity (distinct from the derived
 *   conversation_turns view): a real row with a mode state machine
 *   (bot → pending → human) and an optional assigned agent. The mode↔agent
 *   invariant (agent set iff mode='human') is enforced in the REPO transition
 *   function, NOT a DB CHECK — a CHECK would fight the ON DELETE SET NULL below
 *   when an assigned agent's user is deleted.
 * - handoff_messages — first-class message events. Dedup guarantee = a PARTIAL
 *   unique index on (conversation_id, external_message_id) WHERE the id is present
 *   (NULL ids never collide, so un-keyed messages always insert).
 * - handoff_tokens — per-connection machine credentials. Only the SHA-256 hash +
 *   an 8-char display prefix are stored; the raw token is shown once by the repo.
 * - conversation_mode_transitions — the audit trail (one row per real change).
 *
 * FK / ON DELETE choices (see the repo notes too):
 * - tenant_id → tenants, conversation_id → conversations, n8n_connection_id →
 *   n8n_connections: ON DELETE CASCADE (handoff data is meaningless without its
 *   tenant/conversation/connection).
 * - agent_user_id / assigned_agent_user_id → Better Auth "user"(id) (TEXT):
 *   ON DELETE SET NULL — deleting a user must not delete conversations/history;
 *   it just drops the (now dangling) attribution. The "agent id set iff …"
 *   invariant is therefore enforced in the repo, not as a CHECK (a CHECK would
 *   make the SET-NULL cascade fail and block user deletion).
 *
 * Fully reversible: down drops the four tables (dependents first).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- 1. conversations (the stateful entity)
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      n8n_workflow_id text NOT NULL,
      conversation_ref text NOT NULL CHECK (char_length(conversation_ref) BETWEEN 1 AND 256),
      mode text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'pending', 'human')),
      assigned_agent_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      last_message_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, n8n_workflow_id, conversation_ref)
    );

    -- 2. handoff_messages (first-class message events)
    CREATE TABLE handoff_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      sender text NOT NULL CHECK (sender IN ('user', 'bot', 'human_agent')),
      agent_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      text text,
      content_type text NOT NULL DEFAULT 'text',
      content_detail text,
      external_message_id text,
      status text NOT NULL CHECK (status IN ('received', 'sending', 'sent', 'failed')),
      failure_code text,
      failure_detail text,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb
    );
    -- Dedup guarantee: at most one message per (conversation, external id) when an
    -- external id is present. NULL external ids are exempt (always insertable).
    CREATE UNIQUE INDEX handoff_messages_external_dedup
      ON handoff_messages (conversation_id, external_message_id)
      WHERE external_message_id IS NOT NULL;
    -- Thread reads (a conversation's messages in time order).
    CREATE INDEX handoff_messages_thread_idx
      ON handoff_messages (tenant_id, conversation_id, occurred_at);

    -- 3. handoff_tokens (per-connection machine credentials; hash-only at rest)
    CREATE TABLE handoff_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      n8n_connection_id uuid NOT NULL REFERENCES n8n_connections (id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      token_prefix text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      last_used_at timestamptz
    );
    CREATE INDEX handoff_tokens_conn_idx ON handoff_tokens (tenant_id, n8n_connection_id);

    -- 4. conversation_mode_transitions (audit trail)
    CREATE TABLE conversation_mode_transitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      from_mode text NOT NULL CHECK (from_mode IN ('bot', 'pending', 'human')),
      to_mode text NOT NULL CHECK (to_mode IN ('bot', 'pending', 'human')),
      source text NOT NULL CHECK (source IN ('workflow', 'platform_rule', 'agent')),
      agent_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      reason_code text,
      detail text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX conversation_mode_transitions_idx
      ON conversation_mode_transitions (tenant_id, conversation_id, created_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop dependents (reference conversations) before conversations itself.
  pgm.sql(`
    DROP TABLE IF EXISTS handoff_messages;
    DROP TABLE IF EXISTS conversation_mode_transitions;
    DROP TABLE IF EXISTS handoff_tokens;
    DROP TABLE IF EXISTS conversations;
  `);
}
