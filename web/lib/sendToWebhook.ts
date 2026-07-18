import "server-only";
import { createHmac } from "node:crypto";

/**
 * THE single outbound chokepoint (docs/handoff-contract-v1.md §5 Exchange 4). Signs
 * the exact raw body bytes with HMAC-SHA256(secret) and POSTs to the customer URL
 * with a 10s timeout. Every non-200 / timeout / network / unparseable case collapses
 * to a SAFE generic 'failed' outcome — raw response bodies and errors are NEVER
 * surfaced to the UI.
 *
 * SSRF: the URL is customer-supplied. v1 enforces https (+ localhost http) at save
 * time and refuses redirects here; deeper egress filtering (block private ranges) is
 * a tracked scaling-todo — this function is the place to add it.
 */

/** The exact request body per the contract. */
export interface HandoffSendBody {
  type: "handoff.send_message";
  idempotency_key: string;
  workflow_ref: string;
  conversation_ref: string;
  text: string;
  agent: { id: string; name: string | null };
}

export type SendOutcome =
  | { kind: "sent"; externalMessageId: string | null }
  | { kind: "rejected"; code: string | null; detail: string | null }
  | { kind: "failed"; detail: string };

const TIMEOUT_MS = 10_000;

export async function sendToWebhook(params: {
  url: string;
  secret: string;
  body: HandoffSendBody;
}): Promise<SendOutcome> {
  // Sign the EXACT bytes we send (serialize once, sign that string, send that string).
  const raw = JSON.stringify(params.body);
  const signature = "sha256=" + createHmac("sha256", params.secret).update(raw, "utf8").digest("hex");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(params.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Handoff-Signature": signature,
      },
      body: raw,
      redirect: "error", // don't follow redirects (SSRF hygiene)
      signal: controller.signal,
    });

    if (res.status !== 200) {
      return { kind: "failed", detail: `Webhook returned HTTP ${res.status}.` };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { kind: "failed", detail: "Webhook returned an unreadable response." };
    }

    const obj = (parsed ?? {}) as Record<string, unknown>;
    if (obj.status === "sent") {
      const ext = typeof obj.external_message_id === "string" ? obj.external_message_id : null;
      return { kind: "sent", externalMessageId: ext };
    }
    if (obj.status === "rejected") {
      return {
        kind: "rejected",
        code: typeof obj.code === "string" ? obj.code : null,
        detail: typeof obj.detail === "string" ? obj.detail : null,
      };
    }
    return { kind: "failed", detail: "Webhook returned an unrecognized response." };
  } catch (err) {
    // Abort (timeout) vs any other network error — both a safe generic detail.
    const isAbort = err instanceof Error && err.name === "AbortError";
    return { kind: "failed", detail: isAbort ? "Delivery timed out." : "Delivery failed." };
  } finally {
    clearTimeout(timer);
  }
}
