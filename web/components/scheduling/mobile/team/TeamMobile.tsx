"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MToast, staffColors } from "@/components/scheduling/mobile/kit";
import type { StaffAppointment, StaffTabProps } from "@/components/scheduling/staff/StaffTab";
import { staffProfileHref } from "@/lib/staffProfileUrl";
import { CreateForm } from "./forms";
import { presenceFor, rosterOrder, todayLoad } from "./presence";
import { TeamList, type TeamRow, type TeamSeg } from "./TeamList";
import { TeamMember } from "./TeamMember";

/** What only the phone screens need, on top of the roster the desktop already gets (site
 *  hours and closures now live on the roster props: both widths derive presence from them). */
export interface TeamMobileExtras {
  clientName: string;
  /** May the viewer add a professional? (The server checks again on create.) */
  canCreate: boolean;
}

/**
 * EQUIPO on a phone (< md). The desktop/tablet roster (StaffTab) is untouched and renders
 * beside this in a `hidden md:…` tree; this one is `md:hidden`. Both read the SAME page
 * data; this tree also lists INACTIVE professionals (labelled), which the desktop roster
 * filters out as it always has.
 *
 * The detail screen is a URL, `?s=<staffId>` — the SAME parameter as the desktop drawer
 * (lib/staffProfileUrl), so a profile link opens the same professional at any width; the
 * old `?p=` still opens it. The desktop drawer mounted in the hidden tree keeps its focus
 * trap off below md (StaffTab), so sharing the parameter never traps focus on a phone.
 */
export function TeamMobile({ clientId, staff, extras }: { clientId: string; staff: StaffTabProps; extras: TeamMobileExtras }) {
  const router = useRouter();
  const query = useSearchParams();
  const [search, setSearch] = useState("");
  const [seg, setSeg] = useState<TeamSeg>("all");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // "Now" is the server's instant on first paint (so SSR and hydration agree), then a
  // one-minute tick keeps "En turno / Ocupado según agenda" honest while the screen stays open.
  const [tick, setTick] = useState<number | null>(null);
  useEffect(() => {
    const t = window.setInterval(() => setTick(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const now = tick ?? Date.parse(staff.todayIso);
  const tz = staff.timezone;
  const site = staff.sites.find((s) => s.id === staff.currentSiteId) ?? staff.sites[0];
  const siteName = site?.name ?? "";

  const showToast = (msg: string) => {
    window.clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  // The SITE's colour map — every staff id of the site, active or not, as the agenda does.
  const colors = useMemo(() => staffColors(staff.members.map((m) => m.id)), [staff.members]);

  const apptsBy = useMemo(() => {
    const map = new Map<string, StaffAppointment[]>();
    for (const a of staff.todayAppointments) {
      const list = map.get(a.staffId) ?? [];
      list.push(a);
      map.set(a.staffId, list);
    }
    for (const list of map.values()) list.sort((x, y) => x.startAt.localeCompare(y.startAt));
    return map;
  }, [staff.todayAppointments]);

  const fmtDay = (iso: string) =>
    new Intl.DateTimeFormat("es-CO", { timeZone: tz, day: "numeric", month: "short" }).format(new Date(iso)).replace(/\./g, "");

  // Active first (their order from the server: by name); inactive ones last, still shown —
  // the same roster, in the same order, as the desktop (rosterOrder).
  const rows: TeamRow[] = rosterOrder(staff.members)
    .map((member) => {
      const appts = apptsBy.get(member.id) ?? [];
      const presence = presenceFor({
        active: member.active,
        workingHours: member.workingHours,
        siteHours: staff.openingHours,
        appts,
        timeOff: [...staff.timeOff, ...(staff.presenceBlocks ?? [])].filter((t) => t.staffId === member.id),
        closures: staff.closures,
        now,
        tz,
        fmtDay,
      });
      const load = member.takesBookings ? todayLoad(appts).label : "No recibe citas";
      return { member, presence, load };
    });

  const href = (id: string | null) => staffProfileHref(query.toString(), id, { siteId: staff.currentSiteId });

  const selected = staff.selectedId ? rows.find((r) => r.member.id === staff.selectedId) : undefined;

  return (
    <div className="u-sch-m -m-[var(--content-pad)] flex min-h-[calc(100%_+_var(--content-pad)_*_2)] flex-none flex-col bg-m-bg md:hidden">
      {selected ? (
        <TeamMember
          key={selected.member.id}
          clientId={clientId}
          member={selected.member}
          presence={selected.presence}
          appts={apptsBy.get(selected.member.id) ?? []}
          services={staff.services}
          siteId={staff.currentSiteId}
          siteName={siteName}
          tz={tz}
          now={now}
          openingHours={staff.openingHours}
          timeOff={staff.timeOff.filter((t) => t.staffId === selected.member.id)}
          windowAppointments={staff.windowAppointments.filter((a) => a.staffId === selected.member.id)}
          color={colors.get(selected.member.id)}
          listHref={href(null)}
          onToast={showToast}
          photoUploadEnabled={staff.photoUploadEnabled ?? false}
        />
      ) : (
        <TeamList
          clientName={extras.clientName}
          siteName={siteName}
          rows={rows}
          services={staff.services}
          sites={staff.sites}
          currentSiteId={staff.currentSiteId}
          search={search}
          onSearch={setSearch}
          seg={seg}
          onSeg={setSeg}
          hrefFor={(id) => href(id)}
          colors={colors}
          onAdd={extras.canCreate ? () => setCreating(true) : undefined}
        />
      )}

      <CreateForm
        open={creating}
        clientId={clientId}
        siteId={staff.currentSiteId ?? site?.id}
        siteName={siteName}
        services={staff.services}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          showToast("Profesional añadido");
          if (id) {
            sessionStorage.setItem("m-team-from-list", "1");
            router.push(href(id));
          }
          router.refresh();
        }}
      />
      <MToast message={toast} bottom={24} />
    </div>
  );
}
