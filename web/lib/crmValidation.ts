import { z } from "zod";

/**
 * PURE runtime validation for the operational-CRM action inputs — no server-only
 * imports, no PostgreSQL, so it is unit-testable and reusable. Strict by design:
 *  - `.strict()` rejects unknown keys (never trust the browser's shape);
 *  - no coercion (a number/"true" never becomes a boolean/string silently);
 *  - UUIDs validated by regex; user ids are opaque non-empty strings (Better Auth
 *    ids are text, not necessarily uuid); enums exact; lengths bounded; dates ISO.
 * Each parse* returns { ok, value } | { ok:false } and never throws. Callers
 * reconstruct the typed payload from `value` (never re-use the raw input object).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
const uuid = z.string().refine(isUuid, "must be a UUID");
const userId = z.string().min(1).max(255); // Better Auth id (text)
const iso = z.string().datetime({ offset: true });

export const TAG_COLORS = [
  "gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink",
] as const;
export const CONTACT_STAGES = ["new", "active", "customer", "archived"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high"] as const;

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

// ── Notes ────────────────────────────────────────────────────────────────────
export const CreateNoteInput = z
  .object({ clientId: uuid, contactId: uuid, body: nonEmpty(10000) })
  .strict();
export const UpdateNoteInput = z
  .object({ clientId: uuid, noteId: uuid, body: nonEmpty(10000) })
  .strict();
export const NoteRefInput = z.object({ clientId: uuid, noteId: uuid }).strict();

// ── Tasks ────────────────────────────────────────────────────────────────────
export const CreateTaskInput = z
  .object({
    clientId: uuid,
    contactId: uuid,
    title: nonEmpty(300),
    description: z.string().max(10000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueAt: iso.nullable().optional(),
    assignedToUserId: userId.nullable().optional(),
  })
  .strict();
export const UpdateTaskInput = z
  .object({
    clientId: uuid,
    taskId: uuid,
    title: nonEmpty(300).optional(),
    description: z.string().max(10000).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueAt: iso.nullable().optional(),
    assignedToUserId: userId.nullable().optional(),
  })
  .strict();
export const TaskRefInput = z.object({ clientId: uuid, taskId: uuid }).strict();

// ── Tags ─────────────────────────────────────────────────────────────────────
export const CreateTagInput = z
  .object({ clientId: uuid, name: nonEmpty(60), color: z.enum(TAG_COLORS) })
  .strict();
export const RenameTagInput = z
  .object({ clientId: uuid, tagId: uuid, name: nonEmpty(60).optional(), color: z.enum(TAG_COLORS).optional() })
  .strict();
export const TagRefInput = z.object({ clientId: uuid, tagId: uuid }).strict();
export const TagLinkInput = z.object({ clientId: uuid, contactId: uuid, tagId: uuid }).strict();

// ── Owner / stage ──────────────────────────────────────────────────────────────
export const ChangeOwnerInput = z
  .object({ clientId: uuid, contactId: uuid, ownerUserId: userId.nullable() })
  .strict();
export const ChangeStageInput = z
  .object({ clientId: uuid, contactId: uuid, stage: z.enum(CONTACT_STAGES) })
  .strict();

// ── Timeline ─────────────────────────────────────────────────────────────────
export const TimelineQueryInput = z
  .object({ clientId: uuid, contactId: uuid, cursor: z.string().min(1).max(500).nullable().optional() })
  .strict();

/** safeParse → { ok, value } | { ok:false }. Never throws. */
export function parse<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false } {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false };
}
