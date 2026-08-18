import type { AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";
import type { ContactStage, MessagingConsent, PreferredChannel } from "@worker/db/repositories/contacts.js";
import type { IdentityKind } from "@worker/db/repositories/contactIdentities.js";

/**
 * The SERIALIZABLE view shapes that cross the server→client boundary and feed the
 * SHARED contact components (identity summary, next-appointment card, notes, tasks,
 * tags) used by BOTH the full record and the compact inbox panel (C-4). Client-safe:
 * type-only imports are erased, so this pulls no server code into the bundle.
 */

export interface IdentityView {
  kind: IdentityKind;
  value: string;
  /** Origin hint (the source channel), e.g. "whatsapp" / "booking form" / "manual". */
  label: string | null;
}

export interface AppointmentView {
  id: string;
  publicReference: string;
  serviceName: string;
  staffName: string | null;
  startAt: string; // ISO
  endAt: string; // ISO
  status: AppointmentStatus;
  /** The appointment's SITE timezone — so a machine caller can label start_at locally
   *  (an appointment happens at a physical place). */
  siteTimezone: string;
}

export interface TaskView {
  id: string;
  title: string;
  dueAt: string | null; // ISO
  assigneeName: string | null;
  createdByUserId: string | null;
  assignedToUserId: string | null;
}

export interface NoteView {
  id: string;
  body: string;
  authorName: string | null;
  createdByUserId: string | null;
  createdAt: string; // ISO
  edited: boolean;
}

export interface TagView {
  id: string;
  name: string;
  color: string;
}

export interface MemberOption {
  userId: string;
  name: string | null;
  email: string;
}

/** Identity + derived status — the headline both surfaces share. */
export interface ContactSummary {
  id: string;
  displayName: string;
  stage: ContactStage;
  isCustomer: boolean;
  consent: MessagingConsent;
  visitCount: number;
  noShowCount: number;
}

/** Derived-status + appointment split computed once from a contact's appointments. */
export interface AppointmentSummary {
  next: AppointmentView | null;
  upcoming: AppointmentView[];
  past: AppointmentView[];
  visitCount: number; // completed
  noShowCount: number;
  isCustomer: boolean; // ≥1 completed
}

/**
 * The contact-edit drawer's pre-filled state. It lives HERE, with the other wire
 * shapes, rather than in the drawer component, because BOTH doors into editing (the
 * record header and the list's customer panel) build it server-side — and a shape
 * owned by one of the two callers is how they drift apart.
 */
export interface ContactEditInitial {
  contactId: string;
  displayName: string;
  name: string | null;
  stage: string;
  /** DERIVED (≥1 completed appointment), never stored — the header's "cliente" chip.
   *  It rides on this payload so the drawer and the quick view show the same chips. */
  isCustomer: boolean;
  assignedTo: string | null;
  preferredChannel: PreferredChannel | null;
  doNotContact: boolean;
  consent: string;
  consentUpdatedAt: string | null; // ISO
  consentSource: string | null;
  customFields: Record<string, unknown>;
  createdAt: string; // ISO
  lastContactAt: string; // ISO
  activityCount: number;
  sourceChannel: string;
  /** Identities ALREADY on record, shown as facts. The drawer only ADDS. */
  phones: string[];
  emails: string[];
}

/** Display name: the contact's name, else its primary phone identity, else a fallback. */
export function contactDisplayName(name: string | null, identities: IdentityView[], fallback: string): string {
  if (name && name.trim()) return name.trim();
  const phone = identities.find((i) => i.kind === "phone");
  if (phone) return phone.value;
  return identities[0]?.value ?? fallback;
}

/** The agenda `date` query key (YYYY-MM-DD) for an appointment. Uses the UTC date of the
 * start instant — correct for business-hour appointments in America/* (UTC-5/-6) where
 * local and UTC dates agree during the day; a near-midnight edge can differ (the site's
 * timezone isn't carried in the wire shape — noted as a minor approximation). */
export function agendaDateKey(iso: string): string {
  return iso.slice(0, 10);
}
