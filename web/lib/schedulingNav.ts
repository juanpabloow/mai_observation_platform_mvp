/**
 * Where each scheduling function lives after «Configuración de agenda» stopped being one
 * screen with seven tabs. PURE (no next/*, no DB): the pages, the sidebar, the setup
 * summary and the legacy redirect all build their links here, so a destination is named
 * once. Every page below is the SAME module (`scheduling`) and the SAME gate as the old
 * admin screen (agency or this client's owner) — splitting the screen moved functions,
 * it granted nobody anything.
 *
 *   Sedes                 /scheduling/sites           identity, address, structure
 *   Reglas de reserva     /scheduling/rules           notice, horizon, slot interval
 *   Horarios y ausencias  /scheduling/hours           site + professional hours, and the
 *                                                     one-off closures/absences (#ausencias)
 *   Servicios             /scheduling/services        the service catalogue (single source)
 *   Promociones           /scheduling/promotions      conditions and benefits
 *   Página de reservas    /scheduling/booking-page    link, public info, categories, order
 *
 * Every one of these is a PAGE of the sidebar (lib/sectionNav.ts); none has tabs of its own,
 * so the sidebar is the only menu.
 */

export type SchedulingPage = "sites" | "rules" | "hours" | "services" | "promotions" | "booking-page";

const PATH: Record<SchedulingPage, string> = {
  sites: "/scheduling/sites",
  rules: "/scheduling/rules",
  hours: "/scheduling/hours",
  services: "/scheduling/services",
  promotions: "/scheduling/promotions",
  "booking-page": "/scheduling/booking-page",
};

export function schedulingHref(clientId: string, page: SchedulingPage, query?: Record<string, string>, anchor?: string): string {
  const base = `/clients/${encodeURIComponent(clientId)}${PATH[page]}`;
  const q = new URLSearchParams(query ?? {}).toString();
  return `${q ? `${base}?${q}` : base}${anchor ? `#${anchor}` : ""}`;
}

/** The «Ausencias» section of Horarios y ausencias (where blocks / time off live). */
export const ABSENCES_ANCHOR = "ausencias";

/**
 * Links from the interim pages of this branch (`/scheduling/availability?tab=…`,
 * `/scheduling/exceptions`) — never shipped, but kept resolving: both now land on
 * Horarios y ausencias, at «Ausencias» when they meant the closures.
 */
export function legacyAvailabilityDestination(clientId: string, params: Record<string, string | string[] | undefined>): string {
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const m = one("m") ?? "";
  const absences = one("tab") === "excepciones" || m.startsWith("bloqueo");
  // A phone deep link (`?m=bloqueo-nuevo&plantilla=…`) keeps its screen and params.
  const keep: Record<string, string> = {};
  if (m.startsWith("bloqueo")) {
    for (const k of ["m", "id", "plantilla"]) {
      const v = one(k);
      if (v) keep[k] = v;
    }
  }
  return schedulingHref(clientId, "hours", keep, absences ? ABSENCES_ANCHOR : undefined);
}

/** The interim booking-page tabs (`?tab=enlace|categorias|presentacion`) are now sections of
 *  one page; an old tab link lands on its section. */
export function bookingPageAnchor(tab: string | undefined | null): string | null {
  return tab === "categorias" ? "categorias" : tab === "presentacion" ? "presentacion" : tab === "enlace" ? "enlace" : null;
}

/** The phone screens of the old admin page (`?m=`), and the page that now owns each. */
const MOBILE_SCREEN_PAGE: Record<string, { page: SchedulingPage; anchor?: string }> = {
  sedes: { page: "sites" },
  sede: { page: "sites" },
  "sede-editar": { page: "sites" },
  "sede-nueva": { page: "sites" },
  servicios: { page: "services" },
  servicio: { page: "services" },
  // Blocks live in Horarios y ausencias: the phone opens its «Bloqueos» screen (?m=), the
  // desktop scrolls to the «Ausencias» section (#ausencias).
  bloqueos: { page: "hours", anchor: ABSENCES_ANCHOR },
  "bloqueo-nuevo": { page: "hours", anchor: ABSENCES_ANCHOR },
  reglas: { page: "rules" },
};
/** Phone-screen params that must survive the redirect so a deep link still opens the
 *  same sheet (a site, a service, a new block from a template…). */
const KEPT_PARAMS = ["m", "id", "cat", "plantilla", "vista"];

/**
 * The destination of an old `/clients/<c>/scheduling/admin[?…]` link. The desktop tabs
 * were React state (never in the URL), so only the phone's `?m=` screens can be mapped
 * precisely; anything else lands on Sedes, which carries the setup summary that used to
 * open the admin screen.
 */
export function legacyAdminDestination(clientId: string, params: Record<string, string | string[] | undefined>): string {
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const m = one("m");
  const target = (m && MOBILE_SCREEN_PAGE[m]) || { page: "sites" as SchedulingPage };
  const query: Record<string, string> = {};
  if (m && MOBILE_SCREEN_PAGE[m]) {
    for (const k of KEPT_PARAMS) {
      const v = one(k);
      if (v) query[k] = v;
    }
  }
  return schedulingHref(clientId, target.page, query, "anchor" in target ? target.anchor : undefined);
}
