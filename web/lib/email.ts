import "server-only";

/**
 * Minimal transactional email via Resend's REST API — no SDK dependency, so no
 * extra build/runtime surface. SERVER-ONLY: it reads RESEND_API_KEY, which must
 * never reach the client — `import "server-only"` turns any client import into a
 * build error.
 *
 * Degrades gracefully: a missing key / from-address, or any send failure, returns
 * { ok: false, error } rather than throwing, so the caller can surface a clear
 * message (and fall back to copying the accept link) instead of crashing. The API
 * key is NEVER logged or returned.
 */
export const isEmailConfigured = Boolean(
  process.env.RESEND_API_KEY && process.env.INVITE_FROM_EMAIL,
);

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.INVITE_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return { ok: false, error: "Email sending is not configured." };
  }
  const fromName = process.env.RESEND_FROM_NAME?.trim() || "MontserratAI";
  const from = `${fromName} <${fromEmail}>`;

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        // The key lives only in this header for this one call — never logged.
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: params.to, subject: params.subject, html: params.html }),
    });
    if (!res.ok) {
      // Resend's error body (contains none of our secrets) aids diagnosis.
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `Email send failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 180)}` : ""}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, id: body.id ?? "" };
  } catch {
    return { ok: false, error: "Email send failed (network error)." };
  }
}
