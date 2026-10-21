/**
 * A server action that THROWS instead of answering — the network dropped, the server
 * could not be reached, a deploy landed in between. Without this the screen's `await`
 * rejects: a save stays on «Guardando…» forever (and its leave guard, which is off while
 * saving, lets Back drop the draft), or the error escapes a transition to the route's
 * error page. Every module screen awaits its actions through safeAction, so a failure
 * always comes back as the `{ ok: false, error }` the screen already shows, with the
 * draft kept and the guard armed again.
 */

export const OFFLINE_ERROR = "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";

export type OfflineResult = { ok: false; error: string; offline: true };

export async function safeAction<T>(run: () => Promise<T>): Promise<T | OfflineResult> {
  try {
    return await run();
  } catch (err) {
    console.error("server action failed", err);
    return { ok: false, error: OFFLINE_ERROR, offline: true };
  }
}
