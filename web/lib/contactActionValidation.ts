import { z } from "zod";

/**
 * PURE runtime validation for the contact-update patch — the anti-over-posting
 * gate. The repo's updateContact also accepts `assigned_to`, so the browser
 * payload must NEVER be forwarded as-is: only the five editable fields are
 * accepted, unknown properties are REJECTED (strict object), enums are exact,
 * strings are bounded, and there is no coercion anywhere. safeParse never throws
 * (null, arrays, scalars, partial objects all fail cleanly), and the parsed
 * result is a NEW object built from validated fields only.
 */

export const CONTACT_STAGES = ["new", "active", "customer", "archived"] as const;
export const BOT_HUMAN_MODES = ["bot", "human"] as const;
export const MESSAGING_CONSENTS = ["unknown", "opted_in", "opted_out"] as const;
/** Mirrors PREFERRED_CHANNELS in the repo and the migration's CHECK constraint. */
export const PREFERRED_CHANNELS = ["whatsapp", "email", "phone", "sms"] as const;

export const ContactPatchInput = z.strictObject({
  // Strings are optional (a PATCH sends only what changed); empty strings stay
  // allowed — the current UI submits them and the repo normalizes (e.g. phone).
  name: z.string().max(256).optional(),
  phone: z.string().max(64).optional(),
  email: z.string().max(256).optional(),
  stage: z.enum(CONTACT_STAGES).optional(),
  bot_human_mode: z.enum(BOT_HUMAN_MODES).optional(),
  // C-2 additions. assigned_to is now settable but the ACTION validates the assignee
  // has access to this client (server-side). custom_fields is validated against the
  // client's field definitions in the ACTION (shape here is deliberately loose).
  assigned_to: z.string().max(255).nullable().optional(),
  messaging_consent: z.enum(MESSAGING_CONSENTS).optional(),
  consent_source: z.string().max(256).nullable().optional(),
  custom_fields: z.unknown().optional(),
  // Communication preferences. `null` on preferred_channel is a real intent ("no
  // preference"), so it is nullable rather than merely optional.
  preferred_channel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
  do_not_contact: z.boolean().optional(),
});

export type ContactPatch = z.infer<typeof ContactPatchInput>;

/** safeParse wrapper. On success the value is a FRESH validated object (never
 * the original input), with only the whitelisted keys that were present. */
export function parseContactPatch(input: unknown): { ok: true; value: ContactPatch } | { ok: false } {
  const result = ContactPatchInput.safeParse(input);
  if (!result.success) return { ok: false };
  // Rebuild explicitly — belt on top of strictObject's suspenders.
  const v = result.data;
  const value: ContactPatch = {};
  if (v.name !== undefined) value.name = v.name;
  if (v.phone !== undefined) value.phone = v.phone;
  if (v.email !== undefined) value.email = v.email;
  if (v.stage !== undefined) value.stage = v.stage;
  if (v.bot_human_mode !== undefined) value.bot_human_mode = v.bot_human_mode;
  if (v.assigned_to !== undefined) value.assigned_to = v.assigned_to;
  if (v.messaging_consent !== undefined) value.messaging_consent = v.messaging_consent;
  if (v.consent_source !== undefined) value.consent_source = v.consent_source;
  if (v.custom_fields !== undefined) value.custom_fields = v.custom_fields;
  if (v.preferred_channel !== undefined) value.preferred_channel = v.preferred_channel;
  if (v.do_not_contact !== undefined) value.do_not_contact = v.do_not_contact;
  return { ok: true, value };
}

/**
 * CREATE input — a different shape from the patch, not a looser version of it.
 *
 * The patch says "change these fields on a row that exists"; this says "here is a
 * person". The difference that matters is IDENTITY: creation carries LISTS of phones and
 * emails (a lead often arrives with two numbers), and the rule is "at least one of
 * phone or email, name optional" — which no per-field `required` can express, so it is
 * checked below across the whole object. The action re-runs the same check server-side;
 * this is not the browser's promise to keep.
 *
 * Still strict + whitelisted for the same anti-over-posting reason as the patch: the
 * repo write accepts assigned_to and custom_fields, so a browser payload is never
 * forwarded as-is.
 */
export const ContactCreateInput = z.strictObject({
  name: z.string().max(256).optional(),
  phones: z.array(z.string().max(64)).max(10).optional(),
  emails: z.array(z.string().max(256)).max(10).optional(),
  stage: z.enum(CONTACT_STAGES).optional(),
  assigned_to: z.string().max(255).nullable().optional(),
  messaging_consent: z.enum(MESSAGING_CONSENTS).optional(),
  consent_source: z.string().max(256).nullable().optional(),
  preferred_channel: z.enum(PREFERRED_CHANNELS).nullable().optional(),
  do_not_contact: z.boolean().optional(),
  custom_fields: z.unknown().optional(),
  /** Free-text tag names, created-on-the-fly by the action (not ids). */
  tags: z.array(z.string().max(64)).max(20).optional(),
  /** Becomes the contact's FIRST note — a separate row, written after the contact. */
  note: z.string().max(5000).optional(),
});

export type ContactCreate = z.infer<typeof ContactCreateInput>;

/** Non-empty, trimmed entries only — an input the operator opened and left blank is
 *  not an identity, and would otherwise reach the spine as a "" that classifies to null. */
function cleanList(list: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const v = raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export const NEEDS_IDENTITY = "Necesitas al menos un teléfono o un email.";

/**
 * Parse + enforce the identity rule. Returns the cleaned lists so the caller never has
 * to re-trim: `phones`/`emails` are non-empty, de-duplicated and in typed order (the
 * first is the primary the spine will claim).
 */
export function parseContactCreate(
  input: unknown,
): { ok: true; value: ContactCreate & { phones: string[]; emails: string[] } } | { ok: false; error: string } {
  const result = ContactCreateInput.safeParse(input);
  if (!result.success) return { ok: false, error: "Invalid input." };
  const v = result.data;
  const phones = cleanList(v.phones);
  const emails = cleanList(v.emails);
  // THE identity rule. Neither field is required on its own; the pair is.
  if (phones.length === 0 && emails.length === 0) return { ok: false, error: NEEDS_IDENTITY };
  return { ok: true, value: { ...v, phones, emails } };
}
