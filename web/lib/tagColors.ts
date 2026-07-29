import type { TagColor } from "@worker/db/repositories/contactTags.js";

/**
 * Tag chip color → Tailwind tint classes (C-4). Tags carry a stored `color` that the
 * C-3 scaffolding ignored (flat bg-subtle); the record + inbox panel render it here.
 * A STATIC map (never build class names dynamically — Tailwind must see each literal)
 * following the app's tint recipe, legible in both themes. `gray` falls back to the
 * neutral subtle chip so it reads as "no color chosen".
 */
export const TAG_CHIP_CLASS: Record<TagColor, string> = {
  gray: "bg-subtle text-muted",
  red: "bg-red-500/15 text-red-700 dark:text-red-400",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  indigo: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-400",
};

export function tagChipClass(color: string): string {
  return TAG_CHIP_CLASS[color as TagColor] ?? TAG_CHIP_CLASS.gray;
}
