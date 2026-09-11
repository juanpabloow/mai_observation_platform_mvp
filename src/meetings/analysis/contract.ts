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
export const ANALYSIS_PROMPT_VERSION = 1;

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
