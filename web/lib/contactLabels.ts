import type { PreferredChannel } from "@worker/db/repositories/contacts.js";
import type { AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * HUMAN LABELS for everything a contact stores as an enum or a machine string.
 *
 * The rule this file enforces: a stored value is never printed raw. `new`, `manual`,
 * `unknown` and `opted_in` are storage, and an operator reading "unknown" next to
 * "Consent" cannot tell whether nobody asked or the customer said no. They are also
 * English, in a Spanish product.
 *
 * Everything lives HERE rather than inline at each call site, because the same value
 * appears in the record, the drawer, the list and the duplicate cards — and four
 * inline ternaries are how "Nuevo" and "new" end up on screen at the same time.
 *
 * Unknown values fall back to the raw string rather than to a placeholder: a channel
 * label the platform hasn't seen is still more useful to the reader than "—", and it
 * makes the gap visible instead of hiding it.
 */

// ── Stage ──────────────────────────────────────────────────────────────────────

export const STAGE_LABELS: Record<string, string> = {
  new: "Nuevo",
  active: "Activo",
  customer: "Cliente",
  archived: "Archivado",
};

/** The three the FORM offers. `archived` is displayable but not a choice here — it is
 *  reached by the archive action, not by a segmented control. */
export const FORM_STAGES = ["new", "active", "customer"] as const;

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

// ── Preferred channel ──────────────────────────────────────────────────────────

export const CHANNEL_LABELS: Record<PreferredChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  phone: "Teléfono",
  sms: "SMS",
};

export function channelLabel(channel: PreferredChannel | null): string {
  return channel ? CHANNEL_LABELS[channel] : "Sin preferencia";
}

// ── Consent ────────────────────────────────────────────────────────────────────

/**
 * `unknown` is "Sin confirmar", NOT "Desconocido": the distinction that matters to an
 * operator is that nobody has asked yet, which is a different state from a recorded
 * refusal and is actionable.
 */
export const CONSENT_LABELS: Record<string, string> = {
  unknown: "Sin confirmar",
  opted_in: "Aceptado",
  opted_out: "Rechazado",
};

export function consentLabel(consent: string): string {
  return CONSENT_LABELS[consent] ?? consent;
}

// ── Source (contacts.channel — free text, never branched on) ───────────────────

/**
 * How the contact first arrived. This column is deliberately FREE TEXT in the schema
 * (C-2: the source is displayed, never branched on), so this is a display map with a
 * graceful fallback, not an enum: an unmapped source is title-cased rather than
 * dropped, and underscores become spaces so `booking_form` reads as "Booking form"
 * instead of leaking the storage format.
 */
const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  api: "API",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  webchat: "Chat web",
  telegram: "Telegram",
  sms: "SMS",
  email: "Email",
  booking_form: "Formulario de reserva",
  "booking form": "Formulario de reserva",
  booking: "Reserva",
  import: "Importación",
};

export function sourceLabel(channel: string | null | undefined): string {
  const raw = (channel ?? "").trim();
  if (!raw) return "—";
  const mapped = SOURCE_LABELS[raw.toLowerCase()];
  if (mapped) return mapped;
  const spaced = raw.replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ── Appointment status ─────────────────────────────────────────────────────────

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: "Agendada",
  confirmed: "Confirmada",
  completed: "Completada",
  cancelled: "Cancelada",
  no_show: "No asistió",
};

export function appointmentStatusLabel(status: AppointmentStatus): string {
  return APPOINTMENT_STATUS_LABELS[status] ?? status;
}

// ── CRM surface copy ───────────────────────────────────────────────────────────

/**
 * Every human word the CRM's contact surfaces render — the list's side panel, the
 * record's right rail, and the shared blocks both compose.
 *
 * It lives beside the value labels for one reason: three surfaces show the same
 * concepts (next appointment, open tasks, tags, notes), and when each spelled them
 * inline they drifted — "Open tasks" in one place, "OPEN TASKS" in another, and the
 * drawer beside them in Spanish. Naming a concept once is what makes them read as one
 * product.
 *
 * Section headings are written in normal case: `.u-th` applies the uppercase, so
 * shouting here would double it and break the moment a heading moves to another style.
 */
export const CRM_COPY = {
  tabs: {
    summary: "Resumen",
    data: "Datos",
    appointments: "Citas",
    notes: "Notas",
    activity: "Actividad",
  },
  headings: {
    nextAppointment: "Próxima cita",
    appointments: "Citas",
    openTasks: "Tareas abiertas",
    tags: "Etiquetas",
    notes: "Notas",
  },
  empty: {
    appointments: "Sin próximas citas.",
    tasks: "No hay tareas abiertas.",
    tags: "Sin etiquetas.",
    notes: "Todavía no hay notas.",
    history: "Sin citas registradas.",
  },
  actions: {
    addTask: "Agregar tarea",
    addNote: "Agregar nota",
    newTag: "Nueva etiqueta",
    addTag: "Agregar etiqueta…",
    book: "Agendar cita",
    openRecord: "Abrir ficha",
    edit: "Editar",
    close: "Cerrar",
    cancel: "Cancelar",
    create: "Crear",
    reschedule: "Reagendar",
    loadMore: "Cargar más",
  },
  /** "3 en total" beside the next-appointment heading. */
  totalCount: (n: number): string => `${n} en total`,
} as const;

// ── Small shared values ────────────────────────────────────────────────────────

export function yesNoLabel(value: boolean): string {
  return value ? "Sí" : "No";
}

/** Empty read-mode value. One dash everywhere, rather than "—" here and "" there. */
export const EMPTY = "—";

/**
 * A client-defined custom field's value, for READ mode. Typed by the definition, so a
 * boolean shows "Sí"/"No" instead of "true" and a missing value shows the shared dash.
 */
export function customFieldLabel(type: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  if (type === "boolean") return yesNoLabel(value === true);
  if (type === "date") {
    const d = new Date(String(value));
    if (!Number.isNaN(d.getTime())) {
      return new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(d);
    }
  }
  return String(value);
}
