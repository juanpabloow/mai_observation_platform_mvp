# Platform Audit — 2026-10 (AUDIT-2, **revision 2**, report only)

**Date:** 2026-10-15 · **Commit:** `afa7f95` (branch `main`) · **Supersedes:** `docs/platform-audit-2026-10.md` (pinned to `1b49a6c`). **Method:** code-authoritative read of `src/`, `web/`, `migrations/`, `docs/`, plus local test/lint/tsc for counts only. No production access — production checks are given as READ-ONLY (`SELECT`) SQL. Where a doc and code disagree, **the code wins** and the discrepancy is flagged. Claims cite `file:symbol`/`file:line`.

This revision re-audits the material changes merged since the first audit (PRs #21–#30: public-booking v3, reviews, promotions, business categories, staff public profiles, explainable availability + block public-reason, handoff context recovery, inbox redesign, service-description expansion). The CRM/observability/meetings/infra/RBAC core is **unchanged** and carried forward. This file is the deliverable; the chat reply carries only the executive summary, top-10 risks, booking verdict (C.9), and answers to D.1/D.2.

---

## 0. WHAT CHANGED SINCE THE FIRST AUDIT (`1b49a6c` → `afa7f95`)

175 files, +16196/−2948. Migrations **46 → 52** (latest now `1805000000000_promotions.ts`; `1802` intentionally reserved for an unmerged `feature/reviews-external-fresha` branch). `web/lib/access.ts` is **unchanged** (every new surface reuses existing predicates). No new dependencies. One new optional env var `REVIEW_LINK_SECRET`.

| Area | v1 finding | v2 status |
|---|---|---|
| **Reviews / ratings** | **ABSENT** (no table/link/storage) | **REVERSED — fully built** (migration 1801): HMAC-token `/resena/{token}`, moderation, per-site/service/**staff** public ratings; per-staff average computable. |
| **Booking page brand** | Spanish/COP/**barbershop-hardwired content** | **PARTIALLY REVERSED**: content now per-business configurable (categories 1804, staff photos/bios 1800, service presentation, public WhatsApp/Maps). **Still Spanish-only + COP-only** (no locale/currency column). |
| **Block reason** | internal `reason`, never returned by machine API | **Still true**; NEW curated `public_reason` enum (1803) + explainable availability `?explain=true` + `/staff/status` return `public_reason` + es-CO sentences to the agent; internal `reason` confirmed still never leaks. |
| **Service description** | ≤500 chars | **≤2000** (migration 1799; validator + DB CHECK agree). |
| **Handoff** | messages/mode/escalations | NEW **`handoff.context.read`** capability (7th; not in LEGACY) + `GET /api/handoff/v1/context` — scoped, fail-closed, bot-mode-only conversation history for the n8n agent. |
| **Promotions** | — | NEW (1805): administrable, **display-only / fail-closed** (no benefit bookable; booking refuses any promotion). Scaffolds a future payments/discount arc. |
| **Inbox** | list + pending-first | Redesigned (mostly cosmetic): tabs Escalado/Todas, opens on Escalado, in-list workflow selector, optional top bar; no new authz. |
| **Public routes** | /book + /api/booking | + `/resena` + `/api/resena/[token]` (token-signed, fail-closed, no PII). |
| **Identity sentinel-collapse (v1 top risk)** | unfixed | **UNCHANGED — still unfixed** (`/messages` contract + `contactIdentities.ts` untouched). Remains the #1 risk. |
| **@aws-sdk at repo root** | missing | **UNCHANGED — still missing** (present only in `web/`). |

---

## A. INVENTORY

### A1. Architecture
**Four services** (DEPLOY.md's summary still says three): **worker** (`node dist/index.js` → `src/ingestion/worker.ts`, n8n poll), **web** (Next 16 + all APIs), **maintenance** (`node dist/maintenanceMain.js` → meetings purge), **Postgres**. Dirs: `src/` shared TS data layer + worker (`db/repositories/**`, `ingestion/`, `n8n/`, `meetings/`, `scheduling/`, `storage/`, `handoff/` **(new)**, `crypto.ts`, `config.ts`, `modules/registry.ts`); `web/app` UI + `app/api/*`; `web/lib` (~120 modules now) via `@worker/*` alias; `web/components`. Stack: Next 16.2.7 / React 19.2.4 / better-auth / Tailwind v4 / zod 4 / pg 8 / node-pg-migrate 8 / tsx. **Deploys:** auto on push to `main`; **migrations NOT automatic** (manual `npm run migrate:prod up` in the worker console). **Latest migration:** `1805000000000_promotions.ts`; **52** files.

**Env var names (delta):** only **new** one is `REVIEW_LINK_SECRET` (optional; falls back `PUBLIC_BOOKING_HASH_SECRET` → `BETTER_AUTH_SECRET`, ≥16 chars, else review links are neither issued nor accepted). All other new-feature env refs are pre-existing (`PUBLIC_BOOKING_HASH_SECRET`, `PUBLIC_BOOKING_DISABLED`, `BETTER_AUTH_URL`, R2 `*`). Full catalogue unchanged from v1 (see `docs/platform-audit-2026-10.md` §A1); `.env.example` remains incomplete relative to code.

### A2. Background work (unchanged)
Two `setInterval` loops: n8n ingestion (worker, 30s) + meetings purge (maintenance, 5min). **No generic cron/job framework.** A timed job would live in the worker service. New features added no background work (review-link delivery is the caller's job; promotions are inert).

### A3. Third-party integrations (unchanged + note)
n8n (`src/n8n/client.ts`), Resend (`web/lib/email.ts`, 3 emails), Google (better-auth optional), two S3/R2 uses (public logos **now also staff photos + service/promotion images** under `staff/…`, `services/…`, `promotions/…` keys via `web/lib/r2.ts`; and the private meetings bucket). Crypto `src/crypto.ts` = AES-256-GCM, reusable for new-provider OAuth tokens; no key rotation.

### A4. Modules (unchanged)
`CLIENT_MODULE_KEYS = ["crm","scheduling","inbox","meetings","catalog"]`. Reviews/promotions/categories/staff-profiles ride under the existing **`scheduling`** module (no new module key). `client_modules` table unchanged.

### A5. Roles & permissions (core unchanged; new surfaces mapped)
`web/lib/access.ts` **unchanged** — tenant `owner|admin|member`, client `owner|setter|staff`, `getAccessScope` authority, predicates as in v1. New surfaces reuse existing gates:

| New surface | Gate |
|---|---|
| Reviews moderation page `/clients/[id]/scheduling/reviews` | `requireClientModulePage("scheduling")` + `canManageClient` |
| `reviewModerationActions.ts:moderateReviewAction` | `resolveClientModuleContext("scheduling")` + `canManageClient` |
| Review-link generation (agenda) `schedulingActions.ts:getReviewLinkAction` | `canOperateScheduling` + own-column (`gateAppointment`) — a staff login may link only its own column |
| Promotions / business-categories / staff-photo / service-presentation actions (all in `schedulingAdminActions.ts`) | `requireSchedulingAdmin` = `resolveClientModuleContext("scheduling")` + `canManageClient` |
| `GET /api/handoff/v1/context` | capability `handoff.context.read` + workflow-ref scope + inbox module + non-default client |
| `GET /api/scheduling/v1/staff/status` | capability `scheduling.read` + owned-site + staff scope |
| `POST /api/scheduling/v1/appointments/[id]/review-link` | capability `scheduling.write` + appointment-belongs-to-client + completed |
| `/resena/[token]` page + `POST /api/resena/[token]` | public, HMAC token only (no session) |

UI-only protections: still none. The two v1 weak gates persist: `connectionActions.ts` (`requireTenant` only) and the CRM fine-grained rules keying on **tenant** role (`crmPermissions.ts`) so a Client Owner is a limited "member" for notes/tasks/tag-catalogue.

### A6. Routes (delta)
- **Machine capabilities now 7:** `handoff, scheduling.read, scheduling.write, crm.read, crm.write, catalog.read, handoff.context.read` (`src/db/repositories/handoffTokens.ts`). `LEGACY_CAPABILITIES` unchanged (3) — `handoff.context.read` is **not** auto-granted; the token UI (`MachineTokens.tsx`) lists it ("Read conversation context"), `DEFAULT_CAPS` unchanged.
- **New machine routes:** `GET /api/handoff/v1/context` (`handoff.context.read`), `GET /api/scheduling/v1/staff/status` (`scheduling.read`), `POST /api/scheduling/v1/appointments/[id]/review-link` (`scheduling.write`). `GET /api/scheduling/v1/availability` gained `?explain=true` (same `scheduling.read`).
- **New public routes:** `GET /resena/[token]` (page) + `POST /api/resena/[token]` (submit) + `/book/[siteSlug]/layout.tsx` (cosmetic font). Middleware `PUBLIC_PREFIXES` += `/api/resena`, `/resena`.
- Everything else as v1.

### A7. Docs (delta)
`docs/schema.md` still stale (now 52 migrations vs its "31"). `DEPLOY.md` still says 3 services. New ops/proposal docs may exist for Gallery; the audit v1 doc is superseded by this file.

### A8. Tests & lint (fresh counts)
- **Unit:** 1127 tests, **1126 pass / 1 fail** — the 1 is `test/unit/meetingsStorage.test.ts` (imports `@aws-sdk/client-s3`, which is **still absent from root `node_modules`** — present only under `web/`). Count grew with new reviews/promotions/handoff-context/booking suites.
- **Integration:** **410 tests** (new suites incl. `handoffContext.test.ts`). The code-level baseline against a migrated local Postgres remains "all pass except the four `meetings*` files (aws-sdk)". ENV NOTE: in this audit run local Postgres was down (`ECONNREFUSED 5432`), inflating failures — an environment artifact, not a regression.
- **tsc:** worker + web clean (filtering the pre-existing aws-sdk/meetings errors).
- **Lint:** **18** (14 errors, 4 warnings) — unchanged baseline.

### A9. scaling-todo + markers (unchanged core)
Still 0 FIXME/HACK/XXX; ~20 `TODO(...)` in agenda/staff/inbox; `web/lib/auth.ts:101` `DEBT` (email verification OFF). scaling-todo priorities unchanged (automate migrations, SSE/WS, SSRF egress, etc.).

---

## B. FEATURES (updated where changed)

### B1. Observability — UNCHANGED
Poller ingestion; analytics computed **on the fly per request, no materialization**; unbounded all-time subqueries; full `raw_data` retained; no `(tenant, workflow)` index. (See v1 §B1.)

### B2. Inbox / handoff — redesigned UI + context recovery
Contract (messages/mode/escalations) and conversation keying `UNIQUE(tenant_id, n8n_workflow_id, conversation_ref)` **unchanged**; `conversation_ref` still opaque, chosen by the n8n workflow. **Redesign** is mostly cosmetic; behavior changes: visible tabs reduced to **Escalado** (`pending`) + **Todas** (`all`), default opens on Escalado (`web/lib/inboxPresent.ts`); an in-list workflow selector (gated by the existing `canSeeWorkflowInsights`); optional top bar (`topbarPref.ts`); new plumbed fields `assignedAgentUserId`/`lastUserMessageAt`. No new authorization.
**NEW context recovery** (`src/handoff/context.ts`, `handoffContext.ts`, `GET /api/handoff/v1/context`): returns a bounded (≤50 msgs, ≤2000 chars/msg, ≤24000 total), **bot-mode-only** conversation history to the n8n agent — narrow projection `{id, sender, text, occurred_at, recorded_at, text_truncated}`, **excludes** metadata/agent identities/channel ids/failure detail; `history_is_authorization:false`. Gated by `handoff.context.read` + inbox module + non-default client + an **anchor-message proof** (caller must present a `through_message_id` that is a `user/received/text` message of this conversation). **Keyed and fail-closed** on the full conversation key; an ambiguous `n8n_workflow_id` (across connections/clients) returns nothing. **No cross-conversation/contact/client leak.** The n8n helper `tools/n8n/handoffContextRecovery.mjs` treats history as quoted data (not instructions) and JSON-encodes it. Gaps from v1 persist (no delivery receipts; outbound exchange-4 webhook has no retries).

### B3. CRM — UNCHANGED (gaps persist)
Contacts + `contact_identities` (`phone|email|external`); `contacts.stage` (`new|active|customer|archived`, stored + derived "customer"); custom fields in `contacts.custom_fields` JSONB; notes/tasks(`crm_tasks`)/tags; timeline + `crm_activity_events`. **Gaps unchanged:** (a) `mergeContacts` drops notes/tasks/tags (CASCADE) + writes no merge event — **data loss**; (b) stage/owner changes via the **web UI** write no `crm_activity_events` history (only the machine PATCH does); (c) `messaging_consent`/`do_not_contact` are **store-only**; (d) hard delete.

### B4. Scheduling — several additions
Core tables + lifecycle **unchanged**: appointment statuses are exactly `scheduled | confirmed | completed | cancelled | no_show`; GiST anti-double-book; `appointment_events` (audit) + `scheduling_events` (realtime poll, internal-only); **price snapshotted** (`price_snapshot` via `resolveEffectivePrice`). Additions:
- **Service description** max 500 → **2000** (`serviceDescription.ts:SERVICE_DESCRIPTION_MAX=2000` + migration 1799 CHECK; validator + CHECK agree).
- **Block `public_reason`** (migration 1803): curated enum `vacation|unavailable|site_closed` with scope CHECKs (`vacation`⇒staff block, `site_closed`⇒site-wide), **separate from internal `reason`** (nothing derived from `reason`). The internal `reason` is **confirmed never returned** by any machine/customer surface — the slot engine selects only `staff_id, starts_at, ends_at`; the explain loader adds only `public_reason`; `reason` (via `SELECT *`) is read only by session-authed admin pages/actions.
- **Explainable availability** `GET /api/scheduling/v1/availability?explain=true` (`scheduling.read`, opt-in; default response byte-identical): an `explanation` block with per-staff/day status + `public_reason` + `public_reason_label` + a code-built es-CO `customer_message` + real `next_available` + `alternatives` (other qualified staff with real slots). Pure engine `src/scheduling/availabilityExplain.ts`. Plus a **has_availability end-exclusive fix** (a `to` on local midnight no longer adds a phantom day) and a **"names-only" alternatives** contract on the staff/service-mismatch 409 (`slots_checked:false` — the agent must re-query before offering hours).
- **`GET /api/scheduling/v1/staff/status`** (new, `scheduling.read`): "does X work on date(s)?" without a service — per-day work status + shift-left + `public_reason`/`customer_message`; reads no appointments; internal `reason` never leaves.
- **Staff public profiles** (migration 1800): nullable `staff.public_title` (≤60), `public_bio` (≤600, plain text, no links/emails/phones), `public_photo_url` (https, R2). **Nothing copied from private PII**; public projection still excludes phone/email/internal `title`.
- **Price guard** (`booking.ts`): the **public** booking POST sends `expected_price`; if it differs from the server-resolved snapshot, `createAppointment` returns `price_changed` with the current price and **writes nothing** (server still owns the price). Public-route-only; machine create does not set it.
- **Two parallel exception writers** (timeOffActions vs schedulingAdminActions.createException) still coexist.

### B5. Catalog (products) — UNCHANGED
Per-client `products`, GET-only machine API (`catalog.read`), INFORM-ONLY. `sort_order` still not reachable from the UI.

### B6. Business categories + staff presentation (NEW, booking-page config)
- **`booking_categories`** (migration 1804): per-client public groups `{name, tagline, layout: list|featured|contact, sort_order, visible}`, `UNIQUE(tenant,client,lower(name))`. Three layouts: `list` (standard), `featured` (one large card; a service shows only when its presentation is complete), `contact` (renders the tagline as a WhatsApp link, only when the site has a public WhatsApp). With **no categories configured the page keeps its legacy grouping** (no change for existing businesses).
- **Service presentation** (`services.public_*`: `public_category_id`, `public_visible`, `public_sort`, `public_recommended`, `public_image_url`, `public_includes[]`, `public_upgrade_service_id`) — presentation separated from catalogue truth; never changes what the agenda/bot can book.
- **Site public contact** (`sites.public_whatsapp` E.164, `sites.public_maps_url` Google-Maps-only).
- All managed via `schedulingAdminActions.ts` under `requireSchedulingAdmin` (owner/agency). **No machine-API exposure**; the public page reads visible categories via `publicCatalog.ts`.

### B7. Reviews / ratings (NEW — reverses v1 "absent")
Table **`appointment_reviews`** (migration 1801): `rating smallint CHECK 1–5`, `status CHECK requested|pending|approved|hidden`, `comment ≤600`, `author_display ≤40`, `publish_consent`, `expires_at`, `submitted_at`, `moderated_*`; **`UNIQUE(appointment_id)`** (one per appointment); `staff_id`/`service_id`/`service_name` **snapshots (no FK)** so a renamed service / deactivated pro keeps the review; FK to appointment + site (composite, CASCADE); invariant that a submitted review has rating+author+consent. Partial indexes for public reads (`status='approved'`) and moderation.
- **Link:** HMAC token `/resena/{token}` (`web/lib/reviewLink.ts`): `base64url(id).base64url(HMAC-SHA256(secret,"review-link:v1:"+id))`; constant-time verify; fail-closed secret chain; nothing secret stored. Generated via agenda action (own-column for staff) or machine `POST .../review-link` (idempotent, sends nothing).
- **Submit:** `POST /api/resena/[token]` — cookieless, rate-limited (10/min/IP), kill-switch + public gate (active site, non-default client, scheduling on), token verified **before any DB hit**, state machine (answered→409, expired→410), strict zod (`rating` 1–5, `comment` ≤2000 then ≤600 content rule, `publish_consent` literal true), **atomic single submit** (`requested→pending`). **No PII** in request/response/logs; author derived server-side ("Andrés G."). A submitted review is **pending**, not published.
- **Moderation:** `/clients/[id]/scheduling/reviews` (owner/agency via `canManageClient`); only `approved` is shown publicly; decisions reversible.
- **Display:** per-site, per-service, and **per-staff** approved ratings on the booking page (`ReviewsDialog`). **Per-staff average is computable** (`reviews.ts:publicStaffRatings` — `avg(rating) … WHERE status='approved' AND staff_id IS NOT NULL GROUP BY staff_id`).
- **Machine API:** exposes **only link generation** — never ratings/averages/review text.

### B8. Promotions (NEW — administrable, display-only)
`promotions` (migration 1805): per-client (optional per-site), `status draft|published|paused|archived`, `benefit_type` currently only `two_for_one`, `benefit_params jsonb`, two windows (booking-made vs appointment-occurs), optimistic `version`, `promotion_events` audit; link tables `promotion_services`/`promotion_staff`; `appointments.promotion_id` (FK NO ACTION) + `promotion_snapshot jsonb` (frozen at booking, CHECK both-or-neither). **Not applied to any booking today:** `benefitPending('two_for_one')` is non-empty → publish blocked / `checkEligibility` always `benefit_not_bookable`; the booking POST **refuses any promotion** (`409 promotion_not_applicable`) so none can produce a mispriced booking; the public page shows promotions **informationally only** (`PromotionCard`). Managed under `requireSchedulingAdmin` (owner/agency); no machine-API exposure. The schema (`promotion_snapshot`, `benefit_params`) is the staging ground for a future payments/discount arc.

### B9. Meetings — UNCHANGED
~10 tables, external GPU worker pull model, OpenAI analysis synchronous in-request, maintenance purge loop. **Depends on `@aws-sdk/client-s3`** (still absent at root — E). (See v1 §B7.)

### B10. Design system + i18n — UNCHANGED posture
Tailwind v4, bespoke primitives, class-based dark; **still no i18n layer; strings hardcoded; UI mixed Spanish/English** (the new booking v3 is Spanish-only). A `Newsreader` font was added for `/book` and `/resena` (cosmetic).

---

## C. THE PUBLIC BOOKING PAGE (deep dive — updated)

### C1–C4 (structure/flow)
`/book/[siteSlug]` is a **four-step** flow now (`ServiceStep → ArtistStep → DateTimeStep → DetailsStep → BookingDone`, `web/components/booking/BookingFlow.tsx` + `web/lib/publicBookingFlow.ts`). Server shell fans out 8 parallel reads (services, logo, service ratings/reviews, categories, site rating/reviews, promotions) → minimal projections (`publicBookingApi.ts`, asserted leak-free by `test/integration/publicBookingRoutes.test.ts`). Slug still **per-site, globally unique**; resolver `getPublicBookingSiteBySlug` unchanged. Booking POST pipeline unchanged (rate-limit → gate-before-body → strict zod → Turnstile fail-closed → engine) **plus** the price guard (B4). Contact create/reuse still **by normalized phone only**; customer confirmation still **on-screen + .ics**; **business notification still none** beyond the in-app `scheduling_event`.

### C2. Configurable vs hardcoded (re-done)
**Now per-business (new):** business categories + layouts; staff photo/public_title/public_bio; service presentation (visible/order/recommended/image/"includes"/upgrade); site public WhatsApp + Maps link; reviews/ratings; promotions (display). **Already configurable:** name, logo (R2), address, hours, timezone, services/staff + order. **Still hardcoded platform-wide:** **language (Spanish, no i18n), currency (COP, `priceLabelCOP`)**, theme color, fonts, OG image, favicon, custom domain, the "Impulsado por M_AI" footer, country-code list (CO/US/MX/ES). Phone validation still privileges `+57`.

### C3. Hardcoding
Still **no client-identity hardcoding** ("Gallery" absent from the booking surface). Remaining vertical/locale literals: Spanish copy everywhere (no strings layer), `priceLabelCOP` (COP), country-code order. Category/keyword barbershop assumptions are now **superseded by per-client categories** when configured (legacy families only as fallback).

### C5. Reviews / ratings — **PRESENT** (reverses v1)
Fully built (see B7): per-appointment HMAC link, moderation, per-site/service/**staff** public ratings, per-staff average computable. Anti-abuse: one review per appointment, single atomic submit, 30-day expiry, rate limit, consent-gated, no PII, moderation before publish. The operator's "rating link" is now a real feature.

### C6. Attribution — still ABSENT
No UTM/referrer capture, no pixel. `appointments` gained `promotion_id` (a promotion dimension) but **not** ad/campaign attribution. Booking POST still `.strict()`.

### C7. Abuse & privacy — strong (extended to /resena)
Two-layer rate limiting + persistent HMAC buckets for booking; the new `/api/resena` adds its own rate limit + HMAC-token-before-DB + no-PII responses. Staff public profiles exclude PII; review author is derived, never typed.

### C8. Quality — improved
Booking v3 is server-shell + client flow, `no-store`, noindex, mobile-first, solid a11y; 8 parallel reads are bounded projections (no N+1). Newsreader font self-hosted.

### C9. VERDICT (updated)
- **Another Colombian, Spanish-speaking, COP business (not only a barbershop) → CONFIG ONLY.** The content layer is now genuinely per-business: create the client + logo, enable `scheduling`, create a site (slug/name/address/timezone/hours + optional public WhatsApp/Maps), add services with presentation + categories + staff with photos/bios, optionally promotions. The page adapts without code. The barbershop-category hardcoding is gone (categories are data; legacy families are only a fallback).
- **Code still required for a different LANGUAGE or CURRENCY** (no i18n layer, COP hard-wired) — edit all `web/components/booking/*`, `web/lib/{publicBookingFlow,publicBookingApi,money,bookingPage}.ts`, `web/app/book/[siteSlug]/page.tsx`, `web/app/api/booking/[slug]/route.ts`, plus a `locale`/`currency` column.
- **Greenfield still:** customer email/WhatsApp confirmations, business notifications, marketing attribution/pixels, per-business theme color/OG/favicon/custom domain. (Reviews are no longer greenfield.)
- **Scalability: MEDIUM-HIGH, now for a wider set of Spanish/COP service businesses** (not just barbershops), capped below "high" only by the Spanish+COP hardcoding. Onboarding is data entry; locale/currency are the remaining code work.

---

## D. READINESS FOR THE NEXT ARC (updated)

### D.1 WhatsApp identity — the sentinel-collapse defect is UNCHANGED (still #1)
The BSUID handling (commit `1444d5a`) remains sound: a `CO.2405…` is stored opaquely as an `external` identity (kinds `phone|email|external`; BSUID **and** username both fit as `external`, no dedicated kind); `normalizeE164` returns null for a BSUID (no invented phone); a BSUID-as-`customer_phone` fails loud (`invalid_phone`). **`POST /api/handoff/v1/messages` and `src/db/repositories/contactIdentities.ts` were NOT touched in this delta** — so the **sentinel-string collapse is still unfixed**: if the documented n8n mapping `conversation_ref = wa_id` renders the literal `"undefined"`/`"null"` when Meta omits the phone, every no-phone stranger collapses into one shared conversation and one shared contact (no sentinel guard exists). Empty/missing → safe 422; the sentinel string is the hole. **Action unchanged:** remap `conversation_ref` + primary identity to `user_id` (BSUID), send `wa_id`/phone + `username` as extra `identities`, and add a platform-side sentinel reject in the `/messages` zod body and/or `classifyIdentity`.
**New & positive for the arc:** the handoff **context recovery** endpoint is correctly scoped to the full conversation key, fails closed on ambiguity, is bot-mode-only with an anchor-message proof, and leaks nothing cross-conversation/contact/client — so recovering a no-phone user's history is safe *once `conversation_ref` is namespaced per person*. Read-only detection SQL (sentinel identifiers Q1–Q4) is unchanged from v1 §D.1.

### D.2 Inbound metadata / referral — UNCHANGED
`/api/handoff/v1/messages` is still non-`.strict()` → a top-level Meta `referral` is **silently stripped**; it survives only nested in the existing `metadata` record (nothing parses it). No UTM/ad_id/campaign column anywhere; closest fields remain free-text `contacts.channel`, `contact_identities.label`, `appointments.origin`. (`appointments.promotion_id` is new but is a promotion link, not acquisition attribution.) Per-ad attribution is net-new.

### D.3 Pipeline — UNCHANGED (+ promotions adjacency)
`contacts.stage` (`new|active|customer|archived`) is per-person, not per-deal; no deals/opportunity entity; `crm_activity_events.stage_changed` reusable (but the web-UI history gap in B3 applies). New promotions are a separate concern, not a pipeline.

### D.4 Payments — still absent, but scaffolding appeared
No payments/orders/invoices/tips/methods. Money fields are still `price_snapshot`/`services.price`/`products.price`. **New:** promotions (`appointments.promotion_id`/`promotion_snapshot`, `benefit_params`) are the deliberate staging ground for a discount/payments arc — inert today (no benefit bookable; booking refuses promotions). "Paid" still indistinguishable from "Attended" (both `status='completed'`).

### D.5 Staff commission — still absent
No commission/payout field (new `public_*` columns are presentation only). Per-staff revenue derivable from `price_snapshot`; commission net-new.

### D.6 Consent — UNCHANGED, store-only
`messaging_consent`/`do_not_contact` gate nothing. Note the review system is a positive precedent: it is **explicitly consent-gated** (`publish_consent` required to publish). A marketing-send feature must still add the opt-out gate.

### D.7 Outbound — UNCHANGED (+ review-link pull)
Only outbound to n8n is the human-agent handoff webhook (no retries); `scheduling_events` internal-only. **New:** n8n can now *pull* a review link (`POST .../review-link`) and a conversation's context (`/context`) — but there is still **no platform→n8n lifecycle event** (booked/completed/paid). A post-visit review/loyalty flow needs n8n to poll or a new outbound webhook.

### D.8 Fresha import — UNCHANGED (dry-run) + note
Still a dry-run planner that writes nothing. Migration **1802 is reserved** for an unmerged `feature/reviews-external-fresha` branch (external/Fresha reviews in progress, not merged). Historical appointment import (staff+price) is still net-new.

### D.9 Other arc trip-wires
As v1, plus: promotions are **fail-closed/inert** — building on them means implementing a benefit engine + wiring `promotion_snapshot` at booking; the price guard + booking refusal ensure no mispriced booking in the meantime.

---

## E. RISKS & DEBT (re-ranked at `afa7f95`)

1. **[Privacy, HIGH] Sentinel-string identity collapse (UNCHANGED).** No guard against `conversation_ref`/identity = `"undefined"`/`"null"`; no-phone WhatsApp strangers can merge. `/messages` + `contactIdentities.ts` untouched this delta. Run D.1 Q1/Q2 in prod.
2. **[Data loss, HIGH] CRM merge deletes notes/tasks/tags (UNCHANGED).** `mergeContacts` (`contactIdentities.ts`) still CASCADE-deletes the dropped contact's notes/tasks/tags and writes no merge event.
3. **[Runtime/tests, HIGH] `@aws-sdk/client-s3` absent at repo root (UNCHANGED).** Breaks meetings unit/integration AND would crash the `maintenance` service at runtime. Fix: root `npm install`.
4. **[AuthN, MEDIUM-HIGH] Email verification OFF (UNCHANGED).** `web/lib/auth.ts:101`.
5. **[Audit, MEDIUM] Stage/owner changes via the web UI write no history (UNCHANGED).** Pipeline arc depends on it.
6. **[Scaling, MEDIUM] Analytics per-request, unbounded all-time subqueries, no materialization (UNCHANGED).**
7. **[AuthZ, MEDIUM] `connectionActions.ts` gated only by `requireTenant` (UNCHANGED).**
8. **[Compliance, MEDIUM] Consent store-only (UNCHANGED)** — a marketing send would message opted-out contacts.
9. **[Ops, MEDIUM] Migrations not auto-applied (UNCHANGED)** — and 6 new migrations (1799–1805) await a manual `migrate:prod up` in the worker console before/with this deploy.
10. **[Debt, LOW-MEDIUM] Divergences (UNCHANGED + new):** two `schedule_exceptions` writers; CRM fine-grained rules key on tenant role; session-authed routes under `/v1/`; mixed Spanish/English + no i18n (new booking v3 is Spanish-only); stale docs (`schema.md` now 52 migrations, `DEPLOY.md` 3→4 services); handoff webhook no retries; SSRF egress unhardened; catalog `sort_order` not in the UI; **new:** promotions are published-but-unbookable by design (operators can "publish" a promo that can never be booked — intended fail-closed, but potentially confusing); `services.ts` repo insert/update don't enforce the 2000-char description limit (relies on action validator + DB CHECK).

**New surfaces reviewed for risk — clean:** reviews (HMAC, fail-closed, no PII, consent-gated, moderated), handoff context recovery (scoped, fail-closed, bot-mode, anchor-proof, no cross-tenant/contact leak), staff public profiles (no PII copied, https-only photos), block `public_reason` (curated enum; internal `reason` never leaks), price guard (public-only, server owns price). None introduced a UI-only-protected surface or a cross-client leak.
