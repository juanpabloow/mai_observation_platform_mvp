# Human Handoff Contract — v1 (Draft)

**Project:** AI & Automation Observability Platform
**Phase:** H-0 — Contract definition (no code)
**Status:** ✅ Locked — all six decisions resolved (§10)
**Date:** July 2026

> **Structure of this document.** Part A is **the contract**: generic, channel-blind, versioned — the permanent, global agreement any workflow on any channel builds against. Part B is the **reference mapping**: how the current WhatsApp test workflow fills each slot. Part B exists to prove Part A works; nothing in Part B may leak into Part A.

---

# PART A — THE CONTRACT (generic, channel-blind)

## 1. Purpose and principles

The contract defines how any n8n workflow and the platform cooperate on **human handoff**: pausing automated replies, letting a human agent take over a conversation, and returning control to the bot.

Non-negotiable principles:

1. **The platform never knows what any channel is.** No field, code, or behavior in this contract references WhatsApp, Meta, Telegram, or any specific tool. All channel meaning lives on the workflow side.
2. **The platform owns conversation state.** The mode flag lives in the platform's database and is the single source of truth. Workflows read it; they never cache it beyond a single execution.
3. **The platform never talks to end-user channels.** Outbound human messages are always delegated to the customer's workflow via a registered webhook.
4. **Small surface, versioned.** v1 is four exchanges. Additive changes (new optional fields) do not bump the version. Breaking changes ship as `/v2/` alongside a still-working `/v1/`.

## 2. Core concepts

| Concept | Definition |
|---|---|
| **Conversation** | Identified by the triple `(tenant, workflow_ref, conversation_ref)`. Auto-created on first message push — no registration step. |
| `conversation_ref` | An **opaque string** (1–256 chars) chosen by the workflow that stably identifies one conversation on its channel. The platform never parses it. |
| `workflow_ref` | The n8n workflow ID — the same identifier the platform already stores from execution ingestion, so handoff data joins existing data naturally. |
| **Mode** | One of `bot` \| `pending` \| `human`. Every conversation has exactly one mode at any time. Default: `bot`. |
| **Agent** | A platform user (owner / admin / member under existing RBAC) acting on a conversation. |

## 3. The mode state machine (platform-owned)

```
            escalation (workflow call or platform rule)
   ┌─────┐ ──────────────────────────────────────────► ┌─────────┐
   │ BOT │                                             │ PENDING │
   └─────┘ ◄────────────────────────────────────────── └─────────┘
     ▲  │            dismiss (agent, no takeover)           │
     │  │ take (agent, direct)              take (agent)    │
     │  ▼                                                   ▼
     │ ┌───────┐ ◄───────────────────────────────────────────┘
     └─│ HUMAN │
return └───────┘
(agent)
```

| Transition | Trigger | Recorded |
|---|---|---|
| `bot → pending` | Workflow escalation call, or a platform-side rule | source + reason |
| `bot → human` | Agent takes directly from the inbox | agent id |
| `pending → human` | Agent takes a pending conversation | agent id |
| `pending → bot` | Agent dismisses without taking over | agent id |
| `human → bot` | Agent returns control | agent id |

Every transition is audited: who/what caused it, when, and the reason. Transitions not in this table are invalid. All transition-causing calls are **idempotent**: requesting a state the conversation is already in returns `200` with current state, never an error.

*(v1 scope note: automatic `human → bot` return after agent inactivity is deliberately excluded from v1 — manual return only. See decision D4.)*

## 4. Authentication

**Workflow → platform** (exchanges 1–3): a **Handoff Token** issued per n8n connection, sent as `Authorization: Bearer <token>`. Revocable and re-issuable from the platform UI. Scoped exclusively to `/api/handoff/*` — it grants no access to dashboards, executions, or any other API surface.

**Platform → workflow** (exchange 4): each handoff-enabled workflow registers a **webhook URL + shared secret** in the platform. The platform signs every request: `X-Handoff-Signature: sha256=HMAC_SHA256(secret, raw_body)`. The workflow must verify the signature before acting — this is what prevents anyone who discovers the webhook URL from sending messages through the customer's channel.

