/**
 * PURE, ISOMORPHIC helpers for the per-client "current workflow" scope cookie
 * (Phase W-1). No `next/headers`, no `document` — safe to import from BOTH the
 * server reader (`lib/workflowScope.ts`) and the client provider
 * (`components/ScopeProvider.tsx`), so the two never disagree on the format.
 *
 * SHAPE (judgment call): ONE cookie holding a compact map, not one cookie per
 * client. A single cookie keeps a tenant with many clients from spraying dozens
 * of cookies, and the server reads it with a single `cookies().get()`. The value
 * is a bounded `clientId:workflowId` list joined by `|`:
 *
 *     <clientId>:<workflowId>|<clientId>:<workflowId>|…
 *
 * Both id kinds are URL-safe (client ids are UUIDs; n8n workflow ids are
 * nanoid-style [A-Za-z0-9]), so no `:` / `|` ever appears INSIDE an id and the
 * value needs no percent-encoding. 'all' is represented by ABSENCE (an entry is
 * only written for a specific workflow), so the common case stores nothing.
 * The map is capped at SCOPE_MAX_ENTRIES with most-recent-wins eviction, so the
 * cookie can never grow unbounded regardless of how many clients a user visits.
 */

export const SCOPE_COOKIE = "wf_scope";
/** ~30 days, in seconds (matches the spec's "~30d"). */
export const SCOPE_MAX_AGE = 60 * 60 * 24 * 30;
/** Hard cap on remembered clients — bounds the cookie size (LRU-ish eviction). */
export const SCOPE_MAX_ENTRIES = 30;

/** clientId → the client's remembered workflow id (absence ⇒ 'all'). */
export type ScopeMap = Record<string, string>;

/** Parse the raw cookie value into a map. Tolerant of malformed input (→ {}). */
export function parseScopeMap(raw: string | null | undefined): ScopeMap {
  if (!raw) return {};
  const out: ScopeMap = {};
  for (const pair of raw.split("|")) {
    if (!pair) continue;
    const i = pair.indexOf(":");
    if (i <= 0) continue; // no separator, or empty clientId
    const clientId = pair.slice(0, i);
    const workflowId = pair.slice(i + 1);
    if (clientId && workflowId) out[clientId] = workflowId;
  }
  return out;
}

/** Serialize a map back to the compact cookie value (stable key order). */
export function serializeScopeMap(map: ScopeMap): string {
  return Object.keys(map)
    .filter((k) => map[k])
    .map((k) => `${k}:${map[k]}`)
    .join("|");
}

/**
 * Return a NEW map with `clientId`'s scope set. `workflowId === null` (or empty)
 * clears the entry (back to 'all'). A set re-inserts the key LAST so the map acts
 * as a most-recently-used list; the oldest entries are evicted once the map would
 * exceed SCOPE_MAX_ENTRIES. Pure — never mutates the input.
 */
export function setScopeEntry(map: ScopeMap, clientId: string, workflowId: string | null): ScopeMap {
  const next: ScopeMap = { ...map };
  delete next[clientId]; // drop first so a re-set moves the key to the end
  if (workflowId) next[clientId] = workflowId;

  const keys = Object.keys(next);
  if (keys.length > SCOPE_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - SCOPE_MAX_ENTRIES)) delete next[k];
  }
  return next;
}

/** Shallow map equality — used to skip needless React state updates / cookie writes. */
export function sameScopeMap(a: ScopeMap, b: ScopeMap): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}
