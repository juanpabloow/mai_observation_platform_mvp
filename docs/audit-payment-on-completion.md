# Audit — payment capture on "mark as completed" (report only)

**Goal.** Let the operator record a payment *without* a separate checkout: when the Setter changes an
appointment to **completada**, that same step asks for the payment method and any extra catalog products
bought, and records the payment. This document reports the exact current state (what the **code does**,
with file paths + function names) and proposes a design. **No code was changed; only this file was added.**

Date: 2026-10-22. All paths are under the repo root. Line numbers are from the audited revision and may
drift; the function/const names are the stable anchors.

---

## A. Appointment status changes today

### A.1 Every UI surface that can change a status

There is **one** appointment-detail object (opened from the agenda), rendered two ways by viewport, plus a
cancel-only control on the contact record. Every write goes through five server actions in
`web/lib/schedulingActions.ts`.

| Surface | File | Controls / flow |
|---|---|---|
| Desktop/tablet detail panel | `web/components/scheduling/agenda/AppointmentPanel.tsx` | Header **"Cambiar estado"** menu (`confirmed` fires immediately; `cancelled`/`no_show` open the in-panel `ConfirmDialog`); footer **"Completar cita"** → `onStatus("completed")` directly (no confirm, no input); **"Cambiar fecha y hora"** → `RescheduleFlow`. Offered transitions come from `appointmentActionPlan(...)`. |
| Phone bottom sheet | `web/components/scheduling/mobile/MobileAppointmentSheet.tsx` | Detail footer primary (`Confirmar`/`Completar`) → `onStatus(primary.target)`; **"Más acciones"** → status sheet (`role=radiogroup`); **cancel sheet** (reason chips + optional textarea); **no_show sheet** (bare confirm). |
| Wiring | `web/components/scheduling/AgendaView.tsx` | `onStatus(target, reason?)` (≈L1825–1837) routes to the server actions via `run(...)` (`startTransition` + error/notice + `router.refresh()`). |
| Reschedule (time/staff, **not** a status) | `web/components/scheduling/agenda/RescheduleFlow.tsx` | Two-step time/staff picker → `rescheduleAppointmentAction`. |
| Contact record | `web/components/contacts/shared/AppointmentsSection.tsx` | **Cancel** only — `cancelAppointmentAction(clientId, appt.id)` directly (no reason, no confirm). Reschedule is a deep-link into the agenda. |
| Read-only | `web/components/scheduling/agenda/AppointmentPreview.tsx` (hover), `web/components/scheduling/mobile/MobileAgenda.tsx` (list + status *filter*) | Show a `StatusChip`/filter only; no writes. |

**Server actions** (`web/lib/schedulingActions.ts`): `cancelAppointmentAction` (L267), `confirmAppointmentAction`
(L271), `completeAppointmentAction` (L275), `noShowAppointmentAction` (L279), `rescheduleAppointmentAction`
(L283) → private `transition(...)` (L243–265) → `gateAppointment` (L66–81) → `transitionStatus` in
`src/scheduling/booking.js` → `revalidatePath`. **There is no bulk status action anywhere** (verified).

### A.2 Statuses + transition map

Vocabulary (`web/components/scheduling/agenda/status.ts` L10–18): `scheduled` ("Sin confirmar"),
`confirmed` ("Confirmada"), `completed` ("Completada"), `cancelled` ("Cancelada"), `no_show` ("Inasistencia").

Transition map `NEXT_STATUSES` (status.ts L26–32), mirrored server-side by `LEGAL_STATUS` in
`src/scheduling/booking.ts` L503–509 (the server is the real gate):

```
scheduled → confirmed, completed, no_show, cancelled
confirmed → completed, no_show, cancelled
completed → (none)   cancelled → (none)   no_show → (none)
```

`DESTRUCTIVE = {cancelled, no_show}` (status.ts L35). `appointmentActionPlan(...)`
(`web/lib/appointmentActionPlan.ts` L37–51) splits the legal transitions into `stateMenu` (minus complete),
`complete` (footer primary), and the phone `primary`.

