import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { isUuid, parseYmd, parseStatus } from "@/lib/schedulingFilters";
import { getStaffForClient, serviceNamesByStaff } from "@worker/db/repositories/scheduling/staff.js";
import { listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { getAppointmentMetrics } from "@worker/db/repositories/scheduling/analytics.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { utcToZonedParts, localDayRangeToUtc } from "@worker/scheduling/timezone.js";
import { StaffDetail } from "@/components/scheduling/StaffDetail";

/**
 * Scheduling → Team → barber detail. Gated by the central `scheduling` resolver;
 * READ-ONLY, so members authorized for this client may consult it. OWNERSHIP GUARD:
 * getStaffForClient resolves the staff ONLY if its SITE belongs to the validated
 * client — a valid UUID from another client (or tenant) returns null → 404. Staff is
 * the independent `staff` entity (never a CRM contact). Contact links appear only
 * when the CRM module is enabled; `?from=` and the range/status filters persist.
 */
const WEEK_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export default async function StaffDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string; staffId: string }>;
  searchParams: Promise<{ from?: string; start?: string; end?: string; status?: string }>;
}) {
  await connection();
  const { clientId, staffId } = await params;
  if (!isUuid(staffId)) notFound();
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  const tenantId = scope.tenantId;
  const sp = await searchParams;

  // OWNERSHIP: staff must belong to a site of THIS client (else 404 — a foreign or
  // cross-tenant UUID never reveals anything).
  const staff = await getStaffForClient(tenantId, client.id, staffId);
  if (!staff) notFound();
  const tz = staff.site_timezone;

  // Default range: the last 30 LOCAL days (site timezone), inclusive.
  const today = utcToZonedParts(new Date(), tz);
  const todayYmd = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const back = new Date(Date.UTC(today.year, today.month - 1, today.day));
  back.setUTCDate(back.getUTCDate() - 29);
  const defaultStart = `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, "0")}-${String(back.getUTCDate()).padStart(2, "0")}`;

  const startYmd = parseYmd(sp.start) ?? defaultStart;
  const endYmd = parseYmd(sp.end) ?? todayYmd;
  const statusFilter = parseStatus(sp.status);
  const { from, to } = localDayRangeToUtc(startYmd, endYmd, tz);

  const [svcMap, upcoming, summary, history, crmEnabled] = await Promise.all([
    serviceNamesByStaff(tenantId, [staff.id]),
    listAppointments(tenantId, {
      clientId: client.id,
      staffId: staff.id,
      from: new Date(),
      status: ["scheduled", "confirmed"],
      order: "asc",
      limit: 25,
    }),
    getAppointmentMetrics(tenantId, { clientId: client.id, siteId: staff.site_id, from, to, staffId: staff.id }),
    listAppointments(tenantId, {
      clientId: client.id,
      staffId: staff.id,
      from,
      to,
      status: statusFilter ?? undefined,
      order: "desc",
      limit: 50,
    }),
    isClientModuleEnabled(tenantId, client.id, "crm"),
  ]);

  const workingHours = WEEK_ORDER.filter((wd) => (staff.working_hours[wd]?.length ?? 0) > 0).map((wd) => ({
    weekday: wd,
    ranges: (staff.working_hours[wd] ?? []).map((r) => ({ start: r.start, end: r.end })),
  }));

  const toDTO = (a: (typeof history)[number]) => ({
    id: a.id,
    start_at: a.start_at.toISOString(),
    service_end_at: a.service_end_at.toISOString(),
    service_name: a.service_name_snapshot,
    status: a.status,
    contact_id: a.contact_id,
    contact_name: a.contact_name,
  });

  const fromQS = sp.from ? `?from=${encodeURIComponent(sp.from)}` : "";

  return (
    <StaffDetail
      basePath={`/clients/${client.id}/scheduling/staff/${staff.id}`}
      backHref={`/clients/${client.id}/scheduling/staff${fromQS}`}
      from={sp.from ?? null}
      contactsBase={crmEnabled ? `/clients/${client.id}/contacts` : null}
      timezone={tz}
      staff={{
        name: staff.name,
        siteName: staff.site_name,
        active: staff.active,
        services: svcMap.get(staff.id) ?? [],
        workingHours,
      }}
      upcoming={upcoming.map(toDTO)}
      range={{ start: startYmd, end: endYmd, status: statusFilter }}
      summary={{
        total: summary.total,
        scheduled: summary.scheduled,
        confirmed: summary.confirmed,
        completed: summary.completed,
        cancelled: summary.cancelled,
        no_show: summary.no_show,
      }}
      history={history.map(toDTO)}
    />
  );
}
