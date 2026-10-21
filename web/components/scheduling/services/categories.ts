import { apptCategoryClass, type ApptCategory } from "@/lib/agendaCategory";

/**
 * The service CATEGORIES of the services menu. M_AI has no category table: a service
 * stores one of four colour families in `services.category` (CHECK-constrained), and
 * NULL means "uncategorised — the agenda infers a colour from the name". So the menu's
 * categories are exactly those four plus "Sin categoría"; names, colours and
 * descriptions are NOT editable here (that needs a categories model — see the gap
 * report). The colour of each family is the agenda's own `.u-appt-*` palette.
 */
export interface CategoryGroup {
  /** The stored value; "" = NULL (uncategorised). */
  value: "" | Exclude<ApptCategory, "danger" | "unassigned" | "tentative" | "cancelled">;
  label: string;
}

export const CATEGORY_GROUPS: CategoryGroup[] = [
  { value: "cut", label: "Corte" },
  { value: "grooming", label: "Barba y cuidado" },
  { value: "color", label: "Color" },
  { value: "feature", label: "Tratamiento destacado" },
  { value: "", label: "Sin categoría" },
];

/** The editor's select: same set, "Sin categoría" first (it is the default). */
export const CATEGORY_CHOICES: CategoryGroup[] = [CATEGORY_GROUPS[4], ...CATEGORY_GROUPS.slice(0, 4)];

/** The dot of a category in the filters and lists: the agenda's own colour, or a dashed
 *  ring for «Sin categoría» (whose services get a colour guessed from their name). */
export function categoryDot(value: string): string {
  // The same tone as the category pill of the list (--appt-rule), so the side menu, the
  // editor chips and the column share one colour per category.
  return value ? `${apptCategoryClass(value as ApptCategory)} bg-[var(--appt-rule)]` : "border border-dashed border-line-strong";
}
