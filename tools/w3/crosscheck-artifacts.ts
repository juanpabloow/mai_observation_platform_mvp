/**
 * ¿Lee mai exactamente lo que el worker escribe?
 *
 *     npx tsx tools/w3/crosscheck-artifacts.ts <directorio-con-los-.ndjson.gz>
 *
 * Las pruebas de cada lado comprueban su mitad del contrato: el worker afirma que
 * emite `words` recortadas y en orden, y mai afirma que las parsea y parte por ellas.
 * Ninguna de las dos detecta que las dos mitades hayan dejado de encajar — y son
 * lenguajes distintos, en máquinas distintas, versionados por separado.
 *
 * Esto coge los artefactos QUE PRODUJO el worker y los pasa por el parser real de mai
 * y por `alignSegments`. Es la única comprobación que ve la junta.
 */
import { readFileSync } from 'node:fs';
import {
  alignSegments,
  parseDiarizationArtifact,
  parseTranscriptArtifact,
} from '../../src/meetings/artifacts.js';

const SP = process.argv[2];
const transcript = parseTranscriptArtifact(readFileSync(`${SP}/x-transcript.ndjson.gz`));
const diarization = parseDiarizationArtifact(readFileSync(`${SP}/x-diarization.ndjson.gz`));

console.log('cabecera transcript :', JSON.stringify(transcript.header));
console.log('cabecera diarizacion:', JSON.stringify(diarization.header));
console.log('segmentos           :', transcript.segments.length);
console.log('con palabras        :', transcript.segments.filter((s) => s.words).length);
console.log('palabras totales    :', transcript.segments.reduce((n, s) => n + (s.words?.length ?? 0), 0));

const { segments, talkSharePct } = alignSegments(transcript.segments, diarization.turns);
console.log('');
console.log('bloques tras alinear:', segments.length, '(de', transcript.segments.length, 'segmentos)');
console.log('reparto             :', JSON.stringify(talkSharePct));
console.log('tentativos          :', segments.filter((s) => s.speakerUncertain).length);
console.log('con solape          :', segments.filter((s) => s.overlap).length);
console.log('indices densos      :', segments.every((s, i) => s.index === i));

// La invariante que no se puede romper: ni una palabra de menos ni de mas.
const plano = (v: string) => v.replace(/\s+/g, ' ').trim();
const antes = plano(transcript.segments.map((s) => s.text).join(' '));
const despues = plano(segments.map((s) => s.text).join(' '));
console.log('texto intacto       :', antes === despues);
if (antes !== despues) {
  console.log('  ANTES  :', antes.slice(0, 120));
  console.log('  DESPUES:', despues.slice(0, 120));
}
console.log('');
console.log('primeros bloques:');
for (const s of segments.slice(0, 6)) {
  console.log(`  ${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)} ${s.speakerLabel} ${s.speakerUncertain ? '(tentativo)' : ''} ${s.text.slice(0, 46)}`);
}
