/**
 * R0 REPLICA — how the deployed image f7c4cf7 classified an inbound value, copied VERBATIM
 * from f7c4cf7:src/scheduling/phone.ts (normalizeE164, default path: the one
 * classifyIdentity uses) and f7c4cf7:src/db/repositories/contactIdentities.ts
 * (classifyIdentity). Frozen on purpose: it is the rollback target the tests compare
 * against, so it must NOT follow later changes to the live code.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validE164(candidate: string): string | null {
  return /^\+[1-9][0-9]{6,14}$/.test(candidate) ? candidate : null;
}

export function r0NormalizeE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (digits[0] === '0') return null;
  return validE164(`+${digits}`);
}

export function r0ClassifyIdentity(raw: string | null | undefined): { kind: 'phone' | 'email' | 'external'; value: string } | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const phone = r0NormalizeE164(trimmed);
  if (phone) return { kind: 'phone', value: phone };
  const lower = trimmed.toLowerCase();
  if (EMAIL_RE.test(lower)) return { kind: 'email', value: lower };
  return { kind: 'external', value: trimmed };
}
