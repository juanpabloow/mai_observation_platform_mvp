# Scaling TODO

Deliberate v1 simplifications and deferrals — things that are *fine for now* but will
need attention as real usage and data grow. Referenced from `DEPLOY.md`. Each entry
notes what we do today and what the scaled version looks like, so a future change
extends the right place instead of bolting on a parallel mechanism.

## Deploy / ops

- **Automate migrations** as a Railway pre-deploy / release step (`railway.worker.json`
  → `deploy.preDeployCommand: "npm run migrate:prod up"`), so schema changes apply on
  every deploy instead of the manual Console step. This makes the **code-outruns-schema
  failure class disappear** — the one that took production down once (H-2/H-3 code
  auto-deployed while its two migrations sat unapplied, so every authenticated page
  `500`'d until they were run). Until this is in place, the manual run is a HARD RULE —
  see `DEPLOY.md`. (Pair it with an automated backup step before the migration runs.)
- **Staging environment** / non-`main` branch workflow before production, once there
  are real users.

## Health & monitoring

- **Self-monitoring / alerting.** `GET /api/health` (public; `SELECT 1` → `200 ok` /
  `503 degraded`) now exists as the probe, but nothing *watches* it — the production
  outage was **invisible until a human loaded a page**. Wire an external uptime monitor
  (or a Railway healthcheck) to poll `/api/health` and alert (Slack / email / paging) on
  `503` or unreachable. Add a synthetic check that also loads an *authenticated* page, so
  a schema/render regression (like the migration outage, which `/api/health` alone would
  NOT have caught — the DB was up, only app tables were missing) is caught before a
  customer hits it.

## Real-time updates (polling → push)

The UI reflects server changes by **light polling**, not push. Today:

- Executions table — periodic auto-refresh.
- **Handoff inbox list** — polls `/api/inbox/[clientId]/conversations` ~5s.
- **Handoff thread** — polls `/api/inbox/[clientId]/conversations/[id]/messages` ~4s.
- **Inbox tab pending-count badge** — polls `/api/inbox/[clientId]/pending-count` ~5s.

All are paused while `document.visibilityState` is hidden. When we need true
real-time (an agent watching an active handoff wants sub-second updates), replace ALL
of the above with a single push channel (SSE or WebSocket) rather than shortening
intervals or adding a second mechanism. This is the ONE real-time deferral — extend
it here; don't duplicate per-surface.

## Handoff / inbox (H-2)

- **Dedicated "Human Agent" role.** Inbox composer access currently rides on the
  existing roles (owner/admin full access; a member scoped to their client). When
  handoff becomes a distinct job, add a 4th role to the RBAC enum
  (`web/lib/access.ts` + the `tenant_members.role` CHECK) rather than overloading
  member/admin. Take/reply/return would key off that role.
- **Hub-level cross-client inbox.** v1 is per-client only (`/clients/[id]/inbox`).
  An owner/admin triaging across clients has to switch clients. A future Hub inbox
  aggregates all accessible clients' conversations (the repo reads already resolve a
  conversation→client mapping; a tenant-wide variant would drop the client filter).
