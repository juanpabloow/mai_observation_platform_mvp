/**
 * LA MEDIDA DE LECTURA, en un solo sitio.
 *
 * El dock flotante tiene que compartir los límites izquierdo y derecho de la
 * columna del transcript. Antes eran dos números escritos por separado —1100 px
 * para el texto y 864 px para el dock— y no había nada que impidiera que
 * divergieran; de hecho divergían.
 *
 * Ahora la medida se declara UNA vez y se consume de dos formas, porque los dos
 * consumidores no pueden usar la misma:
 *
 *   · el contenedor del transcript necesita una CLASE, porque se pinta en el
 *     servidor y no puede depender de medir nada;
 *   · el dock necesita un NÚMERO, porque está `fixed` y su posición se calcula
 *     contra el rectángulo real del panel.
 *
 * Las dos salen de la misma constante, y `test/unit/meetingsLayout.test.ts`
 * comprueba que siguen describiendo el mismo ancho. Si alguien cambia uno sin
 * el otro, la prueba falla.
 */

/** La medida de la columna de lectura, en rem. 68.75rem = 1100px. */
export const READING_MEASURE_REM = 68.75;

/** El mismo número en píxeles, para el cálculo del dock. */
export const READING_MEASURE_PX = READING_MEASURE_REM * 16;

/** La misma medida como clase de Tailwind, para el contenedor del transcript. */
export const READING_MEASURE_CLS = "max-w-[68.75rem]";

/**
 * A qué distancia del borde inferior del panel se apoya el dock.
 *
 * 2 px: justo por dentro del borde, no flotando en el medio del contenido ni
 * pegado al borde de la ventana.
 */
export const DOCK_INSET_BOTTOM_PX = 2;

/** Márgenes laterales del dock en móvil, donde no hay panel que respetar. */
export const DOCK_MOBILE_GUTTER_PX = 12;

export interface DockBounds {
  readonly left: number;
  readonly width: number;
  /** Distancia desde el borde inferior de la VENTANA, que es lo que `fixed` usa. */
  readonly bottom: number;
}

/**
 * Los límites del dock, derivados del rectángulo del PANEL y no del contenido
 * de la pestaña activa.
 *
 * Que el ancla sea el panel es lo que hace que la geometría sea idéntica en
 * Resumen, Transcript, Reportes y Evidencia: el panel mide lo mismo en las
 * cuatro, mientras que el contenedor de cada pestaña no (Resumen ocupa todo el
 * ancho, Reportes son dos columnas, Evidencia tiene otro tope).
 *
 * La regla de ancho es la MISMA que aplica el transcript: la medida de lectura
 * cuando cabe, y el ancho del panel cuando no. Con un panel lateral abierto el
 * transcript pasa a ocupar todo el ancho disponible (`max-w-none`), y el dock
 * hace lo mismo — de ahí el `focusMode`.
 */
export function dockBounds(input: {
  readonly panel: { readonly left: number; readonly width: number; readonly bottom: number };
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  /** true = sin paneles laterales, así que el transcript respeta la medida. */
  readonly focusMode: boolean;
  /**
   * Ancho del canal de la barra de desplazamiento, en píxeles.
   *
   * Hay que descontarlo: la columna del transcript vive DENTRO del scroller, y
   * con `scrollbar-gutter: stable` ese canal está siempre reservado. El dock
   * está fuera, así que sin descontarlo quedaba unos 13 px más ancho por la
   * derecha que el texto al que tiene que alinearse. Es el mismo número en las
   * cuatro pestañas, así que la geometría no cambia entre ellas.
   */
  readonly scrollbarGutter?: number;
  /** Por debajo de esto no hay panel que respetar: el dock va casi a todo ancho. */
  readonly mobileBreakpoint?: number;
}): DockBounds {
  const bp = input.mobileBreakpoint ?? 640;
  if (input.viewportWidth < bp) {
    const g = DOCK_MOBILE_GUTTER_PX;
    return {
      left: g,
      width: Math.max(0, input.viewportWidth - g * 2),
      bottom: g,
    };
  }
  // La caja de contenido del panel: su ancho menos el canal de la barra, que es
  // exactamente el espacio en el que se centra la columna de lectura.
  const contenido = Math.max(0, input.panel.width - (input.scrollbarGutter ?? 0));
  const width = input.focusMode ? Math.min(READING_MEASURE_PX, contenido) : contenido;
  return {
    // Centrado respecto al PANEL, no a la ventana: con barra lateral el centro
    // de la ventana no es el centro del panel, y ahí es donde se desalineaba.
    left: input.panel.left + (contenido - width) / 2,
    width,
    bottom: Math.max(0, input.viewportHeight - input.panel.bottom + DOCK_INSET_BOTTOM_PX),
  };
}

/**
 * Ancho del canal de la barra de desplazamiento de este navegador.
 *
 * Se mide una vez con un elemento de sonda y se guarda: varía por sistema
 * operativo y por configuración —en macOS con barras superpuestas son 0 px—, y
 * codificar 15 desalinearía el dock en la mitad de las máquinas.
 */
let cache: number | null = null;
export function scrollbarGutterPx(doc: Document = document): number {
  if (cache !== null) return cache;
  const sonda = doc.createElement('div');
  sonda.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll;';
  doc.body.appendChild(sonda);
  cache = sonda.offsetWidth - sonda.clientWidth;
  sonda.remove();
  return cache;
}

/**
 * El borde de las tarjetas de la región de contenido, en píxeles.
 *
 * El dock se alinea con la columna de lectura, y esa columna vive DENTRO de una
 * tarjeta con `border border-line`. Así que hay que descontar ese borde del
 * rectángulo de la región: sin ello el dock sale 1 px más ancho por cada lado —
 * poco, pero visible justo en el canto de la tarjeta.
 *
 * Antes se obtenía midiendo la propia tarjeta (`clientLeft` / `clientWidth`, la
 * caja de contenido). Dejó de servir cuando Reportes pasó a ser DOS tarjetas
 * independientes: el ancla tiene que ser una sola región, idéntica en las
 * cuatro pestañas, y una región que contiene tarjetas no tiene el borde de
 * ellas. Se declara aquí, junto a la medida de lectura, porque es la misma
 * clase de constante: geometría compartida por dos consumidores que no pueden
 * medirse el uno al otro.
 */
export const PANEL_BORDER_PX = 1;