## 5. The four exchanges

### Exchange 1 — Inbound message push (workflow → platform)

`POST /api/handoff/v1/messages`

The workflow reports a message the moment it arrives, **regardless of mode**. The response returns the current mode, so this single call is both *notify* and *gate*.

Request:
```json
{
  "workflow_ref": "string, required",
  "conversation_ref": "string, required",
  "sender": "user | bot",
  "text": "string, required unless content_type is non-text",
  "content_type": "text (default) | other",
  "content_detail": "optional free text, e.g. 'voice note, 12s' — displayed, never parsed",
  "external_message_id": "optional string — channel's own message id, used for dedup",
  "occurred_at": "optional ISO-8601 UTC — defaults to receipt time",
  "metadata": "optional object — stored verbatim, never interpreted"
}
```

Response `201` (or `200` on dedup replay):
```json
{
  "message_id": "uuid",
  "conversation": {
    "id": "uuid",
    "mode": "bot | pending | human",
    "assigned_agent": { "id": "...", "name": "..." } | null
  }
}
```

Rules:
- First push for an unknown `conversation_ref` **auto-creates** the conversation in mode `bot`.
- Same `external_message_id` within a conversation → dedup: `200`, original `message_id`, message not duplicated.
- `sender: "bot"` lets the workflow push its own replies so the inbox thread is complete in real time (see decision D3).
- Human-agent messages are **never pushed** — the platform records those itself during Exchange 4.

### Exchange 2 — Mode check (workflow → platform)

`GET /api/handoff/v1/mode?workflow_ref=...&conversation_ref=...`

Response `200`:
```json
{ "mode": "bot | pending | human", "as_of": "ISO-8601" }
```

Used as the cheap **re-check** immediately before a workflow sends an automated reply, to narrow the race window between "gate passed" and "reply sent" (relevant for workflows with debounce/buffer patterns or slow AI generation). Unknown conversation → `200` with `"mode": "bot"` (unknown means never escalated).

**Fail-open rule (see decision D1):** if the platform is unreachable, times out (recommended workflow timeout: 3s), or returns `5xx`, the reference templates **default to `bot`** — the customer's bot keeps working when the platform is down. Platform downtime must never silence a customer's channel.

### Exchange 3 — Escalation (workflow → platform)

`POST /api/handoff/v1/escalations`

```json
{
  "workflow_ref": "string, required",
  "conversation_ref": "string, required",
  "reason_code": "free string chosen by the workflow, e.g. 'user_requested', 'low_confidence'",
  "detail": "optional free text shown to agents"
}
```

Effect: `bot → pending`. Idempotent: already `pending`/`human` → `200` with current state.
Response `200/201`: same `conversation` object as Exchange 1.

`reason_code` is **not an enum** — the platform displays it and can filter by it, but defines no valid values. The workflow's reasons are its own business.

*(Escalation can also happen entirely platform-side — rules like "if an inbound message contains these keywords → set pending", configured per workflow on top of pushed messages. That is platform behavior, not part of the contract, and requires nothing from the workflow.)*

### Exchange 4 — Outbound send (platform → workflow webhook)

`POST <registered webhook URL>` — signed per §4.

```json
{
  "type": "handoff.send_message",
  "idempotency_key": "uuid — resend-safe: workflow should ignore a repeated key",
  "workflow_ref": "string",
  "conversation_ref": "string",
  "text": "string",
  "agent": { "id": "...", "name": "..." }
}
```

The workflow maps `conversation_ref` to its channel recipient, performs the real send, and responds **synchronously**:

Success `200`:
```json
{ "status": "sent", "external_message_id": "optional" }
```

Failure `200` (a *delivered verdict*, not a transport error):
```json
{
  "status": "rejected",
  "code": "CHANNEL_POLICY | INVALID_RECIPIENT | CHANNEL_ERROR",
  "detail": "free text shown to the agent, e.g. why the channel refused"
}
```

