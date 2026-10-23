import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { resolveStaffParam } from "@/lib/semanticParams";
import { localClock24 } from "@/lib/localTime";
import { PUBLIC_REASON_LABEL } from "@/lib/publicAbsenceReason";
import { listStaff } from "@worker/db/repositories/scheduling/staff.js";
import { loadExplainExceptions } from "@worker/db/repositories/scheduling/availabilityData.js";
import { explainStaffStatus, type DayStatus } from "@worker/scheduling/availabilityExplain.js";
import { utcToZonedParts, zonedPartsToUtc } from "@worker/scheduling/timezone.js";

/**
 * GET /api/scheduling/v1/staff/status?site_id=&(staff_id|staff)=&date=YYYY-MM-DD[&days=1..14]
 * — MACHINE endpoint (scheduling.read). "¿Trabaja Falla hoy?" WITHOUT a service.
 *
 * Per local day of the site: whether the professional works (shift ∩ opening hours, minus
 * site closures and their own blocks), the shift time left, and — only when a block covers
 * the whole shift and a person chose it in the block form — its PUBLIC reason. No
 * appointment is read and no bookable time is given: slots depend on a service, so for
 * concrete times call /availability (with explain=true for the reasons). Same auth and
 * client → site → staff scoping as /availability; the internal block text never leaves.
 */
export const dynamic = "force-dynamic";

function message(d: DayStatus, name: string): string {
  switch (d.summary) {
    case "working":
      return `${name} trabaja ese día.`;
    case "site_closed_day":
      return "La sede no abre ese día.";
    case "off_shift":
      return `${name} no trabaja ese día.`;
    case "absence":
      if (d.status === "partly_working") return `${name} trabaja solo parte de ese día.`;
      if (d.public_reason === "vacation") return `${name} está de vacaciones en esa fecha.`;
      if (d.public_reason === "unavailable") return `${name} no está disponible en esa fecha.`;
      return `${name} no tiene disponibilidad ese día.`;
    case "site_closure":
      if (d.status === "partly_working") return `${name} trabaja solo parte de ese día.`;
      if (d.public_reason === "site_closed") return "La sede está cerrada en esa fecha.";
      if (d.public_reason === "unavailable") return "La sede no está disponible en esa fecha.";
      return `${name} no tiene disponibilidad ese día.`;
    default:
      return d.status === "partly_working" ? `${name} trabaja solo parte de ese día.` : `${name} no tiene disponibilidad ese día.`;
  }
}

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const owned = await resolveOwnedSite(auth.auth, p.get("site_id"), { requireActive: true });
  if (!owned.ok) return owned.response;
  const stf = await resolveStaffParam(auth.auth, owned.site.id, p.get("staff_id"), p.get("staff"));
  if (!stf.ok) return stf.response;
  if (!stf.value) return schedulingError(400, "invalid_request", "staff_id or staff is required.");

  const tz = owned.site.timezone;
  const dateRaw = p.get("date");
  let y: number, m: number, d: number;
  if (dateRaw) {
    const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateRaw);
    if (!mt) return schedulingError(400, "invalid_request", "date must be YYYY-MM-DD (site-local).");
    [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return schedulingError(400, "invalid_request", "date is not a real day.");
  } else {
    const t = utcToZonedParts(new Date(), tz);
    [y, m, d] = [t.year, t.month, t.day];
  }
  const daysRaw = p.get("days") ?? "1";
  if (!/^\d{1,2}$/.test(daysRaw) || Number(daysRaw) < 1 || Number(daysRaw) > 14) {
    return schedulingError(400, "invalid_request", "days must be an integer from 1 to 14.");
  }
  const dates = Array.from({ length: Number(daysRaw) }, (_, i) => {
    const u = new Date(Date.UTC(y, m - 1, d + i));
    return { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate() };
  });
  const from = zonedPartsToUtc(dates[0].year, dates[0].month, dates[0].day, 0, 0, tz);
  const last = dates[dates.length - 1];
  const after = new Date(Date.UTC(last.year, last.month - 1, last.day + 1));
  const to = zonedPartsToUtc(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate(), 0, 0, tz);

  const staffRows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id });
  const member = staffRows.find((s) => s.id === stf.value);
  if (!member) return schedulingError(404, "staff_not_found", "No active staff with that id at this site.");
  const exc = await loadExplainExceptions({ tenantId: auth.auth.tenantId, siteId: owned.site.id, from, to, staffIds: [member.id] });
  const days = explainStaffStatus({
    site: { timezone: tz, opening_hours: owned.site.opening_hours },
    staff: { id: member.id, working_hours: member.working_hours },
    dates,
    siteExceptions: exc.site,
    staffExceptions: exc.staff.get(member.id) ?? [],
    breaks: [...exc.siteBreaks, ...(exc.staffBreaks.get(member.id) ?? [])],
  });

  return Response.json({
    site: { id: owned.site.id, timezone: tz },
    staff: { id: member.id, name: member.name, takes_bookings: member.takes_bookings },
    days: days.map((x) => ({
      date: x.date,
      status: x.status,
      summary: x.summary,
      public_reason: x.public_reason,
      public_reason_label: x.public_reason ? PUBLIC_REASON_LABEL[x.public_reason] : null,
      customer_message: message(x, member.name),
      // Shift left after blocks, site-local clock. Not bookable times — see /availability.
      shift: x.shift.map((s) => ({ from: localClock24(s.from, tz), until: localClock24(s.until, tz) === "00:00" ? "24:00" : localClock24(s.until, tz) })),
      causes: x.causes.map((c) => ({ code: c.code, coverage: c.coverage, public_reason: c.public_reason })),
    })),
    // "working" = has shift time that day not covered by a site closure or their own block.
    // It does NOT mean free slots (those depend on the service and on appointments, which are
    // not read here) and it does NOT confirm physical presence.
    note: "Status only: whether the professional has a shift that day. 'working' does not guarantee bookable slots (call /availability with a service) nor physical presence.",
  });
}
