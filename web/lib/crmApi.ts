import "server-only";
import { authenticateHandoffRequest } from "@/lib/handoffApi";
import type { Capability } from "@worker/db/repositories/handoffTokens.js";
import { parseWorkflowRef } from "@worker/scheduling/workflowRef.js";
import { resolveWorkflowForConnection } from "@worker/db/repositories/workflows.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { withTransaction } from "@worker/db/client.js";
import { getContactById, setContactConsent, type ContactRow, type MessagingConsent } from "@worker/db/repositories/contacts.js";
import { listIdentitiesForContact } from "@worker/db/repositories/contactIdentities.js";
import { listNotesForContact } from "@worker/db/repositories/contactNotes.js";
import { listTagsForContact } from "@worker/db/repositories/contactTags.js";
import { listAppointmentsForContact } from "@worker/db/repositories/scheduling/appointments.js";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { recordCrmActivity, type CrmEventType } from "@worker/db/repositories/crmActivityEvents.js";
import { summarizeAppointments } from "@/lib/contactPanel";
import { DEFAULT_LABEL_LOCALE, localMomentFields, localStartFields } from "@/lib/localTime";

/**
 * Shared auth + scope + projection for the n8n-facing CRM API (app/api/crm/v1/*).
 * MACHINE-only: Bearer token + an X-Workflow-Ref header — the SAME chain as the
 * scheduling API, so a token can only ever touch the ONE client its workflow ref
 * resolves to. tenant_id and client_id are NEVER accepted from the request. The
 * capability (crm.read | crm.write) is enforced in the chokepoint BEFORE scope, so a
 * token without it is refused with the identical 401 (indistinguishable from a bad
 * token). CHANNEL-BLIND: nothing here names a channel; identities are phone/email/
 * external as C-2 defined them.
 */

export interface CrmAuth {
  tenantId: string;
  connectionId: string;
  tokenId: string;
  workflowRef: string;
  /** The workflow's owning client — the ONLY client this request may touch. */
  clientId: string;
}
export type CrmAuthResult = { ok: true; auth: CrmAuth } | { ok: false; response: Response };

/** The one machine error shape: { error: { code, message } }. `message` is
 *  human-readable because the agent paraphrases it to a customer; never leak internals. */
export function crmError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Authenticate + capability-check + resolve the CRM scope. Failure modes mirror the
 * scheduling API exactly (byte-identical bodies where they overlap):
 *  - no/invalid/revoked token, OR a token WITHOUT `capability` → the handoff 401.
 *  - X-Workflow-Ref missing/blank → 400 workflow_ref_required.
 *  - unknown/wrong-connection/wrong-tenant workflow → 404 not_found.
 *  - workflow on the default client, or the crm module disabled → 403 module_disabled.
 */
export async function authenticateCrm(req: Request, capability: Capability): Promise<CrmAuthResult> {
  const result = await authenticateHandoffRequest(req, capability);
  if (!result.ok) return { ok: false, response: result.response };
  const { tenantId, connectionId, tokenId } = result.auth;

  const workflowRef = parseWorkflowRef(req.headers.get("x-workflow-ref"));
  if (!workflowRef) return { ok: false, response: crmError(400, "workflow_ref_required", "X-Workflow-Ref header is required.") };

  const wf = await resolveWorkflowForConnection(tenantId, connectionId, workflowRef);
  if (!wf) return { ok: false, response: crmError(404, "not_found", "Workflow not found.") };
  // Default client can't have modules; a non-default client must have crm enabled. Both
  // surface as module_disabled (the workflow DOES belong to the token — not a 404).
  if (wf.client_is_default || !(await isClientModuleEnabled(tenantId, wf.client_id, "crm"))) {
    return { ok: false, response: crmError(403, "module_disabled", "CRM module is disabled for this client.") };
  }
  return { ok: true, auth: { tenantId, connectionId, tokenId, workflowRef: wf.n8n_workflow_id, clientId: wf.client_id } };
}

/** The Idempotency-Key header (optional for CRM writes), trimmed, or null. */
export function idempotencyKey(req: Request): string | null {
  const v = (req.headers.get("idempotency-key") ?? "").trim();
  return v.length > 0 ? v : null;
}

/** Record an automation-driven CRM audit fact in its own small transaction (actor is the
 *  machine, never a user) so the C-4 timeline attributes it to "Automation". */
export async function recordAutomationActivity(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  eventType: CrmEventType;
  detail?: Record<string, unknown>;
}): Promise<void> {
  await withTransaction((client) =>
    recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: input.eventType,
      actorUserId: null,
      actorKind: "automation",
      detail: input.detail,
    }),
  );
}

/** Overwrite consent (an explicit opt-out must stick) + record consent_changed as the
 *  automation, atomically. Consent is store-only — it never gates replies. */
export async function applyConsentAsAutomation(
  tenantId: string,
  clientId: string,
  contactId: string,
  consent: MessagingConsent,
  source: string | null,
): Promise<void> {
  await withTransaction(async (client) => {
    await setContactConsent(tenantId, clientId, contactId, consent, source, client);
    await recordCrmActivity(client, {
      tenantId,
      clientId,
      contactId,
      eventType: "consent_changed",
      actorUserId: null,
      actorKind: "automation",
      detail: { consent, source },
    });
  });
}

