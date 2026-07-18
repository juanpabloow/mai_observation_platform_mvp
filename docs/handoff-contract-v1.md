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
