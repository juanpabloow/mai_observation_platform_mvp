"use server";

import { revalidatePath } from "next/cache";
import { gateClientModule } from "./clientModuleAccess";
import { can, canAccessSchedulingSite, canAccessSchedulingStaff, isSchedulingStaff } from "./access";
import { isUuid } from "./clientModuleValidation";
import { maskIdentity, validateGuest, type ContactMatch, type GuestField, type GuestValue } from "./walkInContact";
import { withTransaction } from "@worker/db/client.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import {
  attachAppointmentContact,
  getAppointmentById,
  getAppointmentForUpdate,
  recordAppointmentEvent,
  updateAppointmentGuest,
} from "@worker/db/repositories/scheduling/appointments.js";
import {
  contactBelongsToClient,
  findContactMatchesByIdentity,
  resolveContactByIdentity,
} from "@worker/db/repositories/contactIdentities.js";
import { recordSchedulingEvent } from "@worker/db/repositories/scheduling/events.js";

/**
 * CONTACT OF AN APPOINTMENT WITHOUT ONE (a walk-in registered as a guest) — from its detail:
 *   guest  keep / correct what was typed, still without a contact;
 *   create save it as a contact (a valid phone or email is required). If a contact already
 *          holds that phone/email it is returned as a MATCH to link — never a duplicate;
 *   link   attach an existing contact of this client.
 * Gated like every agenda write (agenda.book + the appointment's site/staff scope). A link is
 * never replaced: an appointment that already has a contact is refused. Written in one
 * transaction with the appointment row locked; recorded in the appointment's history.
 */

export type AppointmentContactResult =
  | { ok: true; contactId: string | null }
  | { ok: false; error: string; matches?: ContactMatch[]; fieldErrors?: Partial<Record<GuestField, string>> };

const GENERIC = "No disponible.";

async function matchesFor(tenantId: string, clientId: string, v: GuestValue, reveal: boolean): Promise<ContactMatch[]> {
  const out: ContactMatch[] = [];
  const seen = new Set<string>();
  for (const [kind, value] of [["phone", v.phone], ["email", v.email]] as const) {
    if (!value) continue;
    const { matches } = await findContactMatchesByIdentity(tenantId, clientId, value, { limit: 3 });
    for (const m of matches) {
      if (seen.has(m.contact_id)) continue;
      seen.add(m.contact_id);
      out.push({ contactId: m.contact_id, name: m.name, matchedBy: kind, matchedValue: reveal ? m.matched_value : maskIdentity(kind, value) });
    }
  }
  return out;
}

/** Read-only duplicate check while typing (never creates). */
export async function findContactMatchesAction(
  clientId: string,
  input: { siteId: string; phone?: string | null; email?: string | null },
): Promise<{ ok: true; matches: ContactMatch[] } | { ok: false; error: string; fieldErrors?: Partial<Record<GuestField, string>> }> {
  if (!isUuid(input.siteId)) return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "agenda.book", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const { scope } = g.context;
  if (!canAccessSchedulingSite(scope, input.siteId)) return { ok: false, error: GENERIC };
  const site = await getSiteById(scope.tenantId, input.siteId);
  if (!site || site.client_id !== g.context.client.id) return { ok: false, error: GENERIC };
  const typed = validateGuest({ phone: input.phone, email: input.email }, { timeZone: site.timezone, requireIdentity: false });
  if (!typed.ok) return { ok: false, error: "Revisa los datos.", fieldErrors: typed.fieldErrors };
  const reveal = !isSchedulingStaff(scope) && can(scope, "contacts.view", g.context.client.id);
  return { ok: true, matches: await matchesFor(scope.tenantId, g.context.client.id, typed.value, reveal) };
}

