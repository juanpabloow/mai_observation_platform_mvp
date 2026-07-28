/**
 * Static color → className map for CRM tag chips. The classes are written as
 * LITERAL strings (never composed at runtime) so Tailwind's content scanner keeps
 * them in the build. Keys match TAG_COLORS in web/lib/crmValidation.ts.
 */
export const TAG_CHIP: Record<string, string> = {
  gray: "bg-gray-500/15 text-gray-700 dark:text-gray-300 ring-gray-500/30",
  red: "bg-red-500/15 text-red-700 dark:text-red-300 ring-red-500/30",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300 ring-orange-500/30",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-500/30",
  green: "bg-green-500/15 text-green-700 dark:text-green-300 ring-green-500/30",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300 ring-teal-500/30",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300 ring-blue-500/30",
  indigo: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-indigo-500/30",
  purple: "bg-purple-500/15 text-purple-700 dark:text-purple-300 ring-purple-500/30",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300 ring-pink-500/30",
};

export function tagChipClass(color: string): string {
  return TAG_CHIP[color] ?? TAG_CHIP.gray;
}
