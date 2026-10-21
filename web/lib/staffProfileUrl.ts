/**
 * EQUIPO — which professional's profile is open, as a URL.
 *
 * ONE parameter for every width: `?s=<staffId>`. The desktop drawer, the phone detail
 * screen and the deep links from Configuración (AdminPanel) all read and write it, so a
 * link copied on a computer opens the same profile on a phone and the other way round.
 *
 * `?p=` is what the phone screen used to write. It stays readable — an old link still
 * opens its profile — but nothing writes it any more. When a URL carries both, `s` wins.
 *
 * PURE on purpose (no React, no next/navigation) so the page, both trees and the tests
 * share one definition.
 */

/** The canonical parameter — the only one links write. */
export const STAFF_PROFILE_PARAM = "s";
/** The old phone parameter: read as an alias, never written. */
export const STAFF_PROFILE_ALIAS = "p";
/** The drawer tab a deep link opens on (`?dtab=hours`). It belongs to the profile it was
 *  sent with, so opening another profile or closing this one drops it. */
const PROFILE_TAB_PARAM = "dtab";

type ParamValue = string | string[] | undefined | null;

const first = (v: ParamValue): string | null => {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
};

/** The open profile from a page's `searchParams`: the canonical `s`, else the alias `p`,
 *  else none. An empty value counts as absent. */
export function readStaffProfileId(sp: Record<string, ParamValue>): string | null {
  return first(sp[STAFF_PROFILE_PARAM]) ?? first(sp[STAFF_PROFILE_ALIAS]);
}

/**
 * The URL (`?…`, relative to the page) that opens `id`'s profile — or closes it, for
 * `null` — from the CURRENT query. Every other parameter is kept as it is; the profile
 * parameters (`s`, the alias `p`, `dtab`) are replaced, so a link never carries two
 * profiles. `siteId` pins the site the roster is showing, as the screen always did.
 */
export function staffProfileHref(current: string | URLSearchParams, id: string | null, opts: { siteId?: string } = {}): string {
  const p = new URLSearchParams(current);
  p.delete(STAFF_PROFILE_PARAM);
  p.delete(STAFF_PROFILE_ALIAS);
  p.delete(PROFILE_TAB_PARAM);
  if (opts.siteId) p.set("site", opts.siteId);
  if (id) p.set(STAFF_PROFILE_PARAM, id);
  const qs = p.toString();
  // A bare `?` (not "") so a Link to it really drops the query instead of staying put.
  return qs ? `?${qs}` : "?";
}
