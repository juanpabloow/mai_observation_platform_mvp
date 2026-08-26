import { z } from "zod";

/**
 * I-1 MULTI-IDENTITY PUSH (additive to handoff contract v1 — no version bump). The optional
 * `identities` array lets a workflow declare EVERY identity it knows for one person in a single
 * call — [{ kind, value, label }] using the existing C-2 vocabulary (phone | email | external),
 * where `label` is a free-text origin hint ("whatsapp", "instagram_handle", …). Shared VERBATIM
 * by the three write entry points — the messages push, the CRM upsert, and appointment creation
 * — so all accept the identical shape. The parsed value is assignable as-is to
 * `ResolveIdentityInput.identities`; the identity spine attaches them all to the resolved
 * contact (and applies the collision rules when they span existing contacts). Absent → each
 * endpoint behaves exactly as before.
 */
export const identitiesSchema = z
  .array(
    z.object({
      kind: z.enum(["phone", "email", "external"]),
      value: z.string().trim().min(1).max(256),
      label: z.string().trim().min(1).max(64).optional(),
    }),
  )
  .max(20)
  .optional();

export type IdentitiesInput = z.infer<typeof identitiesSchema>;
