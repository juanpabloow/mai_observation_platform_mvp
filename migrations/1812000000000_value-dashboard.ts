import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * VALUE DASHBOARD (spec v3.1, entrega-dashboard-valor/ESPECIFICACION.md) — the two records the
 * dashboard needs that the schema does not have yet, plus one read index.
 *
 *  value_estimate_assumptions — the minutes/cost assumptions behind «Tiempo liberado estimado»
 *      (§4). VERSIONED and APPEND-ONLY: a row is never edited (a trigger refuses UPDATE). The
 *      agency PROPOSES (status 'proposed'); only the business owner CONFIRMS, by inserting a
 *      'confirmed' row (optionally pointing at the proposal it accepts). For a given day the
 *      dashboard uses the most recently confirmed row whose effective_from ≤ that day, so a
 *      change only reaches back as far as the date its confirmer chose — never silently. A
 *      client with no confirmed row has NO estimate (the screen says «Configura tu estimación»);
 *      there are no defaults.
 *
 *  instrumentation_reviews — the «revisión manual aprobada» of §5.2/§7. Conversational metrics
 *      (Q2, Q3, U1/U2) are shown ONLY when Q9 says habilitable AND the latest review of the
 *      client is 'approved', covers every workflow Q9 now treats as conversational, uses the
 *      current method version and its mappings fingerprint still matches. Nothing in
 *      the app writes this table: a review is recorded by whoever performs it, outside the UI,
 *      with its date, reviewer and method version. Until then the dashboard says «Sin evidencia
 *      suficiente» — it never invents an approval.
 *
 * The read index the dashboard wants on appointments (tenant_id, client_id, created_at) is NOT
 * here: it is built CONCURRENTLY in 1813, which must run outside a transaction.
 *
 * Both tables carry tenant_id + client_id with the composite FK used everywhere else, so a row
 * can never point at another tenant's client. Purely ADDITIVE: no existing table or column is
 * altered. Locks: creating the FKs takes SHARE ROW EXCLUSIVE on `tenants` and `clients` until
 * the migration transaction commits (milliseconds — two empty tables), which only blocks writes
 * to those two tables for that instant. Reversible (DOWN drops both tables).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE value_estimate_assumptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('proposed', 'confirmed')),
      method_version text NOT NULL DEFAULT 'v1' CHECK (char_length(method_version) <= 20),
      min_conversacion_atendida integer NOT NULL CHECK (min_conversacion_atendida BETWEEN 0 AND 240),
      min_conversacion_con_cita integer NOT NULL CHECK (min_conversacion_con_cita BETWEEN 0 AND 240),
      min_agendar_manual integer NOT NULL CHECK (min_agendar_manual BETWEEN 0 AND 240),
      costo_hora numeric(12, 2) NOT NULL CHECK (costo_hora >= 0 AND costo_hora <= 100000000),
      effective_from date NOT NULL,
      -- Who proposed it and when (agency or owner). Text: user ids are text in this schema.
      proposed_by text NOT NULL CHECK (char_length(proposed_by) <= 255),
      proposed_at timestamptz NOT NULL DEFAULT now(),
      -- Set only on 'confirmed' rows: the business owner who confirmed and when.
      confirmed_by text CHECK (confirmed_by IS NULL OR char_length(confirmed_by) <= 255),
      confirmed_at timestamptz,
      -- A confirmation that accepts a proposal as-is points at it.
      based_on_id uuid REFERENCES value_estimate_assumptions (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT value_estimate_assumptions_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      CONSTRAINT value_estimate_assumptions_confirmation CHECK (
        (status = 'proposed' AND confirmed_by IS NULL AND confirmed_at IS NULL)
        OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL))
    );
    CREATE INDEX value_estimate_assumptions_client_idx ON value_estimate_assumptions (tenant_id, client_id, created_at DESC);

    CREATE FUNCTION value_estimate_assumptions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'value_estimate_assumptions is append-only: insert a new version instead';
    END $$;
    CREATE TRIGGER value_estimate_assumptions_no_update BEFORE UPDATE ON value_estimate_assumptions
      FOR EACH ROW EXECUTE FUNCTION value_estimate_assumptions_append_only();

    CREATE TABLE instrumentation_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('approved', 'rejected')),
      method_version text NOT NULL CHECK (char_length(method_version) <= 20),
      -- The workflows the reviewer CONFIRMED as conversational (§7.2): a workflow Q9 later sees
      -- as conversational but that is not listed here makes the review stale.
      conversational_workflow_ids text[] NOT NULL,
      -- md5 of the conversation field_mappings of those workflows at review time (see
      -- docs/value-dashboard/REVISION-MANUAL.md for the exact expression). The dashboard
      -- recomputes it on every load: an edited, added or deleted mapping makes the review stale.
      mappings_fingerprint text NOT NULL CHECK (char_length(mappings_fingerprint) = 32),
      sample_size integer NOT NULL CHECK (sample_size > 0),
      correct_count integer NOT NULL CHECK (correct_count >= 0 AND correct_count <= sample_size),
      reviewed_by text NOT NULL CHECK (char_length(reviewed_by) <= 255),
      reviewed_at timestamptz NOT NULL,
      notes text CHECK (notes IS NULL OR char_length(notes) <= 2000),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT instrumentation_reviews_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    CREATE INDEX instrumentation_reviews_client_idx ON instrumentation_reviews (tenant_id, client_id, reviewed_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE instrumentation_reviews;
    DROP TABLE value_estimate_assumptions;
    DROP FUNCTION value_estimate_assumptions_append_only();
  `);
}