**Transitions that ask for extra input today — the pattern to reuse:**
- **Cancel** takes an *optional* reason. Desktop shell = `ConfirmDialog` (`web/components/ui/controls.tsx`
  L272–325, re-exported via `web/components/scheduling/ui/system.tsx`): `role="alertdialog"`, `aria-modal`,
  `aria-labelledby/-describedby`, a `{children}` slot (the reason `<textarea maxLength=500>` goes here), and
  a footer with a `data-autofocus` safe button + a `loading`-aware confirm button. Focus trap/inert via
  `useModalLayer(open, fallback)` (controls.tsx L250–265); Escape peels layers (`useTrappedPanel`). Phone
  equivalent = `MConfirm` in a `<Sheet alert>` (`mobile/kit.tsx` L495–508) with preset reason pills.
- **No-show** = bare confirm (no input). **Confirm / complete** = no input and no confirmation at all.
- **Reschedule** = a dedicated time/staff picker (`RescheduleFlow.tsx`), not a confirm dialog.

**Important for a future payment step:** the cancel reason is *optional* — **there is no existing example of a
required field** in `ConfirmDialog` (the confirm button is never disabled for a missing reason; an empty
reason is normalized to `undefined`). A "reason required when charging less" rule would be a new `disabled`
guard on the confirm button, added for the first time.

### A.3 Server path (`src/scheduling/booking.ts` `transitionStatus`, L531)

One `withTransaction`: fail-closed `scopeClientId` check → `getAppointmentForUpdate` (FOR UPDATE row lock) →
cross-client guard (`not_found`) → `isSchedulingEnabledForUpdate` module gate → `LEGAL_STATUS` state-machine
check (`invalid_transition`) → `setStatus` (`UPDATE … status, version = version+1`) → `recordAppointmentEvent`
(immutable `appointment_events` audit row with `actor_type`/`actor_user_id`/`detail:{from,to,reason}`).
`ActorType = 'system'|'agent'|'public'|'n8n'`; the UI passes `agent` + `userId`, the machine routes pass `n8n`.

**Post-commit, exactly two hooks** (nothing else is wired into status change):
1. `recordSchedulingEvent(...)` (`src/db/repositories/scheduling/events.ts`) — realtime feed row for the agenda
   poll. **Not** swallowed (an error here throws post-commit; it cannot roll back the committed status).
2. `pipelineOnAppointmentStatusChanged(...)` (`src/pipeline/hooks.ts` L31–37) — **fail-safe** (try/catch →
   `recordPipelineFailure`; a pipeline error never fails the status change). It calls
   `engine.onAppointmentStatusChanged` (`src/pipeline/engine.ts` L324–364):
   - `completed` → opportunity `stage='attended', attended_at=now(), status='won', closed_at=now()` + event
     `appointment_completed` (L335–343). **This is the only thing completion does to money/pipeline.**
   - `no_show` → `status='lost', lost_reason='no_asistio'`. `cancelled` → revert `booked→qualified` only if no
     other active appointment. `confirmed` → untouched.

**No attribution, value-dashboard, reviews, or messaging hook fires on a status change** (verified). Review
requests are created lazily and only for already-`completed` appointments (`ensureReviewRequest`).

**Undo / change-after-completion:** impossible via the engine — `LEGAL_STATUS['completed'] = []`, so
re-complete / un-complete / cancel-a-completed all return `invalid_transition`; reschedule refuses terminal
states too. Defense in depth: `onAppointmentStatusChanged` early-returns when `opp.status !== 'open'`
(engine.ts L333), so a won opportunity can never be re-won or reverted.

### A.4 Who can change status, per role

Gate chain (`web/lib/schedulingActions.ts` `gate`+`gateAppointment` L59–81 → predicates in `web/lib/access.ts`):
`canOperateScheduling` (access.ts L166–168) = `hasFullAccess(scope) || scope.clientRole !== null` → agency
**and** every client role (owner/setter/staff). Then `gateAppointment` also requires the appointment to belong
to the contextual client, `canAccessSchedulingSite`, and `canAccessSchedulingStaff` (access.ts L181–184: a
`staff` login may act **only** on `schedulingStaffId === appointment.staff_id`).

