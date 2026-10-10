"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon, ICON, M_CARD, MSegmented, MStaffAvatar } from "@/components/scheduling/mobile/kit";
import { initialsOf } from "@/lib/staffTone";
import type { StaffMember, StaffServiceOpt, StaffSiteOpt } from "@/components/scheduling/staff/StaffTab";
import { presenceSegCounts, type Presence } from "./presence";

export type TeamSeg = "all" | "on" | "off";

export interface TeamRow {
  member: StaffMember;
  presence: Presence;
  load: string;
}

/**
 * EQUIPO (reference 4.15) — the phone roster. One row per professional: avatar, the name
 * (it WRAPS, never truncates), a presence chip with its glyph and words, the line that
 * goes with it and today's load. Every one of those is derived (see presence.ts).
 *
 * Inactive professionals stay in the list, last, labelled "Inactivo".
 */
export function TeamList({
  clientName,
  siteName,
  rows,
  services,
  sites,
  currentSiteId,
  search,
  onSearch,
  seg,
  onSeg,
  hrefFor,
  colors,
  onAdd,
}: {
  clientName: string;
  siteName: string;
  rows: TeamRow[];
  services: StaffServiceOpt[];
  sites: StaffSiteOpt[];
  currentSiteId?: string;
  search: string;
  onSearch: (v: string) => void;
  seg: TeamSeg;
  onSeg: (v: TeamSeg) => void;
  hrefFor: (id: string) => string;
  /** The site's avatar colours (kit `staffColors` over every staff id of the site, active
   *  or not — the agenda builds the same map, so a person keeps one colour everywhere). */
  colors: Map<string, string>;
  /** Absent when the viewer cannot add a professional. */
  onAdd?: () => void;
}) {
  const router = useRouter();
  // Same set as the desktop pills: Todos = everyone listed, inactive included; En turno =
  // on shift now; Fuera = the rest (presence.ts).
  const counts = presenceSegCounts(rows.map((r) => r.presence));
  const q = search.trim().toLocaleLowerCase("es");
  const visible = rows.filter((r) => {
    if (seg === "on" && !r.presence.onShift) return false;
    if (seg === "off" && r.presence.onShift) return false;
    if (!q) return true;
    // Same haystack as the desktop roster: name, title, site, the services they perform.
    const names = services.filter((s) => r.member.serviceIds.includes(s.id)).map((s) => s.name);
    return [r.member.name, r.member.title, r.member.siteName, ...names].filter(Boolean).join(" ").toLocaleLowerCase("es").includes(q);
  });

  return (
    <>
      <header className="sticky top-[calc(var(--content-pad)*-1)] z-10 flex-none border-b border-m-bd bg-m-sf px-4 pb-3 pt-[10px]">
        <div className="flex min-h-[44px] items-center gap-[10px]">
          <span aria-hidden className="flex size-9 flex-none items-center justify-center rounded-full bg-m-pri text-[12px] font-semibold text-m-onpri">
            {initialsOf(clientName)}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="m-0 text-[21px] font-semibold leading-[1.2] tracking-[-0.01em]">Equipo</h1>
            <span className="text-[13px] leading-[1.3] text-m-tx3 [overflow-wrap:anywhere]">
              {clientName} · {siteName}
            </span>
          </div>
          {onAdd ? (
            <button
              type="button"
              aria-label="Añadir profesional"
              onClick={onAdd}
              className="flex size-[44px] flex-none items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-m-tx"
            >
              <Icon d={ICON.plus} size={18} width={1.6} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 pb-[max(32px,env(safe-area-inset-bottom))] pt-4">
        <label className="u-focus flex h-12 items-center gap-2 rounded-[12px] border border-m-bd bg-m-sf px-3 text-m-tx3">
          <Icon d={ICON.search} size={18} />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Buscar profesional"
            aria-label="Buscar profesional"
            className="h-[44px] min-w-0 flex-1 border-0 bg-transparent text-[16px] text-m-tx outline-none placeholder:text-m-tx3"
          />
        </label>

        {sites.length > 1 ? (
          <label className="u-focus relative flex h-12 items-center rounded-[12px] border border-m-bd bg-m-sf px-[14px] text-[16px] text-m-tx">
            <span className="sr-only">Sede</span>
            <select
              value={currentSiteId ?? ""}
              onChange={(e) => router.push(`?site=${e.target.value}`)}
              className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent pr-6 text-[16px] text-m-tx outline-none"
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <span aria-hidden className="pointer-events-none absolute right-[14px] rotate-90 text-m-tx3">
              <Icon d={ICON.next} size={16} />
            </span>
          </label>
        ) : null}

        <MSegmented<TeamSeg>
          label="Presencia"
          stretch
          value={seg}
          onChange={onSeg}
          options={[
            { value: "all", label: `Todos ${counts.all}` },
            { value: "on", label: `En turno ${counts.on}` },
            { value: "off", label: `Fuera ${counts.off}` },
          ]}
        />

        <div className={M_CARD}>
          {visible.map((r, i) => (
            <Link
              key={r.member.id}
              href={hrefFor(r.member.id)}
              onClick={() => sessionStorage.setItem("m-team-from-list", "1")}
              className={`flex min-h-[92px] w-full items-start gap-3 py-[14px] pl-[14px] pr-3 text-left text-m-tx no-underline ${i ? "border-t border-m-dv" : ""}`}
            >
              <MStaffAvatar id={r.member.id} name={r.member.name} size={44} color={colors.get(r.member.id)} />
              <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
                <span className="text-[16px] font-semibold leading-[1.3] [overflow-wrap:anywhere] [text-wrap:pretty]">{r.member.name}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <PresenceChip presence={r.presence} />
                  <span className="text-[13px] text-m-tx3">{r.presence.sub}</span>
                </span>
                <span className="text-[13px] text-m-tx2">{r.load}</span>
              </span>
              <span aria-hidden className="pt-[10px] text-[20px] leading-none text-m-tx3">
                ›
              </span>
            </Link>
          ))}
          {visible.length === 0 ? (
            <div className="px-[14px] py-5 text-[14px] text-m-tx3">
              {rows.length === 0 ? "Todavía no hay profesionales en esta sede." : "Nadie coincide con la búsqueda."}
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** The presence chip — glyph + words in the state palette (26px, radius 8, 13/600). */
export function PresenceChip({ presence }: { presence: Presence }) {
  return (
    <span
      className={`${presence.chipClass} inline-flex h-[26px] flex-none items-center gap-1 self-start whitespace-nowrap rounded-[8px] px-[9px] text-[13px] font-semibold`}
    >
      {presence.chip}
    </span>
  );
}
