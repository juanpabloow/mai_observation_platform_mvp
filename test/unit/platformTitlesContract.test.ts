import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('ONE page title across the platform: same class, size and band on every screen', () => {
  const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
  const css = r('web/app/globals.css');
  assert.ok(/\.u-page-title \{ font-size: 24px; line-height: 30px; \}/.test(css), '24px / 30px from md up, in px');
  assert.ok(r('web/components/scheduling/agenda/AgendaChrome.tsx').includes('export const AG_H1 = "u-page-title '), 'Agenda, Equipo, Horarios');
  const surface = r('web/components/ui/module/ModuleSurface.tsx');
  assert.equal(surface.match(/<h1 className="u-page-title /g)?.length, 2, 'Servicios, Productos, Promociones… (SurfaceHeader + SurfaceTop)');
  assert.equal(surface.match(/md:px-\[20px\] md:pt-\[10px\]/g)?.length, 2, "the same band as Agenda's (20px sides, 10px top)");
  assert.ok(r('web/components/ui/PageTitle.tsx').includes('<h1 className="u-page-title '), 'Contactos, Inbox, Automatizaciones, Reuniones (PageHeading)');
  for (const f of ['web/components/pipeline/PipelinePanel.tsx', 'web/components/scheduling/AdminPanel.tsx', 'web/components/campaigns/AttributionSettingsPanel.tsx']) {
    assert.ok(r(f).includes('<h1 className="u-page-title '), f);
  }
});
