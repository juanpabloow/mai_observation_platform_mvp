/**
 * Qué hace la pantalla cuando el servidor ACEPTA una eliminación — y qué hace
 * cuando no llega a aceptarla.
 *
 * ── Por qué esto es un módulo y no unas líneas dentro del diálogo ──────────
 *
 * Porque es la parte que se puede probar. El diálogo es un componente de
 * cliente: el runner de la raíz no lo puede renderizar, así que si la decisión
 * vive dentro de él lo único que queda es afirmar sobre su código fuente, y un
 * `assert.match` sobre un `router.replace` no distingue «redirige al listado»
 * de «redirige a cualquier sitio». Aquí las tres ramas —listado, ficha y
 * fallo— son funciones puras con entradas y salidas, y las pruebas las
 * ejecutan de verdad.
 *
 * ── «Aceptada» no es «terminada» ──────────────────────────────────────────
 *
 * La ruta responde **202**: reservó la eliminación y el barrido periódico
 * vaciará R2 después de que venzan las URLs de escritura ya firmadas. La
 * pantalla no espera nada de eso. Lo que es cierto en cuanto llega el 202 es
 * que la reunión dejó de estar viva, y como las lecturas de la interfaz sólo
 * devuelven `deletion_state = 'live'`, la fila ya no puede reaparecer en una
 * recarga. Esa es la razón por la que retirarla al instante no es una mentira
 * optimista: es lo mismo que diría el servidor si se le preguntara otra vez.
 */

/** El mismo texto en las dos superficies. Uno solo, para que no divergan. */
export const TOAST_ELIMINADA = 'Reunión eliminada';

/**
 * El aviso viaja entre dos páginas por `sessionStorage`.
 *
 * La ficha redirige al listado, y esa navegación desmonta el proveedor que
 * tendría que estar pintando el aviso. Sin un relevo, el toast de la ficha se
 * mostraría durante los milisegundos que tarda el router y nadie lo leería.
 * `sessionStorage` y no un query param: no ensucia la URL que queda en el
 * historial, y se consume una sola vez.
 */
export const HANDOFF_KEY = 'mai:reuniones:eliminada';

/** Dónde está montado el diálogo. Decide qué pasa tras el 202, nada más. */
export type DeletionSurface = 'list' | 'detail';

export interface TrasAceptar {
  /** Quitar la fila del estado visual ya, sin esperar a R2. */
  readonly retirarDelListado: boolean;
  /** Ruta a la que ir, o null si ya estamos donde hay que estar. */
  readonly redirigirA: string | null;
  readonly toast: string;
}

/**
 * El listado retira la fila y se queda. La ficha no tiene fila que retirar:
 * la reunión que se acaba de eliminar es la que se está mirando, así que lo
 * que hace es irse al listado.
 *
 * El destino se compone con el `clientId` que el servidor ya validó al pintar
 * la página, no con el trozo de URL del navegador.
 */
export function trasAceptar(surface: DeletionSurface, clientId: string): TrasAceptar {
  if (surface === 'detail') {
    return {
      retirarDelListado: false,
      redirigirA: `/clients/${clientId}/reuniones`,
      toast: TOAST_ELIMINADA,
    };
  }
  return { retirarDelListado: true, redirigirA: null, toast: TOAST_ELIMINADA };
}

export interface Resultado {
  /** true sólo si el servidor la aceptó. Nada se retira si esto es false. */
  readonly aceptada: boolean;
  readonly error: string | null;
}

const ACEPTADA: Resultado = { aceptada: true, error: null };

/**
 * Traduce la respuesta HTTP.
 *
 * Cualquier 2xx es aceptación. El contrato de hoy es 202 y las pruebas lo
 * fijan en la ruta, pero la pantalla no debe romperse porque algún día la
 * segunda llamada sobre una reunión ya marcada conteste 200.
 *
 * Todo lo demás es «no aceptada», y no aceptada significa exactamente una
 * cosa: la reunión sigue donde estaba. El diálogo no se cierra, la fila no se
 * va, y el botón vuelve a estar disponible — incluido el 403, donde reintentar
 * no va a funcionar pero cerrarle el botón en la cara al usuario no explica
 * más que el texto.
 */
export function leerRespuesta(status: number, mensajeServidor?: string | null): Resultado {
  if (status >= 200 && status < 300) return ACEPTADA;

  if (status === 401) return { aceptada: false, error: 'Tu sesión caducó. Vuelve a entrar e inténtalo otra vez.' };
  if (status === 403) return { aceptada: false, error: 'No tienes permisos para eliminar esta reunión.' };
  if (status === 404) return { aceptada: false, error: 'Esta reunión ya no está disponible. Recarga la pantalla.' };
  if (status >= 500) {
    return { aceptada: false, error: 'El servidor no pudo procesar la eliminación. Vuelve a intentarlo.' };
  }

  // 409, 422 y compañía: el servidor tiene algo concreto que decir y decirlo
  // es más útil que nuestro texto genérico.
  const limpio = mensajeServidor?.trim();
  return { aceptada: false, error: limpio ? limpio : 'No se pudo eliminar la reunión. Vuelve a intentarlo.' };
}

/** La petición no llegó a salir o no volvió. Tampoco se retira nada. */
export function errorDeRed(): Resultado {
  return { aceptada: false, error: 'No se pudo contactar con el servidor. Vuelve a intentarlo.' };
}