/** The machine-facing contact summary (channel-blind). */
export interface MachineContact {
  id: string;
  name: string | null;
  stage: string;
  owner_user_id: string | null;
  is_customer: boolean;
  visits: number;
  no_shows: number;
  consent: string;
  custom_fields: Record<string, unknown>;
  identities: Array<{ kind: string; value: string; label: string | null }>;
  tags: string[];
  next_appointment: {
    id: string;
    public_reference: string;
    service_name: string;
    staff_name: string | null;
    // UTC stays the canonical wire value; the *_local / *_label / day fields are the C-6
    // labels an agent reads aloud (in the appointment's SITE tz unless `tz` overrides).
    start_at: string;
    start_local: string;
    start_label: string;
    date_label: string;
    day: string;
    status: string;
  } | null;
  recent_notes: Array<{
    id: string;
    body: string;
    author: "user" | "automation" | "system";
    created_at: string;
    created_at_local: string;
    created_at_label: string;
  }>;
}

const RECENT_NOTES = 5;

/** E-4 compact contact for a conversational caller (`?compact=true`): drop the fields an
 *  agent never reads — owner_user_id, next_appointment.public_reference + its raw UTC pair,
 *  identity labels, and note created_at + created_at_local (keep the spoken label). The full
 *  shape stays the default. */
export interface CompactContact {
  id: string;
  name: string | null;
  stage: string;
  is_customer: boolean;
  visits: number;
  no_shows: number;
  consent: string;
  custom_fields: Record<string, unknown>;
  identities: Array<{ kind: string; value: string }>;
  tags: string[];
  next_appointment: { id: string; service_name: string; staff_name: string | null; start_label: string; date_label: string; day: string; status: string } | null;
  recent_notes: Array<{ id: string; body: string; author: "user" | "automation" | "system"; created_at_label: string }>;
}

export function toCompactContact(c: MachineContact): CompactContact {
  const n = c.next_appointment;
  return {
    id: c.id,
    name: c.name,
    stage: c.stage,
    is_customer: c.is_customer,
    visits: c.visits,
    no_shows: c.no_shows,
    consent: c.consent,
    custom_fields: c.custom_fields,
    identities: c.identities.map((i) => ({ kind: i.kind, value: i.value })),
    tags: c.tags,
    next_appointment: n
      ? { id: n.id, service_name: n.service_name, staff_name: n.staff_name, start_label: n.start_label, date_label: n.date_label, day: n.day, status: n.status }
      : null,
    recent_notes: c.recent_notes.map((r) => ({ id: r.id, body: r.body, author: r.author, created_at_label: r.created_at_label })),
  };
}

/** Optional presentation controls for a machine contact response (mirrors the scheduling
 *  routes' `tz`/`locale`). tz defaults to the appointment's / client's site timezone. */
export interface ContactLabelOpts {
  tzOverride?: string | null;
  locale?: string;
}

/** Load + project a contact for the API. Returns null when the contact isn't found under
 *  this client (missing OR cross-client — indistinguishable). Bounded queries only. */
export async function loadMachineContact(
  tenantId: string,
  clientId: string,
  contactId: string,
  labels: ContactLabelOpts = {},
): Promise<MachineContact | null> {
  const contact = await getContactById(tenantId, contactId, clientId);
  if (!contact) return null;
  const [identities, appts, notes, tags] = await Promise.all([
    listIdentitiesForContact(tenantId, clientId, contactId),
    listAppointmentsForContact(tenantId, contactId, clientId),
    listNotesForContact(tenantId, clientId, contactId),
    listTagsForContact(tenantId, clientId, contactId),
  ]);
  // A single presentation tz for site-less fields (notes): the ?tz override, else any of
  // this contact's appointment site tzs, else the client's first site, else UTC. One extra
  // query only when there is no override and no appointment to borrow a tz from.
  const locale = labels.locale ?? DEFAULT_LABEL_LOCALE;
  let notesTz = labels.tzOverride ?? appts[0]?.site_timezone ?? null;
  if (!notesTz) notesTz = (await listSites(tenantId, { clientId }))[0]?.timezone ?? "UTC";
  return projectContact(contact, identities, appts, notes, tags, { tzOverride: labels.tzOverride ?? null, locale, notesTz });
}

export function projectContact(
  contact: ContactRow,
  identities: Array<{ kind: string; value: string; label: string | null }>,
  appts: Parameters<typeof summarizeAppointments>[0],
  notes: Array<{ id: string; body: string; author_kind: "user" | "automation"; created_by_user_id: string | null; created_at: Date }>,
  tags: Array<{ name: string }>,
  labels: { tzOverride: string | null; locale: string; notesTz: string },
): MachineContact {
  const summary = summarizeAppointments(appts);
  const next = summary.next;
  // next_appointment labels use the appointment's OWN site tz (unless `tz` overrides), since
  // it happens at a physical place; a raw UTC alone made the agent say "4 p. m." for 11 a. m.
  const nextTz = labels.tzOverride ?? next?.siteTimezone ?? labels.notesTz;
  return {
    id: contact.id,
    name: contact.name,
    stage: contact.stage,
    owner_user_id: contact.assigned_to,
    is_customer: summary.isCustomer,
    visits: summary.visitCount,
    no_shows: summary.noShowCount,
    consent: contact.messaging_consent,
    custom_fields: contact.custom_fields ?? {},
    identities: identities.map((i) => ({ kind: i.kind, value: i.value, label: i.label })),
    tags: tags.map((t) => t.name),
    next_appointment: next
      ? {
          id: next.id,
          public_reference: next.publicReference,
          service_name: next.serviceName,
          staff_name: next.staffName,
          start_at: next.startAt,
          ...localStartFields(new Date(next.startAt), nextTz, labels.locale),
          status: next.status,
        }
      : null,
    recent_notes: notes.slice(0, RECENT_NOTES).map((n) => {
      const m = localMomentFields(n.created_at, labels.notesTz, labels.locale);
      return {
        id: n.id,
        body: n.body,
        author: n.author_kind === "automation" ? "automation" : n.created_by_user_id ? "user" : "system",
        created_at: n.created_at.toISOString(),
        created_at_local: m.local,
        created_at_label: m.label,
      };
    }),
  };
}
