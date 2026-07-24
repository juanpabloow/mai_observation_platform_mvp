/**
 * PURE builder for the sidebar's clientId → enabled-module-keys map. The
 * default ("Unassigned") client can never expose modules — the Phase-1 backfill
 * may have created client_modules rows for it, and those rows are treated as
 * untrusted/inert everywhere — so its rows are EXCLUDED here regardless of
 * their enabled flag. Kept dependency-free so it is unit-testable.
 */

export interface ModuleRowLike {
  client_id: string;
  module_key: string;
  enabled: boolean;
}

export function buildEnabledModulesMap(
  rows: ModuleRowLike[],
  excludeClientId: string | null,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const r of rows) {
    if (!r.enabled) continue;
    if (excludeClientId !== null && r.client_id === excludeClientId) continue; // Unassigned: inert
    (map[r.client_id] ??= []).push(r.module_key);
  }
  return map;
}
