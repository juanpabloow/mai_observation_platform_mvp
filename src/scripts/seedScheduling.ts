import { pool, query } from '../db/client.js';
import { logger } from '../logger.js';
import { createAppointment } from '../scheduling/booking.js';
import type { WeeklyHours } from '../scheduling/types.js';

/**
 * Idempotent demo seed for the scheduling module. Creates (or reuses) a dedicated
 * demo tenant + one Bogota site, two barbers, three services, weekly hours, one
 * exception, a couple of contacts and example appointments — enough to explore the
 * agenda, contacts, and public booking page locally.
 *
 * Run with: npm run seed:scheduling
 * It NEVER touches other tenants and can be re-run safely.
 */

const DEMO_TENANT_ID = '22222222-2222-2222-2222-222222222222';
const DEMO_SLUG = 'demo-barbershop';

const WEEK: WeeklyHours = {
  mon: [{ start: '09:00', end: '18:00' }],
  tue: [{ start: '09:00', end: '18:00' }],
  wed: [{ start: '09:00', end: '18:00' }],
  thu: [{ start: '09:00', end: '18:00' }],
  fri: [{ start: '09:00', end: '19:00' }],
  sat: [{ start: '10:00', end: '16:00' }],
};

async function main(): Promise<void> {
  await query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'Demo Scheduling Tenant') ON CONFLICT (id) DO NOTHING`,
    [DEMO_TENANT_ID],
  );

  // Site (idempotent by slug within the tenant).
  const siteRow = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, slug, name, address, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, 'Demo Barbershop', 'Cra 7 #1-23, Bogotá', 'America/Bogota', $3,
         '{"slot_interval_min":15,"min_notice_min":60,"booking_horizon_days":30,"default_buffer_before_min":0,"default_buffer_after_min":5}'::jsonb)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [DEMO_TENANT_ID, DEMO_SLUG, JSON.stringify(WEEK)],
  );
  const siteId = siteRow.rows[0].id;

  const upsertStaff = async (name: string): Promise<string> => {
    const existing = await query<{ id: string }>(
      `SELECT id FROM staff WHERE tenant_id = $1 AND site_id = $2 AND name = $3`,
      [DEMO_TENANT_ID, siteId, name],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const r = await query<{ id: string }>(
      `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`,
      [DEMO_TENANT_ID, siteId, name],
    );
    return r.rows[0].id;
  };
  const ana = await upsertStaff('Ana Gómez');
  const beto = await upsertStaff('Beto Ruiz');

  const upsertService = async (name: string, dur: number, price: number, bAfter = 5): Promise<string> => {
    const existing = await query<{ id: string }>(`SELECT id FROM services WHERE tenant_id = $1 AND name = $2`, [DEMO_TENANT_ID, name]);
    let id: string;
    if (existing.rows[0]) {
      id = existing.rows[0].id;
    } else {
      const r = await query<{ id: string }>(
        `INSERT INTO services (tenant_id, name, duration_min, price, buffer_after_min) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [DEMO_TENANT_ID, name, dur, price, bAfter],
      );
      id = r.rows[0].id;
    }
    await query(
      `INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3) ON CONFLICT (site_id, service_id) DO NOTHING`,
      [DEMO_TENANT_ID, siteId, id],
    );
    return id;
  };
  const haircut = await upsertService('Corte de cabello', 45, 35000);
  const beard = await upsertService('Arreglo de barba', 30, 20000);
  const combo = await upsertService('Corte + barba', 75, 50000);

  for (const svc of [haircut, beard, combo]) {
    for (const st of [ana, beto]) {
      await query(
        `INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3) ON CONFLICT (staff_id, service_id) DO NOTHING`,
        [DEMO_TENANT_ID, st, svc],
      );
    }
  }

  // One exception: block Ana next Monday 12:00–13:00 local (lunch).
  await query(
    `INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason)
       SELECT $1, $2, $3, ts, ts + interval '1 hour', 'Almuerzo'
         FROM (SELECT (date_trunc('week', now() AT TIME ZONE 'America/Bogota') + interval '1 week 12 hours') AT TIME ZONE 'America/Bogota' AS ts) t
        WHERE NOT EXISTS (
          SELECT 1 FROM schedule_exceptions WHERE tenant_id = $1 AND site_id = $2 AND staff_id = $3 AND reason = 'Almuerzo'
        )`,
    [DEMO_TENANT_ID, siteId, ana],
  );

  // Example appointments via the real engine (skip if the demo already has some).
  const apptCount = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM appointments WHERE tenant_id = $1`, [DEMO_TENANT_ID]);
  if (apptCount.rows[0].n === 0) {
    // Next available-ish slots: tomorrow 10:00 and 11:00 Bogota.
    const tomorrow10 = await nextLocalSlot(10);
    const tomorrow11 = await nextLocalSlot(11);
    const r1 = await createAppointment({
      tenantId: DEMO_TENANT_ID, siteId, serviceId: haircut, staffId: ana, startAt: tomorrow10,
      channel: 'whatsapp', channelUserId: '573001112233', customerName: 'Carlos Pérez', customerPhone: '+573001112233',
      origin: 'internal', createdByType: 'agent',
    });
    const r2 = await createAppointment({
      tenantId: DEMO_TENANT_ID, siteId, serviceId: combo, staffId: beto, startAt: tomorrow11,
      channel: 'whatsapp', channelUserId: '573004445566', customerName: 'Diana López', customerPhone: '+573004445566',
      origin: 'public', createdByType: 'public',
    });
    logger.info({ r1: r1.ok, r2: r2.ok }, 'seeded example appointments');
  }

  logger.info({ tenant: DEMO_TENANT_ID, site: siteId, slug: DEMO_SLUG }, 'scheduling seed complete');
  logger.info(`Public booking page: /book/${DEMO_SLUG}`);
}

/** Tomorrow at HH:00 local Bogota, as a UTC Date. */
async function nextLocalSlot(hour: number): Promise<Date> {
  const r = await query<{ ts: Date }>(
    `SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Bogota') + interval '1 day' + ($1 || ' hours')::interval) AT TIME ZONE 'America/Bogota') AS ts`,
    [hour],
  );
  return r.rows[0].ts;
}

main()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, 'scheduling seed failed');
    return pool.end().finally(() => process.exit(1));
  });