export async function saveAppointmentContactAction(
  clientId: string,
  appointmentId: string,
  input: { mode: "guest" | "create" | "link"; name?: string | null; phone?: string | null; email?: string | null; contactId?: string | null },
): Promise<AppointmentContactResult> {
  if (!isUuid(appointmentId) || (input.contactId && !isUuid(input.contactId))) return { ok: false, error: GENERIC };
  if (input.mode !== "guest" && input.mode !== "create" && input.mode !== "link") return { ok: false, error: GENERIC };
  const g = await gateClientModule(clientId, "scheduling", "agenda.book", GENERIC);
  if (!g.ok) return { ok: false, error: g.error };
  const { scope } = g.context;
  const client = g.context.client;
  const appt = await getAppointmentById(scope.tenantId, appointmentId);
  if (
    !appt ||
    appt.client_id !== client.id ||
    !canAccessSchedulingSite(scope, appt.site_id) ||
    !canAccessSchedulingStaff(scope, appt.staff_id)
  ) {
    return { ok: false, error: GENERIC };
  }
  if (appt.contact_id) return { ok: false, error: "Esta cita ya tiene un contacto vinculado." };
  const site = await getSiteById(scope.tenantId, appt.site_id);
  if (!site) return { ok: false, error: GENERIC };

  let typed: GuestValue = { name: null, phone: null, email: null };
  if (input.mode !== "link") {
    const v = validateGuest(
      { name: input.name, phone: input.phone, email: input.email },
      { timeZone: site.timezone, requireIdentity: input.mode === "create" },
    );
    if (!v.ok) return { ok: false, error: "Revisa los datos del cliente.", fieldErrors: v.fieldErrors };
    typed = v.value;
  }
  if (input.mode === "create") {
    const reveal = !isSchedulingStaff(scope) && can(scope, "contacts.view", client.id);
    const matches = await matchesFor(scope.tenantId, client.id, typed, reveal);
    if (matches.length > 0) {
      return { ok: false, error: "Ya existe un contacto con ese teléfono o correo. Vincúlalo en lugar de crear otro.", matches };
    }
  }
  if (input.mode === "link") {
    if (!input.contactId || !(await contactBelongsToClient(scope.tenantId, client.id, input.contactId))) {
      return { ok: false, error: "Ese contacto no existe en este negocio." };
    }
  }

  try {
    const result = await withTransaction(async (tx) => {
      const locked = await getAppointmentForUpdate(tx, scope.tenantId, appointmentId);
      if (!locked || locked.client_id !== client.id) return { kind: "gone" as const };
      if (locked.contact_id) return { kind: "linked" as const };
      if (input.mode === "guest") {
        await updateAppointmentGuest(tx, scope.tenantId, appointmentId, typed);
        return { kind: "ok" as const, contactId: null };
      }
      let contactId = input.contactId ?? null;
      if (input.mode === "create") {
        const primary = typed.phone ?? (typed.email as string);
        const resolved = await resolveContactByIdentity(
          {
            tenantId: scope.tenantId,
            clientId: client.id,
            channel: "walk_in",
            channelUserId: primary,
            name: typed.name,
            phone: typed.phone,
            email: typed.email,
          },
          tx,
        );
        contactId = resolved.contact.id;
      }
      const row = await attachAppointmentContact(tx, scope.tenantId, appointmentId, contactId as string);
      if (!row) return { kind: "linked" as const };
      await recordAppointmentEvent(
        {
          tenantId: scope.tenantId,
          appointmentId,
          eventType: "manual_note",
          actorType: "agent",
          actorUserId: scope.userId,
          detail: { action: input.mode === "create" ? "contact_created" : "contact_linked", contact_id: contactId },
        },
        tx,
      );
      return { kind: "ok" as const, contactId };
    });
    if (result.kind === "gone") return { ok: false, error: GENERIC };
    if (result.kind === "linked") return { ok: false, error: "Esta cita ya tiene un contacto vinculado." };
    await recordSchedulingEvent({
      tenantId: scope.tenantId,
      clientId: client.id,
      siteId: appt.site_id,
      eventType: "appointment.status_changed",
      payload: { appointment_id: appointmentId, contact_id: result.contactId },
    });
    revalidatePath(`/clients/${client.id}/scheduling/agenda`);
    return { ok: true, contactId: result.contactId };
  } catch {
    return { ok: false, error: "No se pudo guardar. Tus datos siguen aquí; vuelve a intentarlo." };
  }
}
