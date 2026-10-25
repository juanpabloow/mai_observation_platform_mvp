# Integration audit — 2026-10-24 (before PY-2)

Report only. No code was changed, refactored or "tidied"; the only file added is this report.
Audited at `main` = **84fc737** (after a clean fast-forward from 4c97faa).

> **Headline:** PY-2 (the payment step inside the agenda) is **already implemented and merged** on main
> — commit `e335ad8 feat(pagos): PY-2 — el cobro dentro de «Completar cita», cobros pendientes y
> anulación` (VanegasMora), built **on top of PY-1's engine** (it calls `completeWithPayment` /
> `recordPaymentForCompleted` / `voidPayment`, preserves PY-1's atomic `within` hook, and **hardens**
> the permission gating). So the task premise "before PY-2 / start PY-2" is moot: PY-2 is here and
> green. See §3 (agenda) and §5.

---

## 0. Safe pull

- Working tree had **no uncommitted tracked changes** (`git status --porcelain=v1 -uno` empty). Untracked
  files were only the known sensitive ones (`WhatsApp_*`, `docs/prompts/`, `gallery_*`, `whatsapp_*`) —
  left unstaged, nothing stashed/reset/discarded.
- `git fetch` then `git merge --ff-only origin/main`. **Range pulled: `4c97faa..84fc737`** (6 commits,
  21 files, +1814/−1405) — all the agenda grid/cards work (PR #40). Two new remote branches appeared
  (`feature/agenda-grid-cards`, `fix/agenda-atencion-ya-realizada`); only the merged ones are on main.

---

## 1. What changed since `bff449d` (PL-2)

"Ours" = Juan Pablo. "Partner" = VanegasMora. No git conflicts: the partner merged our PY-1 into their
agenda redesign at `fb9c7b1` ("merge: origin/main (PY-1 pagos)… serie renumerada a 1819") and renumbered
their migration off the `1818` collision — clean.

### Partner areas
- **Access / roles (RBAC v1)** — `f5f9e51`, `2b53a1d`, `bd07536`; migrations **1816 access-roles**,
  **1817 access-system-role-overrides**. Permission-catalog model (`web/lib/permissions/catalog.ts`),
  custom roles (`access_roles`, `access_role_permissions`, `access_audit_events`,
  `tenant_members.access_role_id`, `access_roles.system_key`). Tested: `test/integration/access*`,
  `test/unit/accessPermissions.test.ts`, `migrationOrder.test.ts`.
- **Modules redesign** — `d6bc554`, `35f3a99`, `9a80a04` (Catálogo/Presencia/Configuración). Tested.
- **Equipo** — `efde2d5`, `7b0ad6f`, `92f0737` (staff profile, `?s=`). Tested.
- **Agenda redesign (big)** — `aac5414`, `e034857`, `6d84f47`, `989fd19`, `ef0db98`, `8de62d9`,
  `2fd731c`, `51952db`, `38d39c2`, `dab25a8`, + the grid-cards set `032c64d`,`6d50f7a`,`1c2b21a`,
  `0c457bf`,`0189724`. New `AppointmentCard.tsx`, `SidePanel.tsx`, immediate walk-ins, drag-create,
  schedule series. Migration **1819 schedule-series**. Tested: `agendaMergeContract`, `gridCardsContract`,
  `cardLanguageContract`, `rescheduleFlow`, plus the `51952db` suite.
- **PY-2 payments UI** — `e335ad8`. New `ChargePanel.tsx`, `PaymentSection.tsx`; extended
  `web/lib/paymentActions.ts`, `src/scheduling/payments.ts`, `src/scheduling/booking.ts`. Tested:
  `paymentsUiContract.test.ts` (+ our `paymentsEngine`/`paymentsPermissions`).
- **CI + infra** — `f2e6c23` (synthetic CI-only env for unit+build jobs), `6ba25e6` (reuniones gate).

### Ours (unchanged by the merge; all present at HEAD)
- Fonts self-host `98d6894`; PL-2b `bcc39f5`,`9c420c8`; PL-3 `b752498`; PY-1 `32b96b1` (+ audit doc
  `d83c836`); auth fix `4c97faa`.

### Migrations since 1808 (ordered) — no duplicate prefixes, order test passes
```
1808 attribution · 1809 attribution-brief-window · 1810 campaigns-module-key · 1811 ad-name-note
1812 value-dashboard · 1813 value-dashboard-appointments-index · 1814 ad-cover · 1815 sales-pipeline
1816 access-roles · 1817 access-system-role-overrides · 1818 payment-on-completion (ours)
1819 schedule-series (partner)
```
`ls migrations | sed -E 's/_.*//' | sort | uniq -d` → empty (no dup prefixes across the whole dir).
`test/unit/migrationOrder.test.ts` validates 13-digit-unique prefixes + two specific orderings
dynamically (no hardcoded list; 1818/1819 need no edit) — passes. **1819 is disjoint from 1818**: it adds
`schedule_series`, `schedule_series_overrides` and `appointments.guest_{name,phone,email}`; it never
touches `payments*` / `staff.commission_*`. 1816/1817 are disjoint too.

**Operator — read-only production check:**
```sql
SELECT name, run_on FROM pgmigrations ORDER BY run_on;
```
Expected ordered tail (name = filename without extension): `…1815_sales-pipeline, 1816_access-roles,
1817_access-system-role-overrides, 1818_payment-on-completion, 1819_schedule-series`. If prod shows
1815–1817 applied and 1818/1819 absent, those two are the only pending rows and append after 1817
cleanly (run_on order == name order).

---

## 2. Build and test (exactly as CI / Railway)

| Step | Command | Result |
|---|---|---|
| Clean install (root) | `npm ci` | OK (only `npm audit` advisories) |
| Clean install (web) | `npm ci --prefix web` | OK |
| Worker tsc | `npm run typecheck` | **0 errors** |
| Web tsc | `cd web && npx tsc` | **0 errors** |
| Web build, NETWORK DENIED | `cd web && sandbox-exec -p '(version 1)(allow default)(deny network*)' npm run build` | **Compiled successfully** — no `next/font/google` (fonts still self-hosted), no `getaddrinfo`/`ENOTFOUND` |
| Lint | `cd web && npx eslint .` | **29 problems (13 errors, 16 warnings)** — see below |
| Unit | `node --import tsx --test test/unit/*.test.ts` | **1424 / 1424 pass** |
| Auth | `npx tsx --test web/tests/*.test.ts` | **37 / 37 pass** |
| Integration (FULL) | `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/observability_test node --conditions=react-server --experimental-test-module-mocks --import tsx --import ./test/integration/env.ts --test test/integration/*.test.ts` | **737 / 750 pass, 13 fail** |

**Integration — the 13 failures are the documented baseline, named with reason** (no exclusion flag was
used; the whole suite ran):
- `meetingsStagingScripts.test.ts` + `meetingsMaintenanceProcess.test.ts` (12) — `@aws-sdk/client-s3`
  is installed only under `web/node_modules`, not the repo root; documented meetings-staging baseline.
- `externalReviews.test.ts` (1) — known transient flake; passes 6/6 in isolation.
- **None** in auth / payments / pipeline / attribution / agenda / access.

**Lint delta vs `bff449d`:** was 18 (14 errors / 4 warnings) then; now **29 (13 errors / 16 warnings)**.
Errors went **down by one** (14→13); the 13 are all pre-existing `react-hooks` rules
(`set-state-in-effect` ×8, `refs-during-render` ×4, 1 more) in **others' files**
(`reuniones/MeetingWorkspace.tsx`, `scheduling/AdminPanel.tsx`, `scheduling/AgendaView.tsx`,
`scheduling/BookingLinkCard.tsx`). **Zero lint problems in our files.** The warning rise is unused
`next/navigation` imports from the access-roles/agenda refactors. Lint is **not a CI gate** here (the CI
workflow runs the `unit` + `build` jobs only).

**CI status of latest origin/main (`84fc737`, Merge PR #40):** the `ci` workflow run = **success** (2m24s)
— confirmed via `gh run list`. The previous main commits (our auth fix `4c97faa`, PR #39) are also green.

---

## 3. Behavior contracts of our phases (verified by reading code + tests, not assumption)

### 3.1 Roles & permissions — HOLDS (every row, server-side)
No new permission key was added since PY-1 and `SYSTEM_ROLE_PERMISSIONS` is unchanged
(`git diff 32b96b1 HEAD -- web/lib/permissions/catalog.ts` is empty). `can()` =
`inClientScope ∧ permissions.has(key)`; every gate funnels through `gateClientModule` /
`requireFullAccessForAction`. Nothing branches on a role name.
- **Setter** HOLDS: inbox.view/reply, contacts.view/edit/export, pipeline.view+**pipeline.edit**
  (qualify/unqualify/mark-lost/reopen via `pipelineActions.ts`), agenda.view/book/block,
  **campaigns.view only** (every campaigns mutation gated `campaigns.manage` → refused),
  **payments.view + payments.record**; and NOT payments.void / commissions.view / payments.settings /
  analytics / automations / settings.*. No inbox.supervise (can't return another agent's chat).
- **Staff** HOLDS: only `agenda.view` + `agenda.book`, **own column** (`canAccessSchedulingStaff`), can
  **complete WITHOUT payment** via `completeAppointmentAction` → `transition("completed")` gated
  `agenda.book` (NOT payments.record), and has **none** of payments.* / commissions.view / contacts.* /
  analytics.*.
- **Client Owner** HOLDS: full CRM of their client, campaigns.manage, **payments.void**,
  **commissions.view**, **payments.settings** (owner = `BUSINESS_GRANTABLE` minus
  `{inbox.supervise, contacts.delete, meetings.manage}`).
- **Agency-only** HOLDS: attribution settings, pipeline settings (`setPipelineSettingsAction` →
  `requireFullAccessForAction`), module toggles, connections — each throws "Forbidden" for owner+setter.
- **Confirmed:** (a) the Setter **never receives commission fields** — the payment serializer omits
  `commissionPct`/`commissionAmount` unless `can(scope,"commissions.view")` (`paymentActions.ts` toDTO,
  applied at every exit); (b) `voidPaymentAction` gated `payments.void`; (c) complete-without-payment is
  `agenda.book`.
- **CRM machine routes** (`/api/crm/v1/*`) are a separate tier (Bearer + token capabilities
  `crm.read/crm.write/pipeline.write`), orthogonal to the role matrix — by design.

### 3.2 Agenda — HOLDS; and the NEW component map PY-2 already hooks into
The status-change flow still funnels through **`schedulingActions.ts` → `transitionStatus`**
(`src/scheduling/booking.ts`): completion still fires the post-commit pipeline hook
(`pipelineOnAppointmentStatusChanged` → attended/won), and **PY-1's `completeWithPayment` `within` hook
still wraps the same transaction** (payments.ts passes `within` to transitionStatus; booking.ts still
honors it, now also with `requireStartedToComplete`). Time-off blocks + conflict flagging render in the
new grid. New component map:

| File | Role | Where "Completada" / charge triggers |
|---|---|---|
| `web/components/scheduling/AgendaView.tsx` | Orchestrator | `onStatus(target)`: `target==='completed' && canRecordPayments` → opens `ChargePanel` (mode `complete`); else completes directly (Staff path). Holds `charge` state `{apptId, mode}`; `revenue` KPI unchanged (list-price). |
| `web/components/scheduling/agenda/AppointmentCard.tsx` **(new)** | Grid card (desktop + phone grid) | footer actions «Confirmar · Marcar completada · Registrar cobro · Reservar de nuevo» → `onStatus`; «Completar se habilita al empezar la cita». |
| `web/components/scheduling/agenda/ChargePanel.tsx` **(new)** | THE charge step | mode `complete` → `completeWithPaymentAction`; mode `record` → `recordPendingPaymentAction`; «Completar sin cobro» → plain completion; options via `listCheckoutOptionsAction`. |
| `web/components/scheduling/agenda/PaymentSection.tsx` **(new)** | Payment in the detail | `getAppointmentPaymentHistoryAction` (recorded + voided history), `voidPaymentAction`, «Cobro pendiente». |
| `web/components/scheduling/agenda/AppointmentPanel.tsx` / `SidePanel.tsx` | Desktop detail host | renders the above; forwards `onStatus`. |
| `web/components/scheduling/mobile/MobileAppointmentSheet.tsx` / `MobileAgenda.tsx` | Phone equivalents | same `onStatus` + charge flow. |

The partner **hardened** our PY-1 actions: `appointmentInReach(scope, client, appt)` now enforces
client + site + own-column reach on **every** payment action (record/void/view/history/pending) and
complete-with-payment additionally re-checks `agenda.book` + "only once started". This closes a gap our
PY-1 actions had (they checked only client scope).

### 3.3 Pipeline (PL-1/PL-3) — HOLDS
`pipelineOnBookingCreated` fires post-commit from `createAppointment`; `pipelineOnAppointmentStatusChanged`
from `transitionStatus` (completed→attended/won, no_show→lost, cancel→qualified when no other active
appt); `markOpportunityPaid`/`revertOpportunityPaid` wired via `pipelineOnPaymentRecorded/Voided`
(payments.ts post-commit). Auto-lost sweep + reconcile started in `src/index.ts`. Bot qualify endpoint
(`/api/crm/v1/opportunities/qualify`) intact. Board + "Sin respuesta" reads intact. Tests:
`pipelineRules/BoardReads/Actions/Failsafe/QualifyApi/Backfill`, `paymentsEngine` (attended→paid→attended).

### 3.4 Attribution (AT-1/AT-3) — HOLDS
`/handoff/v1/messages` still parses referral, sets origin (`ensureInboundOrigin`), then calls
`pipelineOnInboundMessage` (order preserved). Reconcile job started. `/handoff/v1/context` origin block
shape unchanged (spread only when non-null); AT-3 promotion filter (on-offer predicate) intact. Tests:
`attribution*`, `handoffContextOrigin` (int+unit).

### 3.5 Campaigns UI / shared helpers — HOLDS
Campaigns page + `campaignsActions` (reader vs manager gates) present. Contacts "Origen" column uses
`originColumnChip/Detail`; `web/lib/originDisplay.ts` + `web/lib/contactName.ts` (displayContactName /
maskPhone / isMeaningfulName) intact and widely imported. Tests: `originColumn`, `contactName`,
`campaigns*`, `contactColumns`, `contactsRedesignContract`.

### 3.6 Identity hardening — PARTIAL (sentinel HOLDS; merge loses opportunities — see §4)
`isSentinelIdentifier` still guards every machine route (messages, context, qualify, appointments,
contacts lookup/upsert) + repo defense-in-depth. Merge re-points appointments/conversations/notes/tasks/
tags/attribution + consent + audit. **Gap:** `mergeContacts` never re-points `opportunities`.

### 3.7 Value dashboard — HOLDS
`valueDashboardSql.ts` still sums `appointments.price_snapshot` WHERE `status='completed'`, **no payments
join** (grep clean). PY-1's equality test (`paymentsEngine.test.ts` "recording a payment does NOT change
the value dashboard source") is present and valid.

### 3.8 Design tokens — no breakage
`globals.css` diff vs `bff449d` = **573 insertions, 0 deletions** (the task's "~213" was off). Pure
additions; **no token renamed or removed**; every token our screens use (`bg-surface`, `text-muted`,
`border-line`, `bg-chip`, `text-warn`, `bg-popover`, `u-focus`, `u-mono`, …) still defined for **both
themes**. The agenda added its own **scoped** systems `.u-ag` and `.u-c5` ("Card Language 5a", used by
ChargePanel's `c5-*` classes), each with a `.dark` counterpart — a second vocabulary alongside the global
`@theme` tokens (see §4, divergence).

---

## 4. Conflicts & risks (severity-ordered) — report only, fixes NOT applied

1. **[Informational / plan-changing] PY-2 is already implemented and merged** (`e335ad8`). There is no
   PY-2 to "start" — it is on main, green, and built on PY-1's engine. *Proposed:* re-scope the PY-2
   prompt to a review/hardening pass (see §5); don't rebuild.

2. **[HIGH — silent data loss] Contact merge deletes the opportunity (and its stage events).**
   `mergeContacts` (`src/db/repositories/contactIdentities.ts:813-956`) re-points appointments,
   conversations, notes, tasks, tags, attribution — but **not `opportunities`**; the final
   `DELETE FROM contacts WHERE id=drop` then cascades (`opportunities.contact_id … ON DELETE CASCADE`,
   `migrations/1815…:36`), deleting every sale + stage event of the dropped contact. **Pre-existing**
   (since PL-1; not caused by this merge) and **uncovered by tests** (`identityHardening.test.ts` §3
   asserts notes/tasks/tags/consent but not appointments or opportunities). *Proposed fix:* before the
   DELETE, `UPDATE opportunities SET contact_id=keep WHERE contact_id=drop`, handling the
   `opportunities_one_open_per_contact` unique index (keep one open sale, close/merge the other), then a
   test that a merged contact's sale survives.

3. **[LOW — permission nuance] Commission RATE config is serialized to the staff-page payload** regardless
   of `payments.settings` (`scheduling/staff/page.tsx:178-179`); only the *edit* control is gated. Not a
   leak for owner/setter/staff/agency (setter/staff lack `team.manage` and can't load the page; owner/
   agency hold both), but a hypothetical **custom role** with `team.manage` but not `payments.settings`
   would receive the rate values read-only. This is the commission RATE (config); commission AMOUNTS on
   payment responses ARE correctly stripped. From our PY-1 staff-form work. *Proposed fix:* load/serialize
   commission only when `can(scope,"payments.settings")` (or `commissions.view`).

4. **[LOW — divergence] Two design-token vocabularies now coexist.** The agenda introduced scoped
   `.u-ag` + `.u-c5` ("Card Language 5a") systems; our screens (PipelinePanel, PaymentMethodsPanel) use
   the global `@theme` tokens. Both are themed and valid, but new agenda-adjacent UI (e.g. any PY-2
   follow-up) must pick one. *Proposed:* document that agenda/charge UI uses `.u-c5`, everything else the
   global tokens.

5. **[LOW — pre-existing] 13 react-hooks lint errors** in others' files (meetings/agenda/admin), not
   CI-gated; and the integration baseline of 13 known failures (meetings `aws-sdk` not at root +
   `externalReviews` flake). Neither blocks CI or touches our code. *Proposed:* root-install `@aws-sdk`
   for local parity; address react-hooks lint opportunistically.

**Not found:** git conflicts (the ff pull was clean; PY-1 was merged + the migration renumbered by the
partner), behavior regressions in our phases, naming collisions, duplicated payment logic (PY-2 reuses
PY-1's engine — convergence, not duplication).

---

## 5. Recommendation

**Yes — it is safe to build on main now.** The platform is coherently integrated: clean install, both
tscs, the offline build, unit (1424), auth (37) and the full integration suite all pass except the
documented baseline; CI on latest main is green; every one of our PL/PY/AT/ID contracts holds except the
pre-existing merge→opportunities gap (§4.2), which is independent of this merge and does **not** block
further payment work.

**But do not "start PY-2" — it already exists.** Re-point the PY-2 effort as follows:
- **Verify/accept the existing PY-2** (`ChargePanel`/`PaymentSection` on PY-1's engine) rather than
  re-implement. It already: opens the charge step from `AgendaView.onStatus('completed')` when
  `canRecordPayments` (Staff completes without money), records via `completeWithPaymentAction` (the atomic
  `within` hook), supports pending charges + void with history, lists methods/products via
  `listCheckoutOptionsAction`, and strips commission for the Setter.
- **The PY-2 prompt's agenda-structure assumptions must change:** the target components are
  `AgendaView.tsx` (orchestrator + `charge` state), `AppointmentCard.tsx` (the grid card, NOT the old
  `AppointmentPanel`), `ChargePanel.tsx`, `PaymentSection.tsx`, `SidePanel.tsx` /
  `MobileAppointmentSheet.tsx`; "Completada" triggers via `onStatus('completed')`; the design vocabulary
  is `.u-c5` (Card Language 5a), not the global `@theme` tokens.
- **Recommended before more payment features (not a blocker):** fix §4.2 (merge → opportunities data
  loss) — it is HIGH and silently corrupts pipeline history; and §4.3 (gate the commission-rate payload).

Minimum fixes that are genuinely *required* before shipping new user-facing work: **none** for PY-2
itself. §4.2 should be scheduled soon regardless, as a data-integrity fix.
