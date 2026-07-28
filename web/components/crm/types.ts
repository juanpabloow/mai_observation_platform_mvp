/**
 * Serializable DTOs for the CRM contact-detail client components. The server page
 * builds these (dates → ISO strings, booleans precomputed) so the client tree
 * never touches Date objects or re-derives permissions — `canManage` is decided
 * on the server from the session role and passed down.
 */

export type ContactTab = "overview" | "timeline" | "conversations" | "appointments" | "tasks";

export interface MemberOption {
  userId: string;
  name: string;
  role: string;
}

export interface TagDTO {
  id: string;
  name: string;
  color: string;
}

export interface ContactDTO {
  id: string;
  name: string | null;
  channel: string;
  channel_user_id: string;
  phone_e164: string | null;
  email: string | null;
  stage: string;
  bot_human_mode: string;
  message_count: number;
  is_customer: boolean;
  assigned_to: string | null;
  assignee_name: string | null;
}

export interface NoteDTO {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  canManage: boolean;
}

export interface TaskDTO {
  id: string;
  title: string;
  description: string | null;
  status: "open" | "completed" | "cancelled";
  priority: "low" | "normal" | "high";
  dueAt: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  canManage: boolean;
}

export interface ConversationDTO {
  id: string;
  workflow_ref: string;
  conversation_ref: string;
  mode: string;
  last_message_at: string | null;
}

export interface AppointmentDTO {
  id: string;
  service_name: string;
  staff_name: string | null;
  site_name: string | null;
  start_at: string;
  status: string;
  origin: string;
}

export interface TimelineItemDTO {
  id: string;
  type: string;
  occurredAt: string;
  title: string;
  summary: string | null;
  actorName: string | null;
  sourceId: string;
  sourceType: string;
}

/** Shared date formatter (Colombia locale, matching the rest of the CRM UI). */
export function fmtDateTime(iso: string | null): string {
  return iso
    ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
    : "—";
}
