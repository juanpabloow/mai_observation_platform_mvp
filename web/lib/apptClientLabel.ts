/**
 * WHO an appointment is for, in words — ONE rule for every surface (audit 23 Oct: a
 * confirmed ONLINE booking with no linked contact was titled «Atención sin cita» on the
 * phone). Three facts that must not be mixed: the client's NAME, whether a CRM contact is
 * LINKED, and the appointment's ORIGIN.
 *
 *   linked contact with a name   → its name
 *   linked contact, no name      → «Sin nombre»
 *   no contact, a typed guest    → the guest's name (a walk-in saved without a contact)
 *   no contact, origin walk_in   → «Atención sin cita»
 *   anything else                → «Sin contacto»
 */
export function apptClientLabel(a: { contact_id?: string | null; contact_name: string | null; guest_name?: string | null; origin?: string | null }): string {
  const name = a.contact_name?.trim();
  if (name) return name;
  if (a.contact_id) return "Sin nombre";
  const guest = a.guest_name?.trim();
  if (guest) return guest;
  return a.origin === "walk_in" ? "Atención sin cita" : "Sin contacto";
}
