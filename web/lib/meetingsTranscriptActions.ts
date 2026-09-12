/**
 * Los dos efectos del navegador: escribir en el portapapeles y descargar un
 * fichero. Con sus dependencias INYECTABLES, para poder ejecutarlos en pruebas.
 *
 * ── Por qué inyectadas y no `navigator` y `document` a pelo ────────────────
 *
 * Porque lo que hay que demostrar son cosas que sólo se ven desde fuera: que se
 * copia el texto COMPLETO y no lo que hay en pantalla, que un portapapeles que
 * falla produce un error visible en vez de un silencio, y que el Object URL se
 * REVOCA. Con `navigator.clipboard` escrito dentro, ninguna de las tres se
 * puede comprobar sin un navegador, y las tres son reglas, no detalles.
 *
 * ── Nada sale de la máquina ────────────────────────────────────────────────
 *
 * No hay `fetch`, no hay endpoint y no hay servicio externo. El texto se
 * construye en el navegador y va al portapapeles o a un `Blob`. El contenido de
 * una transcripción es material privado de un tercero: el camino más corto es
 * también el único aceptable.
 */

export interface ClipboardDeps {
  readonly writeText: (text: string) => Promise<void>;
}

/** El portapapeles real, o `null` si este navegador no lo ofrece. */
export function browserClipboard(): ClipboardDeps | null {
  if (typeof navigator === 'undefined') return null;
  const c = navigator.clipboard;
  if (!c || typeof c.writeText !== 'function') return null;
  return { writeText: (text) => c.writeText(text) };
}

/**
 * Copia, y dice si pudo.
 *
 * Devuelve un booleano en vez de propagar: quien llama tiene que enseñar un
 * mensaje distinto en cada caso, y un `try/catch` repetido en el componente es
 * donde se cuela el fallo silencioso. Sin portapapeles —contexto no seguro,
 * permiso denegado, navegador viejo— es `false`, igual que si `writeText`
 * revienta.
 */
export async function copyText(
  text: string,
  clipboard: ClipboardDeps | null = browserClipboard(),
): Promise<boolean> {
  if (clipboard === null || text === '') return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface DownloadDeps {
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Dispara la descarga. En el navegador, un ancla con `download`. */
  readonly triggerDownload: (url: string, fileName: string) => void;
  /**
   * Cuándo revocar. El Object URL no se puede soltar en la misma vuelta del
   * bucle de eventos en que se pincha el ancla: algunos navegadores todavía no
   * han empezado a leerlo y la descarga sale vacía. Por omisión, la siguiente.
   */
  readonly schedule: (fn: () => void) => void;
}

export function browserDownload(): DownloadDeps {
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    triggerDownload: (url, fileName) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      // Fuera del documento: no hace falta insertarlo para que `click()` valga,
      // y así no hay nada que limpiar si algo revienta a mitad.
      a.click();
    },
    schedule: (fn) => setTimeout(fn, 0),
  };
}

/**
 * Descarga un texto como fichero, en el navegador y sin pasar por el servidor.
 *
 * El `Blob` lleva `charset=utf-8` explícito. Sin él, un `.txt` con tildes y
 * eñes se abre como Latin-1 en más sitios de los que gustaría, y «reunión» se
 * lee «reuniÃ³n».
 *
 * Devuelve el url que creó, que es lo que permite comprobar que se revocó.
 */
export function downloadTextFile(
  fileName: string,
  contents: string,
  deps: DownloadDeps = browserDownload(),
): string {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = deps.createObjectURL(blob);
  deps.triggerDownload(url, fileName);
  // SE REVOCA SIEMPRE. Un Object URL que no se suelta mantiene el Blob vivo
  // mientras la pestaña exista, y el Blob aquí es la transcripción entera.
  deps.schedule(() => deps.revokeObjectURL(url));
  return url;
}
