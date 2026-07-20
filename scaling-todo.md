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
