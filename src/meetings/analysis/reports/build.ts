import { stamp, type SourceSegment, type SourceSpeaker } from '../build.js';
import { SELF_OWNER, type RawReport } from './contract.js';

/**
 * De lo que dijo el modelo al reporte que se guarda: cada referencia resuelta
 * contra la transcripción, cada responsable comprobado contra la lista cerrada,
 * cada fecha comprobada contra su evidencia, y lo que no pasa se DESCARTA y
 * consta.
 *
 * El modelo aporta texto y un índice. El segundo al que saltar, la marca, quién
 * lo dijo y sus iniciales salen de leer ese segmento, así que una cita falsa no
 * es una respuesta posible: como mucho hay un índice equivocado, y eso es un
 * error de puntería visible.
 */

/** Quién puede ser responsable. Nombre mostrado y de dónde salió. */
export interface AllowedOwner {
  readonly display: string;
  readonly origin: 'speaker' | 'participant' | 'label';
}

export interface ResolvedCitation {
  readonly segmentIndex: number;
  readonly at: number;
  readonly stamp: string;
  readonly by: string;
  readonly initials: string;
}

export interface ResolvedItem {
  readonly id: string;
  readonly text: string;
  /** `null` cuando nadie la asumió. La pantalla escribe «Sin asignar». */
  readonly owner: string | null;
  /** `null` cuando no se dijo cuándo. La pantalla escribe «No consta». */
  readonly dueText: string | null;
  readonly citation: ResolvedCitation;
}

export interface ResolvedSection {
  readonly heading: string;
  readonly body: string | null;
  readonly items: readonly ResolvedItem[];
  /** La cita de la sección entera, si la dio y era válida. */
  readonly citation: ResolvedCitation | null;
}

/** La cabecera. Sale ENTERA de la base: el modelo no escribe nada de esto. */
export interface ReportHeader {
  readonly title: string;
  readonly clientName: string;
  /** ISO. Cuándo se celebró, o cuándo se subió si nadie declaró lo primero. */
  readonly dateIso: string;
  /** true si `dateIso` es la fecha de subida y no de celebración. */
  readonly dateIsUpload: boolean;
  readonly durationSeconds: number | null;
  /** Los participantes, con nombre real o «Hablante N». Nunca inventados. */
  readonly participants: readonly string[];
}

export interface ResolvedReport {
  readonly header: ReportHeader;
  readonly purpose: string;
  readonly sections: readonly ResolvedSection[];
  readonly caveat: string | null;
}

export interface ReportBuildReport {
  readonly report: ResolvedReport;
  /** Referencias a un segmento inexistente. Se descartan, y consta. */
  readonly droppedRefs: number;
  /** Responsables fuera de la lista cerrada. Pasan a null, y consta. */
  readonly rejectedOwners: number;
  /** Fechas sin evidencia en el segmento citado. Pasan a null, y consta. */
  readonly rejectedDues: number;
  readonly items: number;
}

/**
 * Las iniciales y el nombre mostrado de una etiqueta de hablante.
 *
 * Copia deliberada de la lógica de `analysis/build.ts`: NUNCA se inventa un
 * nombre — un hablante sin identificar se queda en «Hablante 2», que es verdad,
 * en vez de en un nombre plausible.
 */
export function personOf(
  label: string | null,
  speakers: readonly SourceSpeaker[],
): { by: string; initials: string } {
  if (label === null) return { by: 'Sin asignar', initials: '—' };
  const conocido = speakers.find((s) => s.label === label);
  const nombre = conocido?.displayName?.trim();
  if (nombre) {
    const partes = nombre.split(/\s+/).filter(Boolean);
    const iniciales = (partes[0]?.[0] ?? '') + (partes.length > 1 ? partes[partes.length - 1][0] : '');
    return { by: nombre, initials: iniciales.toUpperCase() || '—' };
  }
  const n = /(\d+)\s*$/.exec(label)?.[1];
  const numero = n === undefined ? label : String(Number(n) + 1);
  return { by: `Hablante ${numero}`, initials: numero.slice(-2) };
}

