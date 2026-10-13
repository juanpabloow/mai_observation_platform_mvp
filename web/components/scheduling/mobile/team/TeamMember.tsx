"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Icon, ICON, M_CARD, M_SMALL, MButton, MConfirm, MStaffAvatar, MStateChip, MToggle, Sheet } from "@/components/scheduling/mobile/kit";
import { TimeOffForm } from "@/components/scheduling/timeoff/TimeOffForm";
import { deleteTimeOffAction } from "@/lib/timeOffActions";
import {
  activateStaffAction,
  countUpcomingAppointmentsAction,
  deactivateStaffAction,
  deleteStaffCertificationAction,
  setStaffServiceAction,
} from "@/lib/schedulingAdminActions";
import type {
  StaffAppointment,
  StaffCertification,
  StaffMember,
  StaffServiceOpt,
  StaffTimeOff,
  StaffWindowAppointment,
} from "@/components/scheduling/staff/StaffTab";
import { MError, MSection } from "./FullScreen";
import { CertForm, categoryClass, employmentLabel, HoursForm, ProfileForm } from "./forms";
import { PresenceChip } from "./TeamList";
import { citas, fmtHM, hoursEs, inheritsSiteHours, toMin, weekRows, WEEK_ORDER, type Presence, type Weekly } from "./presence";

type Layer = null | "menu" | "profile" | "hours" | "services" | "cert" | "deactivate" | { cert: StaffCertification };

/**
 * DETALLE DEL PROFESIONAL (reference 4.16) plus every capability of the desktop panel,
 * in sections: today's agenda (each row opens that appointment in the agenda), services,
 * site, weekly hours, profile and contract, contact (PII — only here because the page is
 * the owner/admin roster that reads listStaffAdmin), certifications, time off and the
 * 30-day numbers. The "⋯" menu holds only actions that exist today.
 */
