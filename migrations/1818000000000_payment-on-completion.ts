import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * PY-1 — PAYMENT ON COMPLETION: data model (option 1 of docs/audit-payment-on-completion.md).
 *
 * Records WHAT WAS CHARGED when an appointment is completed, in its own tables that NO
 * value-dashboard query reads — so "valor" (SUM(appointments.price_snapshot) WHERE
 * status='completed') is never changed or double-counted. Payments never write price_snapshot
 * and never change an appointment's status. Generic: nothing names a business, vertical or channel.
 *
 *  payments        — at most ONE recorded payment per appointment (partial unique index); a
 *                    mistake is VOIDED, never deleted. method_key + total snapshot; recorded_by.
 *  payment_lines   — the charge, itemized: the appointment's one service + any catalog products,
 *                    each with quantity, list vs charged unit price, an adjustment reason when
 *                    charged under list, and a per-line commission SNAPSHOT (pct + amount), so a
 *                    later rate change never revalues past payments and ROI/commission is
 *                    computable per artist and per ad.
 *  payment_methods — per client (efectivo, tarjeta, Nequi, Daviplata, transferencia, Bre-B seeded).
 *                    A used method is DEACTIVATED, never deleted.
 *  staff.commission_pct_services / _products — the configurable % per artist (0–100), default 0.
 *  payment_settings.payments_tracking_started_at — the date from which a completed, unpaid
 *                    appointment counts as "cobro pendiente" (default: deploy time).
 *
 * Every row is tenant_id + client_id scoped with the composite FK (client_id, tenant_id) →
 * clients(id, tenant_id), like attribution and the pipeline. Reversible: DOWN removes it all.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ── payment_methods (per client) ──────────────────────────────────────────────
    CREATE TABLE payment_methods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      key text NOT NULL CHECK (btrim(key) <> '' AND char_length(key) <= 64),
      label text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 80),
      active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_methods_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT payment_methods_key_unique UNIQUE (tenant_id, client_id, key)
    );
    CREATE INDEX payment_methods_client_idx ON payment_methods (tenant_id, client_id, active, sort_order);

    -- Seed every existing NON-DEFAULT client with the standard Colombian methods. New clients are
    -- seeded lazily on first read (ensureClientPaymentMethods), so this only covers what exists now.
    INSERT INTO payment_methods (tenant_id, client_id, key, label, sort_order)
      SELECT c.tenant_id, c.id, m.key, m.label, m.ord
        FROM clients c
        CROSS JOIN (VALUES
          ('efectivo', 'Efectivo', 0),
          ('tarjeta', 'Tarjeta', 1),
          ('nequi', 'Nequi', 2),
          ('daviplata', 'Daviplata', 3),
          ('transferencia', 'Transferencia', 4),
          ('bre_b', 'Bre-B', 5)
        ) AS m(key, label, ord)
       WHERE c.is_default = false
    ON CONFLICT (tenant_id, client_id, key) DO NOTHING;

    -- ── payments (one recorded per appointment; voided never deleted) ──────────────
    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
      contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
      opportunity_id uuid REFERENCES opportunities (id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
      method_key text NOT NULL CHECK (btrim(method_key) <> '' AND char_length(method_key) <= 64),
      total numeric(12, 2) NOT NULL CHECK (total >= 0),
      note text CHECK (note IS NULL OR (char_length(note) <= 500 AND btrim(note) <> '')),
      paid_at timestamptz NOT NULL DEFAULT now(),
      recorded_by text NOT NULL CHECK (btrim(recorded_by) <> '' AND char_length(recorded_by) <= 255),
      voided_at timestamptz,
      voided_by text CHECK (voided_by IS NULL OR char_length(voided_by) <= 255),
      void_reason text CHECK (void_reason IS NULL OR (char_length(void_reason) <= 500 AND btrim(void_reason) <> '')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payments_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      -- a voided payment carries its void detail; a recorded one carries none.
      CONSTRAINT payments_void_chk CHECK ((status = 'voided') = (voided_at IS NOT NULL)),
      CONSTRAINT payments_void_reason_chk CHECK (status <> 'voided' OR void_reason IS NOT NULL)
    );
    -- AT MOST ONE recorded payment per appointment (the concurrency guard — ON CONFLICT / caught 23505).
    CREATE UNIQUE INDEX payments_one_recorded_per_appointment
      ON payments (tenant_id, appointment_id) WHERE status = 'recorded';
    CREATE INDEX payments_client_idx ON payments (tenant_id, client_id, status, paid_at);
    CREATE INDEX payments_appointment_idx ON payments (tenant_id, appointment_id);

    -- ── payment_lines (itemized charge + per-line commission snapshot) ─────────────
    CREATE TABLE payment_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      payment_id uuid NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('service', 'product')),
      -- Soft references (the description snapshot is the durable identity): a deleted catalogue row
      -- nulls the ref but the line survives with its name + amounts.
      service_id uuid REFERENCES services (id) ON DELETE SET NULL,
      product_id uuid REFERENCES products (id) ON DELETE SET NULL,
      description text NOT NULL CHECK (btrim(description) <> '' AND char_length(description) <= 200),
      -- service line: the appointment's artist; product line: the optional seller (for commission).
      staff_id uuid REFERENCES staff (id) ON DELETE SET NULL,
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_list_price numeric(10, 2) CHECK (unit_list_price IS NULL OR unit_list_price >= 0),
      unit_charged numeric(10, 2) NOT NULL CHECK (unit_charged >= 0),
      line_total numeric(12, 2) NOT NULL CHECK (line_total >= 0),
      adjustment_reason text CHECK (adjustment_reason IS NULL OR adjustment_reason IN ('promocion', 'cortesia', 'ajuste', 'otro')),
      adjustment_note text CHECK (adjustment_note IS NULL OR (char_length(adjustment_note) <= 500 AND btrim(adjustment_note) <> '')),
      -- Commission SNAPSHOT, computed on the charged line_total at payment time; frozen thereafter.
      commission_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (commission_pct BETWEEN 0 AND 100),
      commission_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (commission_amount >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payment_lines_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      -- kind decides which ref MAY be set (presence is not required — a snapshot carries the truth).
      CONSTRAINT payment_lines_ref_chk CHECK (
        (kind = 'service' AND product_id IS NULL) OR (kind = 'product' AND service_id IS NULL)
      ),
      -- 'otro' adjustment must carry a note.
      CONSTRAINT payment_lines_adjustment_note_chk CHECK (adjustment_reason IS DISTINCT FROM 'otro' OR adjustment_note IS NOT NULL)
    );
    CREATE INDEX payment_lines_payment_idx ON payment_lines (tenant_id, payment_id);
    CREATE INDEX payment_lines_staff_idx ON payment_lines (tenant_id, client_id, staff_id) WHERE staff_id IS NOT NULL;

    -- ── staff commission (the configurable % per artist) ───────────────────────────
    ALTER TABLE staff
      ADD COLUMN commission_pct_services numeric(5, 2) NOT NULL DEFAULT 0 CHECK (commission_pct_services BETWEEN 0 AND 100),
      ADD COLUMN commission_pct_products numeric(5, 2) NOT NULL DEFAULT 0 CHECK (commission_pct_products BETWEEN 0 AND 100);

    -- ── payment_settings (when "cobro pendiente" starts counting) ──────────────────
    CREATE TABLE payment_settings (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      -- A completed appointment on/after this instant, with no recorded payment, is "cobro pendiente".
      -- Default = deploy time for existing clients; a missing row falls back to the client's created_at.
      payments_tracking_started_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id),
      CONSTRAINT payment_settings_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE
    );
    INSERT INTO payment_settings (tenant_id, client_id)
      SELECT tenant_id, id FROM clients WHERE is_default = false
    ON CONFLICT (tenant_id, client_id) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS payment_lines;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS payment_methods;
    DROP TABLE IF EXISTS payment_settings;
    ALTER TABLE staff DROP COLUMN IF EXISTS commission_pct_services;
    ALTER TABLE staff DROP COLUMN IF EXISTS commission_pct_products;
  `);
}
