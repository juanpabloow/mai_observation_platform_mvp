# Booking page catalog + promotions (migrations 1804, 1805)

**Branch:** `feature/booking-gallery-experience` (from `main` 6c50162)
**Status:** implemented and tested locally against synthetic data. **Nothing has been
migrated, imported or changed in production.** The migration and data plans below
are for review; they need explicit authorization to run.

## 1. What the public page reads, and from where

| Shown on `/book/{slug}` | Source of truth | Edited in |
|---|---|---|
| Service name, duration, price | `services` (+ `site_services` / `staff_services` overrides) | Configuración → Servicios (editor) |
| Group, order, "Recomendado", image, "Qué incluye", better alternative, visible on page | `services.public_*` (1804) | Service editor → "Página de reservas" |
| Groups ("Entre Nubes", "Signature", "Esencial", WhatsApp link) | `booking_categories` (1804) | Servicios → "Página de reservas · Categorías" |
| Address, hours, "Cómo llegar", WhatsApp | `sites.address`, `sites.opening_hours`, `sites.public_maps_url`, `sites.public_whatsapp` | Sedes y horarios → site → "Página de reservas" |
| Artist photo, title, bio | `staff.public_*` (1800) | Equipo |
| Ratings and reviews | `appointment_reviews` (1801), approved only | Reseñas (moderation) |
| Promotions | `promotions` (1805), `published` + on offer | Configuración → Promociones |

Price, duration and availability keep ONE source of truth for the agenda, the page and
the bot: nothing in 1804/1805 stores another copy of them.

## 2. Page visibility is presentation only

`publicServicePredicate()` (publicCatalog.ts) is the single SQL rule: a service is on
the PAGE when `public_visible` and its category (same client) is visible and not a
`contact` group. It is applied to the list, the staff list, the staff's
"Servicios que realiza", `isPublicServiceAtSite()` (booking POST) and — through the
public staff list — availability (409 when no public professional remains).

The agenda (`listServicesForSite`) and the bot (`listBookableServicesForSite`,
`/api/scheduling/v1/services`) never read `public_*`: hiding "Ritual Signature" from the
page leaves it bookable by staff and the bot. Covered by
`test/integration/bookingPageCatalog.test.ts`.

## 3. Price guard

The page sends `expected_price` — the exact price it showed (chosen artist, or the one
price every artist shares for "Sin preferencia"; nothing for a "Desde …" range). The
engine (`createAppointment`, `expectedPrice`) compares it with the effective price at
commit and refuses with `price_changed` **before any write**; the route answers 409
with the current price and the page asks for explicit acceptance. Staff and n8n callers
don't send it and are unaffected.

## 4. Promotions model (1805)

- `promotions` per client: `status` draft → published ⇄ paused → archived (terminal; no
  delete in the app; a promotion referenced by an appointment cannot be deleted —
  `appointments.promotion_id`, NO ACTION).
- `benefit_type`: only defined types. Today `two_for_one`.
- Two windows, never mixed:
  - **A. booking moment** — `bookable_from` / `bookable_until` (vigencia). Outside it the
    promotion is not shown.
  - **B. appointment** — `appointment_weekdays` (ISO 1–7), `appointment_from/until`,
    `appointment_time_from/until`, evaluated in the SITE's timezone.
- `promotion_services`, `promotion_staff` (empty = whoever performs the service), `site_id`
  (null = every site). Same-client checked inside the write transaction.
- `version` — optimistic concurrency; a stale edit is refused (`stale`).
- `promotion_events` — created / updated (changed fields) / published / paused / resumed /
  archived / duplicated, with the actor.
- `appointments.promotion_id` + `promotion_snapshot` (both or neither) — what a booking was
  made with, frozen; editing/pausing/archiving never changes it.

Rules live in `src/scheduling/promotions.ts` (pure): `isOnOffer`, `checkEligibility`,
`appointmentReasons`, `appointmentRuleText`, `publishProblems`, `canMove`. The admin
editor, the repository writes and the booking POST all call them.

### 2×1 universitario — confirmed vs pending

Confirmed (implemented and tested in `test/unit/promotions.test.ts`):
- bookable any day; the APPOINTMENT must be Monday or Tuesday in the site timezone
  (Tuesday 23:30 Bogotá = Wednesday UTC still qualifies; Monday 00:30 UTC = Sunday in
  Bogotá does not);
- the page text is generated: "Disponible para citas los lunes y martes";
- the promotion is shown on a Wednesday;
- an ad link cannot skip anything (there is no "from ad" input; the POST re-validates).