export function TeamMember({
  clientId,
  member,
  presence,
  appts,
  services,
  siteId,
  siteName,
  tz,
  now,
  openingHours,
  timeOff,
  windowAppointments,
  color,
  listHref,
  onToast,
}: {
  clientId: string;
  member: StaffMember;
  presence: Presence;
  /** Today's appointments for this professional, every status, by start time. */
  appts: StaffAppointment[];
  services: StaffServiceOpt[];
  siteId?: string;
  siteName: string;
  tz: string;
  now: number;
  openingHours: Weekly;
  timeOff: StaffTimeOff[];
  windowAppointments: StaffWindowAppointment[];
  color?: string;
  listHref: string;
  onToast: (msg: string) => void;
}) {
  const router = useRouter();
  const [layer, setLayer] = useState<Layer>(null);
  const [timeOffForm, setTimeOffForm] = useState<null | { editing?: StaffTimeOff }>(null);
  const [timeOffDelete, setTimeOffDelete] = useState<StaffTimeOff | null>(null);
  const [upcoming, setUpcoming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const saved = (msg: string) => {
    setLayer(null);
    onToast(msg);
    router.refresh();
  };
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) {
        setLayer(null);
        setError(r.error ?? "No se pudo guardar.");
        return;
      }
      saved(msg);
    });

  const role = member.title ?? (member.takesBookings ? "Profesional" : "Recepción");
  const live = appts.filter((a) => a.status !== "cancelled");
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const offered = services.filter((s) => member.serviceIds.includes(s.id));
  const inherits = inheritsSiteHours(member.workingHours);
  const hours = weekRows(inherits ? openingHours : member.workingHours);
  const agendaHref = `/clients/${clientId}/scheduling/agenda?${new URLSearchParams({ ...(siteId ? { site: siteId } : {}), staff: member.id }).toString()}`;

  // ── 30 days, the window the page loaded ──
  const settled = windowAppointments.filter((a) => a.status !== "cancelled");
  const completed = settled.filter((a) => a.status === "completed").length;
  const noShows = settled.filter((a) => a.status === "no_show").length;
  const bookedMin = settled.reduce((n, a) => n + a.durationMin, 0);
  const weeklyMin = WEEK_ORDER.reduce((n, d) => n + (member.workingHours[d] ?? []).reduce((m, r) => m + Math.max(0, toMin(r.end) - toMin(r.start)), 0), 0);
  const top = [...settled.reduce((m, a) => m.set(a.serviceName, (m.get(a.serviceName) ?? 0) + 1), new Map<string, number>())]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, 5);

  const back = (e: React.MouseEvent) => {
    // Came from the list in this tab: go BACK, so the system/browser back stays truthful.
    if (sessionStorage.getItem("m-team-from-list") === "1") {
      e.preventDefault();
      sessionStorage.removeItem("m-team-from-list");
      router.back();
    }
  };

  const openDeactivate = () =>
    start(async () => {
      setLayer(null);
      // The same read-only guard the settings toggle uses: it counts, never cancels.
      const c = await countUpcomingAppointmentsAction(clientId, "staff", member.id);
      setUpcoming(c.ok ? c.count : 0);
      setLayer("deactivate");
    });

  return (
    <>
      <header className="sticky top-[calc(var(--content-pad)*-1)] z-10 flex-none border-b border-m-bd bg-m-sf px-2 pb-[14px] pt-[6px]">
        <div className="flex min-h-[44px] items-center">
          <Link
            href={listHref}
            onClick={back}
            className="flex h-[44px] flex-none items-center gap-0.5 rounded-[12px] pl-1 pr-2 text-[16px] text-m-tx no-underline"
          >
            <Icon d={ICON.back} width={1.6} />
            <span className="whitespace-nowrap">Equipo</span>
          </Link>
          <button
            type="button"
            aria-label="Más opciones"
            aria-haspopup="dialog"
            onClick={() => setLayer("menu")}
            className="ml-auto flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[20px] leading-none text-m-tx"
          >
            ⋯
          </button>
        </div>
        <div className="flex flex-col gap-0.5 px-2 pt-1">
          <h1 className="m-0 text-[24px] font-semibold leading-[1.2] tracking-[-0.01em] [overflow-wrap:anywhere] [text-wrap:pretty]">{member.name}</h1>
          <span className="text-[14px] leading-[1.35] text-m-tx3">
            {role} · {member.siteName}
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 pb-[max(32px,env(safe-area-inset-bottom))] pt-4">
        <MError message={error} />
        <div className="flex items-center gap-[14px]">
          <MStaffAvatar id={member.id} name={member.name} size={64} color={color} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <PresenceChip presence={presence} />
            <span className="text-[14px] text-m-tx2">{presence.sub}</span>
          </div>
        </div>

        <Link
          href={agendaHref}
          className="flex h-12 items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[15px] text-m-tx no-underline"
        >
          Ver su agenda
        </Link>

        <MSection title="Hoy" meta={`${citas(live.length)} hoy`}>
          <div className={M_CARD}>
            {appts.length === 0 ? (
              <div className="px-[14px] py-4 text-[15px] text-m-tx3">Sin citas hoy.</div>
            ) : (
              appts.map((a, i) => {
                const sv = a.serviceId ? serviceById.get(a.serviceId) : undefined;
                return (
                  <Link
                    key={a.id}
                    href={`${agendaHref}&appt=${a.id}`}
                    className={`flex min-h-[64px] w-full items-center gap-3 py-[10px] pl-[14px] pr-3 text-left text-m-tx no-underline ${i ? "border-t border-m-dv" : ""}`}
                  >
                    <span className="u-tnum w-11 flex-none text-[14px] font-semibold">{fmtHM(a.startAt, tz)}</span>
                    <span aria-hidden className={`${categoryClass(a.serviceName, sv?.category)} size-[10px] flex-none rounded-full`} style={{ background: "var(--m-dot)" }} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[15px] [overflow-wrap:anywhere]">{a.contactName ?? "Sin nombre"}</span>
                      <span className="text-[13px] text-m-tx3 [overflow-wrap:anywhere]">{a.serviceName}</span>
                    </span>
                    <MStateChip status={a.status} className="self-center" />
                  </Link>
                );
              })
            )}
          </div>
        </MSection>

        <MSection
          title="Servicios"
          meta={`${offered.length} de ${services.length}`}
          action={
            <button type="button" onClick={() => setLayer("services")} className={M_SMALL}>
              Editar
            </button>
          }
        >
          {offered.length === 0 ? (
            <p className="m-0 text-[14px] text-m-tx3">Sin servicios asignados.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {offered.map((s) => (
                <span key={s.id} className={`${categoryClass(s.name, s.category)} inline-flex min-h-9 items-center gap-1.5 rounded-[12px] bg-m-sf2 px-3 text-[14px]`}>
                  <span aria-hidden className="size-2 flex-none rounded-full" style={{ background: "var(--m-dot)" }} />
                  {s.name}
                  {!s.active ? <span className="text-m-tx3">· archivado</span> : null}
                </span>
              ))}
            </div>
          )}
        </MSection>

        <MSection title="Sedes">
          <div className={`${M_CARD} flex min-h-[52px] items-center px-[14px] text-[15px]`}>{member.siteName}</div>
        </MSection>

        <MSection
          title="Horario semanal"
          meta={inherits ? "Horario de la sede" : undefined}
          action={
            <button type="button" onClick={() => setLayer("hours")} className={M_SMALL}>
              Editar
            </button>
          }
        >
          <div className={M_CARD}>
            {hours.map((h, i) => (
              <div key={h.key} className={`flex min-h-12 items-center justify-between gap-3 px-[14px] py-2 ${i ? "border-t border-m-dv" : ""}`}>
                <span className="text-[15px]">{h.day}</span>
                <span className={`u-tnum text-right text-[15px] ${h.open ? "text-m-tx" : "text-m-tx3"}`}>{h.value}</span>
              </div>
            ))}
          </div>
        </MSection>

        <MSection
          title="Perfil"
          action={
            <button type="button" onClick={() => setLayer("profile")} className={M_SMALL}>
              Editar
            </button>
          }
        >
          <div className={M_CARD}>
            <InfoRow label="Cargo" value={member.title} />
            <InfoRow label="Contrato" value={employmentLabel(member.employmentType)} />
            <InfoRow label="Horas semanales" value={member.weeklyHours === null ? null : `${member.weeklyHours} h`} />
            <InfoRow label="Inicio" value={member.startDate ? seniorityEs(member.startDate, now) : null} />
            <InfoRow label="Recibe citas" value={member.takesBookings ? "Sí" : "No · sin silla"} />
            <InfoRow label="Estado" value={member.active ? "Activo" : "Inactivo · no recibe citas nuevas"} />
            <div className="flex min-h-[52px] flex-col gap-2 border-t border-m-dv px-[14px] py-3">
              <span className="text-[13px] text-m-tx3">Habilidades</span>
              {member.skills.length === 0 ? (
                <span className="text-[15px] text-m-tx3">Sin definir</span>
              ) : (
                <span className="flex flex-wrap gap-2">
                  {member.skills.map((sk) => (
                    <span key={sk} className="inline-flex min-h-8 items-center rounded-[10px] bg-m-sf2 px-[10px] text-[14px]">
                      {sk}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        </MSection>

        <MSection
          title="Contacto"
          action={
            <button type="button" onClick={() => setLayer("profile")} className={M_SMALL}>
              Editar
            </button>
          }
        >
          <div className={M_CARD}>
            <InfoRow label="Teléfono" value={member.phone} href={member.phone ? `tel:${member.phone.replace(/\s+/g, "")}` : undefined} />
            <InfoRow label="Email" value={member.email} href={member.email ? `mailto:${member.email}` : undefined} />
            <InfoRow
              label="Emergencia"
              value={[member.emergencyContactName, member.emergencyContactPhone].filter(Boolean).join(" · ") || null}
              href={member.emergencyContactPhone ? `tel:${member.emergencyContactPhone.replace(/\s+/g, "")}` : undefined}
            />
          </div>
        </MSection>

        <MSection
          title="Certificaciones"
          action={
            <button type="button" onClick={() => setLayer("cert")} className={M_SMALL}>
              <Icon d={ICON.plus} size={16} />
              Añadir
            </button>
          }
        >
          <div className={M_CARD}>
            {member.certifications.length === 0 ? (
              <div className="px-[14px] py-4 text-[15px] text-m-tx3">Ninguna registrada.</div>
            ) : (
              member.certifications.map((c, i) => {
                const left = daysUntil(c.expiresOn, now);
                const state = left === null ? null : left < 0 ? "Vencida" : left <= 60 ? `Vence en ${left} d` : null;
                return (
                  <div key={c.id} className={`flex min-h-[60px] items-center gap-3 py-2 pl-[14px] pr-1 ${i ? "border-t border-m-dv" : ""}`}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[15px] [overflow-wrap:anywhere]">{c.name}</span>
                      <span className="text-[13px] text-m-tx3">
                        {[c.issuer, c.issuedOn ? `emitida ${c.issuedOn}` : null, c.expiresOn ? `vence ${c.expiresOn}` : "sin vencimiento"].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {state ? (
                      <span className={`${left !== null && left < 0 ? "u-m-st-cancelled" : "u-m-st-scheduled"} inline-flex h-[26px] flex-none items-center whitespace-nowrap rounded-[8px] px-[9px] text-[13px] font-semibold`}>
                        {state}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Eliminar ${c.name}`}
                      onClick={() => setLayer({ cert: c })}
                      className="flex size-[44px] flex-none items-center justify-center rounded-[12px] border-0 bg-transparent text-m-tx2"
                    >
                      <Icon d={ICON.close} size={18} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </MSection>

        <MSection
          title="Ausencias"
          meta={timeOff.length > 0 ? `${timeOff.length} próximas` : undefined}
          action={siteId ? <button type="button" className={M_SMALL} onClick={() => setTimeOffForm({})}><Icon d={ICON.plus} size={16} />Añadir</button> : undefined}
        >
          <div className={M_CARD}>
            {timeOff.length === 0 ? (
              <div className="px-[14px] py-4 text-[15px] text-m-tx3">Sin ausencias en los próximos 30 días.</div>
            ) : (
              timeOff.map((t, i) => {
                const days = Math.max(1, Math.round((Date.parse(t.endsAt) - Date.parse(t.startsAt)) / 86_400_000));
                return (
                  <div key={t.id} className={`flex min-h-[60px] flex-wrap items-center gap-3 px-[14px] py-2 ${i ? "border-t border-m-dv" : ""}`}>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[15px] [overflow-wrap:anywhere]">{t.reason?.trim() || "Ausencia"}</span>
                      <span className="text-[13px] text-m-tx3">
                        {fmtDayEs(t.startsAt, tz)} – {fmtDayEs(t.endsAt, tz)}
                      </span>
                    </span>
                    <span className="flex-none text-[13px] text-m-tx2">
                      {days} {days === 1 ? "día" : "días"}
                    </span>
                    {siteId && Date.parse(t.endsAt) > now ? (
                      <span className="flex w-full justify-end gap-2">
                        <button type="button" className={M_SMALL} onClick={() => setTimeOffForm({ editing: t })}>Editar</button>
                        <button type="button" className={M_SMALL} onClick={() => setTimeOffDelete(t)}>Eliminar</button>
                      </span>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
          <p className="m-0 text-[13px] leading-[1.4] text-m-tx3">Los bloqueos quitan disponibilidad sin cambiar el horario semanal. Las ausencias pasadas son de solo lectura.</p>
        </MSection>

        <MSection title="Últimos 30 días">
          <div className={`${M_CARD} grid grid-cols-2`}>
            <Metric label="Citas" value={String(settled.length)} />
            <Metric label="Completadas" value={String(completed)} note={settled.length ? `${Math.round((completed / settled.length) * 100)} %` : undefined} left />
            <Metric label="Inasistencias" value={String(noShows)} top />
            <Metric
              label="Horas reservadas"
              value={hoursEs(bookedMin)}
              note={weeklyMin > 0 ? `de ${Math.round((weeklyMin * (30 / 7)) / 60)} h` : undefined}
              top
              left
            />
          </div>
          {top.length > 0 ? (
            <div className={M_CARD}>
              {top.map(([name, count], i) => (
                <div key={name} className={`flex min-h-12 items-center gap-3 px-[14px] py-2 ${i ? "border-t border-m-dv" : ""}`}>
                  <span aria-hidden className={`${categoryClass(name)} size-2 flex-none rounded-full`} style={{ background: "var(--m-dot)" }} />
                  <span className="min-w-0 flex-1 text-[15px] [overflow-wrap:anywhere]">{name}</span>
                  <span className="u-tnum flex-none text-[15px] text-m-tx2">{count}</span>
                </div>
              ))}
            </div>
          ) : null}
        </MSection>
      </div>

      {/* ⋯ — only actions that exist today. */}
      <Sheet open={layer === "menu"} onClose={() => setLayer(null)} label={`Opciones de ${member.name}`}>
        <div className="flex flex-col px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          <h2 className="m-0 pb-2 text-[17px] font-semibold">{member.name}</h2>
          <div className={M_CARD}>
            <MenuRow label="Editar perfil" onClick={() => setLayer("profile")} first />
            <MenuRow label="Servicios" onClick={() => setLayer("services")} />
            <MenuRow label="Horario semanal" onClick={() => setLayer("hours")} />
            <MenuRow label="Añadir certificación" onClick={() => setLayer("cert")} />
            <Link href={`/clients/${clientId}/team`} className="flex min-h-[56px] w-full items-center gap-3 border-t border-m-dv px-[14px] text-[16px] text-m-tx no-underline">
              <span className="flex min-w-0 flex-1 flex-col">
                <span>Accesos e invitaciones</span>
                <span className="text-[13px] text-m-tx3">Usuarios y acceso de este cliente</span>
              </span>
              <span aria-hidden className="text-[20px] text-m-tx3">›</span>
            </Link>
          </div>
          <div className={`${M_CARD} mt-3`}>
            {member.active ? (
              <MenuRow label={pending ? "Comprobando…" : "Desactivar"} danger first onClick={openDeactivate} />
            ) : (
              <MenuRow label="Reactivar" first onClick={() => run(() => activateStaffAction(clientId, member.id), `${member.name} reactivado`)} />
            )}
          </div>
        </div>
      </Sheet>

      <Sheet
        open={layer === "deactivate"}
        onClose={() => setLayer(null)}
        alert
        label={`¿Desactivar a ${member.name}?`}
        footer={
          <div className="flex flex-col gap-2">
            <MButton data-autofocus onClick={() => setLayer(null)}>
              Cancelar
            </MButton>
            <MButton kind="danger" loading={pending} loadingLabel="Desactivando…" onClick={() => run(() => deactivateStaffAction(clientId, member.id), `${member.name} desactivado`)}>
              {upcoming ? "Desactivar de todos modos" : "Desactivar"}
            </MButton>
          </div>
        }
      >
        <MConfirm
          title={`¿Desactivar a ${member.name}?`}
          body={
            upcoming
              ? `Tiene ${citas(upcoming)} ${upcoming === 1 ? "próxima" : "próximas"}. Al desactivar se detienen las reservas nuevas; las citas existentes se conservan.`
              : "Al desactivar se detienen las reservas nuevas. Conserva su historial y puedes reactivarlo cuando quieras."
          }
        />
      </Sheet>

      <Sheet
        open={typeof layer === "object" && layer !== null}
        onClose={() => setLayer(null)}
        alert
        label="¿Eliminar la certificación?"
        footer={
          <div className="flex flex-col gap-2">
            <MButton data-autofocus onClick={() => setLayer(null)}>
              Cancelar
            </MButton>
            <MButton
              kind="danger"
              loading={pending}
              loadingLabel="Eliminando…"
              onClick={() => {
                if (typeof layer === "object" && layer) run(() => deleteStaffCertificationAction(clientId, member.id, layer.cert.id), "Certificación eliminada");
              }}
            >
              Eliminar
            </MButton>
          </div>
        }
      >
        <MConfirm title="¿Eliminar la certificación?" body={typeof layer === "object" && layer ? `«${layer.cert.name}» se quitará del perfil de ${member.name}.` : ""} />
      </Sheet>

      <ServicesSheet open={layer === "services"} onClose={() => setLayer(null)} clientId={clientId} member={member} services={services} onChanged={() => router.refresh()} />
      <Sheet open={timeOffForm !== null} onClose={() => setTimeOffForm(null)} label={timeOffForm?.editing ? "Editar ausencia" : "Añadir ausencia"}>
        {siteId && timeOffForm ? (
          <div className="px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
            <h2 className="mb-3 text-[18px] font-semibold">{timeOffForm.editing ? "Editar ausencia" : "Añadir ausencia"}</h2>
            <TimeOffForm
              key={timeOffForm.editing?.id ?? "new"}
              clientId={clientId}
              siteId={siteId}
              staff={[{ id: member.id, name: member.name }]}
              fixedStaffId={member.id}
              canSiteClosure={false}
              tz={tz}
              edit={timeOffForm.editing}
              onClose={() => setTimeOffForm(null)}
              onDone={() => { setTimeOffForm(null); onToast("Ausencia guardada"); router.refresh(); }}
            />
          </div>
        ) : null}
      </Sheet>
      <Sheet open={timeOffDelete !== null} onClose={() => setTimeOffDelete(null)} alert label="¿Eliminar la ausencia?" footer={
        <div className="flex flex-col gap-2">
          <MButton data-autofocus onClick={() => setTimeOffDelete(null)}>Cancelar</MButton>
          <MButton kind="danger" loading={pending} loadingLabel="Eliminando…" onClick={() => {
            if (timeOffDelete) run(async () => {
              const r = await deleteTimeOffAction(clientId, timeOffDelete.id);
              setTimeOffDelete(null);
              return r;
            }, "Ausencia eliminada");
          }}>Eliminar ausencia</MButton>
        </div>
      }>
        <MConfirm title="¿Eliminar la ausencia?" body="La disponibilidad se restablece. Las citas existentes no se modifican." />
      </Sheet>
      <ProfileForm open={layer === "profile"} clientId={clientId} member={member} onClose={() => setLayer(null)} onSaved={saved} />
      <HoursForm open={layer === "hours"} clientId={clientId} member={member} siteName={siteName} openingHours={openingHours} onClose={() => setLayer(null)} onSaved={saved} />
      <CertForm open={layer === "cert"} clientId={clientId} member={member} onClose={() => setLayer(null)} onSaved={saved} />
    </>
  );
}

/**
 * SERVICES — the row IS the switch, writing immediately per pairing (setStaffServiceAction
 * takes one service and one boolean), exactly like the desktop Services tab.
 */
function ServicesSheet({
  open,
  onClose,
  clientId,
  member,
  services,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  member: StaffMember;
  services: StaffServiceOpt[];
  onChanged: () => void;
}) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={`Servicios de ${member.name}`}
      footer={
        <MButton kind="primary" className="w-full" onClick={onClose}>
          Listo
        </MButton>
      }
    >
      <div className="flex flex-col gap-3 px-4 pb-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-[20px] font-semibold">Servicios</h2>
          <span className="text-[14px] text-m-tx3">Lo que {member.name} puede atender. Se guarda al tocar.</span>
        </div>
        <MError message={error} />
        <div className={M_CARD}>
          {services.length === 0 ? (
            <div className="px-[14px] py-4 text-[15px] text-m-tx3">Este cliente todavía no tiene servicios.</div>
          ) : (
            services.map((sv, i) => {
              const on = member.serviceIds.includes(sv.id);
              return (
                <button
                  key={sv.id}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      setError(null);
                      const r = await setStaffServiceAction(clientId, member.id, sv.id, !on);
                      if (!r.ok) setError(r.error);
                      else onChanged();
                    })
                  }
                  className={`flex min-h-[60px] w-full items-center gap-3 border-0 bg-transparent py-2 pl-[14px] pr-3 text-left text-m-tx disabled:opacity-60 ${i ? "border-t border-solid border-m-dv" : ""}`}
                >
                  <span aria-hidden className={`${categoryClass(sv.name, sv.category)} size-[10px] flex-none rounded-full`} style={{ background: "var(--m-dot)" }} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[16px] [overflow-wrap:anywhere]">{sv.name}</span>
                    <span className="text-[13px] text-m-tx3">
                      {sv.durationMin} min{sv.active ? "" : " · archivado"}
                    </span>
                  </span>
                  <MToggle on={on} />
                </button>
              );
            })
          )}
        </div>
      </div>
    </Sheet>
  );
}

function MenuRow({ label, onClick, danger = false, first = false }: { label: string; onClick: () => void; danger?: boolean; first?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[56px] w-full items-center gap-3 border-0 bg-transparent px-[14px] text-left text-[16px] ${danger ? "font-semibold text-m-dn" : "text-m-tx"} ${first ? "" : "border-t border-solid border-m-dv"}`}
    >
      <span className="flex-1">{label}</span>
      {danger ? null : (
        <span aria-hidden className="text-[20px] text-m-tx3">
          ›
        </span>
      )}
    </button>
  );
}

function InfoRow({ label, value, href }: { label: string; value: string | null; href?: string }) {
  const body = (
    <>
      <span className="flex-none text-[15px] text-m-tx2">{label}</span>
      <span className={`min-w-0 flex-1 text-right text-[15px] [overflow-wrap:anywhere] ${value ? (href ? "text-m-info" : "text-m-tx") : "text-m-tx3"}`}>{value ?? "Sin definir"}</span>
    </>
  );
  const cls = "flex min-h-[52px] w-full items-center gap-3 border-t border-m-dv px-[14px] py-2 first:border-t-0";
  return href && value ? (
    <a href={href} className={`${cls} no-underline`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Metric({ label, value, note, top = false, left = false }: { label: string; value: string; note?: string; top?: boolean; left?: boolean }) {
  return (
    <div className={`flex min-h-[72px] flex-col justify-center gap-0.5 px-[14px] py-3 ${top ? "border-t border-m-dv" : ""} ${left ? "border-l border-m-dv" : ""}`}>
      <span className="text-[13px] text-m-tx3">{label}</span>
      <span className="u-tnum text-[20px] font-semibold leading-tight">
        {value}
        {note ? <span className="ml-1.5 text-[13px] font-normal text-m-tx3">{note}</span> : null}
      </span>
    </div>
  );
}

function fmtDayEs(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("es-CO", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(iso)).replace(/\./g, "");
}

function daysUntil(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const n = new Date(now);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())) / 86_400_000);
}

/** "Desde mar 2023 · 3 a 7 m" — derived from start_date on every render, never stored. */
export function seniorityEs(startDate: string, now: number): string {
  const [y, mo, day] = startDate.split("-").map(Number);
  if (!y || !mo || !day) return startDate;
  const MS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const n = new Date(now);
  let months = (n.getUTCFullYear() - y) * 12 + (n.getUTCMonth() - (mo - 1));
  if (n.getUTCDate() < day) months -= 1;
  const since = `${MS[mo - 1]} ${y}`;
  if (months < 0) return `Empieza en ${since}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `Desde ${since} · ${years > 0 ? `${years} a ${rest} m` : `${rest} m`}`;
}
