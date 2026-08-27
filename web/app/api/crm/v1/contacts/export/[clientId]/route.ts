import { resolveClientModuleContext } from "@/lib/clientModuleAccess";
import { hasFullAccess } from "@/lib/access";
import {
  listContacts,
  UNASSIGNED_OWNER,
  type ContactStage,
  type ContactTaskFilter,
} from "@worker/db/repositories/contacts.js";
import { listMembersForTenant } from "@worker/db/repositories/tenantMembers.js";
import { channelLabel, consentLabel, sourceLabel, stageLabel } from "@/lib/contactLabels";
import type { PreferredChannel } from "@worker/db/repositories/contacts.js";

/**
 * GET /api/crm/v1/contacts/export/[clientId]?q=&stage=&owner=&tasks=
 *
 * SESSION-authed CSV of the contacts list, for the redesign's `Exportar` control
 * (docs/ui-redesign-crm-inbox.md §2.1). It takes the SAME query params the screen is
 * showing, so what downloads is what the operator is looking at — filters and search
 * included — rather than "all contacts", which is the classic export bug.
 *
 * Access is the page's, not the machine API's: `resolveClientModuleContext` gives a 404
 * for a foreign/unknown client, one outside a member's scope, or a client whose `crm`
 * module is off. Indistinguishable across causes, exactly like the page.
 *
 * It exports the FILTERED SET, not the current page — an export is a dataset, and
 * "page 3 of my filter" is not a thing anyone wants in a spreadsheet. That set is
 * bounded by EXPORT_LIMIT rather than streamed: a chunked response would be the right
 * answer for a six-figure book, and this endpoint says so honestly in a trailing row
 * instead of silently truncating.
 */
export const dynamic = "force-dynamic";

/**
 * The ceiling. High enough for any real single-client contact book, low enough that the
 * response is built in memory without thought. A shop that exceeds it gets a final row
 * saying so — see the note above.
 */
const EXPORT_LIMIT = 5000;

const STAGES = new Set<string>(["new", "active", "customer", "archived"]);
const TASK_FILTERS = new Set<string>(["open", "overdue"]);

/**
 * One CSV field.
 *
 * Quotes unconditionally rather than only when needed: a contact's name can contain a
 * comma, a note a newline, and a phone a leading `+`, so "quote when it looks risky" is
 * a rule that gets it wrong eventually. Internal quotes are doubled per RFC 4180.
 *
 * The leading apostrophe on a value starting with `=`, `+`, `-` or `@` is FORMULA
 * INJECTION defence: Excel and Sheets evaluate such a cell, so an attacker-controlled
 * name like `=HYPERLINK("http://evil","click")` becomes a live link in whatever
 * spreadsheet an operator opens. Prefixing it makes the cell text. This matters here
 * specifically because most of these values arrive from the public internet — a phone
 * number and a display name a stranger chose on WhatsApp.
 */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvField).join(",");
}

/** ISO-8601 in UTC, or empty. A spreadsheet can parse this; a localised string cannot. */
function iso(d: Date | string | null): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  const result = await resolveClientModuleContext(clientId, "crm");
  if (!result.ok) return new Response("Not found", { status: 404 });
  const { scope, client } = result.context;

  const p = new URL(req.url).searchParams;
  // Validate every facet before it reaches SQL — an unknown value is simply no filter,
  // never an error and never an unfiltered tenant-wide read. Same rule as the page.
  const stageRaw = p.get("stage");
  const tasksRaw = p.get("tasks");
  const ownerRaw = p.get("owner");
  const search = p.get("q")?.trim() || undefined;

  const members = await listMembersForTenant(scope.tenantId);
  const ownerName = new Map(members.map((m) => [m.user_id, m.name ?? m.email]));
  const owner =
    ownerRaw === UNASSIGNED_OWNER
      ? UNASSIGNED_OWNER
      : ownerRaw && ownerName.has(ownerRaw)
        ? ownerRaw
        : undefined;

  const { items } = await listContacts(scope.tenantId, {
    search,
    stage: stageRaw && STAGES.has(stageRaw) ? (stageRaw as ContactStage) : undefined,
    tasks: tasksRaw && TASK_FILTERS.has(tasksRaw) ? (tasksRaw as ContactTaskFilter) : undefined,
    owner,
    clientId: client.id, // ALWAYS the validated client — the export stays inside it
    limit: EXPORT_LIMIT,
  });

  // A member sees the same rows they see on screen; only owner/admin get the internal
  // owner column filled in, matching how the page gates that information.
  const full = hasFullAccess(scope);

  const header = [
    "Nombre",
    "Email",
    "Teléfono",
    "Origen",
    "Stage",
    "Canal preferido",
    "Consentimiento",
    "No contactar",
    "Visitas",
    "No-shows",
    "Citas totales",
    "Última visita",
    "Última interacción",
    "Próxima cita",
    "Barbero habitual",
    "Tareas abiertas",
    "Tareas vencidas",
    ...(full ? ["Dueño"] : []),
    "Creado",
  ];

  const lines = [csvRow(header)];
  for (const c of items) {
    lines.push(
      csvRow([
        c.name ?? "",
        c.email ?? "",
        c.phone_e164 ?? "",
        sourceLabel(c.channel),
        stageLabel(c.stage),
        c.preferred_channel ? channelLabel(c.preferred_channel as PreferredChannel) : "",
        consentLabel(c.messaging_consent),
        c.do_not_contact ? "Sí" : "No",
        c.visit_count,
        c.no_show_count,
        c.appointment_count,
        iso(c.last_visit_at),
        iso(c.last_contact_at),
        iso(c.next_appointment_at),
        c.usual_staff_name ?? "",
        c.open_task_count,
        c.overdue_task_count,
        ...(full ? [c.assigned_to ? ownerName.get(c.assigned_to) ?? "" : ""] : []),
        iso(c.created_at),
      ]),
    );
  }
  if (items.length >= EXPORT_LIMIT) {
    // Never truncate silently: a file that stops at 5000 rows without saying so reads as
    // a complete export of a smaller book.
    lines.push(csvRow([`Exportación limitada a ${EXPORT_LIMIT} contactos.`]));
  }

  // A BOM so Excel on Windows reads the UTF-8 accents ("Teléfono", "Próxima") instead of
  // mojibake. Every other consumer ignores it.
  const body = `﻿${lines.join("\r\n")}\r\n`;
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contactos-${slug || "cliente"}-${stamp}.csv"`,
      // Contact data is per-session and per-filter; nothing about it should be cached.
      "cache-control": "no-store",
    },
  });
}