Pending business decisions (`benefitPending('two_for_one')`) — **publishing is refused
until they exist**, and the booking POST refuses every promotion (fail closed):
1. which services exactly;
2. the student requirement and how it is verified;
3. how the two people are identified and booked (an appointment is ONE person, ONE
   artist, ONE service today);
4. simultaneous or consecutive;
5. duration, artists and resources.

### Rescheduling a promotional booking (proposal, not implemented)

When an appointment with `promotion_id` is rescheduled, re-run `appointmentReasons()` for
the new start. If it still qualifies, keep the snapshot. If not, the agenda shows the
reason and the operator chooses explicitly (keep the promotional price as a courtesy, or
reprice at the base price and tell the customer). Never silent.

## 5. Bot (n8n) contract — prepared, NOT wired

No workflow was changed. Proposed additive machine endpoints (capability
`scheduling.read`), both thin wrappers over `src/scheduling/promotions.ts`:

```
GET  /api/scheduling/v1/promotions?site_id=…
  → { promotions: [{ id, name, description, conditions, rule_text, service_ids, benefit: "two_for_one" }] }
     (published + on offer now, services on the page)

POST /api/scheduling/v1/promotions/{id}/check
  { "service_id": "…", "staff_id": "…|null", "start_at": "ISO" }
  → { eligible: false, reasons: [{ code: "weekday", message: "La fecha elegida no aplica para esta promoción." }] }
```

Prompt instruction for the agent: *never* compute promotion rules or prices; list with
the GET, check a concrete slot with the POST, and quote `rule_text` / `message` verbatim.
Booking with a promotion through the machine API is out of scope until the 2×1 booking
rules exist (same fail-closed rule as the page).

## 6. Production migration plan (to run only with authorization)

1. Review this branch's PR; merge only after step 2 is approved.
2. Apply migrations **before** deploying the code (the code reads the new columns):
   `1804000000000_booking-page-catalog`, `1805000000000_promotions`. Both additive;
   DOWN refuses while data exists. Note `1802` (external reviews) is still unmerged on
   `feature/reviews-external-fresha`; node-pg-migrate orders by name, so if 1802 is ever
   merged after 1804/1805 have run it must be applied with `--no-check-order` or
   renumbered — decide before merging either.
3. Deploy. With no categories configured, every booking page looks as before (legacy
   grouping), except: no "Sin reseñas aún", new animations, location block when the site
   has data, the price guard.
4. Data (Gallery) — run `docs/sql/gallery-booking-page-plan.sql`. It is a DRY RUN by
   default (ends in ROLLBACK and prints the before/after); switch to COMMIT only with
   authorization and after the pending values in §7 are confirmed.

## 7. Values that need confirmation before the data plan

- Upgrade pairs: Corte → Corte Signature (+$40.000), Barba → Barba Ritual Signature
  (+$40.000), Corte con barba → Corte con barba Signature (+$50.000). The difference is
  always computed; the PDF's "$40.000 más" is wrong for the last pair.
- WhatsApp: +57 302 227 5653 (from the PDF).
- Address: the PDF says "Calle 77 #13-19"; our synthetic copy says "Calle 77A #13-19".
  Verify the real one before publishing "Cómo llegar".
- Hours: Mon–Sat 10:00–20:00, Sunday closed (PDF) — compare with `sites.opening_hours`.
- Entre Nubes: image, description, "Qué incluye", duration, price — none provided yet; the
  featured group stays hidden until the service is complete.
- Descriptions for services without one: approved text only (the plan lists them).

## 8. Future "Página de reservas" section (not built)

One screen that shows the page as the customer sees it and says where each piece lives:

- **Mobile preview** of the real page (iframe of `/book/{slug}?preview=1` rendered with
  draft values, never indexed).
- **Permissions:** agency or client OWNER edit; editors/staff read the preview only.
- **Draft vs publish:** presentation edits (categories, order, texts, images) go to a
  draft layer and are published together; catalogue facts (price, duration, active,
  sites) and site facts (address, hours) keep saving directly in their own editors,
  because the agenda and the bot use them immediately.
- **What is edited there:** categories, order, badges, images, "Qué incluye", upgrade
  pairs, contact links, promotions' presentation. **What is not:** price, duration,
  availability, artists' schedules, blocks (catalogue / site / team editors).
- Out of scope here and kept separate: recurring blocks and lunch exceptions; custom
  domain and removing "Impulsado por M_AI" (pending decisions; DNS untouched).
