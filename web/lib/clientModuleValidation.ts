import { z } from "zod";
import { isClientModuleKey, type ClientModuleKey } from "../../src/modules/registry.js";

/**
 * PURE runtime validation for the client-modules action input — no server-only
 * imports, no PostgreSQL, so it is unit-testable and reusable (the modules page
 * reuses isUuid for its route param). The module registry stays the single
 * source of truth for keys (validated via its guard, never a duplicated list).
 *
 * Strict by design: no coercion anywhere. `enabled` must be EXACTLY a boolean
 * ("false", 1, {} are all rejected), and safeParse never throws — null,
 * undefined, strings, and partial objects all return a clean failure.
 *
 * NOTE: imports the registry by RELATIVE path (not the @worker alias) so the
 * pure module also resolves under the root test runner, which doesn't know the
 * web app's path aliases.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one UUID validator — reused by the action schema and the modules page. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export const SetClientModuleInput = z.object({
  clientId: z.string().refine(isUuid, "clientId must be a UUID"),
  moduleKey: z.string().refine(isClientModuleKey, "unknown module key"),
  enabled: z.boolean(), // exact boolean — zod does not coerce
});

export interface ParsedSetClientModuleInput {
  clientId: string;
  moduleKey: ClientModuleKey;
  enabled: boolean;
}

/** safeParse wrapper with the narrowed ModuleKey type. Never throws. */
export function parseSetClientModuleInput(
  input: unknown,
): { ok: true; value: ParsedSetClientModuleInput } | { ok: false } {
  const result = SetClientModuleInput.safeParse(input);
  if (!result.success) return { ok: false };
  // moduleKey passed isClientModuleKey, so the narrow is sound.
  return { ok: true, value: result.data as ParsedSetClientModuleInput };
}
