import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { pickAllowedId } from "@/lib/schedulingFilters";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";
import { listStaff, staffOperationalSummary, serviceNamesByStaff } from "@worker/db/repositories/scheduling/staff.js";
import { AutoRefresh } from "@/components/AutoRefresh";

/**
 * Scheduling → Team (barbers). Operational, READ-ONLY: any user authorized for this
 * client (owner/admin or the client's members) can consult it; editing stays in
 * Settings (owner/admin). Gated by the central `scheduling` resolver (404 for
 * foreign/default/disabled/missing). ALL data uses the VALIDATED client id; a `?site=`
 * from another client can't match a loaded site and is ignored. Staff is NEVER a CRM
 * contact — it's the independent `staff` entity, scoped to the client via its site.
 */
export default async function SchedulingTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ site?: string; from?: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "scheduling");
  const sp = await searchParams;
  const tenantId = scope.tenantId;

  const sites = await listSites(tenantId, { clientId: client.id, includeInactive: true });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const siteFilter = pickAllowedId(sp.site, siteById.keys());

  // Include inactive barbers (their active/inactive state is a column).
  const staff = await listStaff(tenantId, { clientId: client.id, includeInactive: true, siteId: siteFilter });
  const [summary, svcByStaff] = await Promise.all([
    staffOperationalSummary(tenantId, client.id, { siteId: siteFilter }),
    serviceNamesByStaff(tenantId, staff.map((s) => s.id)),
  ]);

  const base = `/clients/${client.id}/scheduling/staff`;
  const fromQS = sp.from ? `?from=${encodeURIComponent(sp.from)}` : "";
  const detailQS = (staffId: string) => {
    const p = new URLSearchParams();
    if (sp.from) p.set("from", sp.from);
    const s = p.toString();
    return `${base}/${staffId}${s ? `?${s}` : ""}`;
  };
  const fmt = (d: Date | null, tz: string): string =>
    d ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(d)) : "—";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-6 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <AutoRefresh intervalSeconds={30} />
      </header>

      {sites.length > 1 ? (
        <form className="flex items-center gap-2" action={base}>
          {sp.from ? <input type="hidden" name="from" value={sp.from} /> : null}
          <select name="site" defaultValue={sp.site ?? ""} className="rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm">
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-subtle">Filter</button>
          {siteFilter ? (
            <Link href={base + fromQS} className="px-2 py-1.5 text-sm text-muted hover:text-foreground">
              Clear
            </Link>
          ) : null}
        </form>
      ) : null}

      {staff.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-5 py-8 text-sm text-muted">
          No barbers configured yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-subtle text-left text-xs uppercase tracking-wider text-faint">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Site</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Services</th>
                <th className="px-3 py-2 font-medium">Next appointment</th>
                <th className="px-3 py-2 font-medium">Today</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((st) => {
                const site = siteById.get(st.site_id);
                const ops = summary.get(st.id);
                const services = svcByStaff.get(st.id) ?? [];
                return (
                  <tr key={st.id} className="border-b border-line last:border-0 hover:bg-subtle">
                    <td className="px-3 py-2">
                      <Link href={detailQS(st.id)} className="font-medium text-accent hover:underline">
                        {st.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-muted">{site?.name ?? "—"}</td>
                    <td className="px-3 py-2">
                      {st.active ? (
                        <span className="rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">active</span>
                      ) : (
                        <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px] text-faint">inactive</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted">{services.length > 0 ? services.join(", ") : "—"}</td>
                    <td className="px-3 py-2 text-muted">{fmt(ops?.next_appointment_at ?? null, site?.timezone ?? "America/Bogota")}</td>
                    <td className="px-3 py-2 text-muted">{ops?.today_count ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
