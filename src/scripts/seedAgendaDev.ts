import { pool, query } from '../db/client.js';
import { setClientModuleEnabled } from '../db/repositories/clientModules.js';
import { utcToZonedParts, zonedPartsToUtc, type Weekday } from '../scheduling/timezone.js';
import type { WeeklyHours } from '../scheduling/types.js';

/**
 * DEV-ONLY Agenda fixture: a self-contained sandbox client whose day covers every
 * visual treatment the Agenda can render (each service colour family, unconfirmed,
 * overlap, no-show, cancelled, walk-in, a closed barber lane and a closed weekday).
 *
 * NOT PRODUCTION. Two independent gates, both must pass — see `assertDevOnly`.
 *
 * ISOLATION. Nothing is written into existing clients, sites, staff, services or
 * contacts. Everything lands under ONE new client named exactly
 * `[DEV] Agenda Sandbox`, and every row it owns carries the `[DEV] ` prefix in its
 * name. `--clean` removes that client and everything hanging off it, matched on
 * that marker alone, so real data can't be caught in the sweep. Re-running the
 * seed cleans first, so it is idempotent.
 *
 *   npm run seed:agenda-dev          # seed  (needs ALLOW_DEV_SEED=true)
 *   npm run seed:agenda-dev:clean    # remove
 *
 * WHAT THIS DELIBERATELY DOES NOT FAKE (see the TODOs in web/lib/agendaCategory.ts
 * and web/components/scheduling/AgendaView.tsx):
 * - `services.category` does not exist, so the colour family is inferred from the
 *   service NAME. The names below are chosen to land on each family — that IS the
 *   production behaviour, not a shortcut for the seed.
 * - There is no `payment_due` state, so the DANGER family is exercised through the
 *   two states that really produce it: an overlap and a no-show.
 * - `appointments.staff_id` is NOT NULL, so a walk-in with NOBODY assigned cannot
 *   exist in the database. The seed inserts the closest real thing (origin
 *   `walk_in` with no contact); it renders as a normal card, NOT as the red "?"
 *   lane. That branch stays unreachable until staff_id becomes nullable.
 * - There is no blocked-time / "team meeting" ENTITY on the agenda. The real model
 *   for it is `schedule_exceptions`, so the seed writes one — but the Agenda does
 *   not draw exceptions yet, so it will not appear on the grid.
 */

const MARKER = '[DEV] ';
const CLIENT_NAME = `${MARKER}Agenda Sandbox`;
const SITE_SLUG = 'dev-agenda-sandbox';
const TZ = 'America/Bogota';
const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * THE PRODUCTION GATE. Both conditions must hold, so neither a stray
 * `ALLOW_DEV_SEED` in a deployed environment nor an unset NODE_ENV on a laptop is
 * enough on its own. Nothing has been written at the point this runs — it is the
 * first statement of the process, before any connection is used.
 */
function assertDevOnly(action: string): void {
  const env = process.env.NODE_ENV;
  if (env === 'production') {
    console.error(
      `REFUSED: cannot ${action} with NODE_ENV=production.\n` +
        'This fixture is for a local/dev database only. Nothing was written.',
    );
    process.exit(1);
  }
  if (process.env.ALLOW_DEV_SEED !== 'true') {
    console.error(
      `REFUSED: cannot ${action} without ALLOW_DEV_SEED=true.\n` +
        'Re-run with ALLOW_DEV_SEED=true if this really is a local/dev database.\n' +
        'Nothing was written.',
    );
    process.exit(1);
  }
}

/** The tenant to seed INTO. Explicit when the database holds more than one. */
async function resolveTenantId(): Promise<string> {
  const wanted = process.env.DEV_SEED_TENANT_ID;
  const rows = (await query<{ id: string; name: string }>(`SELECT id, name FROM tenants ORDER BY name`, [])).rows;
  if (wanted) {
    const hit = rows.find((t) => t.id === wanted);
    if (!hit) {
      console.error(`REFUSED: DEV_SEED_TENANT_ID=${wanted} is not a tenant in this database. Nothing was written.`);
      process.exit(1);
    }
    return hit.id;
  }
  if (rows.length === 1) return rows[0].id;
  console.error(
    'REFUSED: this database has more than one tenant, so the target is ambiguous.\n' +
      'Re-run with DEV_SEED_TENANT_ID=<id> set to one of:\n' +
      rows.map((t) => `  ${t.id}  ${t.name}`).join('\n') +
      '\nNothing was written.',
  );
  process.exit(1);
}

/**
 * Remove the sandbox and everything under it, matched ONLY on the marker name.
 * Deletes run child-first: the composite FK from appointments to clients has no
 * ON DELETE, so the client cannot go until its rows do. Runs across every tenant —
 * the marker is the scope, so a sandbox left in another tenant is still cleaned.
 */
