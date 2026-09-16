import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ANALYSIS_PROMPT_VERSION,
  normalizeNullable,
  normalizeRawAnalysis,
  type RawAnalysis,
} from '../../src/meetings/analysis/contract.js';
import { SYSTEM_PROMPT } from '../../src/meetings/analysis/prompt.js';
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

// ─────────────────── 1 · La ausencia es el valor, no la palabra ───────────

test('el prompt prohíbe explícitamente las palabras y exige el valor JSON', () => {
  assert.match(SYSTEM_PROMPT, /valor JSON null/);
  for (const palabra of ['"null"', '"undefined"', '"none"', '"n\/a"']) {
    assert.ok(SYSTEM_PROMPT.includes(palabra), `el prompt debe nombrar ${palabra}`);
  }
  // Cambiar el prompt cambia el resultado, así que la versión sube: sin esto no
  // se podrían distinguir los análisis viejos de los nuevos.
  assert.equal(ANALYSIS_PROMPT_VERSION, 2);
});

test('normalizeNullable: el valor, la palabra, la palabra con espacios y lo válido', () => {
  assert.equal(normalizeNullable(null), null, 'null verdadero');
  assert.equal(normalizeNullable('null'), null, 'la cadena «null»');
  assert.equal(normalizeNullable(' null '), null, 'con espacios alrededor');
  assert.equal(normalizeNullable('NULL'), null, 'en mayúsculas');
  assert.equal(normalizeNullable('undefined'), null);
  assert.equal(normalizeNullable('none'), null);
  assert.equal(normalizeNullable('n/a'), null);
  assert.equal(normalizeNullable(''), null, 'vacío es ausencia');
  assert.equal(normalizeNullable('   '), null, 'sólo espacios, también');
  // Lo válido se CONSERVA, incluido el recorte de espacios.
  assert.equal(normalizeNullable('Ana'), 'Ana');
  assert.equal(normalizeNullable('  Bruno  '), 'Bruno');
  assert.equal(normalizeNullable('viernes'), 'viernes');
});

test('no se tocan palabras que una persona puede decir de verdad', () => {
  // Éste es el límite deliberado de la lista: convertirlas en ausencia sería
  // perder información real de la reunión para arreglar un defecto ajeno.
  for (const legitima of ['nadie', 'pendiente', 'sin definir', 'por decidir', 'Nadie aún']) {
    assert.equal(normalizeNullable(legitima), legitima.trim(), `«${legitima}» es una respuesta`);
  }
});

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

test('normalizeRawAnalysis limpia responsable y fecha, y conserva lo válido', () => {
  const casos: Array<[string | null, string | null, string | null, string | null]> = [
    // entrada owner, entrada dueText, esperado owner, esperado dueText
    [null, null, null, null],
    ['null', 'null', null, null],
    [' null ', ' null ', null, null],
    ['Ana', 'el viernes', 'Ana', 'el viernes'],
    ['null', 'el viernes', null, 'el viernes'],
    ['Ana', 'null', 'Ana', null],
  ];
  for (const [oIn, dIn, oOut, dOut] of casos) {
    const r = normalizeRawAnalysis(CRUDO(oIn, dIn));
    assert.equal(r.nextSteps[0].owner, oOut, `owner de ${JSON.stringify(oIn)}`);
    assert.equal(r.nextSteps[0].dueText, dOut, `dueText de ${JSON.stringify(dIn)}`);
  }
});

test('no toca los campos OBLIGATORIOS: ahí «null» no es un marcador, es que no analizó', () => {
  const crudo = { ...CRUDO(null, null), executive: 'null' };
  const r = normalizeRawAnalysis(crudo);
  assert.equal(r.executive, 'null', 'se conserva; lo detecta `esUtil`, no esto');
  assert.equal(r.findings[0].title, 'Se migra el viernes');
  assert.equal(r.nextSteps[0].text, 'Avisar al equipo');
});

test('la normalización ocurre al PARSEAR, antes de construir y persistir', async () => {
  // El proveedor devuelve la palabra; lo que sale de `analyze` ya es el valor.
  const respuesta = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const sucio = CRUDO(' null ', 'null');
  const r = await analyze(
    { text: '[3] 00:30 Ana: Aviso yo.', includedSegments: 1, totalSegments: 1, truncated: false },
    {
      apiKey: 'k',
      fetchImpl: (async () =>
        respuesta({
          model: 'gpt-4o-mini-2024-07-18',
          usage: { prompt_tokens: 900, completion_tokens: 120 },
          choices: [{ message: { content: JSON.stringify(sucio) } }],
        })) as unknown as typeof fetch,
    },
  );
  assert.equal(r.raw.nextSteps[0].owner, null, 'ya viene limpio de analyze()');
  assert.equal(r.raw.nextSteps[0].dueText, null);
  // Y un responsable válido en la misma posición sobrevive.
  const limpio = await analyze(
    { text: '[3] 00:30 Ana: Aviso yo.', includedSegments: 1, totalSegments: 1, truncated: false },
    {
      apiKey: 'k',
      fetchImpl: (async () =>
        respuesta({
          model: 'gpt-4o-mini-2024-07-18',
          usage: { prompt_tokens: 900, completion_tokens: 120 },
          choices: [{ message: { content: JSON.stringify(CRUDO('Ana', 'el viernes')) } }],
        })) as unknown as typeof fetch,
    },
  );
  assert.equal(limpio.raw.nextSteps[0].owner, 'Ana');
  assert.equal(limpio.raw.nextSteps[0].dueText, 'el viernes');
});
