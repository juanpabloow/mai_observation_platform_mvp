/**
 * Webhook URL policy (v1): HTTPS required, with http:// allowed ONLY for localhost
 * (dev/testing). Pure + client-safe, so the registration form can pre-validate and
 * the server action + send pipeline can re-check (defense in depth). This is also
 * the natural chokepoint for future SSRF egress hardening (block private ranges /
 * redirects) — see scaling-todo.md.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }
  if (parsed.protocol === "https:") return { ok: true, url: parsed.toString() };
  if (parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname)) {
    return { ok: true, url: parsed.toString() };
  }
  return {
    ok: false,
    error: "Webhook URL must be https:// (http:// is allowed only for localhost).",
  };
}