async function clean(): Promise<Record<string, number>> {
  const clients = (
    await query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM clients WHERE name = $1`, [CLIENT_NAME])
  ).rows;
  const counts: Record<string, number> = {
    appointments: 0,
    schedule_exceptions: 0,
    staff: 0,
    sites: 0,
    services: 0,
    contacts: 0,
    clients: 0,
  };
  for (const c of clients) {
    const del = async (sql: string): Promise<number> => (await query(sql, [c.id, c.tenant_id])).rowCount ?? 0;
    // appointment_events cascade from appointments; site_services / staff_services
    // and contact_identities cascade from their parents.
    counts.appointments += await del(`DELETE FROM appointments WHERE client_id = $1 AND tenant_id = $2`);
    counts.schedule_exceptions += await del(
      `DELETE FROM schedule_exceptions WHERE tenant_id = $2
         AND site_id IN (SELECT id FROM sites WHERE client_id = $1 AND tenant_id = $2)`,
    );
    counts.staff += await del(
      `DELETE FROM staff WHERE tenant_id = $2
         AND site_id IN (SELECT id FROM sites WHERE client_id = $1 AND tenant_id = $2)`,
    );
    counts.sites += await del(`DELETE FROM sites WHERE client_id = $1 AND tenant_id = $2`);
    counts.services += await del(`DELETE FROM services WHERE client_id = $1 AND tenant_id = $2`);
    counts.contacts += await del(`DELETE FROM contacts WHERE client_id = $1 AND tenant_id = $2`);
    await del(`DELETE FROM client_modules WHERE client_id = $1 AND tenant_id = $2`);
    counts.clients += await del(`DELETE FROM clients WHERE id = $1 AND tenant_id = $2`);
  }
  return counts;
}

interface Ctx {
  tenantId: string;
  clientId: string;
  siteId: string;
  today: { year: number; month: number; day: number; weekday: Weekday };
  staff: Record<string, string>;
  services: Record<string, { id: string; duration: number; price: number }>;
  contacts: Record<string, string>;
}

/** A local wall-clock time on a day offset from today, as a UTC instant. */
function at(ctx: Ctx, dayOffset: number, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedPartsToUtc(ctx.today.year, ctx.today.month, ctx.today.day + dayOffset, h, m, TZ);
}

async function seed(tenantId: string): Promise<Ctx> {
  const now = utcToZonedParts(new Date(), TZ);
  const today = { year: now.year, month: now.month, day: now.day, weekday: now.weekday };

  const clientId = (
    await query<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`,
      [tenantId, CLIENT_NAME],
    )
  ).rows[0].id;
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  // CRM on as well, so the drawer's "Open contact" link is exercised too.
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'crm', enabled: true });

  // ── Opening hours. One weekday is CLOSED so the week view shows the hatch; it is
  // Sunday unless the seed runs on a Sunday, in which case today must stay open
  // (a closed today would hatch every lane and hide the point of the fixture).
  const closedWeekday: Weekday = today.weekday === 'sun' ? 'mon' : 'sun';
  const shopHours = [{ start: '09:00', end: '19:00' }];
  const openingHours: WeeklyHours = {};
  for (const wd of WEEKDAYS) if (wd !== closedWeekday) openingHours[wd] = shopHours;

  const siteId = (
    await query<{ id: string }>(
      `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
         VALUES ($1, $2, $3, $4, 'Cra 11 #93-45, Bogotá', $5, $6,
           '{"slot_interval_min":15,"min_notice_min":0,"booking_horizon_days":60,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
       RETURNING id`,
      [tenantId, clientId, SITE_SLUG, `${MARKER}Sandbox Barbershop`, TZ, JSON.stringify(openingHours)],
    )
  ).rows[0].id;

  // ── Staff. Marco works every day EXCEPT today, which is what puts a hatched,
  // "Closed" lane on the day view. The other three inherit the site hours ({}).
  const mkStaff = async (name: string, hours: WeeklyHours): Promise<string> =>
    (
      await query<{ id: string }>(
        `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, siteId, `${MARKER}${name}`, JSON.stringify(hours)],
      )
    ).rows[0].id;
  const marcoHours: WeeklyHours = {};
  for (const wd of WEEKDAYS) if (wd !== today.weekday && wd !== closedWeekday) marcoHours[wd] = shopHours;
  const staff = {
    daniela: await mkStaff('Daniela Ríos', {}),
    federico: await mkStaff('Federico Lara', {}),
    paola: await mkStaff('Paola Méndez', {}),
    marco: await mkStaff('Marco Duarte', marcoHours),
  };

  // ── Services. The NAME is what picks the colour family (no category column
  // exists), so these names are the fixture's whole point. Prices are COP.
  const mkService = async (name: string, duration: number, price: number) => {
    const id = (
      await query<{ id: string }>(
        `INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [tenantId, clientId, `${MARKER}${name}`, duration, price],
      )
    ).rows[0].id;
    await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [
      tenantId,
      siteId,
      id,
    ]);
    for (const st of Object.values(staff)) {
      await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [
        tenantId,
        st,
        id,
      ]);
    }
    return { id, duration, price };
  };
  const services = {
    classicCut: await mkService('Classic cut', 45, 60000), // → cut (neutral)
    cutBeard: await mkService('Cut + beard', 60, 85000), // → cut (neutral)
    highlights: await mkService('Highlights', 90, 220000), // → colour (lilac)
    colourCut: await mkService('Colour + cut', 120, 260000), // → colour (lilac)
    beardSculpt: await mkService('Beard sculpt', 30, 40000), // → grooming (sand)
    groomingSet: await mkService('Grooming set', 75, 130000), // → grooming (sand)
    keratin: await mkService('Keratin package', 120, 380000), // → feature (solid)
  };

  // ── Contacts (+ the canonical phone identity the drawer reads).
  const mkContact = async (name: string, phone: string): Promise<string> => {
    const id = (
      await query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, phone_e164, name, stage)
           VALUES ($1, $2, 'whatsapp', $3, $3, $4, 'customer') RETURNING id`,
        [tenantId, clientId, phone, `${MARKER}${name}`],
      )
    ).rows[0].id;
    await query(
      `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label)
         VALUES ($1, $2, $3, 'phone', $4, 'whatsapp')`,
      [tenantId, clientId, id, phone],
    );
    return id;
  };
  const contacts = {
    emma: await mkContact('Emma López', '+573001110001'),
    liam: await mkContact('Liam Cárdenas', '+573001110002'),
    sofia: await mkContact('Sofía Restrepo', '+573001110003'),
    zara: await mkContact('Zara Molina', '+573001110004'),
    kristin: await mkContact('Kristin Peña', '+573001110005'),
    omar: await mkContact('Omar Alzate', '+573001110006'),
    clara: await mkContact('Clara Vélez', '+573001110007'),
    mia: await mkContact('Mía Torres', '+573001110008'),
    john: await mkContact('John Camargo', '+573001110009'),
    savannah: await mkContact('Savannah Niño', '+573001110010'),
  };

  return { tenantId, clientId, siteId, today, staff, services, contacts };
}

type Booking = {
  staff: string;
  service: keyof Ctx['services'];
  /** Local HH:MM in the site timezone. */
  from: string;
  status: 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
  contact?: string | null;
  origin?: 'internal' | 'public' | 'n8n' | 'walk_in';
  /** Days from today; 0 = today. */
  day?: number;
  note?: string;
};

async function book(ctx: Ctx, b: Booking): Promise<void> {
  const svc = ctx.services[b.service];
  const start = at(ctx, b.day ?? 0, b.from);
  const end = new Date(start.getTime() + svc.duration * 60_000);
  await query(
    `INSERT INTO appointments (
       tenant_id, client_id, site_id, contact_id, staff_id, service_id,
       start_at, service_end_at, blocked_from, blocked_until,
       service_name_snapshot, duration_min_snapshot, price_snapshot,
       status, origin, created_by_type)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $7, $8, s.name, $9, $10, $11, $12, 'system'
       FROM services s WHERE s.id = $6`,
    [
      ctx.tenantId,
      ctx.clientId,
      ctx.siteId,
      b.contact ?? null,
      ctx.staff[b.staff],
      svc.id,
      start,
      end,
      svc.duration,
      svc.price,
      b.status,
      b.origin ?? 'internal',
    ],
  );
}

/**
 * TODAY's board — 15 appointments across three working lanes (Marco's is closed).
 * Every visual treatment the grid can produce is represented; see the header for
 * the three it deliberately cannot.
 *
 * The OVERLAP pair is not an accident of times: the database has a GiST exclusion
 * constraint that makes two ACTIVE (scheduled|confirmed) appointments for one
 * barber impossible, so the conflict is seeded as a `completed` card under a
 * `confirmed` one — which is exactly how a real overlap survives to the screen.
 */
function todaysBoard(ctx: Ctx): Booking[] {
  const c = ctx.contacts;
  return [
    // ── Daniela: a clean, full day (neutral → colour → grooming → feature).
    { staff: 'daniela', service: 'classicCut', from: '09:00', status: 'confirmed', contact: c.emma },
    { staff: 'daniela', service: 'colourCut', from: '10:00', status: 'confirmed', contact: c.savannah },
    { staff: 'daniela', service: 'beardSculpt', from: '13:00', status: 'completed', contact: c.kristin },
    { staff: 'daniela', service: 'classicCut', from: '14:00', status: 'scheduled', contact: c.liam }, // unconfirmed
    { staff: 'daniela', service: 'keratin', from: '16:00', status: 'confirmed', contact: c.mia }, // solid block

    // ── Federico: the exception lane — overlap, no-show, cancelled, unconfirmed.
    { staff: 'federico', service: 'cutBeard', from: '09:30', status: 'completed', contact: c.john },
    { staff: 'federico', service: 'highlights', from: '10:00', status: 'confirmed', contact: c.sofia }, // ↑ overlaps
    { staff: 'federico', service: 'groomingSet', from: '12:00', status: 'confirmed', contact: c.zara },
    { staff: 'federico', service: 'classicCut', from: '14:00', status: 'no_show', contact: c.omar },
    { staff: 'federico', service: 'beardSculpt', from: '15:30', status: 'cancelled', contact: c.clara },
    { staff: 'federico', service: 'cutBeard', from: '17:00', status: 'scheduled', contact: c.emma },

    // ── Paola: includes the walk-in (no contact → the card reads "Walk-in").
    { staff: 'paola', service: 'groomingSet', from: '09:00', status: 'confirmed', contact: c.clara },
    { staff: 'paola', service: 'keratin', from: '11:00', status: 'confirmed', contact: c.sofia },
    { staff: 'paola', service: 'classicCut', from: '13:30', status: 'confirmed', contact: null, origin: 'walk_in' },
    { staff: 'paola', service: 'colourCut', from: '15:00', status: 'confirmed', contact: c.zara },
  ];
}

/** A few cards on the neighbouring days so the WEEK view isn't a single column. */
function weekSpread(ctx: Ctx): Booking[] {
  const c = ctx.contacts;
  return [
    { staff: 'daniela', service: 'highlights', from: '10:00', status: 'completed', contact: c.mia, day: -2 },
    { staff: 'federico', service: 'classicCut', from: '11:00', status: 'completed', contact: c.john, day: -1 },
    { staff: 'paola', service: 'beardSculpt', from: '15:00', status: 'confirmed', contact: c.omar, day: 1 },
    { staff: 'daniela', service: 'keratin', from: '12:00', status: 'scheduled', contact: c.savannah, day: 2 },
  ];
}

async function main(): Promise<void> {
  const wantsClean = process.argv.includes('--clean');
  assertDevOnly(wantsClean ? 'clean the dev agenda fixture' : 'seed the dev agenda fixture');

  if (wantsClean) {
    const counts = await clean();
    if (counts.clients === 0) {
      console.log(`Nothing to clean — no client named "${CLIENT_NAME}" exists.`);
      return;
    }
    console.log(`Removed "${CLIENT_NAME}":`, counts);
    return;
  }

  const tenantId = await resolveTenantId();
  // Re-runnable: wipe any previous sandbox before rebuilding it.
  const wiped = await clean();
  if (wiped.clients > 0) console.log('Replaced the previous sandbox:', wiped);

  const ctx = await seed(tenantId);
  const bookings = [...todaysBoard(ctx), ...weekSpread(ctx)];
  for (const b of bookings) await book(ctx, b);

  // The REAL model for a "team meeting" block. The Agenda does not render
  // schedule_exceptions yet (see the TODO in AgendaView), so this will not show on
  // the grid — it is here so the fixture is honest about what the data holds.
  await query(
    `INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason, type)
       VALUES ($1, $2, NULL, $3, $4, $5, 'blocked')`,
    [ctx.tenantId, ctx.siteId, at(ctx, 0, '13:00'), at(ctx, 0, '14:00'), `${MARKER}Team meeting`],
  );

  const todayCount = todaysBoard(ctx).length;
  console.log(
    [
      `Seeded "${CLIENT_NAME}" into tenant ${tenantId}`,
      `  agenda:      /clients/${ctx.clientId}/scheduling/agenda`,
      `  site:        ${MARKER}Sandbox Barbershop (${TZ}, 09:00–19:00)`,
      `  staff:       Daniela, Federico, Paola (working today) + Marco (off today → closed lane)`,
      `  services:    ${Object.keys(ctx.services).length}, spanning every colour family (colour, grooming, cut, feature)`,
      `  appointments: ${todayCount} today + ${weekSpread(ctx).length} across the week`,
      `  closed day:  ${ctx.today.weekday === 'sun' ? 'mon' : 'sun'} (no opening_hours → hatched in week view)`,
      '',
      'Remove it with: npm run seed:agenda-dev:clean',
    ].join('\n'),
  );
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
