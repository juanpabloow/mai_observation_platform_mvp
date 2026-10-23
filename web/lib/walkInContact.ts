/**
 * WALK-IN CONTACT details — the pure rules shared by the agenda form and its server
 * actions (unit-tested in test/unit/walkInContact.test.ts).
 *
 * A walk-in ("Atención sin cita") is registered with whatever the operator typed — name,
 * phone, email, all optional — and is linked to a contact ONLY when they ask for it:
 *   - "guest": nothing is created. What was typed stays on the appointment (guest_*), is
 *              shown again when it is reopened and is never used to identify anyone.
 *   - "create": a contact is created — that needs at least ONE valid phone or email (the
 *              current contact rules); a NAME alone never identifies a person (two walk-ins
 *              called "Juan" are two people).
 *   - "link":   an existing contact chosen by the operator.
 * Whether an appointment HAS a contact is its contact_id — never its display name.
 * Having an email says nothing about WhatsApp: only a phone can be messaged there.
 */
import { dialingRegionForTimezone, normalizeE164 } from "@worker/scheduling/phone.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const GUEST_NAME_MAX = 120;
export const GUEST_EMAIL_MAX = 254;

export type ContactMode = "guest" | "create" | "link";

export interface GuestInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface GuestValue {
  name: string | null;
  /** E.164, or null. */
  phone: string | null;
  /** Lowercased, or null. */
  email: string | null;
}

export type GuestField = "name" | "phone" | "email";

export type GuestResult =
  | { ok: true; value: GuestValue }
  | { ok: false; fieldErrors: Partial<Record<GuestField, string>> };

/** Validate what was typed. `requireIdentity` = saving a contact (phone or email needed). */
export function validateGuest(input: GuestInput, opts: { timeZone: string; requireIdentity: boolean }): GuestResult {
  const errors: Partial<Record<GuestField, string>> = {};
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length > GUEST_NAME_MAX) errors.name = `Máximo ${GUEST_NAME_MAX} caracteres.`;

  const rawPhone = (input.phone ?? "").trim();
  let phone: string | null = null;
  if (rawPhone) {
    phone = normalizeE164(rawPhone, { defaultRegion: dialingRegionForTimezone(opts.timeZone) });
    if (!phone) errors.phone = "Revisa el teléfono: escríbelo completo, con el indicativo si no es de este país.";
  }

  const rawEmail = (input.email ?? "").trim().toLowerCase();
  let email: string | null = null;
  if (rawEmail) {
    if (rawEmail.length > GUEST_EMAIL_MAX || !EMAIL_RE.test(rawEmail)) errors.email = "Revisa el correo: debe tener la forma nombre@dominio.com.";
    else email = rawEmail;
  }

  if (opts.requireIdentity && !rawPhone && !rawEmail) {
    errors.phone = "Para guardar el contacto escribe un teléfono o un correo.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return { ok: true, value: { name: name || null, phone, email } };
}

/** Whether there is anything worth keeping on the appointment. */
export function hasGuestData(v: GuestValue): boolean {
  return Boolean(v.name || v.phone || v.email);
}

/** Only a phone can be reached on WhatsApp — an email never implies it. */
export function canMessageOnWhatsApp(v: { phone: string | null }): boolean {
  return Boolean(v.phone);
}

/** A matching contact the operator may link instead of creating a duplicate. */
export interface ContactMatch {
  contactId: string;
  name: string | null;
  matchedBy: "phone" | "email";
  /** Masked unless the viewer may see contact identities. */
  matchedValue: string | null;
}

/** "+57 300 555 0101" → "+57 ••• ••• 0101"; "ana@x.com" → "a••@x.com". */
export function maskIdentity(kind: "phone" | "email", value: string): string {
  if (kind === "phone") return value.length > 4 ? `${value.slice(0, 3)} ••• ${value.slice(-4)}` : "•••";
  const [user, domain] = value.split("@");
  return `${user.slice(0, 1)}••@${domain ?? ""}`;
}