Rules:
- `CHANNEL_POLICY` is the generic slot for channel rules (messaging windows, template requirements, rate limits). The platform renders `detail` verbatim; it never understands the policy.
- Webhook unreachable / timeout (10s) / `5xx` → the platform marks the message **failed** and shows the agent a manual *Retry* (same `idempotency_key`). No automatic retries in v1 — double-sending to an end user is worse than asking the agent to click again.
- The platform records the message (`sending → sent | failed`) itself; the workflow does not push human messages back.

## 6. Message model (platform side)

Handoff introduces a first-class `messages` table — messages as events, not as values derived from execution payloads:

| Field | Notes |
|---|---|
| `id`, `tenant_id`, `conversation_id` | standard scoping — all queries tenant-scoped as everywhere else |
| `sender` | `user` \| `bot` \| `human_agent` |
| `agent_id` | set when sender is `human_agent` |
| `text`, `content_type`, `content_detail` | display content |
| `external_message_id` | dedup key (unique per conversation when present) |
| `status` | `received` for inbound; `sending`/`sent`/`failed` for outbound |
| `occurred_at`, `created_at` | channel time vs. platform receipt time |
| `metadata` | JSONB, verbatim |

Relationship to the existing Phase-3 view: execution-derived conversation reconstruction (observability truth) and pushed messages (inbox truth) **coexist**; a workflow with handoff enabled gets the live inbox view, while the execution-truth view remains for debugging. How they visually relate is an H-2 UI decision, not a contract matter.

## 7. HTTP conventions

| Code | Meaning |
|---|---|
| `200 / 201` | Success (`200` on idempotent replays) |
| `401` | Missing/invalid/revoked token |
| `404` | Unknown `workflow_ref` for this tenant |
| `422` | Malformed payload (missing required field, oversize) |
| `429` | Reserved for rate limiting (not enforced in v1) |
| `5xx` | Platform fault → workflows apply the fail-open rule |

Timestamps ISO-8601 UTC. Bodies UTF-8 JSON. `text` capped at 64KB.

## 8. Versioning and evolution

- Version lives in the path (`/api/handoff/v1/`) and in the webhook payload (`"type"` field naming).
- **Additive** (new optional request fields, new response fields, new rejection codes): no version bump; workflows must tolerate unknown response fields.
- **Breaking** (renaming/removing fields, changing semantics): new `/v2/` published alongside; `/v1/` keeps its promise until a announced sunset.

## 9. What the contract deliberately does NOT cover

- How a workflow decides to escalate (its business).
- How a workflow buffers, debounces, or generates replies (its business).
- Channel identity of any kind (its business).
- Typing indicators, read receipts, attachments-as-files, agent presence — possible v2 candidates, out of v1.
- Automatic return-to-bot timers (D4), platform-side SLA alerts on `pending` age (natural later feature on existing alerting plans).

---

# PART B — REFERENCE MAPPING: the WhatsApp test workflow

*(Worked example. Everything here is customer-side configuration for the current test workflow — `Test Observability Workflow`, the debounce/buffer WhatsApp bot. It is the template future channel docs will copy.)*

## B.1 Slot filling

| Contract slot | This workflow's value |
|---|---|
| `workflow_ref` | the workflow's n8n ID (already known to the platform via ingestion) |
| `conversation_ref` | `{{ $('WhatsApp Trigger').item.json.contacts[0].wa_id }}` — same key Phase-3 mapping already extracts, and the same key the bot's chat memory uses |
| `text` | `{{ $('WhatsApp Trigger').item.json.messages[0].text.body }}` |
| `external_message_id` | `{{ $('WhatsApp Trigger').item.json.messages[0].id }}` (the `wamid` — gives free dedup on Meta webhook redeliveries) |
| `content_type` | `"text"` (the Filter node already guarantees text-only) |

## B.2 Touchpoint placement in the existing graph

```
WhatsApp Trigger
  → Filter messages types
  → [NEW ①  Push message + gate]  POST /messages (sender: user)
       ├─ mode == bot  → Buffer insert → Wait 7s → Get latest → Latest message?
       │                                              ├─ not latest → do nothing
       │                                              └─ latest →
       │                                    [NEW ②  Re-check]  GET /mode
       │                                         ├─ bot → Combine messages → AI Agent
       │                                         │        → Send message
       │                                         │        → [NEW ③ optional] POST /messages (sender: bot)
       │                                         │        → Delete Buffer
       │                                         └─ not bot → Delete Buffer → stop   (see D2)
       └─ mode != bot → stop (message already visible in the inbox)
```

