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
 *
 * "completed" is the walk-in that ALREADY HAPPENED («Esta atención ya se realizó»): the
 * same way — created, then the real `complete` transition (the one the detail's «Completar»
 * runs; the payment stays pending, nothing is charged).
 */

export type CreateOutcome =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string; problems?: import("./pastAttendance").PastProblemView[] };
export type ManualBookingResult =
  | { ok: true; id: string; warning?: string }
  | {
      ok: false;
      error: string;
      /** Contacts that already hold the typed phone/email — offered to LINK, never duplicated. */
      matches?: import("./walkInContact").ContactMatch[];
      /** Per-field validation messages (the form keeps every value and shows each by its field). */
      fieldErrors?: Partial<Record<import("./walkInContact").GuestField, string>>;
      /** A past walk-in that overlaps the professional's other appointments: those, to SHOW
       *  (nothing was changed). Times are ISO; the service is the stored snapshot. */
      conflicts?: import("./pastAttendance").PastConflict[];
      /** A past walk-in the professional's schedule did not allow then: each rule, to SHOW. */
      problems?: import("./pastAttendance").PastProblemView[];
    };

export async function createThenMaybeConfirm(
  create: () => Promise<CreateOutcome>,
  confirm: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  initialStatus: "scheduled" | "confirmed" | "completed",
): Promise<ManualBookingResult> {
  const created = await create();
  if (!created.ok) return created;
  if (initialStatus === "scheduled" || created.status !== "scheduled") return { ok: true, id: created.id };
  let confirmed: { ok: true } | { ok: false; error: string };
  try {
    confirmed = await confirm(created.id);
  } catch {
    confirmed = { ok: false, error: "" };
  }
  return confirmed.ok
    ? { ok: true, id: created.id }
    : {
        ok: true,
        id: created.id,
        warning:
          initialStatus === "completed"
            ? "La atención se registró, pero no se pudo marcar como completada. Complétala desde el detalle."
            : "La cita se creó como «Sin confirmar»: no se pudo confirmar. Confírmala desde el detalle.",
      };
}
