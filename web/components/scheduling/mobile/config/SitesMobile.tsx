"use client";

import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { bookingLinkStatus, bookingUrl } from "@/lib/bookingLink";
import {
  activateSiteAction,
  countUpcomingAppointmentsAction,
  createSiteAction,
  deactivateSiteAction,
  updateSiteAction,
} from "@/lib/schedulingAdminActions";
import type { Site, Staff } from "../../AdminPanel";
import { MButton, MToggle, Sheet } from "../kit";
import {
  COMMON_ZONES,
  SLUG_RE,
  WEEKDAYS,
  WEEKDAY_LONG,
  dayError,
  daySummary,
  openDaysSummary,
  plural,
  slugify,
  storedFromWeek,
  suggestPause,
  timeOptions,
  tzLabel,
  weekFromStored,
  type DayHours,
} from "./logic";
import {
  CARD_M,
  Chevron,
  Chip,
  ConfirmSheet,
  ErrorNote,
  Field,
  Glyph,
  H2_M,
  INPUT_M,
  ROW_M,
  SELECT_M,
  Screen,
  SheetOption,
  SubHeader,
  copyText,
  type ConfigNav,
} from "./ui";

const noop = () => () => {};
/** The browser's origin after hydration (the link is never built from a fixed host). */
function useOrigin(): string | null {
  return useSyncExternalStore(noop, () => window.location.origin, () => null);
}
function useCanShare(): boolean {
  return useSyncExternalStore(noop, () => typeof navigator !== "undefined" && typeof navigator.share === "function", () => false);
}

const activeStaffAt = (staff: Staff[], siteId: string) => staff.filter((p) => p.site_id === siteId && p.active);

function statusOf(site: Site, schedulingEnabled: boolean) {
  const s = bookingLinkStatus({ siteActive: site.active, schedulingEnabled });
  if (s === "available") return { tone: "ok" as const, short: "✓ Activa", long: "✓ Activa · acepta reservas", hint: "Cualquier persona con el enlace puede reservar, sin crear cuenta." };
  if (s === "site_inactive") return { tone: "off" as const, short: "○ Inactiva", long: "○ Inactiva", hint: "El enlace muestra «no disponible» hasta que reactives la sede." };
  return {
    tone: "warn" as const,
    short: "! Agenda apagada",
    long: "! Agenda desactivada",
    hint: "El módulo de agenda de este cliente está apagado; el enlace no acepta reservas.",
  };
}

// ── 4.2 Lista de sedes ────────────────────────────────────────────────────────────

export function SitesList({ nav, sites, staff, schedulingEnabled }: { nav: ConfigNav; sites: Site[]; staff: Staff[]; schedulingEnabled: boolean }) {
  return (
    <Screen
      label="Sedes y horarios"
      header={
        <SubHeader
          backLabel={nav.rootLabel ?? "Configuración"}
          onBack={() => nav.back(null)}
          title="Sedes y horarios"
          sub={`${plural(sites.length, "sede", "sedes")} · zona horaria de cada sede`}
          action={{ label: "Nueva sede", text: <Glyph d="M8 3v10M3 8h10" size={18} width={1.6} />, onClick: () => nav.go("sede-nueva") }}
        />
      }
    >
      {sites.length === 0 ? (
        <div className={`${CARD_M} flex flex-col gap-[14px] px-[18px] py-[24px]`}>
          <div className="flex flex-col gap-[4px]">
            <span className="text-[16px] font-semibold">Aún no hay sedes</span>
            <span className="text-[14px] leading-[1.45] text-m-tx3">Crea la primera sede para definir su horario y recibir reservas.</span>
          </div>
          <MButton kind="primary" onClick={() => nav.go("sede-nueva")}>
            Nueva sede
          </MButton>
        </div>
      ) : (
        <div className={CARD_M}>
          {sites.map((site) => {
            const st = statusOf(site, schedulingEnabled);
            const pros = activeStaffAt(staff, site.id).length;
            return (
              <button key={site.id} type="button" onClick={() => nav.go("sede", site.id)} className={`${ROW_M} min-h-[76px]`}>
                <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
                  <span className="text-[16px] font-semibold [overflow-wrap:anywhere]">{site.name}</span>
                  {site.address ? <span className="text-[14px] text-m-tx3">{site.address}</span> : null}
                  <span className="flex flex-wrap items-center gap-[8px]">
                    <Chip tone={st.tone}>{st.short}</Chip>
                    <span className="text-[13px] text-m-tx2">
                      {site.active ? `${openDaysSummary(site.opening_hours)} · ${plural(pros, "profesional", "profesionales")}` : "No acepta reservas"}
                    </span>
                  </span>
                </span>
                <Chevron />
              </button>
            );
          })}
        </div>
      )}
    </Screen>
  );
}