/**
 * La LISTA CERRADA de responsables permitidos.
 *
 * Tres fuentes, y ninguna es el modelo:
 *
 *   1. los hablantes IDENTIFICADOS de esta versión de transcripción;
 *   2. los participantes REALES de la reunión —`meeting_speakers` con nombre—,
 *      que pueden estar identificados sin tener tramos en esta versión;
 *   3. las etiquetas «Hablante N» de los hablantes sin identificar, que son una
 *      identidad verdadera aunque no sepamos su nombre.
 *
 * Se deduplica conservando el primer origen, porque el orden anterior es el de
 * preferencia: si Ana aparece como hablante identificado y como participante,
 * es la misma Ana.
 */
export function allowedOwners(
  speakers: readonly SourceSpeaker[],
  participants: readonly string[],
): AllowedOwner[] {
  const fuera = new Map<string, AllowedOwner>();
  const añadir = (display: string, origin: AllowedOwner['origin']) => {
    const limpio = display.trim();
    if (limpio === '' || limpio === 'Sin asignar') return;
    const clave = normalizar(limpio);
    if (!fuera.has(clave)) fuera.set(clave, { display: limpio, origin });
  };

  for (const s of speakers) {
    const nombre = s.displayName?.trim();
    if (nombre) añadir(nombre, 'speaker');
  }
  for (const p of participants) añadir(p, 'participant');
  for (const s of speakers) {
    if (!s.displayName?.trim()) añadir(personOf(s.label, speakers).by, 'label');
  }
  return [...fuera.values()];
}

/** Sin acentos, sin mayúsculas y sin espacios de más. Para comparar, no para mostrar. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ¿La fecha que dio el modelo está DICHA en el segmento que citó?
 *
 * Comparación normalizada por contención: «el viernes» vale si el segmento dice
 * «lo tenemos para el viernes». No se acepta nada que no esté en ese texto, y
 * no se calcula ninguna fecha — ni se traduce «la semana que viene» a un día.
 *
 * Erra hacia `null` a propósito. Si el modelo parafrasea y la contención falla,
 * se pierde una fecha que quizá era correcta; la alternativa es publicar como
 * compromiso una fecha que nadie dijo, y en un documento que sirve para
 * reclamar, eso es peor.
 */
export function dueTextRespaldada(dueText: string, textoDelSegmento: string): boolean {
  const aguja = normalizar(dueText);
  if (aguja === '') return false;
  return normalizar(textoDelSegmento).includes(aguja);
}

export interface BuildReportInput {
  readonly raw: RawReport;
  readonly segments: readonly SourceSegment[];
  readonly speakers: readonly SourceSpeaker[];
  readonly allowed: readonly AllowedOwner[];
  readonly header: ReportHeader;
}