- **Conversations of client-UNASSIGNED workflows are invisible in per-client
  inboxes.** A conversation belongs to a client iff its workflow's canonical row is
  assigned to that client; a conversation whose workflow has no client assignment (or
  no synced workflow row) appears in NO inbox. Acceptable for v1. A "tenant unassigned"
  bucket (or surfacing them under the tenant's default client) would close the gap.
- **Thread pagination.** The thread loads all messages oldest→newest each poll. Fine
  for v1 volumes; long-lived conversations will want a windowed/cursor load (the
  machine-API `listMessages` already has a `before` cursor to build on).

## Conversation grid / activity (H-7)

- **Per-workflow activity threshold.** ACTIVE/INACTIVE uses one global constant
  `ACTIVITY_WINDOW_HOURS = 24` (`src/db/repositories/handoff.ts`, surfaced to the UI via
  the list payload's `activityWindowHours`). Channel service windows differ (WhatsApp
  24h vs. others), so make it per-workflow configurable — a column on the workflow's
  handoff config, read into the `active` SQL expression instead of the constant.
- **Grid / list view toggle.** The per-workflow Inbox is a card grid; a dense list view
  suits high-volume triage. Add a remembered per-user toggle (the data payload already
  serves both — only the presentation differs).
- **Read / unread tracking.** There is NO read-state today and the grid does not fake
  one. A real "unread since you last looked" needs a per-agent last-seen marker
  (per conversation or per workflow) — a new table + write on thread open; do not
  approximate it from message timestamps.
- **Pending notifications + recipient model** (carried forward, unchanged): when a
  conversation goes pending, notify the right humans (email/Slack/push). Needs a
  recipient model (who watches which client/workflow) — deferred until the Human-Agent
  role lands. `/api/health`-style polling is not a substitute for a push notification.

## CRM / contacts (D-2)

- **Contacts list: separate genuine leads from inbound noise.** D-2 auto-creates a contact for
  everyone who writes, so the list will accumulate nameless, appointment-less contacts — some
  are real leads (asked a price, haven't booked), some are spam / wrong numbers / one-word
  "hola". Revisit once real customer traffic exists — decide the criterion from the observed
  shape of the junk, not from a guess. **Do NOT build the filter now:** the current signal is
  9 contacts over 3 weeks at 0% single-message, all operator testing — a filter now would risk
  hiding genuine leads. **Trigger:** `pct_single_msg` above ~20%, or the contacts list exceeding
  a few hundred rows. **Sizing query:** `docs/ops/d2-inbound-contact-sizing.sql` (re-runnable,
  read-only) — the D-2 rate + junk-fraction estimate this decision keys off.

## Outbound send (H-3)

- **Webhook egress hardening (SSRF).** The send webhook URL is customer-supplied. v1
  accepts `https://` (+ `http://localhost` for dev) and refuses redirects, but does NOT
  resolve-and-block private/link-local/metadata IP ranges (`10/8`, `172.16/12`,
  `192.168/16`, `127/8`, `169.254/16`, `::1`, `fc00::/7`) or guard against DNS-rebinding.
  All outbound delivery goes through the single `sendToWebhook()` function in
  `web/lib/sendToWebhook.ts` — add the egress allow/deny check there (resolve the host,
  reject private targets, pin the resolved IP for the connection) when this platform is
  exposed to untrusted tenants.
- **Delivery is synchronous** inside the send server action (POST within the request,
  10s timeout, no queue). Fine at v1 volume; a durable outbound queue/worker with
  backoff-free manual retry semantics would decouple the agent's click from channel
  latency as send volume grows.

## Client roles (Setter)

- **Billing is ✗ for the Setter** — the client's operating document says the Setter must
  not see billing/payments. Payments aren't built yet; when they are, the Setter defaults
  to NO access (gate on a capability like the existing `canSeeWorkflowInsights`, i.e.
  owner/agency only). Add the server gate + hide the nav the same way analytics is hidden.
- **Meetings (Reuniones) vs Setter — DECIDED 2026-10-20: ✗ (no access).** The Setter
  matrix lists only inbox, contacts and agenda. The sidebar already hid Reuniones from the
  Setter; now the server agrees: `canAccessMeetings` (web/lib/access.ts — agency or this
  client's owner) gates both meetings pages and every session-authed meetings API route
  (via `resolveAppScope`), with the same indistinguishable 404. Worker routes are machine-
  authenticated and unchanged.

## Product catalog

The catalog is INFORM-ONLY in v1 (a client lists what it sells; the bot can read name,
price, description and availability — no orders, reservations, stock quantities or
payments). Deferred, in rough dependency order:

- **Product images.** A product has no image yet. When added, the *platform* stores the
  image (object storage, like the meetings uploads) but the *workflow* decides how/whether
  to send it on a given channel — the API stays channel-blind (it would expose a URL, not
  push media).
- **Variants** (sizes / presentations, e.g. 30ml vs 100ml). For now model each as a
  SEPARATE product. A real variant model (one product, many SKUs with their own price +
  availability) lands when a client actually needs shared metadata across sizes.
- **Stock QUANTITIES.** v1 has only the boolean `in_stock` (disponible/agotado). Real
  counts require recorded sales/movements first (you can't decrement what you don't log),
  so quantities come with — not before — the sales phase.
- **Reserve-for-pickup at an appointment.** Linking a product hold to a scheduling
  appointment (the bot sets aside an item for a booked visit) needs the write side the
  INFORM-ONLY rule deliberately excludes here.
- **Orders / delivery.** A real order object (line items, totals, status, fulfilment) is a
  separate module that CONSUMES the catalog; `products.is_active` archiving exists precisely
  so order history can keep referencing a product that's no longer offered.
- **Payments link.** When payments ship, tie a product sale to the ticket (and to
  commissions). The `catalog.read` capability stays read-only; a sale is a different family
  with its own write capability, never bolted onto the catalog read.
- **Categories table.** Category is free text in v1 (one column, no joins, no CRUD). A real
  `product_categories` table (ordering, rename-propagation, per-category rules) is worth it
  only once a client manages enough products that free text drifts ("Barba" vs "barba" vs
  "Cuidado de barba"); until then it would add a table + management UI for no gain.
- **Reorder UI.** `sort_order` exists and the API honours it, but there's no drag-to-order
  control yet (every row defaults to 0 → name order), the same deferral services made for
  `display_order`. Add a reorder control (owner-only) alongside this column when wanted.

## Scheduling — Time Off & staff editing

- **Staff-name uniqueness DB backstop.** Uniqueness (ACTIVE staff, per site, case-insensitive)
  is enforced in the server action (`activeStaffNameTaken` in create/updateStaffAction). The
  belt-and-braces DB guarantee — `CREATE UNIQUE INDEX ON staff (tenant_id, site_id,
  lower(btrim(name))) WHERE active` — was deliberately NOT added this phase: `staff` is an
  existing populated table, and a `CREATE UNIQUE INDEX` that finds pre-existing duplicate active
  names would FAIL the migration and block the deploy. Add the index once prod data is verified
  clean (or after a one-off de-dupe), so the DB enforces what the action already does.
- **Owner override to book INTO a block.** Every write path (incl. an owner booking manually)
  returns the normal `unavailable` for a slot inside a Time Off block. A force-book override for
  owners was considered and deferred: it isn't trivial (a `force` flag threaded through the
  booking engine + a stored reason), and the simpler path — shrink or delete the block first —
  already exists. Revisit if operators ask for it.
- **Recurring time off is out of scope** (as specified): recurring patterns are the weekly
  hours' job. Time Off is one-off blocks only. If a "every Monday off" need appears, it belongs
  in `working_hours`, not here.
- **Week-view per-staff bands.** The week grid aggregates all staff per day, so a per-staff
  partial band has no single column to live in; the week shows SITE closures as a day hatch and
  staff time off as a "Fuera · N" count, while the DAY view carries the full per-staff bands. A
  dedicated per-staff week grid (one row per staff × 7 days) could render bands if added.

## Attribution (AT-1 → AT-2/AT-3 and beyond)

- **Meta Marketing API sync.** `campaigns.external_campaign_id` and `ads.campaign_id` exist but
  nothing writes them. Sync real campaign/ad names + structure from the Meta Marketing API so an
  ad row shows its campaign and headline without waiting for a message to carry them.
- **Conversions API (CAPI).** `attribution_touches.ctwa_clid` is stored precisely so a future
  phase can send conversions (bookings, completed appointments) back to Meta keyed on the click
  id. Not sent anywhere yet.
- **UTM capture on the booking page.** The public booking page could capture `utm_*` /
  `fbclid` / `gclid` into a touch so organic-vs-paid is distinguishable there too (today a
  booking-page contact is just `booking_page`).
- **Per-ad / per-campaign dashboard (AT-2).** Counts per ad/campaign with test ads excluded by
  default (`ads.is_test`), spend/ROI once the Marketing API sync lands, and the campaigns admin
  UI (the `campaigns` module is registered but hidden from the modules page until AT-2).
- **Opportunity-level attribution.** Today origin is per-contact (first/last touch). A
  multi-touch / per-booking (opportunity) attribution model would value each touch in the path.
- **Reconciliation scan efficiency.** `backfillAttribution` scans all referral messages +
  all unclassified contacts each pass; fine at current volume. Scope the reconcile job to a
  recent window (or a backlog cursor) before this grows large.
- **Attribution health across replicas.** `failed_attributions` is an in-process counter (web),
  so it resets on deploy and isn't summed across replicas. Move to a durable/shared counter when
  web scales past one replica; `pending_attributions` (DB-derived) is already durable.
- **New-client tracking start.** A client created after this phase has no `attribution_settings`
  row, so its no-referral contacts are `unknown` until the agency sets `tracking_started_at`.
  Consider seeding a row at client creation (tracking from creation time).

## Payments (PY-1 → beyond)

PY-1 records ONE payment per completed appointment (service + optional products), with a
per-line commission snapshot, through the completion step. Deferred, on purpose:

- **Split payments.** One payment, one `method_key` today. A real "efectivo 20.000 + tarjeta
  30.000" split needs payment-level method lines (or a `payment_tenders` child table). The
  `payments`/`payment_lines` shape leaves room; the engine + UI assume a single method for now.
- **Tips (propinas).** Explicitly out of PY-1. A tip is neither service nor product revenue and
  usually routes 100% to the artist — it would be its own line `kind='tip'` (no list price) with
  its own commission rule, not a discount/adjustment.
- **Standalone product sales.** A payment is always anchored to an appointment
  (`payments.appointment_id NOT NULL`). Selling products with no appointment (a walk-in buying
  wax) needs an appointment-less sale — relax the FK or add a `sales` parent.
- **Refunds.** Today a mistake is VOIDED (whole payment). A partial refund (return one product,
  keep the service) needs refund lines against a recorded payment, not an all-or-nothing void.
- **Stock quantities.** `products.in_stock` is a manual boolean; a product line never decrements
  stock. Real inventory (quantity on hand, decrement on sale, low-stock) is a separate model.
- **POS / gateway / accounting import.** `payments.source` is not modelled yet (every row is
  manual). Importing settled payments from Wompi / Bold / a POS or accounting system (instead of
  manual entry) would add a `source` + external id and a reconcile path; the tables were designed
  so an imported payment looks like a manual one.
- **Conversions API "Purchase".** With payments, a completed+paid opportunity carrying
  `attribution_touches.ctwa_clid` can send a Meta CAPI "Purchase" with the real `total` (not just
  list price) — the first event with actual revenue. Ties into the attribution CAPI item above.
- **Editing a completed appointment.** `completed` is still terminal (PY-1 unchanged): amount,
  service and staff on a completed appointment have no edit path. Correcting the SALE goes through
  void + re-record; correcting the APPOINTMENT itself (wrong service/staff/time after completion)
  is a separate, audited un-complete/edit flow not built here.
- **Mobile commission editor.** PY-1 added the per-artist commission fields to the DESKTOP staff
  Details form only; the mobile staff detail (`mobile/team/forms.tsx`, an unsaved-bar modal) needs
  its own "Comisiones" layer (like HoursForm/CertForm) — the payment-methods settings screen itself
  is already responsive. `canManagePayments` is already threaded into the mobile tree.
- **New-client seeding.** A client created after PY-1 gets its payment methods seeded lazily on
  first list (ensureClientPaymentMethods) and its `payments_tracking_started_at` falls back to the
  client's `created_at`; consider seeding both at client creation (same note as attribution).
