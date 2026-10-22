/**
 * "Estado inicial" of a manual booking, WITHOUT a new column: the appointment is created
 * the only way the engine creates it (Sin confirmar), and — only when the operator chose
 * "Confirmada" — the real `confirm` transition runs right after. Pure over injected
 * steps so it is unit-tested (test/unit/manualBooking.test.ts).
 *
 * If the confirm step fails the appointment still EXISTS (it was committed), so this
 * never reports a failure that would invite a second create: it returns ok with a
 * warning that says the booking is there, unconfirmed. A replayed create (same
 * idempotency key → deduped) that is already confirmed is not confirmed twice.
 */

export type CreateOutcome = { ok: true; id: string; status: string } | { ok: false; error: string };
export type ManualBookingResult =
  | { ok: true; id: string; warning?: string }
  | {
      ok: false;
      error: string;
      /** Contacts that already hold the typed phone/email — offered to LINK, never duplicated. */
      matches?: import("./walkInContact").ContactMatch[];
      /** Per-field validation messages (the form keeps every value and shows each by its field). */
      fieldErrors?: Partial<Record<import("./walkInContact").GuestField, string>>;
    };

export async function createThenMaybeConfirm(
  create: () => Promise<CreateOutcome>,
  confirm: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  initialStatus: "scheduled" | "confirmed",
): Promise<ManualBookingResult> {
  const created = await create();
  if (!created.ok) return created;
  if (initialStatus !== "confirmed" || created.status !== "scheduled") return { ok: true, id: created.id };
  let confirmed: { ok: true } | { ok: false; error: string };
  try {
    confirmed = await confirm(created.id);
  } catch {
    confirmed = { ok: false, error: "" };
  }
  return confirmed.ok
    ? { ok: true, id: created.id }
    : { ok: true, id: created.id, warning: "La cita se creó como «Sin confirmar»: no se pudo confirmar. Confírmala desde el detalle." };
}