- **①** replaces nothing — one HTTP Request node + one IF node after the filter. If the platform is unreachable: proceed as `bot` (fail-open, D1).
- **②** exists *because of* this workflow's 7-second debounce + AI generation time — the takeover race window here is many seconds wide, so the pre-send re-check is not optional for this pattern.
- **③** pushes the bot's own reply so the inbox thread is complete in real time (D3).

## B.3 The send workflow (new, separate, ~5 nodes)

`Webhook (POST) → verify X-Handoff-Signature → map conversation_ref → wa_id → WhatsApp Send (same credentials + phoneNumberId 1079483095237963) → respond`

- Success → `{ "status": "sent" }`.
- Meta's 24-hour customer-service window expired → `{ "status": "rejected", "code": "CHANNEL_POLICY", "detail": "WhatsApp 24h service window expired — only approved templates can be sent" }`. The platform shows that sentence to the agent without understanding it. (Template-message sending as the recovery path: future enhancement, not v1.)
- **Optional memory write (D5):** after a successful send, insert the human's reply into the bot's Postgres chat-memory table (session key = `wa_id`) as an assistant turn — so when the conversation returns to `bot`, the AI resumes knowing what the human said instead of with amnesia about the whole human exchange.

## B.4 Known interaction: the buffer on takeover

If a takeover happens mid-debounce, un-answered rows may sit in `message_buffer`. They are already visible in the platform (pushed at arrival by ①), so the buffer's only remaining job — feeding the AI prompt — is obsolete for those rows. Recommendation (D2): the `not bot` branch of ② deletes the buffer for that `wa_id`, so a later return-to-bot starts clean instead of replaying stale messages into the AI.

---

# §10 — Decisions (LOCKED, July 2026)

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Fail-open (`bot`) vs fail-closed when the platform is unreachable | **Fail-open.** Platform downtime must never silence customers' bots — it turns an observability outage into their business outage. |
| **D2** | Buffered-but-unanswered messages on takeover | **Delete the buffer** in ②'s `not bot` branch (messages already live in the inbox; replaying them into the AI later is worse). |
| **D3** | Push bot replies (`sender: bot`) too, or derive them from polling only | **Push them.** Real-time complete threads for handoff conversations; polling stays the observability source for everything else. |
| **D4** | Auto-return `human → bot` after agent inactivity | **Defer.** Manual return only in v1; timers are product policy best added with real usage data. |
| **D5** | Human replies written into the bot's chat memory | **Yes, as a template option** — return-to-bot amnesia will confuse end users; but it touches the customer's memory table, so it ships as a documented optional node, not platform behavior. |
| **D6** | Handoff Token scope | **Per n8n connection** (matches how everything else is keyed; revoking one customer's token can't affect another connection). |

**All six locked on the recommendations:** D1 fail-open · D2 delete buffer on takeover · D3 push bot replies · D4 auto-return deferred · D5 memory write as optional template node · D6 tokens per n8n connection. The contract above is final for v1 — any future change follows §8's versioning rules.


# Handoff contract v1

The wire contract between an n8n **workflow** and the observability **platform** for
human handoff. Two directions:

- **Inbound** (workflow → platform): the workflow tells the platform about messages,
  asks whether a human has taken over, and requests escalation. Machine-authed with a
  per-connection Bearer token. (Exchanges 1–3; shipped in H-1b.)
- **Outbound** (platform → workflow): the platform delivers an agent's reply back to
  the workflow, which forwards it to the end-user channel. Signed with a per-workflow
  shared secret. (Exchange 4; shipped in H-3.)

