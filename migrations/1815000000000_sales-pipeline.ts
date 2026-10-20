import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * PL-1 — SALES PIPELINE: data model. The OPPORTUNITY (one sale), NOT the contact, moves through
 * the funnel, so a contact who paid in October and returns in December from another ad starts a
 * NEW opportunity without rewriting history, and each sale keeps the ad that brought it.
 *
 * Generic: nothing names a business, vertical or channel. Every row is tenant_id + client_id
 * scoped with the composite FK `(client_id, tenant_id) → clients(id, tenant_id)`, like attribution.
 *
 * This phase deliberately does NOT touch `contacts.stage` — that per-contact relationship lifecycle
 * (new/active/customer/archived) is a SEPARATE axis and keeps its single writer (updateContact,
 * "MF-1"). An opportunity's `stage` is the sale's funnel position, independent of it.
 *
 *  opportunities          — one sale. status open|won|lost; stage lead→qualified→booked→attended→paid.
 *                           Stage timestamps are stored (lead_at … paid_at) so funnels need no event
 *                           replay. origin_touch_id keeps the AT-1 ad touch that opened it. At most
 *                           ONE open opportunity per contact (partial unique index).
 *  opportunity_stage_events — one row per transition (stage and/or status change), with the actor,
 *                           written in the SAME transaction as the change.
 *  pipeline_settings      — per-client auto_lost_after_hours (default 72) + reopen_window_days (30).
 *  appointments.opportunity_id — links a booking to the sale it belongs to (nullable).
 *
 * `paid` / `paid_at` exist now but are NOT written this phase — completion marks attended + won; a
 * later payments phase sets paid_at on the same won opportunity (no payments/revenue data exists
 * yet, matching the value dashboard's "valor ≠ cobrado" rule).
 *
 * Reversible. DOWN removes the whole subsystem (and its data — expected for a schema rollback).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE opportunities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
      conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
      stage text NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'qualified', 'booked', 'attended', 'paid')),
      -- Stage timestamps (all nullable): when the sale REACHED each stage. Funnels read these directly.
      lead_at timestamptz,
      qualified_at timestamptz,
      booked_at timestamptz,
      attended_at timestamptz,
      paid_at timestamptz,
      -- The AT-1 ad touch that opened/originated the sale (kept per-opportunity, not just per-contact).
      origin_touch_id uuid REFERENCES attribution_touches (id) ON DELETE SET NULL,
      -- Qualification evidence. qualified_by is 'system' | 'bot' | a user id (free text, like origin_set_by).
      qualified_by text CHECK (qualified_by IS NULL OR char_length(qualified_by) <= 255),
      qualification_service text CHECK (qualification_service IS NULL OR char_length(qualification_service) <= 200),
      qualification_timeframe text CHECK (qualification_timeframe IS NULL OR char_length(qualification_timeframe) <= 200),
      qualification_message_id uuid REFERENCES handoff_messages (id) ON DELETE SET NULL,
      qualified_implicitly boolean NOT NULL DEFAULT false,
      -- Lost detail. lost_note is REQUIRED when the reason is 'otro'.
      lost_reason text CHECK (lost_reason IS NULL OR lost_reason IN ('precio', 'horario', 'no_respondio', 'no_asistio', 'otro')),
      lost_note text CHECK (lost_note IS NULL OR (char_length(lost_note) <= 1000 AND btrim(lost_note) <> '')),
      closed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT opportunities_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      -- A non-open sale is closed (has closed_at); an open one is not.
      CONSTRAINT opportunities_closed_chk CHECK ((status = 'open') = (closed_at IS NULL)),
      -- A lost sale names a reason; a non-lost one does not.
      CONSTRAINT opportunities_lost_reason_chk CHECK ((status = 'lost') = (lost_reason IS NOT NULL)),
      -- 'otro' must carry a note.
      CONSTRAINT opportunities_lost_note_chk CHECK (lost_reason IS DISTINCT FROM 'otro' OR lost_note IS NOT NULL)
    );
    -- AT MOST ONE open opportunity per contact (the concurrency guard — ON CONFLICT targets this).
    CREATE UNIQUE INDEX opportunities_one_open_per_contact
      ON opportunities (tenant_id, client_id, contact_id) WHERE status = 'open';
    -- Board / funnel reads, and finding a contact's latest opportunity (reopen).
    CREATE INDEX opportunities_board_idx ON opportunities (tenant_id, client_id, status, stage);
    CREATE INDEX opportunities_contact_idx ON opportunities (tenant_id, client_id, contact_id, created_at DESC);

    CREATE TABLE opportunity_stage_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      opportunity_id uuid NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
      from_stage text CHECK (from_stage IS NULL OR from_stage IN ('lead', 'qualified', 'booked', 'attended', 'paid')),
      to_stage text CHECK (to_stage IS NULL OR to_stage IN ('lead', 'qualified', 'booked', 'attended', 'paid')),
      from_status text CHECK (from_status IS NULL OR from_status IN ('open', 'won', 'lost')),
      to_status text CHECK (to_status IS NULL OR to_status IN ('open', 'won', 'lost')),
      -- The actor behind the transition: 'system' | 'bot' | a user id.
      actor text NOT NULL CHECK (char_length(actor) <= 255 AND btrim(actor) <> ''),
      reason text CHECK (reason IS NULL OR char_length(reason) <= 1000),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT opportunity_stage_events_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    CREATE INDEX opportunity_stage_events_opportunity_idx
      ON opportunity_stage_events (tenant_id, opportunity_id, occurred_at);

    CREATE TABLE pipeline_settings (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      -- An open lead/qualified opportunity the business answered last, with no customer reply for
      -- this many hours, is auto-lost (reason no_respondio).
      auto_lost_after_hours integer NOT NULL DEFAULT 72 CHECK (auto_lost_after_hours BETWEEN 1 AND 2160),
      -- A lost opportunity can be reopened by a new message/booking within this many days.
      reopen_window_days integer NOT NULL DEFAULT 30 CHECK (reopen_window_days BETWEEN 0 AND 365),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id),
      CONSTRAINT pipeline_settings_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    -- Every existing client gets the defaults; the repo also COALESCEs defaults if a row is missing.
    INSERT INTO pipeline_settings (tenant_id, client_id)
      SELECT tenant_id, id FROM clients
    ON CONFLICT (tenant_id, client_id) DO NOTHING;

    ALTER TABLE appointments
      ADD COLUMN opportunity_id uuid REFERENCES opportunities (id) ON DELETE SET NULL;
    CREATE INDEX appointments_opportunity_idx
      ON appointments (tenant_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS appointments_opportunity_idx;
    ALTER TABLE appointments DROP COLUMN IF EXISTS opportunity_id;
    DROP TABLE IF EXISTS pipeline_settings;
    DROP TABLE IF EXISTS opportunity_stage_events;
    DROP TABLE IF EXISTS opportunities;
  `);
}
