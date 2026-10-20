/**
 * AT-UI — pure grouping / sort / share helpers for the cover-first Ads gallery. Kept out of the
 * client component so the rules are unit-testable and don't drift. No React, no I/O.
 *
 * Rules: ads are grouped by campaign; the UNASSIGNED group ("Sin campaña") always comes FIRST, then
 * campaign groups by their lead total (desc). Inside a group, ads sort by leads (desc) then by their
 * most recent lead (desc). The share bar is an ad's leads over its group's leads.
 */

/** The minimal ad shape the gallery logic reads (AdItem in the panel is a superset). */
export interface GalleryAd {
  id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  leads: number;
  last_lead_at: string | null;
  name?: string | null;
  headline?: string | null;
  cover_url?: string | null;
}

export interface AdGroup<T extends GalleryAd> {
  /** The campaign id, or null for the unassigned group. */
  key: string | null;
  /** Campaign name, or null for the unassigned group. */
  name: string | null;
  isUnassigned: boolean;
  ads: T[];
  totalLeads: number;
  adCount: number;
}

const leadTime = (a: GalleryAd): number => (a.last_lead_at ? new Date(a.last_lead_at).getTime() : 0);

/** Ads within a group: most leads first, then most-recent lead first, then id for stability. */
export function sortAdsInGroup<T extends GalleryAd>(ads: T[]): T[] {
  return [...ads].sort((a, b) => b.leads - a.leads || leadTime(b) - leadTime(a) || a.id.localeCompare(b.id));
}

/**
 * Group ads by campaign. Returns the unassigned group FIRST (only when it has ads), then campaign
 * groups ordered by total leads desc, then name. Each group's ads are sorted by sortAdsInGroup.
 */
export function groupAdsByCampaign<T extends GalleryAd>(ads: T[]): Array<AdGroup<T>> {
  const byKey = new Map<string | null, T[]>();
  for (const ad of ads) {
    const key = ad.campaign_id ?? null;
    const list = byKey.get(key);
    if (list) list.push(ad);
    else byKey.set(key, [ad]);
  }
  const groups: Array<AdGroup<T>> = [];
  for (const [key, list] of byKey) {
    groups.push({
      key,
      name: key === null ? null : list.find((a) => a.campaign_name)?.campaign_name ?? null,
      isUnassigned: key === null,
      ads: sortAdsInGroup(list),
      totalLeads: list.reduce((n, a) => n + a.leads, 0),
      adCount: list.length,
    });
  }
  groups.sort((a, b) => {
    if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? -1 : 1; // unassigned first
    return b.totalLeads - a.totalLeads || (a.name ?? "").localeCompare(b.name ?? "");
  });
  return groups;
}

/** An ad's share (0..1) of its group's leads. 0 when the group has no leads (never divides by 0). */
export function shareOfGroup(adLeads: number, groupLeads: number): number {
  if (groupLeads <= 0) return 0;
  return Math.min(1, Math.max(0, adLeads / groupLeads));
}

/** The tile's label: the Ads Manager name, else the creative headline, else a neutral fallback. */
export function tileLabel(ad: { name?: string | null; headline?: string | null }): string {
  return (ad.name && ad.name.trim()) || (ad.headline && ad.headline.trim()) || "Anuncio sin título";
}

export function hasCover(ad: { cover_url?: string | null }): boolean {
  return !!(ad.cover_url && ad.cover_url.trim());
}
