import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RawAnalysis } from '../../src/meetings/analysis/contract.js';
import {
  costUsd,
  MODEL_ALIAS,
  PRICING,
  pricingKeyFor,
} from '../../src/meetings/analysis/openai.js';
import { analyze } from '../../src/meetings/analysis/openai.js';

/**
 * Los dos defectos que se vieron en los análisis REALES de staging:
 *
 *   · `owner: "null"` —la cadena, no el valor— de la que salieron un
 *     responsable llamado «null» y unas iniciales «N»;
 *   · `cost_usd = NULL` en las dos filas, porque el precio se buscaba con el
 *     identificador fechado que devuelve el proveedor y ése no estaba en la
 *     tabla de tarifas.
 *
 * Ninguna de estas pruebas llama a OpenAI: el `fetch` es falso.
 */


const CRUDO = (owner: string | null, dueText: string | null): RawAnalysis => ({
  executive: 'Se revisó el índice y se acordó migrarlo.',
  themes: [{ label: 'Migración', segmentIndex: 1 }],
  findings: [
    { kind: 'decision', title: 'Se migra el viernes', detail: null, level: null, segmentIndex: 2, confidence: null },
  ],
  nextSteps: [{ text: 'Avisar al equipo', owner, dueText, segmentIndex: 3 }],
  absences: [],
  caveat: null,
});

// ─────────────────── La tarifa del identificador fechado ──────────────

test('el identificador REAL fechado usa la tarifa de su alias', () => {
  // Éste es el caso que hacía que TODA llamada real guardara coste nulo.
  assert.equal(pricingKeyFor('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini');
  assert.equal(pricingKeyFor('gpt-4o-mini'), 'gpt-4o-mini');
  const esperado = (1549 / 1e6) * 0.15 + (126 / 1e6) * 0.6;
  assert.equal(costUsd('gpt-4o-mini-2024-07-18', 1549, 126), esperado);
  assert.equal(costUsd('gpt-4o-mini', 1549, 126), esperado, 'el alias y el fechado cuestan lo mismo');
  // Las dos filas reales de staging, con sus tokens exactos.
  assert.ok(Math.abs(costUsd('gpt-4o-mini-2024-07-18', 16157, 415)! - 0.00267255) < 1e-9);
});

test('un modelo desconocido sigue dando null, y la equivalencia es CERRADA', () => {
  for (const desconocido of [
    'gpt-5-mini',
    'gpt-4o-mini-2099-01-01',   // fechado pero no declarado
    'gpt-4o-mini-turbo',        // un prefijo NO basta
    'gpt-4o-mini-',
    'GPT-4O-MINI',              // sensible a mayúsculas: no se adivina
    '',
  ]) {
    assert.equal(pricingKeyFor(desconocido), null, `${desconocido} no debe tener tarifa`);
    assert.equal(costUsd(desconocido, 1000, 100), null, `${desconocido} debe dar null, nunca 0`);
  }
  // Y la tabla no crece por accidente: dos entradas, las dos del mismo alias.
  assert.deepEqual(Object.keys(MODEL_ALIAS).sort(), ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']);
  assert.ok(Object.values(MODEL_ALIAS).every((v) => v in PRICING));
});

test('`model_returned` se conserva EXACTO para auditoría', async () => {
  const r = await analyze(
    { text: '[3] 00:30 Ana: Aviso yo.', includedSegments: 1, totalSegments: 1, truncated: false },
    {
      apiKey: 'k',
      model: 'gpt-4o-mini',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-4o-mini-2024-07-18',
            usage: { prompt_tokens: 1549, completion_tokens: 126 },
            choices: [{ message: { content: JSON.stringify(CRUDO('Ana', null)) } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    },
  );
  assert.equal(r.model, 'gpt-4o-mini', 'el que se pidió');
  assert.equal(r.modelReturned, 'gpt-4o-mini-2024-07-18', 'sin normalizar: es la auditoría');
  // Y el coste ya NO es null, que era el defecto.
  assert.ok(r.costUsd !== null, 'la llamada real registra su coste estimado');
  assert.ok(Math.abs(r.costUsd! - 0.00030795) < 1e-9);
});

test('el coste se describe como estimado y la sobreestimación está documentada', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../../src/meetings/analysis/openai.ts', import.meta.url)),
    'utf8',
  );
  assert.match(src, /coste estimado|Coste ESTIMADO/);
  // Los tokens cacheados se facturan más baratos y aquí se cuentan a tarifa
  // completa: eso hay que decirlo, no descubrirlo con la factura.
  assert.match(src, /CACHEADOS|cacheados/);
  assert.match(src, /CONSERVADORA|conservadora/i);
  assert.match(src, /migración/, 'y por qué no se soportan todavía');
  // Sin comentarios: el comentario que EXPLICA por qué no se usa `startsWith`
  // lo nombra, y una aserción que lo cuente como código prohíbe documentar la
  // decisión. Ya me pasó con el rótulo viejo del seguimiento.
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codigo, /startsWith/, 'la equivalencia es cerrada, no por prefijo');
});


