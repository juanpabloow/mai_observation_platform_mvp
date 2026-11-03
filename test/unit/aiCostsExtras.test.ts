import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assignChartColors, CHART_COLORS, isChartColorSlot } from '../../src/analytics/chartColors.js';
import { parseEnvRate, parseTrmResponse, TRM_URL } from '../../src/analytics/usdCop.js';

test('chart colors: a chosen slot is kept, the rest fill the free slots by name, overflow is gray', () => {
  const m = assignChartColors([
    { key: 'b', name: 'Zeta', chartColor: 's1' },
    { key: 'a', name: 'Alfa', chartColor: null },
    { key: 'c', name: 'Beta', chartColor: 'not-a-slot' },
  ]);
  assert.equal(m.get('b'), 's1');
  assert.equal(m.get('a'), 's2'); // first free slot, by name: Alfa before Beta
  assert.equal(m.get('c'), 's3'); // an invalid stored value is treated as automatic
  const many = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, name: `N${i}`, chartColor: null }));
  const mm = assignChartColors(many);
  assert.equal(mm.get('k7'), 's8');
  assert.equal(mm.get('k8'), null);
  assert.equal(CHART_COLORS.length, 8);
  assert.ok(isChartColorSlot('s8') && !isChartColorSlot('s9') && !isChartColorSlot('#fff'));
});

test('TRM: the official response parses; anything odd or out of band is refused', () => {
  const ok = parseTrmResponse([{ valor: '3182.99', vigenciadesde: '2026-10-31T00:00:00.000', vigenciahasta: '2026-11-03T00:00:00.000' }]);
  assert.deepEqual(ok, { rate: 3182.99, source: 'trm', validFrom: '2026-10-31', validTo: '2026-11-03' });
  for (const bad of [null, {}, [], [{}], [{ valor: 'abc' }], [{ valor: '12' }], [{ valor: '999999' }], [{ valor: { x: 1 } }], 'x']) {
    assert.equal(parseTrmResponse(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(parseEnvRate('3900'), { rate: 3900, source: 'env', validFrom: null, validTo: null });
  assert.equal(parseEnvRate(undefined), null);
  assert.equal(parseEnvRate('0'), null);
  // The endpoint is a constant on the official host, never built from input.
  assert.ok(TRM_URL.startsWith('https://www.datos.gov.co/resource/32sa-8pi3.json?'));
});
