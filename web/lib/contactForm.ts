import { normalizeE164 } from "@worker/scheduling/phone.js";
import type { PreferredChannel } from "@worker/db/repositories/contacts.js";
import { conversationAvatarLabel } from "./inboxView";

/**
 * PURE form logic for the contact CREATE + EDIT forms. No React, no server imports —
 * `normalizeE164` is the worker's own helper and has no dependencies of its own, which
 * is deliberate: the browser must normalize a typed number EXACTLY the way the identity
 * spine will, or the inline duplicate check answers a different question than the save.
 *
 * Everything here is a pure function so the rules that matter (the identity rule, the
 * change count, the patch minimisation) are unit-testable without rendering anything.
 * The server re-validates all of it — see parseContactCreate / parseContactPatch.
 */

// ── Copy ───────────────────────────────────────────────────────────────────────
// In one place because several of these strings appear in two forms and in a test.
export const COPY = {
  needsIdentity: "Necesitas al menos un teléfono o un email.",
  identityHint: "Al menos uno de los dos: teléfono o email.",
  readyToSave: "Listo para guardar: ya tienes un dato de contacto.",
  reviewMatches: "Revisa las coincidencias antes de guardar — igual puedes continuar.",
  checking: "Verificando si ya existe…",
  noMatch: "No existe un contacto con este dato",
  continueAnyway: "Continuar de todos modos",
  openContact: "Abrir contacto",
  addEmail: "+ Agregar email",
  addPhone: "+ Agregar número",
  optionalDivider: "Todo lo de abajo es opcional",
  businessConfigured: "CONFIGURADO POR EL NEGOCIO",
  doNotContact: "No contactar",
  doNotContactNote: "Suprime todos los envíos, incluidos los recordatorios",
  invalidPhone: "Ese número no parece válido. Incluye el indicativo del país.",
  invalidEmail: "Ese email no parece válido.",
} as const;

/** "Ya existe 1 contacto…" vs "Ya existen 3 contactos…" — the header pluralises on the
 *  TRUE total, not on how many cards fit. */
export function matchHeading(total: number, kind: IdentityKindLite): string {
  const what = kind === "phone" ? "número" : "email";
  return total === 1
    ? `Ya existe 1 contacto con este ${what}`
    : `Ya existen ${total} contactos con este ${what}`;
}

// ── Identity ───────────────────────────────────────────────────────────────────

export type IdentityKindLite = "phone" | "email";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Same shape the spine stores: E.164 for a phone, lowercased+trimmed for an email.
 *  Returns null when the value can't be normalized — which is how the field knows to
 *  show "no parece válido" INSTEAD of running a duplicate check on garbage. */
export function normalizeIdentity(kind: IdentityKindLite, raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (kind === "phone") return normalizeE164(trimmed);
  const lower = trimmed.toLowerCase();
  return EMAIL_RE.test(lower) ? lower : null;
}

/** Non-empty entries, de-duplicated by NORMALIZED value so "+57 318 598 0405" and
 *  "573185980405" don't both get sent (the spine would collapse them anyway, but the
 *  form should not claim two identities where there is one). Typed order is preserved:
 *  the first entry is the primary. */
