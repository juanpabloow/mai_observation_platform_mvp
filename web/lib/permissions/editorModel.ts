/**
 * The ROLE EDITOR's selection logic — pure, so the dependency rules are tested without a
 * browser. The editor only ever offers `grantable` keys (what the viewer may hand out);
 * every change keeps the selection dependency-closed, and says what it changed besides
 * the box that was clicked so the screen can explain it:
 *  - checking a permission also checks what it requires («Editar» needs «Ver»);
 *  - unchecking a permission also unchecks what depends on it.
 */

import {
  PERMISSIONS,
  dependentsOf,
  requiredBy,
  type PermissionArea,
  type PermissionKey,
} from "./catalog";

export interface ToggleResult {
  next: Set<PermissionKey>;
  /** Keys switched on/off as a consequence (not the one clicked). */
  alsoAdded: PermissionKey[];
  alsoRemoved: PermissionKey[];
}

export function togglePermission(
  current: ReadonlySet<PermissionKey>,
  key: PermissionKey,
  grantable: ReadonlySet<PermissionKey>,
): ToggleResult {
  const next = new Set(current);
  const alsoAdded: PermissionKey[] = [];
  const alsoRemoved: PermissionKey[] = [];
  if (!grantable.has(key)) return { next, alsoAdded, alsoRemoved };
  if (next.has(key)) {
    next.delete(key);
    for (const d of dependentsOf(key)) {
      if (next.delete(d)) alsoRemoved.push(d);
    }
  } else {
    // A requirement the viewer can't grant makes the key unavailable (never half-added).
    const reqs = requiredBy(key);
    if (reqs.some((r) => !grantable.has(r))) return { next, alsoAdded, alsoRemoved };
    next.add(key);
    for (const r of reqs) {
      if (!next.has(r)) {
        next.add(r);
        alsoAdded.push(r);
      }
    }
  }
  return { next, alsoAdded, alsoRemoved };
}

export function areaKeys(area: PermissionArea, grantable: ReadonlySet<PermissionKey>): PermissionKey[] {
  return PERMISSIONS.filter((p) => p.area === area && grantable.has(p.key)).map((p) => p.key);
}

/** The group checkbox: all / some (indeterminate) / none of the area's offered keys. */
export function areaState(area: PermissionArea, current: ReadonlySet<PermissionKey>, grantable: ReadonlySet<PermissionKey>): "all" | "some" | "none" {
  const keys = areaKeys(area, grantable);
  const on = keys.filter((k) => current.has(k)).length;
  return on === 0 ? "none" : on === keys.length ? "all" : "some";
}

/** Check (or clear) a whole area — with requirements / dependents across areas. */
export function setArea(
  current: ReadonlySet<PermissionKey>,
  area: PermissionArea,
  on: boolean,
  grantable: ReadonlySet<PermissionKey>,
): ToggleResult {
  let next = new Set(current);
  const alsoAdded: PermissionKey[] = [];
  const alsoRemoved: PermissionKey[] = [];
  const keys = areaKeys(area, grantable);
  for (const k of keys) {
    if (next.has(k) === on) continue;
    const r = togglePermission(next, k, grantable);
    next = r.next;
    alsoAdded.push(...r.alsoAdded.filter((x) => !keys.includes(x)));
    alsoRemoved.push(...r.alsoRemoved.filter((x) => !keys.includes(x)));
  }
  return { next, alsoAdded: [...new Set(alsoAdded)], alsoRemoved: [...new Set(alsoRemoved)] };
}
