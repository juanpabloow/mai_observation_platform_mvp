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

export const ContactPatchInput = z.strictObject({
  // Strings are optional (a PATCH sends only what changed); empty strings stay
  // allowed — the current UI submits them and the repo normalizes (e.g. phone).
  name: z.string().max(256).optional(),
  phone: z.string().max(64).optional(),
  email: z.string().max(256).optional(),
  stage: z.enum(CONTACT_STAGES).optional(),
  bot_human_mode: z.enum(BOT_HUMAN_MODES).optional(),
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
  return { ok: true, value };
}
