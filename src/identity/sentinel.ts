/**
 * ID-H §1 — SENTINEL IDENTIFIERS.
 *
 * A "sentinel" is a string a MISCONFIGURED workflow sends in place of a real
 * `conversation_ref` or identity value — most commonly the literal "undefined" that an n8n
 * expression renders when a field is absent (e.g. a WhatsApp user with no phone, so no
 * `wa_id`). Keying a conversation or a contact on such a value COLLAPSES every stranger who
 * lacks a phone into ONE shared conversation and ONE shared contact — a privacy defect.
 *
 * The production workflow never sends these (it derives the ref as wa_id || user_id || … and
 * throws when none exists). This guard protects the platform against this client's — or any
 * future client's — misconfiguration, at every write/read boundary:
 *   - routes REFUSE a sentinel with a 422 + stable code (never a silent 2xx, never a 500);
 *   - repositories treat a sentinel as "no identity" (classifyIdentity → null;
 *     getOrCreateConversation → throws) as defense in depth.
 *
 * This is NOT a per-client identifier-schema decision (which identifier is primary, whether a
 * username may be a fallback) — those are phases I-2 / I-4. This only refuses garbage.
 */

/** Case-insensitive, trimmed exact matches that are never a real identifier. */
const SENTINEL_WORDS: ReadonlySet<string> = new Set([
  'undefined',
  'null',
  'nan',
  'none',
  'true',
  'false',
  '[object object]',
]);

/** Re-keyed, unmatchable ref prefix used by the §4 containment tool to quarantine a
 *  collapsed conversation. A quarantined conversation can never be read (/context) or joined
 *  by a new message. No real workflow sends this prefix. */
export const QUARANTINE_PREFIX = 'quarantined:';

/**
 * True when `raw` must be refused as an identifier/conversation_ref: empty after trim, a known
 * placeholder word, an unrendered n8n expression (`{{ … }}`), or an n8n expression literal
 * (starts with `=`). `null`/`undefined` count as sentinels (there is nothing to key on).
 */
export function isSentinelIdentifier(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const trimmed = String(raw).trim();
  if (trimmed === '') return true;
  if (SENTINEL_WORDS.has(trimmed.toLowerCase())) return true;
  if (trimmed.includes('{{')) return true; // an unrendered n8n expression, e.g. "{{ $json.wa_id }}"
  if (trimmed.startsWith('=')) return true; // an n8n expression literal, e.g. "=$json.id"
  return false;
}

/** True when a ref is a quarantined (contained) conversation — never readable or writable. */
export function isQuarantinedRef(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim().toLowerCase().startsWith(QUARANTINE_PREFIX);
}
