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
    instructions: `Redacta el acta completa de la reunión, con estas secciones y en este orden:

1. "Temas tratados" — los asuntos que se abordaron, en el orden en que se trataron.
2. "Decisiones" — sólo lo que quedó cerrado. Si no se cerró nada, deja la sección vacía.
3. "Compromisos" — lo que alguien asumió hacer, con su responsable y su fecha cuando consten.
4. "Próximos pasos" — lo que queda pendiente sin que nadie lo haya asumido todavía.

En el propósito, explica en dos o tres frases para qué se reunieron.

Prefiero un acta corta y exacta a una larga con relleno. Si una sección no tiene contenido, déjala vacía en lugar de completarla.`,
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

En el propósito, cuenta en tres o cuatro frases qué pasó y en qué quedó.

Después, estas secciones:

1. "Lo que se decidió" — las decisiones, en una línea cada una.
2. "Lo que queda abierto" — lo que no se resolvió y hace falta resolver.
3. "Qué se necesita" — lo que se pidió o hace falta para avanzar, si se dijo algo al respecto.

Sin jerga y sin adjetivos de valoración. Que se entienda leyendo sólo el propósito.`,
  },
  {
    slug: 'riesgos-oportunidades',
    name: 'Riesgos y oportunidades',
    description:
      'Lo que puede salir mal y lo que puede salir bien, tal y como se dijo en la reunión.',
    instructions: `Quiero dos secciones:

1. "Riesgos" — lo que se mencionó que puede salir mal: problemas, bloqueos, dependencias de terceros, plazos apretados, objeciones.
2. "Oportunidades" — lo que se mencionó que puede salir bien: posibilidades que alguien planteó, aperturas, mejoras propuestas.

En el propósito, una o dos frases de contexto.

Importante: sólo lo que se DIJO en la reunión. No añadas riesgos que tú consideres probables ni oportunidades que se te ocurran a ti; si nadie lo mencionó, no existe para este informe.`,
  },
];

/** La plantilla predeterminada de un slug, o `null` si el slug no es de las nuestras. */
export function builtinBySlug(slug: string): BuiltinTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.slug === slug) ?? null;
}