// ── 4.3 Detalle · 4.4 Más opciones · 4.5 Desactivar ──────────────────────────────

export function SiteDetail({
  nav,
  clientId,
  site,
  staff,
  serviceCount,
  schedulingEnabled,
  toast,
}: {
  nav: ConfigNav;
  clientId: string;
  site: Site;
  staff: Staff[];
  serviceCount: number;
  schedulingEnabled: boolean;
  toast: (m: string) => void;
}) {
  const router = useRouter();
  const origin = useOrigin();
  const canShare = useCanShare();
  const [more, setMore] = useState(false);
  const [confirm, setConfirm] = useState<{ upcoming: number } | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startBusy] = useTransition();
  const [checking, startCheck] = useTransition();
  const url = bookingUrl(origin, site.slug);
  const st = statusOf(site, schedulingEnabled);
  const pros = activeStaffAt(staff, site.id).length;

  const copyLink = async () => {
    const ok = await copyText(url);
    setCopyFailed(!ok);
    if (ok) toast("Enlace copiado");
  };
  const share = async () => {
    try {
      await navigator.share({ title: site.name, text: `Reserva en ${site.name}`, url });
    } catch {
      /* dismissed — nothing to do */
    }
  };
  const askDeactivate = () =>
    startCheck(async () => {
      const c = await countUpcomingAppointmentsAction(clientId, "site", site.id);
      setConfirm({ upcoming: c.ok ? c.count : 0 });
    });
  const deactivate = () =>
    startBusy(async () => {
      setError(null);
      const r = await deactivateSiteAction(clientId, site.id);
      setConfirm(null);
      setMore(false);
      if (!r.ok) setError(r.error ?? "No se pudo desactivar la sede.");
      else {
        toast("Sede desactivada");
        router.refresh();
      }
    });
  const reactivate = () =>
    startBusy(async () => {
      setError(null);
      const r = await activateSiteAction(clientId, site.id);
      setMore(false);
      if (!r.ok) setError(r.error ?? "No se pudo reactivar la sede.");
      else {
        toast("Sede reactivada");
        router.refresh();
      }
    });

  return (
    <Screen
      label={site.name}
      header={
        <SubHeader
          backLabel="Sedes"
          onBack={() => nav.back("sedes")}
          title={site.name}
          sub={site.address || tzLabel(site.timezone)}
          action={{ label: "Más opciones de la sede", text: "⋯", onClick: () => setMore(true) }}
        />
      }
      footer={
        <MButton kind="primary" grow onClick={() => nav.go("sede-editar", site.id)}>
          Editar sede y horario
        </MButton>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Chip tone={st.tone}>{st.long}</Chip>

      <section className="flex flex-col gap-[8px]">
        <h2 className={H2_M}>Enlace público de reservas</h2>
        <div className="flex flex-col gap-[12px] rounded-[16px] border border-m-bd bg-m-sf p-[14px]">
          <span className="select-all break-all font-mono text-[14px] text-m-tx">{url.replace(/^https?:\/\//, "")}</span>
          <div className="flex gap-[8px]">
            <button type="button" onClick={copyLink} className="flex h-[44px] min-w-0 flex-1 items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[15px] text-m-tx">
              {copyFailed ? "Mantén pulsado y copia" : "Copiar"}
            </button>
            {canShare ? (
              <button type="button" onClick={share} className="flex h-[44px] min-w-0 flex-1 items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[15px] text-m-tx">
                Compartir
              </button>
            ) : (
              <a href={url} target="_blank" rel="noopener noreferrer" className="flex h-[44px] min-w-0 flex-1 items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[15px] text-m-tx">
                Abrir página
              </a>
            )}
          </div>
          <span className="text-[13px] leading-[1.4] text-m-tx3">{st.hint}</span>
          {st.tone === "ok" && serviceCount === 0 ? (
            <span className="rounded-[12px] bg-m-warnbg px-[12px] py-[10px] text-[13px] leading-[1.4] text-m-warn">
              Esta sede aún no tiene servicios activos: la página no tendrá nada para reservar.
            </span>
          ) : null}
        </div>
      </section>

      <section className="flex flex-col gap-[8px]">
        <h2 className={H2_M}>Datos</h2>
        <div className={CARD_M}>
          {[
            ["Zona horaria", tzLabel(site.timezone)],
            ["Profesionales", pros === 0 ? "Ninguno activo" : plural(pros, "asignado", "asignados")],
            ["Servicios", serviceCount === 0 ? "Ninguno en línea" : plural(serviceCount, "en línea", "en línea")],
          ].map(([k, v], i) => (
            <div key={k} className={`flex min-h-[48px] gap-[12px] px-[14px] py-[12px] ${i ? "border-t border-m-dv" : ""}`}>
              <span className="w-[110px] flex-none text-[14px] text-m-tx3">{k}</span>
              <span className="min-w-0 text-[15px]">{v}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-[8px]">
        <h2 className={H2_M}>Horario semanal</h2>
        <div className={CARD_M}>
          {WEEKDAYS.map((d, i) => {
            const sum = daySummary(site.opening_hours?.[d]);
            return (
              <div key={d} className={`flex min-h-[48px] items-start gap-[12px] px-[14px] py-[12px] ${i ? "border-t border-m-dv" : ""}`}>
                <span className="w-[96px] flex-none text-[15px]">{WEEKDAY_LONG[d]}</span>
                <span className="flex flex-1 flex-col items-end gap-[2px]">
                  <span className={`u-tnum text-right text-[15px] ${sum.open ? "text-m-tx" : "text-m-tx3"}`}>{sum.value}</span>
                  {sum.pauses.map((p) => (
                    <span key={p} className="u-tnum text-[13px] text-m-tx3">
                      {p}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <Sheet open={more} onClose={() => setMore(false)} label="Más opciones de la sede">
        <div className="flex flex-col gap-[8px] px-[16px] pb-[max(20px,env(safe-area-inset-bottom))]">
          <SheetOption
            onClick={() => {
              setMore(false);
              nav.go("sede-editar", site.id);
            }}
          >
            Editar sede y horario
          </SheetOption>
          <SheetOption
            onClick={async () => {
              const ok = await copyText(url);
              setMore(false);
              if (ok) toast("Enlace copiado");
              else setCopyFailed(true);
            }}
          >
            Copiar enlace público
          </SheetOption>
          <SheetOption
            onClick={async () => {
              const ok = await copyText(site.id);
              setMore(false);
              if (ok) toast("ID de sede copiado");
            }}
          >
            <span className="flex min-w-0 flex-col py-[6px]">
              <span>Copiar ID de sede</span>
              <span className="truncate font-mono text-[12px] text-m-tx3">{site.id}</span>
            </span>
          </SheetOption>
          {site.active ? (
            <SheetOption danger onClick={askDeactivate} disabled={checking}>
              {checking ? "Comprobando citas…" : "Desactivar sede…"}
            </SheetOption>
          ) : (
            <SheetOption onClick={reactivate} disabled={busy}>
              {busy ? "Reactivando…" : "Reactivar sede"}
            </SheetOption>
          )}
          <MButton kind="soft" className="mt-[6px] w-full" onClick={() => setMore(false)}>
            Cerrar
          </MButton>
        </div>
      </Sheet>

      <ConfirmSheet
        open={confirm !== null}
        title={`¿Desactivar ${site.name}?`}
        body={`Dejará de aceptar reservas nuevas y su enlace público mostrará «No disponible». ${
          confirm && confirm.upcoming > 0
            ? `${confirm.upcoming === 1 ? "La cita futura se conserva" : `Las ${confirm.upcoming} citas futuras se conservan`}; revísalas en la agenda.`
            : "No tiene citas futuras."
        } Puedes reactivarla cuando quieras.`}
        cancelLabel="Volver"
        okLabel="Desactivar sede"
        busy={busy}
        busyLabel="Desactivando…"
        onCancel={() => setConfirm(null)}
        onOk={deactivate}
      />
    </Screen>
  );
}

// ── 4.6 Editar / nueva sede ──────────────────────────────────────────────────────

function allZones(current: string): { common: string[]; rest: string[] } {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  const common = [...new Set([...COMMON_ZONES, current])];
  return { common, rest: all.filter((z) => !common.includes(z)) };
}

const NEW_WEEK = (): Record<string, DayHours> =>
  Object.fromEntries(WEEKDAYS.map((d) => [d, { on: d !== "sun", start: "09:00", end: "18:00", pauses: [] }]));

export function SiteEdit({
  nav,
  clientId,
  site,
  toast,
}: {
  nav: ConfigNav;
  clientId: string;
  /** null = a new site. */
  site: Site | null;
  toast: (m: string) => void;
}) {
  const router = useRouter();
  const initial = useMemo(
    () => ({
      name: site?.name ?? "",
      address: site?.address ?? "",
      tz: site?.timezone ?? "America/Bogota",
      slug: site?.slug ?? "",
      week: site ? weekFromStored(site.opening_hours) : NEW_WEEK(),
    }),
    [site],
  );
  const [form, setForm] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(Boolean(site));
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const origin = useOrigin();
  const zones = useMemo(() => allZones(initial.tz), [initial.tz]);

  const slug = slugTouched ? form.slug : slugify(form.name);
  const dirty = JSON.stringify({ ...form, slug }) !== JSON.stringify(initial);
  const nameErr = !form.name.trim() ? "Escribe el nombre de la sede." : null;
  const slugErr = !slug
    ? "Escribe el final del enlace."
    : slug !== initial.slug && !SLUG_RE.test(slug)
      ? "Solo minúsculas, números y guiones (sin espacios ni tildes)."
      : null;
  const dayErrs = Object.fromEntries(WEEKDAYS.map((d) => [d, dayError(form.week[d])]));
  const invalid = Boolean(nameErr || slugErr || WEEKDAYS.some((d) => dayErrs[d]));

  const setDay = (d: string, patch: Partial<DayHours>) => setForm((f) => ({ ...f, week: { ...f.week, [d]: { ...f.week[d], ...patch } } }));
  const leave = () => (site ? nav.back("sede", site.id) : nav.back("sedes"));
  const requestLeave = () => (dirty && !saving ? setDiscard(true) : leave());

  const save = async () => {
    setAttempted(true);
    if (invalid) {
      setError("Revisa los campos marcados.");
      return;
    }
    setSaving(true);
    setError(null);
    const openingHours = storedFromWeek(form.week);
    const r = site
      ? await updateSiteAction(clientId, site.id, {
          name: form.name.trim(),
          slug: slug.trim(),
          timezone: form.tz,
          openingHours,
          ...(form.address.trim() !== (site.address ?? "") ? { address: form.address.trim() } : {}),
        })
      : await createSiteAction({
          clientId,
          name: form.name.trim(),
          slug: slug.trim(),
          timezone: form.tz,
          address: form.address.trim() || undefined,
          openingHours,
        });
    setSaving(false);
    if (!r.ok) {
      setError(r.error ?? "No se pudo guardar la sede.");
      return;
    }
    toast(site ? "Sede guardada" : "Sede creada");
    router.refresh();
    leave();
  };

  const host = origin ? origin.replace(/^https?:\/\//, "") : "";
  return (
    <Screen
      label={site ? "Editar sede" : "Nueva sede"}
      header={<SubHeader backLabel={site ? site.name : "Sedes"} onBack={requestLeave} title={site ? "Editar sede" : "Nueva sede"} sub={dirty ? "Cambios sin guardar" : null} />}
      footer={
        <>
          <MButton kind="secondary" onClick={requestLeave} disabled={saving}>
            Cancelar
          </MButton>
          <MButton kind="primary" grow onClick={save} disabled={!dirty} loading={saving} loadingLabel="Guardando…">
            {site ? "Guardar" : "Crear sede"}
          </MButton>
        </>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field id="sd-n" label="Nombre" error={attempted || form.name !== initial.name ? nameErr : null}>
        <input id="sd-n" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoComplete="organization" aria-invalid={Boolean(attempted && nameErr)} className={INPUT_M} />
      </Field>
      <Field id="sd-a" label="Dirección" optional>
        <input id="sd-a" value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} autoComplete="street-address" className={INPUT_M} />
      </Field>
      <Field id="sd-tz" label="Zona horaria" hint="Los horarios y bloqueos de la sede se leen en esta zona.">
        <select id="sd-tz" value={form.tz} onChange={(e) => setForm((f) => ({ ...f, tz: e.target.value }))} className={SELECT_M}>
          <optgroup label="Frecuentes">
            {zones.common.map((z) => (
              <option key={z} value={z}>
                {tzLabel(z)}
              </option>
            ))}
          </optgroup>
          {zones.rest.length ? (
            <optgroup label="Todas">
              {zones.rest.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </Field>
      <Field
        id="sd-s"
        label="Enlace público"
        error={attempted || slugTouched ? slugErr : null}
        hint={`${host ? `${host}/book/${slug || "…"} · ` : ""}${site ? "Si lo cambias, el enlace anterior deja de funcionar." : "Lo genera la aplicación; puedes ajustar la última parte."}`}
      >
        <div className={`flex h-[48px] items-center overflow-hidden rounded-[12px] border bg-m-sf u-focus ${attempted && slugErr ? "border-m-dn" : "border-m-bd"}`}>
          <span className="flex-none pl-[14px] font-mono text-[15px] text-m-tx3">/book/</span>
          <input
            id="sd-s"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }));
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={Boolean(attempted && slugErr)}
            className="h-[46px] min-w-0 flex-1 border-0 bg-transparent pr-[14px] font-mono text-[16px] text-m-tx outline-none"
          />
        </div>
      </Field>

      <section className="flex flex-col gap-[8px]">
        <h2 className={H2_M}>Horario semanal</h2>
        <div className={CARD_M}>
          {WEEKDAYS.map((d, i) => {
            const day = form.week[d];
            const opts = timeOptions([day.start, day.end, ...day.pauses.flatMap((p) => [p.start, p.end])]);
            const room = day.on ? suggestPause(day) : null;
            return (
              <div key={d} className={`flex flex-col gap-[10px] px-[14px] py-[12px] ${i ? "border-t border-m-dv" : ""}`}>
                <button
                  type="button"
                  role="switch"
                  aria-checked={day.on}
                  aria-label={`Abierto el ${WEEKDAY_LONG[d].toLowerCase()}`}
                  onClick={() => setDay(d, { on: !day.on })}
                  className="flex min-h-[44px] w-full items-center gap-[12px] border-0 bg-transparent p-0 text-left text-m-tx"
                >
                  <span className="flex-1 text-[16px]">{WEEKDAY_LONG[d]}</span>
                  {!day.on ? <span className="text-[14px] text-m-tx3">Cerrado</span> : null}
                  <MToggle on={day.on} />
                </button>
                {day.on ? (
                  <>
                    <div className="flex items-center gap-[8px]">
                      <select aria-label={`Apertura ${WEEKDAY_LONG[d].toLowerCase()}`} value={day.start} onChange={(e) => setDay(d, { start: e.target.value })} className={`${SELECT_M} u-tnum h-[44px] flex-1 px-[10px]`}>
                        {opts.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                      <span aria-hidden className="text-m-tx3">
                        –
                      </span>
                      <select aria-label={`Cierre ${WEEKDAY_LONG[d].toLowerCase()}`} value={day.end} onChange={(e) => setDay(d, { end: e.target.value })} className={`${SELECT_M} u-tnum h-[44px] flex-1 px-[10px]`}>
                        {opts.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    {day.pauses.map((p, pi) => (
                      <div key={pi} className="flex flex-col gap-[4px] rounded-[12px] bg-m-sf2 py-[8px] pl-[12px] pr-[4px]">
                        <span className="text-[13px] text-m-tx2">Pausa</span>
                        <div className="flex items-center gap-[8px]">
                          <select
                            aria-label={`Inicio de la pausa del ${WEEKDAY_LONG[d].toLowerCase()}`}
                            value={p.start}
                            onChange={(e) => setDay(d, { pauses: day.pauses.map((x, j) => (j === pi ? { ...x, start: e.target.value } : x)) })}
                            className={`${SELECT_M} u-tnum h-[44px] flex-1 px-[10px]`}
                          >
                            {opts.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                          <span aria-hidden className="text-m-tx3">
                            –
                          </span>
                          <select
                            aria-label={`Fin de la pausa del ${WEEKDAY_LONG[d].toLowerCase()}`}
                            value={p.end}
                            onChange={(e) => setDay(d, { pauses: day.pauses.map((x, j) => (j === pi ? { ...x, end: e.target.value } : x)) })}
                            className={`${SELECT_M} u-tnum h-[44px] flex-1 px-[10px]`}
                          >
                            {opts.map((t) => (
                              <option key={t}>{t}</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            aria-label={`Quitar pausa del ${WEEKDAY_LONG[d].toLowerCase()}`}
                            onClick={() => setDay(d, { pauses: day.pauses.filter((_, j) => j !== pi) })}
                            className="flex size-[44px] flex-none items-center justify-center border-0 bg-transparent text-m-tx2"
                          >
                            <Glyph d="M4 4l8 8M12 4l-8 8" size={14} width={1.6} />
                          </button>
                        </div>
                      </div>
                    ))}
                    {room ? (
                      <button
                        type="button"
                        onClick={() => setDay(d, { pauses: [...day.pauses, room] })}
                        className="h-[44px] self-start border-0 bg-transparent px-[4px] text-[14px] text-m-tx underline underline-offset-[3px]"
                      >
                        + Añadir pausa
                      </button>
                    ) : null}
                    {dayErrs[d] ? (
                      <span role="alert" className="text-[13px] text-m-dn">
                        {dayErrs[d]}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmSheet
        open={discard}
        title="¿Descartar los cambios?"
        body={`Los cambios en «${form.name.trim() || site?.name || "la sede"}» no se guardarán.`}
        cancelLabel="Seguir editando"
        okLabel="Descartar"
        onCancel={() => setDiscard(false)}
        onOk={() => {
          setDiscard(false);
          leave();
        }}
      />
    </Screen>
  );
}
