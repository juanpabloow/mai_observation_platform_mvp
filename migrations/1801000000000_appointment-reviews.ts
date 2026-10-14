import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * APPOINTMENT REVIEWS — what a customer thinks of a COMPLETED appointment, published on
 * the booking page only after the business approves it.
 *
 * One row per appointment (UNIQUE appointment_id), created when someone asks for the
 * review link (agenda "Enlace de reseña" or the machine API for n8n). The link carries
 * the row id plus an HMAC — no secret is stored here.
 *
 *   requested → (customer submits) → pending → (business) → approved | hidden
 *
 *  - rating 1–5 and an optional comment (≤ 600, plain text; content rules in the app).
 *  - author_display is computed at submission ("Andrés G." — first name + initial), never
 *    the phone or e-mail; publish_consent must be true to leave `requested`.
 *  - service_name / staff_id are a snapshot of the appointment, so a renamed service or
 *    a deactivated professional keeps the review where it was earned.
 *  - Tenant/client/site scoped with composite FKs, like the rest of scheduling.
 *
 * Adds UNIQUE (id, tenant_id, client_id) on appointments so the FK can be composite (the
 * same pattern as sites/contacts). DOWN refuses while any review has been submitted.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_id_tenant_client_key UNIQUE (id, tenant_id, client_id);

    CREATE TABLE appointment_reviews (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id        uuid        NOT NULL,
      client_id        uuid        NOT NULL,
      site_id          uuid        NOT NULL,
      appointment_id   uuid        NOT NULL,
      staff_id         uuid,
      service_id       uuid,
      service_name     text        NOT NULL,
      status           text        NOT NULL DEFAULT 'requested',
      rating           smallint,
      comment          text,
      author_display   text,
      publish_consent  boolean     NOT NULL DEFAULT false,
      expires_at       timestamptz NOT NULL,
      submitted_at     timestamptz,
      moderated_at     timestamptz,
      moderated_by     text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT appointment_reviews_appointment_key UNIQUE (appointment_id),
      CONSTRAINT appointment_reviews_status_check CHECK (status IN ('requested', 'pending', 'approved', 'hidden')),
      CONSTRAINT appointment_reviews_rating_check CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
      CONSTRAINT appointment_reviews_comment_check CHECK (comment IS NULL OR (char_length(comment) <= 600 AND btrim(comment) <> '')),
      CONSTRAINT appointment_reviews_author_check CHECK (author_display IS NULL OR (char_length(author_display) <= 40 AND btrim(author_display) <> '')),
      -- requested ⇔ not submitted; anything submitted has a rating, an author and consent.
      CONSTRAINT appointment_reviews_submitted_check CHECK (
        (status = 'requested' AND submitted_at IS NULL)
        OR (status <> 'requested' AND submitted_at IS NOT NULL AND rating IS NOT NULL
            AND author_display IS NOT NULL AND publish_consent)
      ),
      CONSTRAINT appointment_reviews_appointment_fkey
        FOREIGN KEY (appointment_id, tenant_id, client_id)
        REFERENCES appointments (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT appointment_reviews_site_fkey
        FOREIGN KEY (site_id, tenant_id, client_id)
        REFERENCES sites (id, tenant_id, client_id) ON DELETE CASCADE
    );

    -- Booking page aggregates and lists: approved reviews of a site, per professional.
    CREATE INDEX appointment_reviews_public_idx
      ON appointment_reviews (site_id, staff_id, submitted_at DESC) WHERE status = 'approved';
    -- Moderation queue of a client.
    CREATE INDEX appointment_reviews_moderation_idx
      ON appointment_reviews (tenant_id, client_id, status, submitted_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM appointment_reviews WHERE status <> 'requested') THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop appointment_reviews while customers have submitted reviews. Export or clear them explicitly; nothing was deleted.';
      END IF;
    END $$;
    DROP TABLE appointment_reviews;
    ALTER TABLE appointments DROP CONSTRAINT appointments_id_tenant_client_key;
  `);
}