| Role | May change status? |
|---|---|
| Agency (owner/admin) | Any appointment of any client in the tenant (scoped by `scopeClientId`). |
| Client Owner | Any appointment of their client. |
| Setter | Any appointment of their client (not pinned to a column). |
| **Staff (barber)** | **Only their own column** (`staff_id === schedulingStaffId`), at their own site. |

**A Staff login CAN mark its own appointment `completed` — YES.** It passes `canOperateScheduling`
(`clientRole !== null`) and `canAccessSchedulingStaff` for its own `staff_id`; `completeAppointmentAction`
then runs `transitionStatus("completed", …)`. (`web/lib/access.ts:181-184` + the gate at
`web/lib/schedulingActions.ts:76`.) A Staff marking *another* staff's appointment is refused. **Consequence
for the payment step: a person who can complete an appointment (Staff) may be someone who should not record
money — the step must handle "complete without charge".**

### A.5 Price, services-per-appointment, staff link

- **Price** = `appointments.price_snapshot numeric(10,2)` **NULLABLE** (`migrations/1782000000002_appointments.ts:60`;
  TS `price_snapshot: string | null`). It is a **frozen snapshot** copied at booking from the effective price
  `resolveEffectivePrice` = `COALESCE(staff_services.price_override, site_services.price_override, services.price)`
  (`src/db/repositories/scheduling/availabilityData.ts` L99–126; written in `booking.ts` createAppointment
  ≈L215). There is **no plain `price` column** on appointments; later catalogue edits never revalue a past row.
- **Services per appointment = EXACTLY ONE.** `service_id uuid NOT NULL` + single `service_name_snapshot` /
  `duration_min_snapshot` / `price_snapshot` / buffer snapshots (appointments migration L51, L58–62). There is
  **no `appointment_services`/line-item join table**. "Corte + barba" is modeled as **one combined service row**
  in the services catalogue (its own duration + price), booked as one appointment; two distinct billable
  services would be two separate appointments.
- **Staff = EXACTLY ONE, required.** `staff_id uuid NOT NULL` (appointments migration L50); the anti-double-book
  GiST exclusion is keyed on `staff_id`.

### A.6 Can a completed appointment be edited later?

No. `completed` is terminal (empty legal-transition list), reschedule refuses terminal states, and
`price_snapshot` / `service_id` / the snapshots have **no UPDATE path anywhere** (grep of `UPDATE appointments
SET` found only `status/version` via the guarded state machine, `staff_id/start_at` via reschedule,
`opportunity_id` via the pipeline link, and `contact_id` via contact-merge). There is no "locked" flag — the
lock is behavioral (terminal state + absence of edit code) plus optimistic `version` and the immutable
`appointment_events` audit. Nothing is hard-deleted (cancel is a status change).

---

## B. The catalog today

### B.1 Data model + screens

**Table `products`** (`migrations/1798000000001_products.ts` L34–60; repo
`src/db/repositories/catalog/products.ts`): `id`, `tenant_id`, `client_id`, `name text NOT NULL` (non-blank;
app cap 200 in `web/lib/catalogValidation.ts`), `description text` (≤500), `price numeric(10,2) NOT NULL
CHECK (price > 0)`, `category text` (free text, nullable — no category table), `in_stock boolean DEFAULT true`
(manual "disponible/agotado" switch — **not a quantity**), `is_active boolean DEFAULT true` (archive flag),
`sort_order integer DEFAULT 0`, timestamps. Partial unique index on `(tenant_id, client_id, lower(btrim(name)))
WHERE is_active`. **No image column.** Price is returned from pg as a **string** (`"35000.00"`).

Screens where products appear:
- **Admin catalog** — `web/app/clients/[clientId]/catalog/page.tsx` → `web/components/catalog/CatalogPanel.tsx`:
  a management list with a **name search box**, a **category `<select>` filter**, an inline **availability toggle**
  (Disponible/Agotado, via `setProductStockAction`), and a create/edit **modal** (name, price, category with a
  `<datalist>`, availability checkbox, description). **No image upload, no reorder control** (`sort_order` is
  never set by the UI → always 0 → effectively alphabetical).
