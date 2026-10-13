/**
 * PROVIDER DIAGNOSTICS for a rejected human-agent send (docs/handoff-contract-v1.md §5).
 *
 * A rejection's `code` is the workflow's CLASSIFICATION (CHANNEL_POLICY / INVALID_RECIPIENT /
 * CHANNEL_ERROR); it can be wrong — a Meta HTTP 500 / code 131000 ("Something went wrong")
 * was once reported as CHANNEL_POLICY. The optional `provider` object lets the workflow pass
 * the provider's OWN numbers through, so the Inbox keeps the evidence instead of only the
 * label. Pure and allow-listed on purpose:
 *   - only an HTTP status (100–599), short alphanumeric codes and a provider trace id
 *     (8–64 chars, e.g. Meta fbtrace_id) are kept;
 *   - the provider's free-text message is NEVER kept (it can echo the recipient or the
 *     message), and nothing else from the object is read.
 */

const CODE_RE = /^[A-Za-z0-9_.-]{1,16}$/;
/** Meta's `fbtrace_id` — what Meta support asks for to investigate one failed call. */
const TRACE_RE = /^[A-Za-z0-9_-]{8,64}$/;

function cleanCode(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && CODE_RE.test(v.trim())) return v.trim();
  return null;
}

/** "HTTP 500 · código 131000 · subcódigo 2494010 · traza A1Z2…" — or null when nothing usable was sent. */
export function formatProviderDiagnostic(provider: unknown): string | null {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return null;
  const p = provider as Record<string, unknown>;
  const parts: string[] = [];
  const http = p.http_status;
  if (typeof http === "number" && Number.isInteger(http) && http >= 100 && http <= 599) parts.push(`HTTP ${http}`);
  const code = cleanCode(p.code);
  if (code) parts.push(`código ${code}`);
  const sub = cleanCode(p.subcode);
  if (sub) parts.push(`subcódigo ${sub}`);
  if (typeof p.trace_id === "string" && TRACE_RE.test(p.trace_id.trim())) parts.push(`traza ${p.trace_id.trim()}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The detail the Inbox stores: the workflow's detail, then the provider's numbers. */
export function rejectionDetail(detail: string | null, provider: unknown): string | null {
  const diag = formatProviderDiagnostic(provider);
  if (!diag) return detail;
  return detail ? `${detail} (${diag})` : `(${diag})`;
}
