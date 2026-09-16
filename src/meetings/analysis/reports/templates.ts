/**
 * Las cuatro plantillas predeterminadas, EN CÓDIGO.
 *
 * ── Por qué en código y no sembradas en la base ────────────────────────────
 *
 * Porque si el predeterminado viviera en la base, «Restaurar predeterminado»
 * significaría «vuelve a lo que se sembró», y una siembra mal escrita no se
 * podría arreglar nunca desde la aplicación. Aquí el predeterminado es lo que
 * dice este fichero: restaurar escribe ESTE texto como una versión nueva, con
 * su fila de auditoría, sin borrar el historial.
 *
 * ── Qué hay aquí y qué no ──────────────────────────────────────────────────
 *
 * Aquí está sólo la parte EDITABLE: nombre, descripción e instrucciones en
 * lenguaje natural. El system prompt, el esquema JSON, las guardas contra
 * invención, `store: false`, la lista cerrada de responsables y la resolución
 * de citas están en `prompt.ts`, `contract.ts` y `build.ts`, no se exponen por
 * ninguna API y no se pueden editar. Un usuario puede cambiar QUÉ quiere que el
 * reporte destaque; no puede cambiar las reglas que hacen el resultado
 * verificable.
 *
 * Las instrucciones están escritas en el mismo registro en el que las
 * escribiría una persona, a propósito: son el ejemplo de lo que se espera que
 * alguien edite.
 */

export interface BuiltinTemplate {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  {
    slug: 'acta-general',
    name: 'Acta general',
    description:
      'El acta completa de la reunión: propósito, temas tratados, decisiones, compromisos y próximos pasos.',
    instructions: `Redacta el acta completa de la reunión con estas cuatro secciones, en este orden y con estos nombres exactos:

1. "Temas tratados" — los asuntos que se abordaron, en el orden en que se trataron.
2. "Decisiones" — sólo lo que quedó cerrado.
3. "Compromisos" — lo que alguien asumió hacer, con su responsable y su fecha cuando consten.
4. "Próximos pasos" — lo que queda pendiente sin que nadie lo haya asumido todavía.

LO MÁS IMPORTANTE: cada hecho concreto va como un PUNTO DE LISTA de su sección, nunca sólo en el texto corrido. Un punto de lista lleva su cita al momento del audio; un párrafo no. Si escribes "se acordó migrar el índice" dentro del texto de la sección en lugar de como punto, ese acuerdo queda en el acta sin poder comprobarse, y un acta que no se puede comprobar no sirve para reclamar nada.

Así que:
- Usa el texto de la sección sólo para enlazar o dar contexto, y que no contenga ningún hecho que no esté también como punto.
- En el propósito, explica en dos o tres frases para qué se reunieron. Los hechos concretos no van aquí: van en sus secciones, como puntos.

SECCIONES SIN CONTENIDO: si una sección no tiene nada, déjala vacía. No la rellenes con algo parecido ni conviertas una discusión abierta en una decisión. Si te parece relevante que esté vacía —por ejemplo, que no se cerrara ninguna decisión— dilo en el caveat.

Prefiero un acta corta y exacta a una larga con relleno.`,
  },
  {
    slug: 'decisiones-compromisos',
    name: 'Decisiones y compromisos',
    description:
      'Sólo lo que se acordó y lo que alguien asumió. Para repartir trabajo después de la reunión.',
    instructions: `Quiero únicamente dos secciones, sin narrativa alrededor:

1. "Decisiones" — lo que quedó cerrado, una línea por decisión.
2. "Compromisos" — lo que alguien asumió hacer, con responsable y fecha cuando consten.

En el propósito, una sola frase que diga de qué iba la reunión.

No incluyas temas tratados ni contexto: si algo no es una decisión ni un compromiso, no va. Si la reunión no cerró nada, dilo en el caveat y deja las secciones vacías.`,
  },
  {
    slug: 'informe-ejecutivo',
    name: 'Informe ejecutivo',
    description:
      'Una lectura breve para quien no asistió: qué pasó, qué se decidió y qué hace falta.',
    instructions: `Escribe para alguien que no estuvo en la reunión y tiene dos minutos.

En el propósito, cuenta en tres o cuatro frases qué pasó y en qué quedó. Sin hechos concretos: los hechos van en las secciones, como puntos.

Después, estas tres secciones:

1. "Lo que se decidió" — las decisiones que quedaron cerradas.
2. "Lo que queda abierto" — lo que no se resolvió y hace falta resolver.
3. "Qué se necesita" — lo que se pidió o hace falta para avanzar, si se dijo algo al respecto.

CADA AFIRMACIÓN COMPROBABLE VA COMO UN PUNTO DE LISTA de su sección, y no dentro del texto. El punto lleva su cita al audio; el párrafo no. Quien lea esto no estuvo en la reunión, así que necesita poder ir al minuto exacto y oírlo — si el hecho está en prosa, no puede.

Cada punto debe ir a un momento distinto y concreto de la reunión. No mandes todos los puntos al mismo sitio.

Si una sección no tiene contenido, déjala vacía y, si hace falta, explícalo en el caveat. Sin jerga y sin adjetivos de valoración.`,
  },
  {
    slug: 'riesgos-oportunidades',
    name: 'Riesgos y oportunidades',
    description:
      'Lo que puede salir mal y lo que puede salir bien, tal y como se dijo en la reunión.',
    instructions: `Quiero dos secciones:

1. "Riesgos" — lo que se mencionó que puede salir mal: problemas, bloqueos, dependencias de terceros, plazos apretados, objeciones.
2. "Oportunidades" — lo que se mencionó que puede salir bien: posibilidades que alguien planteó, aperturas, mejoras propuestas.

CADA RIESGO Y CADA OPORTUNIDAD VA COMO UN PUNTO DE LISTA, con su cita al momento en que se dijo. Nunca en el texto de la sección: un riesgo que no se puede ir a escuchar es una opinión, no un hallazgo. El texto de la sección, si lo usas, es sólo para dar contexto y no debe contener ninguno.

En el propósito, una o dos frases de contexto, sin hechos concretos.

SÓLO LO QUE SE DIJO. No añadas riesgos que te parezcan probables ni oportunidades que se te ocurran a ti: si nadie lo mencionó, no existe para este informe. Y si una de las dos secciones está vacía porque no se habló de eso, déjala vacía y dilo en el caveat — es un resultado correcto y más útil que rellenarla.`,
  },
];

/** La plantilla predeterminada de un slug, o `null` si el slug no es de las nuestras. */
export function builtinBySlug(slug: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