- **Bot/machine API (read-only)** — `web/app/api/catalog/v1/products/route.ts` (`catalog.read`): returns active
  products (out-of-stock included with `in_stock=false`), `q=` name match + `category=` filter, capped 200.
- **Booking page: products do NOT appear** (customers never see products on any first-party surface).

Permissions (`web/lib/access.ts`): `canReadCatalog` includes the **Setter** (who can also toggle `in_stock`);
`canManageCatalog` = **agency or client owner** (create/edit/archive/price). Money shown via `priceLabelCOP`.

### B.2 Gaps a counter product-picker would hit

Scoped to a quick "extra products bought + quantity" step (no POS exists at all today):
- **No lightweight picker component** — search/category exist only inside the full management list and the bot
  API, not as a tap-to-add selector.
- **No quantity concept anywhere** — no qty column, no cart, no line items. Quantity would be entirely new
  (and belongs on the payment line, **not** on the product).
- **Out-of-stock is a manual boolean** — nothing blocks selling an `in_stock=false` product; the step must
  decide whether to show/warn/allow (recommended: show + allow, since there is no stock tracking).
- **No stock decrement** — a sale would not alter any product row (confirmed).
- **Mobile primitives are touch-friendly** (44px targets, bottom-sheet modal) but wrapped in an editing list,
  not a sale builder.

---

## C. What exists for payments and money

### C.1 Payment / cash / commission fields

**None.** There is **no payments/cash/transactions/invoices/commissions/payouts table**, and **no
commission %, payout, salary, or tip field** anywhere (staff projection `STAFF_COLS`/`STAFF_PII_COLS` in
`src/db/repositories/scheduling/staff.ts` carry no money column). The only money columns are **list-price**
`numeric(10,2)` fields: `services.price`, `site_services.price_override`, `staff_services.price_override`,
`appointments.price_snapshot`, `products.price`, and `value_estimate_assumptions.costo_hora`. The agenda
`revenue` KPI (`agenda/page.tsx` ≈L189) and the contact "Valor del cliente" card
(`getContactValueProfile`, appointments.ts ≈L629) are both **derived sums of `price_snapshot`** — list price,
never money collected.

### C.2 PL-1 `paid`

`opportunities.stage` CHECK already includes `'paid'`, and `paid_at timestamptz` exists
(`migrations/1815000000000_sales-pipeline.ts` L39/L45), but **no code writes them** — completion writes
`attended`/`won`/`closed` only (`src/pipeline/engine.ts` L335–343). The migration header reserves them for "a
later payments phase … matching the value dashboard's 'valor ≠ cobrado' rule." The `'paid'` stage + `paid_at`
are a ready, unwired slot.

### C.3 Value dashboard — how "valor" reads completed appointments

The dashboard's "valor" is **exclusively `SUM(appointments.price_snapshot)`**, from the `appointments` table,
with **no join to any payment record**. The completed slice is `Q4bd` (`src/db/repositories/valueDashboardSql.ts`
L470–479): `sum(price_snapshot) AS valor … WHERE … status = 'completed' AND origin IN ('n8n','public')`,
bucketed by local day of `start_at AT TIME ZONE :tz`. `Q4b`/`Q7`/cohort queries likewise sum `price_snapshot`,
filter by `status`, and bucket by `start_at`/`created_at`. A NULL price is "unknown", counted via `con_precio`/
`sin_precio`, never 0. The code comments state **"Completado ≠ cobrado (no hay pagos)."**

**To leave the dashboard neither changed nor double-counted, a payment record must:** (1) never write
`appointments.price_snapshot` (nor the override chain feeding it); (2) store the collected amount in its own
table/column that **no `VALUE_DASHBOARD_SQL` query references**; (3) never change appointment `status`
(the `status='completed'` filter defines the valor population). "Cobrado" is a new, separate measure from
list-price "valor".

### C.4 Money helper + numeric representation

`priceLabelCOP(raw)` in `web/lib/money.ts` is the **single** money formatter (display only; no parser/arith).
Amounts are stored as Postgres `numeric(10,2)` and surface in app code as a **string decimal** (`"35000.00"`,
two decimal places — **not** integer minor units). Display is COP with `.` thousands separators (`"$35.000"`,
comma decimals only when cents exist). Any new amount should reuse this representation and helper.

