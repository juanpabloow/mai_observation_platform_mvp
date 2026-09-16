import { z } from 'zod';
import { normalizeNullable } from '../contract.js';

/**
 * El contrato del reporte con el modelo. UNO para las cuatro plantillas.
 *
 * ── Por qué un esquema genérico y no cuatro ────────────────────────────────
 *
 * Porque el esquema NO es editable y las instrucciones SÍ. Si cada plantilla
 * tuviera su forma fija en código, editar las instrucciones no podría cambiar la
 * estructura del documento y el botón «Editar instrucciones» sería decorativo.
 * Con un esquema de secciones y elementos, la plantilla manda de verdad —«quiero
 * dos secciones, Riesgos y Oportunidades»— y el renderizador sigue siendo uno.
 *
 * ── La protección estructural contra responsables inventados ───────────────
 *
 * `owner` NO es texto libre. Es un `enum` que el servidor construye para cada
 * llamada con la lista cerrada de responsables permitidos —hablantes
 * identificados, participantes reales de la reunión y las etiquetas «Hablante
 * N»— más un valor especial para «quien habla en la cita» y `null`.
 *
 * Eso importa por dónde está puesto: al ir en el `json_schema` con
 * `strict: true`, es el PROVEEDOR el que no puede devolver otra cosa. No es una
 * instrucción del prompt que haya que confiar en que obedezca. Y aun así el
 * servidor lo vuelve a comprobar en `build.ts`, porque «lo impone el proveedor»
 * no es una garantía que queramos creer sin verificar.
 *
 * Y no se usa la regla de que el nombre aparezca literalmente en el segmento
 * citado, porque es falsa en el caso más común: quien dice «yo me encargo» no
 * pronuncia su propio nombre. Por eso existe el valor especial — lo resuelve el
 * servidor con la identidad real del hablante de ese segmento.
 *
 * ── Lo que el modelo no escribe, en ningún caso ────────────────────────────
 *
 * Título, fecha, cliente, duración, lista de participantes, tiempos y marcas.
 * Todo eso sale de la base. El modelo devuelve texto y `segmentIndex`, y el
 * servidor resuelve el resto leyendo ESE segmento.
 */

/** Sube cuando cambian el esquema o las instrucciones internas. Va en el digest. */
export const REPORT_PROMPT_VERSION = 1;

/**
 * «El responsable es quien habla en el segmento citado».
 *
 * Existe para «yo me encargo», «lo miro yo» y «déjamelo a mí»: frases en las que
 * el responsable está perfectamente determinado pero su nombre no se pronuncia.
 * El servidor lo sustituye por la identidad real de ese hablante; si el segmento
 * no tiene hablante asignado, queda `null`.
 */
export const SELF_OWNER = '(quien habla en la cita)';

export const RawReport = z
  .object({
    /** El encabezado narrativo. Dos o tres frases, factuales. */
    purpose: z.string().max(900),
    sections: z
      .array(
        z.object({
          heading: z.string().min(1).max(120),
          /** Texto de la sección, o `null` si sólo son elementos. */
          body: z.string().max(900).nullable(),
          items: z
            .array(
              z.object({
                text: z.string().min(1).max(400),
                /**
                 * Un valor de la lista cerrada, `SELF_OWNER`, o `null`. La
                 * validación contra la lista real se hace en `build.ts`: aquí
                 * no se conoce, porque se construye por llamada.
                 */
                owner: z.string().max(120).nullable(),
                /** El literal de la fecha SI se dijo. Nunca calculada. */
                dueText: z.string().max(80).nullable(),
                segmentIndex: z.number().int().min(0),
              }),
            )
            .max(20),
          segmentIndex: z.number().int().min(0).nullable(),
        }),
      )
      .max(8),
    /** Lo que el reporte prefiere no afirmar, o `null`. */
    caveat: z.string().max(400).nullable(),
  })
  .strict();

export type RawReport = z.infer<typeof RawReport>;

/**
 * El esquema JSON para `response_format`, con la lista cerrada de responsables
 * dentro.
 *
 * `allowedOwners` llega ya normalizada y sin duplicados desde `build.ts`. Si
 * viene vacía, el `enum` conserva `SELF_OWNER` y `null`: un `enum` vacío sería
 * un esquema inválido, y además «quien habla en la cita» sigue siendo
 * resoluble aunque no haya ni un nombre conocido.
 */
export function reportJsonSchema(allowedOwners: readonly string[]): Record<string, unknown> {
  const owners = [...new Set(allowedOwners.filter((o) => o.trim() !== ''))];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['purpose', 'sections', 'caveat'],
    properties: {
      purpose: { type: 'string', maxLength: 900 },
      sections: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['heading', 'body', 'items', 'segmentIndex'],
          properties: {
            heading: { type: 'string', maxLength: 120 },
            body: { type: ['string', 'null'], maxLength: 900 },
            segmentIndex: { type: ['integer', 'null'], minimum: 0 },
            items: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'owner', 'dueText', 'segmentIndex'],
                properties: {
                  text: { type: 'string', maxLength: 400 },
                  // LA LISTA CERRADA. El proveedor no puede devolver un nombre
                  // que no esté aquí, así que un responsable inventado no es
                  // una respuesta posible y no hay que detectarlo después.
                  owner: { type: ['string', 'null'], enum: [...owners, SELF_OWNER, null] },
                  dueText: { type: ['string', 'null'], maxLength: 80 },
                  segmentIndex: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
      caveat: { type: ['string', 'null'], maxLength: 400 },
    },
  };
}

/**
 * Normaliza los NULLABLE antes de construir y persistir: el `"null"` textual y
 * compañía. Misma red que el resumen, y por la misma razón demostrada — los dos
 * análisis que ya hay en staging tienen `owner: "null"` dentro.
 *
 * No toca `text`, `heading` ni `purpose`: ésos son obligatorios, y si el modelo
 * escribiera «null» ahí el problema no es el marcador sino que no produjo nada,
 * y eso lo detecta `esUtilReporte`.
 */
export function normalizeRawReport(raw: RawReport): RawReport {
  return {
    ...raw,
    sections: raw.sections.map((s) => ({
      ...s,
      body: normalizeNullable(s.body),
      items: s.items.map((i) => ({
        ...i,
        owner: normalizeNullable(i.owner),
        dueText: normalizeNullable(i.dueText),
      })),
    })),
    caveat: normalizeNullable(raw.caveat),
  };
}
