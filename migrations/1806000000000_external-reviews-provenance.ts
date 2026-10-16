import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * EXTERNAL REVIEWS WITH PROVENANCE — reviews a business had on Fresha, imported into the
 * SAME table and the SAME public reads as the reviews collected here (migration 1801),
 * but under PLATFORM-ADMIN control and with a traceable origin. Supersedes the unmerged
 * draft migration 1802 (`feature/reviews-external-fresha`), which must not be merged.
 *
 * What an imported review is, and is not:
 *  - NO appointment here and NO review link: it was never a completed appointment of
 *    M_AI and is never presented as one.
 *  - publish_consent stays FALSE (no consent was given in M_AI).
 *  - It enters `pending` with provenance `pending`, and can only be APPROVED (published)
 *    after a platform administrator reviewed its provenance — a DB CHECK, not only the UI.
 *  - staff_id / service_id are set only when a person CONFIRMED the equivalence; a review
 *    of the business in general stays unattributed and counts for no artist or service.
 *  - original_comment keeps the text exactly as imported (internal, for audit); `comment`
 *    is what may be shown. Any difference is recorded in `redactions`.
 *  - evidence_ref is an internal pointer to where it can be checked (never fetched, never
 *    public). public_source_url is a link the page may show (https only; the app further
 *    restricts it to Fresha).
 *
 *  review_import_batches — one row per applied import: who, when, which file (its SHA-256,
 *    never its contents), counts and the confirmed equivalences.
 *  review_events — append-only audit of administrative actions on reviews and batches.
 *  external_review_requests — the business may ask for a review or the withdrawal of an
 *    imported review; only a platform administrator resolves it.
 *
 * DOWN refuses while any imported review or batch exists.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE review_import_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      site_id uuid NOT NULL REFERENCES sites (id),
      source text NOT NULL CHECK (source IN ('fresha')),
      file_name text CHECK (file_name IS NULL OR (char_length(file_name) <= 200 AND btrim(file_name) <> '')),
      file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
      total_rows integer NOT NULL CHECK (total_rows >= 0),
      imported integer NOT NULL CHECK (imported >= 0),
      duplicates integer NOT NULL CHECK (duplicates >= 0),
      rejected integer NOT NULL CHECK (rejected >= 0),
      mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
      imported_by text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT review_import_batches_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    CREATE INDEX review_import_batches_client_idx ON review_import_batches (tenant_id, client_id, created_at);

    ALTER TABLE appointment_reviews
      ADD COLUMN source text NOT NULL DEFAULT 'mai',
      ADD COLUMN external_key text,
      ADD COLUMN original_reviewed_at timestamptz,
      ADD COLUMN import_batch_id uuid REFERENCES review_import_batches (id),
      ADD COLUMN evidence_ref text,
      ADD COLUMN public_source_url text,
      ADD COLUMN original_comment text,
      ADD COLUMN redactions jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN provenance_status text,
      ADD COLUMN provenance_reviewed_by text REFERENCES "user" (id) ON DELETE SET NULL,
      ADD COLUMN provenance_reviewed_at timestamptz,
      ADD COLUMN provenance_notes text,
      ALTER COLUMN appointment_id DROP NOT NULL,
      ALTER COLUMN service_name DROP NOT NULL,
      ALTER COLUMN expires_at DROP NOT NULL;

    ALTER TABLE appointment_reviews
      ADD CONSTRAINT appointment_reviews_source_check CHECK (source IN ('mai', 'fresha')),
      ADD CONSTRAINT appointment_reviews_origin_check CHECK (
        (source = 'mai'
          AND appointment_id IS NOT NULL AND service_name IS NOT NULL AND expires_at IS NOT NULL
          AND external_key IS NULL AND original_reviewed_at IS NULL AND import_batch_id IS NULL
          AND evidence_ref IS NULL AND public_source_url IS NULL AND original_comment IS NULL
          AND provenance_status IS NULL)
        OR
        (source <> 'mai'
          AND appointment_id IS NULL AND expires_at IS NULL
          AND external_key IS NOT NULL AND btrim(external_key) <> '' AND char_length(external_key) <= 200
          AND original_reviewed_at IS NOT NULL AND import_batch_id IS NOT NULL
          AND provenance_status IS NOT NULL
          AND status <> 'requested' AND publish_consent = false)
      ),
      ADD CONSTRAINT appointment_reviews_provenance_check CHECK (
        provenance_status IS NULL OR provenance_status IN ('pending', 'reviewed', 'rejected')
      ),
      ADD CONSTRAINT appointment_reviews_provenance_reviewed_check CHECK (
        provenance_status IS NULL OR provenance_status = 'pending' OR provenance_reviewed_at IS NOT NULL
      ),
      -- THE publication gate: an imported review is public only after its provenance review.
      ADD CONSTRAINT appointment_reviews_external_publish_check CHECK (
        source = 'mai' OR status <> 'approved' OR provenance_status = 'reviewed'
      ),
      ADD CONSTRAINT appointment_reviews_service_name_check CHECK (
        service_name IS NULL OR (char_length(service_name) <= 200 AND btrim(service_name) <> '')
      ),
      ADD CONSTRAINT appointment_reviews_external_text_check CHECK (
        (evidence_ref IS NULL OR (char_length(evidence_ref) <= 500 AND btrim(evidence_ref) <> ''))
        AND (public_source_url IS NULL OR (char_length(public_source_url) <= 1000 AND public_source_url ~ '^https://[^[:space:]]+$'))
        AND (original_comment IS NULL OR char_length(original_comment) <= 4000)
        AND (provenance_notes IS NULL OR (char_length(provenance_notes) <= 1000 AND btrim(provenance_notes) <> ''))
      );

    -- Consent is required to leave 'requested' ONLY for reviews collected here.
    ALTER TABLE appointment_reviews DROP CONSTRAINT appointment_reviews_submitted_check;
    ALTER TABLE appointment_reviews ADD CONSTRAINT appointment_reviews_submitted_check CHECK (
      (status = 'requested' AND submitted_at IS NULL)
      OR (status <> 'requested' AND submitted_at IS NOT NULL AND rating IS NOT NULL
          AND author_display IS NOT NULL AND (publish_consent OR source <> 'mai'))
    );

    CREATE UNIQUE INDEX appointment_reviews_external_key
      ON appointment_reviews (tenant_id, client_id, source, external_key)
      WHERE external_key IS NOT NULL;

    CREATE TABLE review_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      review_id uuid REFERENCES appointment_reviews (id) ON DELETE CASCADE,
      batch_id uuid REFERENCES review_import_batches (id) ON DELETE CASCADE,
      event_type text NOT NULL CHECK (event_type IN (
        'imported', 'provenance_reviewed', 'provenance_rejected', 'published', 'hidden',
        'redacted', 'request_created', 'request_resolved'
      )),
      actor_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT review_events_target CHECK (review_id IS NOT NULL OR batch_id IS NOT NULL)
    );
    CREATE INDEX review_events_review_idx ON review_events (tenant_id, review_id, created_at);

    CREATE TABLE external_review_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      review_id uuid NOT NULL REFERENCES appointment_reviews (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('review', 'withdraw')),
      note text CHECK (note IS NULL OR (char_length(note) <= 500 AND btrim(note) <> '')),
      requested_by text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_by text REFERENCES "user" (id) ON DELETE SET NULL,
      resolved_at timestamptz,
      resolution text CHECK (resolution IS NULL OR resolution IN ('kept', 'withdrawn', 'corrected')),
      CONSTRAINT external_review_requests_resolved CHECK ((resolved_at IS NULL) = (resolution IS NULL)),
      CONSTRAINT external_review_requests_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    -- One OPEN request of each kind per review.
    CREATE UNIQUE INDEX external_review_requests_open
      ON external_review_requests (review_id, kind) WHERE resolved_at IS NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    LOCK TABLE appointment_reviews IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM appointment_reviews WHERE source <> 'mai') OR EXISTS (SELECT 1 FROM review_import_batches) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot revert external reviews while imported reviews or batches exist. Remove them explicitly first; nothing was deleted.';
      END IF;
    END $$;
    DROP TABLE external_review_requests;
    DROP TABLE review_events;
    DROP INDEX appointment_reviews_external_key;
    ALTER TABLE appointment_reviews DROP CONSTRAINT appointment_reviews_submitted_check;
    ALTER TABLE appointment_reviews ADD CONSTRAINT appointment_reviews_submitted_check CHECK (
      (status = 'requested' AND submitted_at IS NULL)
      OR (status <> 'requested' AND submitted_at IS NOT NULL AND rating IS NOT NULL
          AND author_display IS NOT NULL AND publish_consent)
    );
    ALTER TABLE appointment_reviews
      DROP CONSTRAINT appointment_reviews_external_text_check,
      DROP CONSTRAINT appointment_reviews_service_name_check,
      DROP CONSTRAINT appointment_reviews_external_publish_check,
      DROP CONSTRAINT appointment_reviews_provenance_reviewed_check,
      DROP CONSTRAINT appointment_reviews_provenance_check,
      DROP CONSTRAINT appointment_reviews_origin_check,
      DROP CONSTRAINT appointment_reviews_source_check,
      ALTER COLUMN appointment_id SET NOT NULL,
      ALTER COLUMN service_name SET NOT NULL,
      ALTER COLUMN expires_at SET NOT NULL,
      DROP COLUMN provenance_notes,
      DROP COLUMN provenance_reviewed_at,
      DROP COLUMN provenance_reviewed_by,
      DROP COLUMN provenance_status,
      DROP COLUMN redactions,
      DROP COLUMN original_comment,
      DROP COLUMN public_source_url,
      DROP COLUMN evidence_ref,
      DROP COLUMN import_batch_id,
      DROP COLUMN original_reviewed_at,
      DROP COLUMN external_key,
      DROP COLUMN source;
    DROP TABLE review_import_batches;
  `);
}