---

## D. Proposal (design, not code)

### D.1 Where it lives — fold a payment sub-step into "Completar cita"

Reuse the existing `ConfirmDialog` shell (`web/components/ui/controls.tsx`) on desktop and the `<Sheet alert>`/
`MConfirm` on phone — the same focus-trap/inert/`data-autofocus` pattern the cancel-reason step already uses.
Today "Completar cita" calls `onStatus("completed")` with **no** step; the change is to make completion open a
dialog first (only where money may be recorded — see D.2), then call completion. The dialog content:

- **Amount charged** — prefilled from `price_snapshot` (COP via `priceLabelCOP`; reuse the string-decimal
  representation). If `price_snapshot IS NULL` (unknown price) the field starts empty and is required. **A reason
  is required when the amount is *less* than the prefilled service price** — this is the first required field in
  a confirm dialog (add a `disabled` guard on the confirm button; no existing example).
- **Payment method** — a per-business configurable list (seed: efectivo, tarjeta, Nequi, Daviplata,
  transferencia, Bre-B). Store the chosen method as a snapshot string on the payment.
- **Extra products** — an optional lightweight picker (D.6) with a **quantity** stepper; each becomes a payment
  line (product, qty, unit price snapshot, line total). Out-of-stock products are shown and sellable (no stock
  model).
- **Computed total** = service line + Σ product lines, shown live.

On save: write the payment (+ lines) **and** run the existing completion transition, so the appointment becomes
`completed` and the opportunity `attended/won` exactly as today — the payment is additive.

### D.2 When the person completing cannot record money

Staff can complete their own appointment (A.4) but should not record money. Options: (a) block Staff from
completing (rejected — they legitimately close their own column); (b) let Staff complete but **skip** the
payment sub-step. **Recommendation: "completar sin cobro".** Staff (and anyone lacking the record-payment right)
gets completion with **no** payment dialog; the appointment completes and a **pending payment** is created
(`status='pending'`), surfaced in a visible **"pendientes de cobro"** queue for the Setter/Owner to settle
later. Roles allowed to record money see the full dialog. This keeps completion unblocked while never forcing a
barber to handle cash figures.

### D.3 Correcting a mistake after saving (nothing hard-deleted)

Payments are **append-only + void**, mirroring the `appointment_events` immutability model. A wrong payment is
**voided** (`status='voided'`, with `voided_by`, `voided_at`, `void_reason`) and, if needed, a **new** payment
is recorded that supersedes it; history is kept. **Voiding/correcting belongs to the Client Owner and agency**;
the **Setter can record** a payment for the appointment they complete but **cannot void or edit** one. A small
`payment_events` audit (or reuse of a generic activity log) records capture/void with actor + reason.

### D.4 Data-model options

**Option 1 — `payments` + `payment_lines` (RECOMMENDED).**
- `payments`: `id`, `tenant_id`, `client_id`, `appointment_id` (nullable for non-appointment sales later),
  `opportunity_id` (link to the won sale, for pipeline + ROI), `method` (snapshot text), `status`
  (`active`/`pending`/`voided`), `collected_by_user_id`, `source` (`manual`/`pos`), `total numeric(12,2)`,
  `created_at`, void fields. Totals are derivable from lines but stored for fast reads.
- `payment_lines`: `id`, `payment_id`, `kind` (`service`/`product`), `ref_id` (service_id/product_id),
  `name_snapshot`, `unit_price_snapshot numeric(10,2)`, `quantity integer`, `line_total numeric(12,2)`,
  **`staff_id`** (who performed/sold the line) + **`commission_pct_snapshot numeric(5,2)` NULLABLE** (frozen at
  capture when a per-artist % is configured; null until commissions ship).
- Trade-offs: more tables and join work; but it is the only shape that represents **multiple product lines with
  quantity**, **per-line per-artist commission snapshots**, and a clean **POS import** target
  (`source='pos'`), and it keeps all collected money **off** `price_snapshot`/appointment `status` so the value
  dashboard (C.3) is untouched.

