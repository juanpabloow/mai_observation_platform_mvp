/**
 * PROPOSAL — reference mapping for the n8n handoff send workflow (Exchange 4), NOT wired
 * into any workflow. It is meant to be pasted into the workflow's error-branch Code node
 * after review. The active workflow is not modified by this repository.
 *
 * Why: execution 5059 of "Gallery Handoff - (Exchange 4) Oficial" got HTTP 500 with Meta
 * code 131000 ("Something went wrong") and answered the platform
 * `{status:"rejected", code:"CHANNEL_POLICY"}`. The platform stores the workflow's code
 * verbatim (web/lib/sendToWebhook.ts), so a catch-all branch that labels every Meta error
 * CHANNEL_POLICY makes a provider failure look like a 24h-window/policy rejection.
 *
 * Rules:
 *   - CHANNEL_POLICY only for codes that ARE channel rules (re-engagement window, rate and
 *     spam limits, policy blocks).
 *   - INVALID_RECIPIENT only for codes that say the recipient cannot receive.
 *   - Everything else — including generic/unknown errors and any HTTP 5xx without a known
 *     policy code — is CHANNEL_ERROR. A generic error is never attributed to the window.
 *   - The provider's numbers are passed through in `provider` (the platform keeps them,
 *     allow-listed); the provider's free-text message is not.
 *   - No retry here: a retry is a human action in the Inbox, deduplicated by idempotency_key.
 *
 * Codes are from the WhatsApp Cloud API error reference; VERIFY against Meta's current
 * documentation before enabling (codes are occasionally added or re-scoped).
 */

const POLICY = new Map([
  [131047, "Re-engagement: more than 24 h since the customer's last message — only an approved template can be sent."],
  [470, "Message outside the 24 h customer-service window (legacy code)."],
  [130429, "Rate limit reached for this phone number."],
  [131048, "Spam rate limit: too many messages to this recipient."],
  [131056, "Pair rate limit: too many messages to the same recipient in a short time."],
  [368, "The sending account is temporarily restricted for a policy violation."],
  [4, "Application request limit reached."],
  [80007, "WhatsApp Business account rate limit reached."],
]);

const RECIPIENT = new Map([
  [131026, "The message could not be delivered to this recipient (not on WhatsApp, or cannot receive it)."],
  [131021, "Recipient and sender are the same number."],
]);

/**
 * @param {{ httpStatus?: number|null, code?: number|string|null, subcode?: number|string|null, traceId?: string|null }} err
 * @returns {{ status: "rejected", code: "CHANNEL_POLICY"|"INVALID_RECIPIENT"|"CHANNEL_ERROR", detail: string, provider: object }}
 */
export function mapWhatsAppSendError(err) {
  const httpStatus = Number.isInteger(err?.httpStatus) ? err.httpStatus : null;
  const code = err?.code === undefined || err?.code === null || err?.code === "" ? null : Number(err.code);
  const provider = {
    ...(httpStatus !== null ? { http_status: httpStatus } : {}),
    ...(code !== null && Number.isFinite(code) ? { code } : {}),
    ...(err?.subcode !== undefined && err?.subcode !== null && err?.subcode !== "" ? { subcode: err.subcode } : {}),
    // Meta's fbtrace_id: the id Meta support needs to investigate this call.
    ...(typeof err?.traceId === "string" && err.traceId ? { trace_id: err.traceId } : {}),
  };
  if (code !== null && POLICY.has(code)) return { status: "rejected", code: "CHANNEL_POLICY", detail: POLICY.get(code), provider };
  if (code !== null && RECIPIENT.has(code)) return { status: "rejected", code: "INVALID_RECIPIENT", detail: RECIPIENT.get(code), provider };
  const detail =
    code === 131000
      ? "WhatsApp returned a generic error (131000). Not a window or policy rejection — check the provider status; retry only from the Inbox."
      : httpStatus !== null && httpStatus >= 500
        ? `WhatsApp returned HTTP ${httpStatus}. Not a window or policy rejection.`
        : "WhatsApp rejected the message with an unclassified error.";
  return { status: "rejected", code: "CHANNEL_ERROR", detail, provider };
}
