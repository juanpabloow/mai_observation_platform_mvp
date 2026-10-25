/**
 * The machine-token capability vocabulary (C-5) — the SINGLE SOURCE OF TRUTH.
 *
 * It lives here, in a module with NO imports, so EVERY consumer can share it: the worker, the
 * web server actions (via `@worker/db/repositories/handoffTokens.js`, which re-exports it) AND
 * the "use client" token editor (via `web/lib/capabilityLabels.ts`). Because this file pulls in
 * no server-only code (no pg, no token repo), bundling it into the client is safe — which is what
 * lets the token-editor checklist render straight from `ALL_CAPABILITIES` instead of a hand-kept
 * copy that can drift (the bug: a capability added here but forgotten in the editor had no
 * checkbox). Dot-separated, stored as `text[]`, deny-by-default: a token grants ONLY the
 * capabilities it lists; an unknown/removed string is simply absent (never a wildcard).
 */
export const ALL_CAPABILITIES = [
  'handoff',
  'scheduling.read',
  'scheduling.write',
  'crm.read',
  'crm.write',
  'pipeline.write',
  'catalog.read',
  'handoff.context.read',
] as const;
export type Capability = (typeof ALL_CAPABILITIES)[number];

/**
 * The authority every pre-C-5 token effectively had — the migration + backfill grant exactly
 * these to existing tokens so no running workflow changes behavior. CRM / pipeline / catalog are
 * deliberately NOT in the legacy set: a new API family is never auto-granted to existing tokens.
 */
export const LEGACY_CAPABILITIES: Capability[] = ['handoff', 'scheduling.read', 'scheduling.write'];

export function isCapability(value: string): value is Capability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

/** Deny-by-default membership check. An unknown string in `have` is ignored. */
export function tokenHasCapability(have: readonly string[] | null | undefined, required: Capability): boolean {
  return Array.isArray(have) && have.includes(required);
}