**Option 2 — a few columns on `appointments`** (e.g. `paid_amount`, `payment_method`, `paid_at`).
- Trade-offs: simplest to add; but an appointment holds **exactly one service** (A.5) and has **no line
  concept**, so it cannot represent extra products with quantities or per-line commission; it also puts money on
  the very row whose `price_snapshot`/`status` the dashboard sums (C.3), inviting accidental double-counting;
  and it offers no natural void/history or POS-import seam. Rejected.

**Recommendation: Option 1.** Main reason: **per-artist commission and product quantities are inherently
line-level**, and a separate payments store keeps "cobrado" fully isolated from the list-price "valor" the
dashboard computes from `price_snapshot` — neither of which Option 2 can do.

### D.5 Pipeline / attribution / value dashboard

- **Pipeline:** on a settled (`active`, fully-paid) payment, advance the won opportunity to the reserved slot —
  `stage='paid'`, `paid_at=now()` (C.2) — leaving `status='won'`. This is additive and idempotent (guard on the
  already-`paid` stage). A pending payment does **not** move the stage.
- **Attribution / ROI per ad:** unchanged now. Later, ROI = join `payments → opportunity_id →
  opportunities.origin_touch_id → ads`, so spend vs collected is computable without touching attribution writes.
- **Value dashboard:** unaffected — it keeps summing `price_snapshot` by `status='completed'` (C.3). "Cobrado"
  becomes a new, separately-gated measure; the two numbers (`valor` vs `cobrado`) stay distinct by design.

### D.6 Smallest catalog improvements the step needs

Only a **read-side product picker**: a compact component that calls the existing `listActiveProducts`
(name search + `category` filter already exist in the repo) with tap-to-add + a **quantity** stepper. **No
products schema change** — quantity lives on `payment_lines`. Show out-of-stock products (sellable; no stock
model). Optional later polish: actually populate `sort_order` so a counter can surface top sellers.

### D.7 Permissions — enforceable server-side?

**Yes, with the current `AccessScope`/`clientRole` model** (`web/lib/access.ts`). Add predicates alongside the
existing scheduling/catalog ones:
- `canRecordPayment` = `hasFullAccess || clientRole ∈ {owner, setter}` (Staff → "completar sin cobro").
- `canVoidPayment` / `canSeeRevenue` = `hasFullAccess || clientRole === 'owner'` — the **Setter must never see
  revenue totals, reports, or commissions, and cannot void/correct**.
- A new payment server action gates on `canRecordPayment` the same way `transition(...)` gates on
  `canOperateScheduling` + the own-column rule; totals/commission pages gate on `canSeeRevenue`.

**Risk to flag:** the agenda already shows a `revenue` KPI tile (sum of `price_snapshot`). Confirm whether a
Setter currently sees it; the new "cobrado"/commission figures must be gated to owner/agency so recording
payments does not expose revenue to the Setter.

### D.8 Phased plan

**Phase 1 (MVP, recommended first):** `payments` + `payment_lines` tables; a per-business `payment_methods`
config (seed efectivo/tarjeta/Nequi/Daviplata/transferencia/Bre-B); fold the payment sub-step into "Completar
cita" (amount prefilled from `price_snapshot`, reason-required-when-less, method, optional product lines with
qty, live total); write `opportunities.paid_at` + `stage='paid'` on full payment; Setter can capture, Staff
"completar sin cobro" → `pending` + a "pendientes de cobro" queue; Owner/agency void+correct; gate
revenue/cobrado views to owner/agency. Snapshot `commission_pct` on each line if configured, else null.

**Phase 2 (later):** commission configuration UI + payout/commission reports (owner/agency); ROI-per-ad using
payments; POS import adapter (`source='pos'`); partial/split payments and refunds.

**Risks:** (1) Staff completing without charge builds a pending-payment backlog → the "pendientes de cobro"
queue is the mitigation. (2) `price_snapshot` is nullable (unknown price) → amount can't always prefill; the
field must be required then. (3) One service per appointment means service-level commission is per **combined**
service, not per sub-service (corte vs barba) — acceptable, but note it for commission design. (4) Keep "valor"
= `price_snapshot` and "cobrado" = payments strictly separate to avoid double-counting in any future report.
