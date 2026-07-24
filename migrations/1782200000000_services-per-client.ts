import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SCHED-3: make the service CATALOGUE per-CLIENT (tenant_id + client_id), not just
 * per-tenant. Two businesses in one tenant must own independent "Haircut" services;
 * changing one can never touch the other, and no client's service id may ever be
 * used at another client's site/staff/appointment.
 *
 * OWNERSHIP EVIDENCE (real relations, never a guessed client):
 *   - site_services  → sites.client_id
 *   - staff_services → staff → sites.client_id
 *   - appointments   → appointments.client_id
 *
 * BACKFILL:
 *   1. add client_id NULLABLE;
 *   2. a service related to exactly ONE client → assign it (UUID preserved);
 *   3. a service related to MULTIPLE clients → keep the original for the
 *      deterministic FIRST client (min(client_id)) and CLONE it (new UUID, all real
 *      fields copied) for each other client, then re-point THAT client's
 *      site_services / staff_services / appointments to the clone (every relation
 *      ends on the service of its OWN client);
 *   4. ORPHAN (no evidence) → if the tenant has EXACTLY ONE non-default client with
 *      scheduling enabled, assign it there; if ambiguous, RAISE (stop the migration
 *      — never guess, never assign to Unassigned/default, never delete silently);
 *   5. client_id NOT NULL + composite FK (client_id, tenant_id) → clients(id,
 *      tenant_id) (same-tenant, matching sites/appointments; NO ACTION on delete,
 *      same as sites); per-client index. Two clients may now share a service name.
 *
 * DOWN is intentionally IRREVERSIBLE: step 3 cloned rows and re-pointed FKs, which
 * cannot be un-merged without losing the per-client split — a destructive rollback
 * would silently lose data, so down RAISES instead of faking reversibility.
 *
 * Not to be run in production by this task.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE services ADD COLUMN client_id uuid;

    DO $$
    DECLARE
      rec        RECORD;
      copy_id    uuid;
      i          integer;
      candidates uuid[];
    BEGIN
      -- Distinct (service, client) evidence across ALL real relations.
      CREATE TEMP TABLE _svc_owner ON COMMIT DROP AS
        SELECT DISTINCT service_id, client_id FROM (
          SELECT ss.service_id, si.client_id
            FROM site_services ss JOIN sites si ON si.id = ss.site_id
          UNION
          SELECT sts.service_id, si.client_id
            FROM staff_services sts
            JOIN staff st ON st.id = sts.staff_id
            JOIN sites si ON si.id = st.site_id
          UNION
          SELECT a.service_id, a.client_id
            FROM appointments a
        ) ev;

      -- (2) Single-owner services → assign directly (UUID preserved).
      -- uuid has no min() aggregate — pick deterministically via text.
      UPDATE services s
         SET client_id = e.client_id
        FROM (
          SELECT service_id, min(client_id::text)::uuid AS client_id, count(*) AS n
            FROM _svc_owner GROUP BY service_id
        ) e
       WHERE s.id = e.service_id AND e.n = 1;

      -- (3) Shared services → keep original for clients[1]; clone + re-point for rest.
      FOR rec IN
        SELECT service_id, array_agg(client_id ORDER BY client_id) AS clients
          FROM _svc_owner GROUP BY service_id HAVING count(*) > 1
      LOOP
        UPDATE services SET client_id = rec.clients[1] WHERE id = rec.service_id;

        FOR i IN 2 .. array_length(rec.clients, 1) LOOP
          INSERT INTO services
            (tenant_id, client_id, name, description, duration_min, price,
             buffer_before_min, buffer_after_min, active, created_at, updated_at)
          SELECT tenant_id, rec.clients[i], name, description, duration_min, price,
                 buffer_before_min, buffer_after_min, active, created_at, now()
            FROM services WHERE id = rec.service_id
          RETURNING id INTO copy_id;

          -- Re-point site_services whose SITE belongs to clients[i].
          UPDATE site_services ss SET service_id = copy_id, updated_at = now()
            FROM sites si
           WHERE ss.site_id = si.id
             AND ss.service_id = rec.service_id
             AND si.client_id = rec.clients[i];

          -- Re-point staff_services whose STAFF's site belongs to clients[i].
          UPDATE staff_services sts SET service_id = copy_id, updated_at = now()
            FROM staff st JOIN sites si ON si.id = st.site_id
           WHERE sts.staff_id = st.id
             AND sts.service_id = rec.service_id
             AND si.client_id = rec.clients[i];

          -- Re-point appointments of clients[i].
          UPDATE appointments SET service_id = copy_id, updated_at = now()
           WHERE service_id = rec.service_id
             AND client_id = rec.clients[i];
        END LOOP;
      END LOOP;

      -- (4) Orphans (no evidence): single non-default scheduling client, or STOP.
      FOR rec IN SELECT id, tenant_id FROM services WHERE client_id IS NULL LOOP
        SELECT array_agg(cm.client_id) INTO candidates
          FROM client_modules cm
          JOIN clients c ON c.id = cm.client_id AND c.tenant_id = cm.tenant_id
         WHERE cm.tenant_id = rec.tenant_id
           AND cm.module_key = 'scheduling'
           AND cm.enabled = true
           AND c.is_default = false;

        IF candidates IS NULL OR array_length(candidates, 1) IS NULL THEN
          RAISE EXCEPTION
            'SCHED-3: orphan service % (tenant %) has no ownership evidence and no non-default scheduling client to assign; resolve manually.',
            rec.id, rec.tenant_id;
        ELSIF array_length(candidates, 1) = 1 THEN
          UPDATE services SET client_id = candidates[1] WHERE id = rec.id;
        ELSE
          RAISE EXCEPTION
            'SCHED-3: orphan service % (tenant %) is AMBIGUOUS — % non-default scheduling clients; resolve manually.',
            rec.id, rec.tenant_id, array_length(candidates, 1);
        END IF;
      END LOOP;
    END $$;

    ALTER TABLE services ALTER COLUMN client_id SET NOT NULL;
    ALTER TABLE services
      ADD CONSTRAINT services_client_fkey FOREIGN KEY (client_id, tenant_id)
      REFERENCES clients (id, tenant_id);

    DROP INDEX IF EXISTS services_tenant_idx;
    CREATE INDEX services_tenant_client_idx ON services (tenant_id, client_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // IRREVERSIBLE: the up step cloned shared services and re-pointed FKs. A
  // destructive down would silently lose the per-client split — fail explicitly.
  pgm.sql(`
    DO $$ BEGIN
      RAISE EXCEPTION
        'SCHED-3 is irreversible: it cloned shared services per client and re-pointed site_services/staff_services/appointments. Restore from a backup instead of rolling back.';
    END $$;
  `);
}
