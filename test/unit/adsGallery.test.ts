import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { groupAdsByCampaign, hasCover, shareOfGroup, sortAdsInGroup, tileLabel, type GalleryAd } from '../../web/lib/adsGallery.js';

const ad = (p: Partial<GalleryAd> & { id: string }): GalleryAd => ({ campaign_id: null, campaign_name: null, leads: 0, last_lead_at: null, ...p });

test('groupAdsByCampaign: the unassigned group comes FIRST, then campaigns by total leads desc', () => {
  const groups = groupAdsByCampaign([
    ad({ id: 'a', campaign_id: 'c1', campaign_name: 'Camp 1', leads: 2 }),
    ad({ id: 'b', campaign_id: null, leads: 5 }),
    ad({ id: 'c', campaign_id: 'c2', campaign_name: 'Camp 2', leads: 10 }),
    ad({ id: 'd', campaign_id: 'c1', campaign_name: 'Camp 1', leads: 3 }),
  ]);
  assert.equal(groups[0].isUnassigned, true, 'unassigned first');
  assert.equal(groups[0].key, null);
  assert.equal(groups[0].totalLeads, 5);
  assert.deepEqual(groups.slice(1).map((g) => g.name), ['Camp 2', 'Camp 1'], 'campaigns by total leads desc');
  assert.equal(groups[2].totalLeads, 5, 'Camp 1 = 2 + 3');
  assert.equal(groups[2].adCount, 2);
});

test('groupAdsByCampaign: no unassigned group when every ad has a campaign', () => {
  const groups = groupAdsByCampaign([ad({ id: 'a', campaign_id: 'c1', campaign_name: 'C1', leads: 1 })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].isUnassigned, false);
});

test('sortAdsInGroup: leads desc, then most-recent lead desc, then id', () => {
  const sorted = sortAdsInGroup([
    ad({ id: 'x', leads: 1, last_lead_at: '2026-01-01T00:00:00Z' }),
    ad({ id: 'y', leads: 3 }),
    ad({ id: 'z', leads: 1, last_lead_at: '2026-02-01T00:00:00Z' }),
  ]);
  assert.deepEqual(sorted.map((a) => a.id), ['y', 'z', 'x'], 'y(3) · z(newer lead) · x(older lead)');
});

test('shareOfGroup: bounded ratio, never divides by zero', () => {
  assert.equal(shareOfGroup(3, 12), 0.25);
  assert.equal(shareOfGroup(0, 0), 0);
  assert.equal(shareOfGroup(5, 0), 0, 'group with no leads → 0, not NaN');
  assert.equal(shareOfGroup(10, 5), 1, 'clamped to 1');
});

test('tileLabel + hasCover fallbacks', () => {
  assert.equal(tileLabel({ name: 'Nombre', headline: 'H' }), 'Nombre');
  assert.equal(tileLabel({ name: '   ', headline: 'H' }), 'H', 'blank name falls back to headline');
  assert.equal(tileLabel({ name: null, headline: null }), 'Anuncio sin título');
  assert.equal(hasCover({ cover_url: 'https://x/y.jpg' }), true);
  assert.equal(hasCover({ cover_url: null }), false);
  assert.equal(hasCover({ cover_url: '' }), false);
});
