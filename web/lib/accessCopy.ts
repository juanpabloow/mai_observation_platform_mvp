/**
 * Copy for the "your session ended" states (4e/4f/4i) — pure, shared by the login page (server)
 * and the session guard (client), so the reason a tab was closed reads the same everywhere.
 */
export type SessionEndReason = "idle" | "max" | "persist" | "revoked" | "ended" | "signed-out";

export function parseEndReason(v: string | null | undefined): SessionEndReason | null {
  return v === "idle" || v === "max" || v === "persist" || v === "revoked" || v === "ended" || v === "signed-out" ? v : null;
}

export const END_REASON_MESSAGE: Record<Exclude<SessionEndReason, "revoked">, string> = {
  idle: "Pasaron 2 horas sin actividad en una sesión de equipo compartido.",
  max: "Las sesiones sin «Mantener sesión» duran como máximo 12 horas.",
  persist: "Pasaron 30 días desde que elegiste mantener la sesión en este equipo.",
  ended: "La sesión venció o se cerró desde otro lugar.",
  "signed-out": "Cerraste la sesión en este equipo. Tus otras sesiones siguen abiertas.",
};

/** The channel tabs of the same browser use to agree on activity and sign-outs. */
export const SESSION_CHANNEL = "mai-session";

/** Remembers the last business picked in /negocios (a navigation preference, not an authorization). */
export const LAST_BUSINESS_COOKIE = "mai_last_business";
