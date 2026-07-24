/**
 * Module registry — the PURE source of truth for which per-client modules exist.
 * No PostgreSQL (or any other) dependency: the web app, the worker, migrations
 * commentary, and tests all import the same list from here, so a module key is
 * never string-duplicated across layers.
 *
 * Ownership model (Phase 1): modules belong to a CLIENT (a business within a
 * tenant) — tenant → client → modules. A `client_modules` row enables a module
 * for a client; the ABSENCE of a row means disabled. Workflows will later
 * CONSUME modules (workflow_modules, a future phase) but never own module data.
 */

export const CLIENT_MODULE_KEYS = ["crm", "scheduling", "inbox"] as const;

export type ClientModuleKey = (typeof CLIENT_MODULE_KEYS)[number];

/** Type guard: is `value` one of the known client module keys? */
export function isClientModuleKey(value: string): value is ClientModuleKey {
  return (CLIENT_MODULE_KEYS as readonly string[]).includes(value);
}
