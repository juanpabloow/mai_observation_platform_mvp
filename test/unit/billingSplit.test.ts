import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { splitBilling } from '../../src/analytics/billingSplit.js';
import { parseProjectsPage } from '../../src/analytics/openaiBilling.js';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('own project → exact; shared project → split by that day\x27s tokens; nobody → unassigned', () => {
  const r = splitBilling({
    billed: [
      { day: '2026-11-01', projectId: 'proj_gallery', usd: 3 }, // Gallery's own project
      { day: '2026-11-01', projectId: 'proj_default', usd: 4 }, // shared
      { day: '2026-11-02', projectId: 'proj_default', usd: 2 }, // shared, but no bot ran: unassigned
    ],
    projectOf: { gallery: 'proj_gallery' },
    tokens: [{ day: '2026-11-01', byClient: { gallery: 9000, spa: 3000, '': 1000 } }],
  });
  // Gallery's spend that day is explained by its own project: it takes no shared part.
  assert.deepEqual(r.byClient.gallery, { exactUsd: 3, sharedUsd: 0, totalUsd: 3 });
  // The 4 shared dollars go to spa (3000 tokens) and to workflows with no business (1000 tokens).
  close(r.byClient.spa.sharedUsd, 3);
  close(r.unassignedUsd, 1 + 2);
  close(r.totalUsd, 9);
  close(Object.values(r.byClient).reduce((n, c) => n + c.totalUsd, 0) + r.unassignedUsd, r.totalUsd);
});

test('before a business gets its own project it takes a shared part; after, only its exact line', () => {
  const r = splitBilling({
    billed: [
      { day: '2026-10-20', projectId: 'proj_default', usd: 10 }, // before the switch: all shared
      { day: '2026-10-21', projectId: 'proj_gallery', usd: 6 },
      { day: '2026-10-21', projectId: 'proj_default', usd: 1 },
    ],
    projectOf: { gallery: 'proj_gallery' },
    tokens: [
      { day: '2026-10-20', byClient: { gallery: 8, spa: 2 } },
      { day: '2026-10-21', byClient: { gallery: 8, spa: 2 } },
    ],
  });
  close(r.byClient.gallery.exactUsd, 6);
  close(r.byClient.gallery.sharedUsd, 8); // 80 % of day 20
  close(r.byClient.spa.sharedUsd, 2 + 1); // 20 % of day 20, all of day 21's shared dollar
  close(r.unassignedUsd, 0);
});

test('projects page: names, archived status, cursor', () => {
  const p = parseProjectsPage({
    object: 'list',
    data: [
      { id: 'proj_1', object: 'organization.project', name: 'Gallery', status: 'active' },
      { id: 'proj_2', name: null, status: 'archived' },
      { name: 'sin id' },
    ],
    has_more: true,
    last_id: 'proj_2',
  });
  assert.deepEqual(p, {
    rows: [
      { projectId: 'proj_1', name: 'Gallery', status: 'active' },
      { projectId: 'proj_2', name: null, status: 'archived' },
    ],
    after: 'proj_2',
  });
});
