/**
 * Server-side validation for a service's optional `description` — one pure function so the
 * rule is testable on its own and the admin actions can't drift from it.
 *
 * Rule (mirrors the DB CHECK in migration 1799):
 *   - undefined / null / whitespace-only  → NULL (no description);
 *   - trimmed, plain text, ≤ 2000 characters → stored trimmed;
 *   - longer than 2000 → rejected, naming the field (the action returns it; the DB CHECK is
 *     the backstop). No markdown is interpreted — it is stored and shown as plain text.
 */

export const SERVICE_DESCRIPTION_MAX = 2000;

export type DescriptionResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export function normalizeServiceDescription(raw: string | null | undefined): DescriptionResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null }; // whitespace-only → NULL
  if (trimmed.length > SERVICE_DESCRIPTION_MAX) {
    return {
      ok: false,
      error: `description: must be ${SERVICE_DESCRIPTION_MAX} characters or fewer.`,
    };
  }
  return { ok: true, value: trimmed };
}