export function buildReport(input: BuildReportInput): ReportBuildReport {
  const { raw, segments, speakers, allowed, header } = input;

  const porIndice = new Map<number, SourceSegment>();
  for (const s of segments) porIndice.set(s.index, s);
  const permitidos = new Map(allowed.map((o) => [normalizar(o.display), o.display]));

  let dropped = 0;
  let rejectedOwners = 0;
  let rejectedDues = 0;
  let total = 0;

  /** Resuelve un índice contra ESTA versión, o `null`. Descartar es la única respuesta. */
  const cita = (i: number): ResolvedCitation | null => {
    const seg = porIndice.get(i);
    if (seg === undefined) {
      dropped += 1;
      return null;
    }
    const quien = personOf(seg.speakerLabel, speakers);
    return {
      segmentIndex: seg.index,
      at: seg.startSec,
      stamp: stamp(seg.startSec),
      by: quien.by,
      initials: quien.initials,
    };
  };

  /**
   * El responsable, comprobado contra la lista cerrada.
   *
   * `SELF_OWNER` se resuelve con la identidad real del hablante del segmento
   * citado — que es el caso de «yo me encargo», donde el responsable está
   * determinado pero su nombre no se pronuncia. Si ese hablante no está
   * asignado, queda `null`.
   *
   * Cualquier otro valor tiene que estar en la lista. El `enum` del esquema ya
   * lo impide del lado del proveedor; esto es la comprobación de servidor, y
   * cuenta los rechazos para poder registrarlos.
   */
  const responsable = (bruto: string | null, c: ResolvedCitation): string | null => {
    if (bruto === null) return null;
    if (bruto === SELF_OWNER) {
      const seg = porIndice.get(c.segmentIndex);
      if (!seg || seg.speakerLabel === null) {
        rejectedOwners += 1;
        return null;
      }
      return personOf(seg.speakerLabel, speakers).by;
    }
    const permitido = permitidos.get(normalizar(bruto));
    if (permitido === undefined) {
      rejectedOwners += 1;
      return null;
    }
    // Se devuelve la forma CANÓNICA de la lista, no la que escribió el modelo:
    // así «ana ruiz» y «Ana Ruiz» son la misma persona en la pantalla.
    return permitido;
  };

  const sections: ResolvedSection[] = [];
  raw.sections.forEach((s, si) => {
    const items: ResolvedItem[] = [];
    s.items.forEach((it, ii) => {
      const c = cita(it.segmentIndex);
      // Un elemento sin cita válida no se publica. Es la regla que hace que un
      // `segmentIndex` inventado no produzca una línea sin respaldo.
      if (c === null) return;
      total += 1;
      const seg = porIndice.get(c.segmentIndex)!;
      let due: string | null = null;
      if (it.dueText !== null) {
        if (dueTextRespaldada(it.dueText, seg.text)) due = it.dueText.trim();
        else rejectedDues += 1;
      }
      items.push({
        id: `s${si}i${ii}`,
        text: it.text.trim(),
        owner: responsable(it.owner, c),
        dueText: due,
        citation: c,
      });
    });

    const citaSeccion = s.segmentIndex === null ? null : cita(s.segmentIndex);
    const body = s.body?.trim() ? s.body.trim() : null;
    // Una sección que se queda sin cuerpo Y sin elementos no se publica: sería
    // un encabezado suelto prometiendo contenido que se descartó.
    if (body === null && items.length === 0) return;
    sections.push({ heading: s.heading.trim(), body, items, citation: citaSeccion });
  });

  // Si se descartó algo, se DICE. Un reporte al que le faltan líneas sin avisar
  // parece completo, y ése es justo el fallo que no queremos.
  const avisos: string[] = [];
  if (dropped > 0) {
    avisos.push(`${dropped} referencia(s) no correspondían a ningún segmento de esta versión y se descartaron.`);
  }
  if (rejectedOwners > 0) {
    avisos.push(`${rejectedOwners} responsable(s) no correspondían a ningún participante de la reunión y quedaron sin asignar.`);
  }
  if (rejectedDues > 0) {
    avisos.push(`${rejectedDues} fecha(s) no constaban en el segmento citado y se omitieron.`);
  }
  const caveatBase = raw.caveat?.trim() ? raw.caveat.trim() : '';
  const caveat = [caveatBase, ...avisos].filter(Boolean).join(' ');

  return {
    report: {
      header,
      purpose: raw.purpose.trim(),
      sections,
      caveat: caveat === '' ? null : caveat,
    },
    droppedRefs: dropped,
    rejectedOwners,
    rejectedDues,
    items: total,
  };
}

/** ¿Hay algo que enseñar, o el modelo no produjo nada utilizable? */
export function esUtilReporte(r: ResolvedReport): boolean {
  return r.purpose.trim() !== '' || r.sections.length > 0;
}
