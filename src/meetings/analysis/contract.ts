import { z } from 'zod';

/**
 * El contrato con el modelo, y lo que hace que sus referencias sean verificables.
 *
 * ── La decisión de diseño ───────────────────────────────────────────────────
 *
 * El modelo NO devuelve tiempos, ni nombres de hablante, ni marcas. Devuelve
 * **índices de segmento**, y nada más. Todo lo demás —el segundo al que saltar, la
 * marca `mm:ss`, quién lo dijo, sus iniciales— lo resolvemos nosotros leyendo ESE
 * segmento de la transcripción.
 *
 * Eso convierte «no inventar referencias» de una súplica en el prompt a una
 * propiedad estructural: un índice sólo puede ser válido o no, y si no lo es se
 * descarta. Un modelo no puede inventar el minuto 7:13 porque nunca escribe
 * minutos; a lo sumo señala un segmento que no existe, y eso se detecta comparando
 * un entero contra una longitud.
 *
 * ── Propuesta contra decisión ───────────────────────────────────────────────
 *
 * No es un campo aparte: es `kind`. `decision` y `agreement` afirman que se acordó;
 * `idea`, `recommendation` y `question` afirman que se planteó. El prompt lo exige y
 * la pantalla ya los etiqueta distinto con `FINDING_KIND`, así que no hace falta un
 * indicador nuevo que pudiera contradecir al que ya existe.
 */

/** Sube cuando cambian las instrucciones o el esquema. Va guardado con el resultado. */
/**
 * 2 — se añadió la regla de que la ausencia es el valor JSON `null` y nunca la
 * palabra. El número existe justamente para esto: los dos análisis que ya hay
 * guardados se generaron con la versión 1 y con `owner: "null"` dentro, y sin
 * este contador no habría forma de distinguirlos de los nuevos.
 */
export const ANALYSIS_PROMPT_VERSION = 2;

/** Tipos que afirman que algo se ACORDÓ, frente a los que sólo lo plantean. */
export const DECIDED_KINDS = ['decision', 'agreement'] as const;
export const PROPOSED_KINDS = ['idea', 'recommendation', 'question'] as const;

const KINDS = [
  'decision', 'agreement', 'conclusion', 'risk', 'dependency', 'question',
  'objection', 'problem', 'need', 'idea', 'feedback', 'recommendation',
] as const;

/**
 * Lo que el modelo debe devolver. Se usa DOS veces: como `json_schema` de la
 * salida estructurada —para que el proveedor lo imponga— y como validación al
 * recibirla, porque «lo impone el proveedor» no es una garantía que queramos creer
 * sin comprobar.
 */
export const RawAnalysis = z
  .object({
    executive: z.string().max(1200),
    themes: z
      .array(z.object({ label: z.string().min(1).max(80), segmentIndex: z.number().int().min(0) }))
      .max(8),
    findings: z
      .array(
        z.object({
          kind: z.enum(KINDS),
          title: z.string().min(1).max(200),
          detail: z.string().max(400).nullable(),
          level: z.enum(['critical', 'warning', 'info']).nullable(),
          segmentIndex: z.number().int().min(0),
          /** 0–100. El prompt pide que sólo baje de 100 cuando de verdad dude. */
          confidence: z.number().int().min(0).max(100).nullable(),
        }),
      )
      .max(20),
    nextSteps: z
      .array(
        z.object({
          text: z.string().min(1).max(300),
          /** null cuando la reunión no dijo quién. NUNCA se deduce. */
          owner: z.string().max(80).nullable(),
          /** Literal de la fecha SI se dijo ("el viernes"). null si no. */
          dueText: z.string().max(80).nullable(),
          segmentIndex: z.number().int().min(0),
        }),
      )
      .max(15),
    /** Ausencias dignas de mención: «no se decidió el precio». */
    absences: z.array(z.string().min(1).max(200)).max(5),
    /** Lo que el análisis prefiere no afirmar. null si no hay nada que advertir. */
    caveat: z.string().max(400).nullable(),
  })
  .strict();

export type RawAnalysis = z.infer<typeof RawAnalysis>;

