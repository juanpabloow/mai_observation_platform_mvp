# Edit an existing appointment — audit & design (JP-4)

**Status: BUILT (operator's "go" with decisions D1–D6). This is the design of record; the
"Decisions needed" at the end were all answered — see "What was built" below.**

## What was built (JP-4)
- **Migration** `migrations/1824000000000_appointment-edit-events.ts` — reversibly extends the
  `appointment_events.event_type` CHECK with `appointment_service_changed` + `appointment_time_corrected`.
- **Engine** (`src/scheduling/booking.ts`): `changeAppointmentService` (A1) and `correctAppointmentTime`
  (B), plus the `hasRecordedPayment` guard, `EditConflict`, and two new `BookingError`s
  (`service_not_performed`, `payment_recorded`). Repo: `changeServiceColumns`
  (`src/db/repositories/scheduling/appointments.ts`).
- **Actions** (`web/lib/schedulingActions.ts`): `changeAppointmentServiceAction` (D3: a Staff login
  cannot change a completed appointment's service) and `correctAppointmentTimeAction` (a Staff login
  stays on its own column), both gated by `agenda.book`, with the `EDIT_ERROR` copy map.
- **UI**: the shared action plan (`appointmentActionPlan.changeService` / `.correctTime`) → two entry
  points in the `AppointmentCard` «Cita» section → the `ServiceChangeInline` / `TimeCorrectInline`
  panels (desktop `SidePanel`, phone `Sheet`), wired through `AppointmentPanel` + `AgendaView`. The
  activity timeline labels both new events (`web/lib/schedulingActions.ts` → `AppointmentCard`).
- **Tests**: `test/integration/editAppointment.test.ts` (14 cases: fits / overlap / not-performed /
  completed-without-payment / completed+paid-blocked / D3 staff-vs-setter; past & completed time
  correction / overlap / artist-on-unpaid / artist-on-paid-blocked / time-only-on-paid / D2 setter /
  cancelled / permission tiers) and new `appointmentActionPlan` unit assertions.

Decisions as built: **D1** void→change→re-charge for completed+paid; **D2** the Setter may
time-correct completed/paid (time-only; artist still Owner/agency via void→re-charge); **D3** service
change includes completed-without-payment, a Staff login excluded from completed; **D4** extras stay in
checkout; **D5** artist change on a paid appointment goes via void→re-charge; **D6** combos suffice,
line-items deferred.

---

**Original audit + design (for reference):**

Two operator requirements:
- **A. Change the service** of an appointment ("Corte + barba" → "Corte") and **add extras** (e.g. a catalog product) before or while it happens.
- **B. Correct the time** of an appointment even after it has passed (Setter booked 7:00, it really happened at 8:00).

All paths are under the repo root. Line numbers may drift; the function/column names are the stable anchors.

---

## 0. Audit (current state — report only)

### 0.1 The appointment today
- **Exactly one service, one staff, a frozen price.** `appointments.service_id uuid NOT NULL`, `staff_id uuid NOT NULL`, and the booking-time SNAPSHOTS `service_name_snapshot`, `duration_min_snapshot`, `price_snapshot numeric(10,2) NULLABLE`, `buffer_before_min_snapshot`, `buffer_after_min_snapshot`, plus `start_at` / `service_end_at` / `blocked_from` / `blocked_until` (`migrations/1782000000002_appointments.ts`). There is **no `appointment_services` line-item table** — "Corte + barba" is modelled as ONE combined service row.
- **The ONLY `UPDATE appointments` paths** (grep-verified): `status`/`version` via the state machine (`transitionStatus`), `staff_id`/`start_at`/`service_end_at`/`blocked_*` via `rescheduleAppointment` → `moveInterval`, `opportunity_id` via the pipeline link, `contact_id` via contact-merge. **Nothing updates `service_id`, the snapshots, or `price_snapshot`.**
- **`completed` is terminal.** `LEGAL_STATUS` (`src/scheduling/booking.ts:712`): `completed: []`, `cancelled: []`, `no_show: []`. `rescheduleAppointment` refuses a `TERMINAL` status (`booking.ts:852` → `invalid`).
- **Reschedule refuses past times.** It re-validates through the availability engine (`isSlotAvailable` → `computeAvailability`), which applies `min_notice_min` and `booking_horizon_days`, so a past `start_at` is not a valid slot → `unavailable`. Reschedule also keeps the **same `service_id`** (it only moves staff/start) and uses the **snapshot** timing (a later catalogue edit never reshapes a booking).
- **A past attendance already has a CREATE path.** `planPastAttendance` + `checkPastInterval` (`src/scheduling/pastAttendance.ts`) register a walk-in that ALREADY happened — it validates the past interval against site/staff hours, breaks and closures and refuses an overlap with the same staff, and bypasses lead-time. This is the pattern to reuse for B (but it is CREATE-only today).
- **Payments at completion (PY-1/PY-2).** `payments` + `payment_lines` (service line + product lines) are written at completion, each line snapshotting `name` / `unit price` / `quantity` / `commission_pct` / `commission_amount`. One `recorded` payment per appointment (partial unique index); a mistake is **voided**, never deleted; `payments.appointment_id` is `NOT NULL` with **ON DELETE NO ACTION** (JP/FIX-1). The paid pipeline stage advances on a recorded payment.
- **Value dashboard.** "Valor" = `SUM(appointments.price_snapshot)` WHERE `status='completed'`, bucketed by the **local day of `start_at`** (`valueDashboardSql.ts` Q4bd and friends). It never joins payments. So changing `price_snapshot` changes the valor; changing `start_at` across a day boundary moves the row to a different day bucket.
- **Audit + events.** `appointment_events` (`event_type` is **CHECK-constrained** to: `appointment_created`, `appointment_rescheduled`, `appointment_cancelled`, `appointment_confirmed`, `appointment_completed`, `appointment_no_show`, `manual_note`, `mode_changed`, `escalation`; `actor_type` ∈ system/agent/public/n8n). A new event type is a migration (extend the CHECK). `recordSchedulingEvent` (`events.ts`) is the AGENDA's realtime-poll feed, written post-commit on create/status/reschedule.
- **Notifications.** The platform sends **no customer message** on a reschedule or any status change — `recordSchedulingEvent` only feeds the operator's agenda poll; the bot messages only inside a conversation. So an agenda-driven change is already notification-free; "a reschedule triggers a customer notification" is **not true today**.
- **Permissions.** Reschedule/complete gate on `agenda.book` via `gateAppointment` (`schedulingActions.ts`) = agency, Client Owner, Setter, and a Staff login **on its own column only**. `payments.void` is agency + Client Owner. `commissions.view` / `payments.settings` gate commission read/edit.
- **Bot `ver_mis_citas`.** Reads the live appointment (`service_name_snapshot`, `start_at`, `staff`). No second copy of those values exists, so a service/time change is reflected immediately.

### 0.2 What blocks requirement A (change service + extras)
1. **No update path for `service_id` / snapshots / `price_snapshot`** — it is entirely new code.
2. **A new service has a different duration** → the new `[start − buffer_before, start + duration + buffer_after)` must be re-validated against the same staff from the same start; a longer service may now overlap the next booking.
3. **Completed is terminal + has a recorded payment** → changing the service silently would desync `payment_lines` (name/price/commission) and the paid stage from the appointment. Must be handled explicitly.
4. **Extras**: products are ALREADY addable in the PY-2 checkout step (`ChargePanel`); there is no "attach an extra ahead of time" concept, and a SECOND billable service has no home (no line items).

### 0.3 What blocks requirement B (time correction, incl. past/completed)
1. **`rescheduleAppointment` refuses TERMINAL** → cannot touch a completed appointment.
2. **The engine refuses past `start_at`** (min-notice/horizon) → cannot move to a time that has passed.
3. Reschedule applies booking-window/lead-time/availability-hours rules a *correction* must NOT apply (it is recording what happened, not offering a new slot).

### 0.4 Downstream effects (both requirements)
| Area | Service change (A) | Time correction (B) |
|---|---|---|
| **Pipeline** | No status change → stages unchanged. (Completion/paid are driven by status + payments, not service.) | **Unchanged** — a time move never changes status, so attended/won/paid are untouched. |
| **Attribution** | Unaffected (touches live on the contact, not the appointment's service/time). | Unaffected. |
| **Payments / commissions** | Pre-completion: no payment yet → safe. Post-completion (recorded payment): `payment_lines` snapshot the OLD service/price/commission → desync → must void+recharge or block. | Lines snapshot **amounts, not time** → a time move keeps payments/commissions consistent. |
| **Value dashboard** | `price_snapshot` changes → the completed "valor" changes (the intended correction). | `start_at` day-bucket changes → the valor moves to the corrected day (the intended correction). |
| **Reviews** | `ensureReviewRequest` keys on completion, not service → unaffected. | Unaffected (completion unchanged). |
| **`ver_mis_citas`** | Reflects the new `service_name_snapshot` live. | Reflects the corrected `start_at` live. |
| **Scheduling events / inbox strip** | Add an `appointment_service_changed` event → shows in the thread + agenda feed. | Add an `appointment_time_corrected` event. Must NOT read as a customer-facing reschedule. |

---

## 1. Design to propose (with trade-offs)

### A1 — Change the service
- **Allowed for `scheduled` / `confirmed`** (an "in-progress" appointment is a `confirmed` one whose start has passed — same gate). A new engine function `changeAppointmentService(appointmentId, newServiceId, { keepStart })` + action:
  - Resolves the NEW service's duration/buffers/price for the SAME staff (`resolveEffectivePrice` + timing), recomputes `service_end_at` / `blocked_until`, and re-validates the interval with `isSlotAvailable` **excluding this appointment itself** and from the SAME `start_at`.
  - **Fits** → update `service_id` + the four snapshots + `price_snapshot` + end/blocked columns; write `appointment_service_changed` {from, to, actor}. 
  - **Doesn't fit** (the longer service overlaps the next booking) → refuse with the conflicting appointment **named**, and let the UI offer "keep the start and resolve the conflict" (move/cancel the other) or "pick a new time" (a normal reschedule). *We do NOT silently shorten or auto-move.*
- **Completed WITH a recorded payment** → the service cannot change silently (it would desync the payment + the paid stage). **Recommended flow:** block the change with a clear message and require **void the payment first** (the existing PY-2 void → `pending` → re-charge with the new service keeps full history and keeps `payment_lines`/commissions/paid-stage consistent). Rejected alternative: an in-place "correction" that rewrites the recorded payment — it hides money history, which PY-1/PY-2 deliberately never do.
- **Completed WITHOUT a payment** → allow; update `price_snapshot` so the value dashboard reflects the corrected service. (Decision D3 below: is this in scope, or only non-completed?)

### A2 — Extras before checkout (recommendation)
- **Products: recommend option (1) — the existing checkout.** Products are already added in the PY-2 `ChargePanel` with quantity + per-line price/commission. "Attach extras ahead of time that prefill the checkout" (option 2) is a nice-to-have that adds a pre-checkout `appointment_extras` store purely to pre-fill a step that already works — **not worth it now**. If the operator wants the barber to tick extras during the service (before the cashier opens checkout), that is a small additive table; otherwise skip it.
- **A second billable SERVICE (corte + cejas as two services): recommend a COMBO service for now, NOT line items.** A true second service needs `appointment_services` line items, which ripples through availability (two durations), the snapshots, payments and the dashboard. The current one-service + combined-service model already expresses "corte + cejas" as one catalogue entry with its own duration + price. **Recommendation: keep combos; defer appointment line-items** unless multi-artist-per-appointment or per-sub-service commission becomes a hard requirement.

### B — Time correction (a CORRECTION, not a reschedule)
- A new engine function `correctAppointmentTime(appointmentId, { startAt, staffId?, reason? })` + action, distinct from reschedule:
  - **Allowed on any status including `completed` and on past times.** No booking-window, no lead-time, no availability-hours rule (it records what happened — the `planPastAttendance`/`checkPastInterval` validation style, not `computeAvailability`).
  - **The one hard rule:** the corrected `[blocked_from, blocked_until)` must not overlap another **active** appointment of the same staff — reuse `listStaffAppointmentsOverlapping` (and the DB GiST exclusion as the belt), **excluding this appointment**. Refuse with the conflicting appointment named.
  - Recompute `service_end_at` / `blocked_*` from the appointment's **snapshot** duration (never the live catalogue).
  - **Optional staff correction (recommend: YES).** "It was actually done by Paola" is a real case; allow `staffId`, with the overlap check run against the NEW staff. Low extra cost, high value.
  - **No customer notification** (the platform sends none anyway). Emits `appointment_time_corrected` {from, to, reason?, actor} — a DISTINCT event type from `appointment_rescheduled`, so the agenda shows it as a correction and any future notification wiring can skip it.
  - **Pipeline stages unchanged** (no status change). The value dashboard reflects the corrected day because it buckets by `start_at`.

### Permissions (proposed)
| Action | Agency | Client Owner | Setter | Staff (own column) |
|---|---|---|---|---|
| Change service (non-completed) | ✓ | ✓ | ✓ | ✓ |
| Change service (completed, **no** payment) | ✓ | ✓ | ✓ | — |
| Change service (completed, **with** payment) | via void+recharge (✓) | via void+recharge (✓) | — | — |
| Time correction (non-completed) | ✓ | ✓ | ✓ | ✓ |
| Time correction (completed / with payment) | ✓ | ✓ | **D2** | — |

Rationale: corrections that touch a recorded payment's appointment align with the `payments.void` tier (agency + Client Owner). Whether the **Setter** may time-correct a completed/paid appointment is **Decision D2**.

### Effects / invariants to uphold (no new work needed, but stated)
- Value dashboard + reports read `price_snapshot` by `start_at` day → a service or time correction is reflected automatically; **no dashboard code changes**.
- Payments/commissions stay consistent because time never touches them and a post-payment service change goes through void+recharge.
- Pipeline stages are never moved by a time correction.
- Every edit writes an audit event (from → to, actor, when, optional reason) visible on the appointment and the inbox thread.

### Migration + rollout
- One reversible migration: extend the `appointment_events.event_type` CHECK with `appointment_service_changed` + `appointment_time_corrected`. (If A2 option 2 or line-items are chosen, that is additional schema — out of scope unless selected.) Numbered per the branch rules (> the latest on `origin/main` at build time), run through the dashboard pre-deploy with CI green.

---

## 2. Decisions needed from the operator (before building)

- **D1 — Completed + recorded payment service change:** confirm the **void → change → re-charge** flow (keeps money history) rather than an in-place payment rewrite. *(Recommended: void+recharge.)*
- **D2 — Who may time-correct a completed / paid appointment:** **Client Owner + agency only**, or **also the Setter**? *(Recommended: Owner + agency; Setter for non-completed only.)*
- **D3 — Scope of the service change:** only `scheduled`/`confirmed`, or also `completed` without a payment (updating historical valor)? *(Recommended: include completed-without-payment.)*
- **D4 — Extras:** ship **nothing new** (products via the existing checkout + combos for a second service), or also build **pre-attached extras** that prefill checkout? *(Recommended: nothing new now.)*
- **D5 — Staff correction in B:** allow correcting the artist too? *(Recommended: yes.)*
- **D6 — Second billable service:** confirm **combo service** suffices for now and appointment line-items are deferred. *(Recommended: defer line-items.)*