export function cleanIdentities(kind: IdentityKindLite, values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    // An unnormalizable value still counts as typed — it must reach the server and be
    // rejected there, rather than being silently dropped as if never entered.
    const key = normalizeIdentity(kind, trimmed) ?? trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export interface IdentityCheck {
  /** May the form submit? False ONLY when both lists are empty. */
  canSubmit: boolean;
  /** The blocking message, or null. */
  error: string | null;
  phones: string[];
  emails: string[];
}

/**
 * THE identity rule, in one function: at least one of phone or email, name irrelevant.
 * Note what it does NOT do — it never requires a name, never requires both, and never
 * blocks on a duplicate. A duplicate is a warning; an empty pair is the only hard stop.
 */
export function checkIdentity(rawPhones: string[], rawEmails: string[]): IdentityCheck {
  const phones = cleanIdentities("phone", rawPhones);
  const emails = cleanIdentities("email", rawEmails);
  const empty = phones.length === 0 && emails.length === 0;
  return { canSubmit: !empty, error: empty ? COPY.needsIdentity : null, phones, emails };
}

// ── Edit: what actually changed ────────────────────────────────────────────────

/** The editable surface of a contact, as the form holds it. Identity lists are excluded
 *  on purpose: identities are ADDITIVE through the spine, never a diff (see the note on
 *  buildEditPatch). */
export interface ContactFormValues {
  name: string;
  stage: string;
  assignedTo: string | null;
  preferredChannel: PreferredChannel | null;
  doNotContact: boolean;
  consent: string;
  customFields: Record<string, unknown>;
  tags: string[];
}

/** Order-insensitive comparison — reordering chips is not a change. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function sameCustom(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const av = a[k] ?? null;
    const bv = b[k] ?? null;
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (!sameSet(av.map(String), bv.map(String))) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}

/** The field-by-field change list, used for the "N cambios sin guardar" count. Tags are
 *  ONE change however many chips moved — the bar counts what the operator would describe
 *  as a change, not how many rows a save touches. */
export function changedFields(initial: ContactFormValues, current: ContactFormValues): string[] {
  const changed: string[] = [];
  if (initial.name.trim() !== current.name.trim()) changed.push("name");
  if (initial.stage !== current.stage) changed.push("stage");
  if ((initial.assignedTo ?? null) !== (current.assignedTo ?? null)) changed.push("assigned_to");
  if ((initial.preferredChannel ?? null) !== (current.preferredChannel ?? null)) changed.push("preferred_channel");
  if (initial.doNotContact !== current.doNotContact) changed.push("do_not_contact");
  if (initial.consent !== current.consent) changed.push("messaging_consent");
  if (!sameCustom(initial.customFields, current.customFields)) changed.push("custom_fields");
  if (!sameSet(initial.tags, current.tags)) changed.push("tags");
  return changed;
}

export function unsavedLabel(count: number): string {
  return count === 1 ? "1 cambio sin guardar" : `${count} cambios sin guardar`;
}

/**
 * The PATCH — only what changed, which is the whole reason the edit form tracks an
 * `initial`. Sending the full object would look identical to the operator and be wrong
 * in two ways the schema cares about: `custom_fields` would re-assert every key on every
 * save (defeating the partial-merge that stops one editor wiping another's enrichment),
 * and `messaging_consent` would re-stamp consent_updated_at on saves that never touched
 * consent — turning "accepted 12 mar 2023" into today's date because someone fixed a
 * typo in the name.
 *
 * IDENTITIES ARE NOT IN THE PATCH. contacts.phone_e164/email are the scalar mirror of
 * the identity spine, and the spine owns adding identities (resolveContactByIdentity).
 * Removing one is a different operation with different consequences — it frees the value
 * for another contact to claim — so the form adds identities and does not silently drop
 * them. Tags are also excluded: they are their own rows, written by attach/detach.
 */
export function buildEditPatch(
  initial: ContactFormValues,
  current: ContactFormValues,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const changed = new Set(changedFields(initial, current));
  if (changed.has("name")) patch.name = current.name.trim() === "" ? null : current.name.trim();
  if (changed.has("stage")) patch.stage = current.stage;
  if (changed.has("assigned_to")) patch.assigned_to = current.assignedTo;
  if (changed.has("preferred_channel")) patch.preferred_channel = current.preferredChannel;
  if (changed.has("do_not_contact")) patch.do_not_contact = current.doNotContact;
  if (changed.has("messaging_consent")) patch.messaging_consent = current.consent;
  if (changed.has("custom_fields")) patch.custom_fields = current.customFields;
  return patch;
}

// ── Display helpers ────────────────────────────────────────────────────────────

/**
 * The avatar disc's initials — ONE rule for the whole app.
 *
 * It delegates to conversationAvatarLabel rather than reimplementing it, because there
 * were briefly two rules: the contacts table took the first two words ("Santiago
 * Vanegas Mora" → SV) and a phone's LAST two digits, while this took first+last word
 * (→ SM) and the FIRST two characters. The same contact then wore different initials
 * in the row and in the panel beside it. The table's rule wins on both counts — "SV"
 * is the pair a Spanish reader recognises, and the last digits are what distinguishes
 * two numbers that share a country code.
 *
 * (inboxView is explicitly client-safe with zero server coupling, so importing it here
 * keeps this module pure.)
 */
export function initialsFor(name: string | null, fallback: string): string {
  return conversationAvatarLabel(fallback, name);
}

/** "hace 3 días" / "hace 6 meses" — the relative age the match cards show. Deliberately
 *  coarse: the operator is deciding "is this the same person", not reading a log. */
export function relativeAge(from: Date | string, now: Date): string {
  const d = typeof from === "string" ? new Date(from) : from;
  const ms = now.getTime() - d.getTime();
  if (Number.isNaN(ms)) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "hace un momento";
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "hace 1 hora" : `hace ${hours} horas`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "hace 1 día" : `hace ${days} días`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "hace 1 mes" : `hace ${months} meses`;
  const years = Math.floor(months / 12);
  return years === 1 ? "hace 1 año" : `hace ${years} años`;
}

/** "Contacto desde mar 2023" — the derived line in the edit header. */
export function contactSince(createdAt: Date | string): string {
  const d = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  if (Number.isNaN(d.getTime())) return "—";
  return `Contacto desde ${new Intl.DateTimeFormat("es", { month: "short", year: "numeric" }).format(d)}`;
}

export function activityLabel(count: number): string {
  return count === 1 ? "1 actividad" : `${count} actividades`;
}

/** Consent line: "Aceptado el 12 mar 2023 por WhatsApp" when we know when and from
 *  where, degrading gracefully when we know only one of the two (an older row may carry
 *  consent with no source). */
export function consentProvenance(
  consent: string,
  updatedAt: Date | string | null,
  source: string | null,
): string | null {
  if (consent !== "opted_in") return null;
  if (!updatedAt) return source ? `Aceptado por ${source}` : null;
  const d = typeof updatedAt === "string" ? new Date(updatedAt) : updatedAt;
  if (Number.isNaN(d.getTime())) return null;
  const when = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(d);
  return source ? `Aceptado el ${when} por ${source}` : `Aceptado el ${when}`;
}