Identifiers are stable strings the workflow chooses: `workflow_ref` (the n8n workflow
id) and `conversation_ref` (the workflow's own conversation/thread key). The platform
keys everything by `(tenant, workflow_ref, conversation_ref)`.

---

## Inbound — machine API (summary)

Base: `POST/GET /api/handoff/v1/*`. Auth: `Authorization: Bearer hk_…` (per-connection
token; the token authorizes ONLY workflows of its connection). Errors:
`{ "error": { "code", "message" } }` with constant 401 (auth) / 404 (scope) bodies.

1. **`POST /messages`** — record an inbound message. Body: `workflow_ref`,
   `conversation_ref`, `sender` (`user` | `bot`), `text`, optional `content_type`,
   `content_detail`, `external_message_id` (dedup key), `occurred_at`, `metadata`.
   → `201` new / `200` deduped, `{ message_id, conversation: { id, mode, assigned_agent } }`.
2. **`GET /mode?workflow_ref=&conversation_ref=`** — `{ mode, as_of }`; unknown → `bot`.
3. **`POST /escalations`** — request human handoff. `bot`→`pending` (201); already
   pending/human → 200 current state, no-op.

---

## §5 Exchange 4 — Outbound send (platform → workflow)

When a human agent sends a reply from the inbox composer, the platform POSTs it to the
workflow's registered **send webhook**. The workflow forwards it to the real channel
(WhatsApp, SMS, web chat, …) and answers with the result.

### Registration

Per workflow, the customer registers ONE webhook (owner/admin, in the workflow's
settings): an HTTPS `url` (http:// allowed only for `localhost` in dev) and a
platform-generated **shared secret** (`whs_` + 32 random bytes, base64url). The secret
is symmetric — the platform signs with it, the workflow verifies with it. It is stored
encrypted at rest and revealed to owner/admin on demand. Regenerating it invalidates
the previous secret immediately.

### Request

```
POST <webhook url>
Content-Type: application/json
X-Handoff-Signature: sha256=<hex HMAC-SHA256(secret, raw_request_body_bytes)>
```

Body (exact shape):

```json
{
  "type": "handoff.send_message",
  "idempotency_key": "<uuid>",
  "workflow_ref": "<n8n workflow id>",
  "conversation_ref": "<conversation key>",
  "text": "<agent's message>",
  "agent": { "id": "<user id>", "name": "<display name or null>" }
}
```

- `idempotency_key` is the platform's message id and is **stable across retries** — the
  workflow MUST de-duplicate on it (delivering the same message twice to an end user is
  the worst failure mode). The platform performs **no automatic retries**; a retry only
  happens when an agent explicitly clicks Retry, and reuses the same key.
- Timeout: the platform waits **10 seconds**, then treats the attempt as failed.
- The platform does not follow redirects.

### Signature verification (the workflow's side — reference)

Compute `HMAC-SHA256(secret, raw_body_bytes)` over the EXACT bytes received (before any
JSON re-serialization) and constant-time compare the lowercase hex against the value
after `sha256=` in `X-Handoff-Signature`. Reject on mismatch. (The H-3 mock receiver in
the test suite is the reference implementation the real n8n workflow copies in H-4.)

### Response

The workflow MUST reply `200` with one of:

- **Delivered:**
  ```json
  { "status": "sent", "external_message_id": "<optional channel id>" }
  ```
  → platform marks the message `sent` (stores `external_message_id` if present).

- **Rejected** (reached the channel logic, but it declined — e.g. outside a messaging
  window, unapproved template):
  ```json
  { "status": "rejected", "code": "CHANNEL_POLICY", "detail": "human-readable reason" }
  ```
  → platform marks the message `failed`, stores `code`/`detail`, and shows `detail`
  verbatim to the agent (who can edit and Retry).

Anything else — non-200, timeout, network error, or an unparseable/unrecognized body —
is a **delivery failure**: the platform marks the message `failed` with a safe generic
detail (raw response bodies and internal errors are never surfaced to the agent). The
per-workflow `last_delivery_status` records `sent` | `rejected` | `failed`.

### Ordering / state

The platform only sends while the conversation is in `human` mode. If mode flips (the
conversation was returned to the bot) before a send, the platform refuses with a typed
error and the composer tells the agent. Concurrent sends into one conversation are each
attributed to their own sender and idempotency key; there is no server-side ordering
guarantee beyond per-message delivery.
