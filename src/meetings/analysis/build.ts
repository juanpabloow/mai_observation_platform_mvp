import { DECIDED_KINDS, type RawAnalysis } from './contract.js';

/**
 * De lo que dijo el modelo al resumen que se guarda, resolviendo cada referencia
 * contra la transcripción y descartando la que no exista.
 *
 * El modelo sólo aporta TEXTO y un ÍNDICE. El segundo al que saltar, la marca, el
 * hablante y sus iniciales salen de leer ese segmento — así que no hay forma de
 * que invente una atribución: como mucho señala un segmento equivocado, y eso es
 * un error de puntería visible, no una cita falsa.
 */

export interface SourceSegment {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly speakerLabel: string | null;
  readonly text: string;
}

export interface SourceSpeaker {
  readonly label: string;
  readonly displayName: string | null;
}

export interface ResolvedTheme {
  readonly label: string;
  readonly range: string;
  readonly at: number;
}

export interface ResolvedFinding {
  readonly id: string;
  readonly kind: RawAnalysis['findings'][number]['kind'];
  readonly title: string;
  readonly detail?: string;
  readonly level?: 'critical' | 'warning' | 'info';
  readonly by: string;
  readonly initials: string;
  readonly stamp: string;
  readonly at: number;
  readonly confidence?: number;
  readonly sources: readonly ['transcript'];
}

export interface ResolvedStep {
  readonly id: string;
  readonly text: string;
  readonly owner: string | null;
  readonly ownerInitials: string | null;
  readonly due: { label: string; state: 'scheduled' } | null;
  readonly evidence: { initials: string; stamp: string; at: number };
  readonly state: 'todo';
}

export interface ResolvedSummary {
  readonly executive: string;
  readonly highlights: readonly never[];
  readonly themes: readonly ResolvedTheme[];
  readonly findings: readonly ResolvedFinding[];
  readonly nextSteps: readonly ResolvedStep[];
  readonly absences?: readonly string[];
  readonly caveat?: string;
}

export interface BuildReport {
  readonly summary: ResolvedSummary;
  /** Referencias que apuntaban a un segmento inexistente. Se descartan, y consta. */
  readonly droppedRefs: number;
  /** Cuántos hallazgos afirman un acuerdo, frente a los que sólo lo plantean. */
  readonly decided: number;
  readonly proposed: number;
}

/** `mm:ss`, o `h:mm:ss` si pasa de la hora. Sin redondeos que muevan el salto. */
export function stamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const dos = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

/**
 * Las iniciales de quien habla. De su nombre si lo tiene; si no, del número de la
 * etiqueta. NUNCA se inventa un nombre: un hablante sin identificar se queda en
 * «Hablante 2», que es verdad, en vez de en un nombre plausible.
 */
function person(
  label: string | null,
  speakers: readonly SourceSpeaker[],
): { by: string; initials: string } {
  if (label === null) return { by: 'Sin asignar', initials: '—' };
  const known = speakers.find((s) => s.label === label);
  const nombre = known?.displayName?.trim();
  if (nombre) {
    const partes = nombre.split(/\s+/).filter(Boolean);
    const iniciales = (partes[0]?.[0] ?? '') + (partes.length > 1 ? partes[partes.length - 1][0] : '');
    return { by: nombre, initials: iniciales.toUpperCase() || '—' };
  }
  const n = /(\d+)\s*$/.exec(label)?.[1];
  const numero = n === undefined ? label : String(Number(n) + 1);
  return { by: `Hablante ${numero}`, initials: numero.slice(-2) };
}

export function buildSummary(
  raw: RawAnalysis,
  segments: readonly SourceSegment[],
  speakers: readonly SourceSpeaker[],
): BuildReport {
  const porIndice = new Map<number, SourceSegment>();
  for (const s of segments) porIndice.set(s.index, s);

  let dropped = 0;
  /** Resuelve un índice, o `null` si no existe. Descartar es la única respuesta. */
  const ref = (i: number): SourceSegment | null => {
    const seg = porIndice.get(i);
    if (seg === undefined) {
      dropped += 1;
      return null;
    }
    return seg;
  };

  const themes: ResolvedTheme[] = [];
  for (const t of raw.themes) {
    const seg = ref(t.segmentIndex);
    if (seg === null) continue;
    themes.push({ label: t.label, range: `${stamp(seg.startSec)}–${stamp(seg.endSec)}`, at: seg.startSec });
  }

  const findings: ResolvedFinding[] = [];
  let decided = 0;
  let proposed = 0;
  raw.findings.forEach((f, i) => {
    const seg = ref(f.segmentIndex);
    if (seg === null) return;
    const quien = person(seg.speakerLabel, speakers);
    if ((DECIDED_KINDS as readonly string[]).includes(f.kind)) decided += 1;
    else proposed += 1;
    findings.push({
      id: `f${i}`,
      kind: f.kind,
      title: f.title,
      ...(f.detail ? { detail: f.detail } : {}),
      ...(f.level ? { level: f.level } : {}),
      by: quien.by,
      initials: quien.initials,
      stamp: stamp(seg.startSec),
      at: seg.startSec,
      // Sólo se muestra cuando de verdad baja: un número en cada línea enseña a
      // ignorarlo. El prompt pide que omita el campo cuando no duda.
      ...(f.confidence !== null && f.confidence < 100 ? { confidence: f.confidence } : {}),
      sources: ['transcript'] as const,
    });
  });

  const nextSteps: ResolvedStep[] = [];
  raw.nextSteps.forEach((p, i) => {
    const seg = ref(p.segmentIndex);
    if (seg === null) return;
    const quien = person(seg.speakerLabel, speakers);
    const owner = p.owner?.trim() ? p.owner.trim() : null;
    nextSteps.push({
      id: `s${i}`,
      text: p.text,
      // `null` cuando la reunión no dijo quién. La pantalla lo muestra sin dueño
      // en vez de atribuirlo a quien hablaba, que es lo fácil y lo falso.
      owner,
      ownerInitials: owner ? (owner.trim()[0] ?? '').toUpperCase() || null : null,
      // Sin fecha dicha, no hay fecha. La pantalla escribe «Sin fecha».
      due: p.dueText?.trim() ? { label: p.dueText.trim(), state: 'scheduled' } : null,
      evidence: { initials: quien.initials, stamp: stamp(seg.startSec), at: seg.startSec },
      state: 'todo',
    });
  });

  const absences = raw.absences.filter((a) => a.trim().length > 0);
  const caveatBase = raw.caveat?.trim() ? raw.caveat.trim() : '';
  // Si se descartó alguna referencia, se DICE. Un resumen al que le faltan citas
  // sin avisar parece completo, y ése es justo el fallo que no queremos.
  const aviso =
    dropped > 0
      ? `${dropped} referencia(s) del análisis no correspondían a ningún segmento y se descartaron.`
      : '';
  const caveat = [caveatBase, aviso].filter(Boolean).join(' ');

  return {
    summary: {
      executive: raw.executive.trim(),
      highlights: [],
      themes,
      findings,
      nextSteps,
      ...(absences.length > 0 ? { absences } : {}),
      ...(caveat ? { caveat } : {}),
    },
    droppedRefs: dropped,
    decided,
    proposed,
  };
}
