/**
 * Where to send someone after they authenticate. Pure + isomorphic (the login form, the
 * server gates and the tests share it).
 *
 * Only a same-site PATH is accepted: no scheme, no host, no protocol-relative `//evil`, no
 * backslash tricks (`/\evil` is `//evil` to some browsers), no control characters. Auth
 * screens and API endpoints are refused too (a loop, or a raw JSON page). The destination
 * page still runs its OWN permission gate — a path the person cannot open bounces them to the
 * first page their role does open (lib/access.ts memberLandingHref), never to someone else's
 * data.
 */
const BLOCKED_PREFIXES = ["/login", "/signup", "/logout", "/forgot-password", "/reset-password", "/api", "/_next"];

export const DEFAULT_AFTER_LOGIN = "/negocios";

export function safeInternalPath(value: string | null | undefined, fallback = DEFAULT_AFTER_LOGIN): string {
  if (!value || typeof value !== "string" || value.length > 2048) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // Encoded control characters / backslashes too (%0d%0a, %5c): never useful in a path.
  try {
    if (/[\u0000-\u001f\u007f\\]/.test(decodeURIComponent(value))) return fallback;
  } catch {
    return fallback;
  }
  let url: URL;
  try {
    url = new URL(value, "https://internal.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://internal.invalid") return fallback;
  const path = url.pathname;
  if (BLOCKED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return fallback;
  return `${path}${url.search}${url.hash}`;
}

/** A short, human name for where the person will land ("Agenda", "Inbox"…), or null. */
export function destinationLabel(path: string): string | null {
  const p = path.split("?")[0] ?? "";
  if (/\/scheduling(\/|$)/.test(p)) return "Agenda";
  if (/\/inbox(\/|$)/.test(p)) return "Inbox";
  if (/\/contacts(\/|$)/.test(p)) return "Contactos";
  if (/\/analytics(\/|$)/.test(p)) return "Resultados";
  if (/\/catalog(\/|$)/.test(p)) return "Productos";
  if (/\/campaigns(\/|$)/.test(p)) return "Campañas";
  if (/\/team(\/|$)/.test(p)) return "Usuarios y accesos";
  if (/^\/settings\/security/.test(p)) return "Seguridad";
  return null;
}