/**
 * El mismo esquema en JSON Schema, para `response_format: json_schema` con
 * `strict: true`. Se escribe aparte porque el modo estricto del proveedor exige
 * `additionalProperties: false` y que TODA propiedad esté en `required` — los
 * opcionales se expresan como `nullable`, no omitiéndolos.
 */
export function analysisJsonSchema(): Record<string, unknown> {
  const nullableString = (max: number) => ({ type: ['string', 'null'], maxLength: max });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['executive', 'themes', 'findings', 'nextSteps', 'absences', 'caveat'],
    properties: {
      executive: { type: 'string', maxLength: 1200 },
      themes: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'segmentIndex'],
          properties: {
            label: { type: 'string', maxLength: 80 },
            segmentIndex: { type: 'integer', minimum: 0 },
          },
        },
      },
      findings: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title', 'detail', 'level', 'segmentIndex', 'confidence'],
          properties: {
            kind: { type: 'string', enum: [...KINDS] },
            title: { type: 'string', maxLength: 200 },
            detail: nullableString(400),
            level: { type: ['string', 'null'], enum: ['critical', 'warning', 'info', null] },
            segmentIndex: { type: 'integer', minimum: 0 },
            confidence: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
          },
        },
      },
      nextSteps: {
        type: 'array',
        maxItems: 15,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'owner', 'dueText', 'segmentIndex'],
          properties: {
            text: { type: 'string', maxLength: 300 },
            owner: nullableString(80),
            dueText: nullableString(80),
            segmentIndex: { type: 'integer', minimum: 0 },
          },
        },
      },
      absences: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
      caveat: nullableString(400),
    },
  };
}

/* ── Marcadores técnicos que llegan como TEXTO ────────────────────────────── */

/**
 * Ausencias escritas con palabras en lugar del valor JSON `null`.
 *
 * No es una precaución teórica: los dos análisis que ya hay en staging tienen
 * `owner: "null"` —la cadena— y de ahí salieron un responsable llamado «null» y
 * unas iniciales «N». Con salida estructurada estricta el proveedor cumple el
 * ESQUEMA, y un `string | null` se satisface igual con la palabra; el esquema no
 * puede distinguirlas, así que la distinción hay que hacerla aquí.
 *
 * El prompt ya lo prohíbe explícitamente (ver SYSTEM_PROMPT). Esto es la red:
 * una instrucción es una petición, no una garantía.
 *
 * La lista es CORTA y sólo de marcadores técnicos. No incluye palabras que una
 * persona pueda decir de verdad: «nadie», «pendiente» o «sin definir» son
 * respuestas legítimas de una reunión, y convertirlas en ausencia sería perder
 * información real para arreglar un defecto del proveedor.
 */
const MARCADORES = new Set(['null', 'nulo', 'undefined', 'none', 'n/a', 'na', 'nil']);

/** El texto si dice algo; `null` si está vacío o es un marcador técnico. */
export function normalizeNullable(valor: string | null): string | null {
  if (valor === null) return null;
  // Se recorta antes de comparar: llegó `" null "` con espacios en una de las
  // filas, y un `trim` posterior no habría servido de nada.
  const limpio = valor.trim();
  if (limpio === '') return null;
  return MARCADORES.has(limpio.toLowerCase()) ? null : limpio;
}

/**
 * Normaliza los campos NULLABLE de un análisis ya validado, antes de
 * construirlo y persistirlo.
 *
 * Sólo toca campos que el esquema declara `nullable`: `owner`, `dueText`,
 * `detail` y `caveat`. No toca `title`, `text`, `label` ni `executive` —ésos son
 * obligatorios, y si el modelo escribiera «null» ahí el problema no es el
 * marcador sino que no analizó nada, y eso lo detecta `esUtil`.
 */
export function normalizeRawAnalysis(raw: RawAnalysis): RawAnalysis {
  return {
    ...raw,
    findings: raw.findings.map((f) => ({ ...f, detail: normalizeNullable(f.detail) })),
    nextSteps: raw.nextSteps.map((p) => ({
      ...p,
      owner: normalizeNullable(p.owner),
      dueText: normalizeNullable(p.dueText),
    })),
    caveat: normalizeNullable(raw.caveat),
  };
}
