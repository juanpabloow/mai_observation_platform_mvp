"use client";

import { SERVICE_DESCRIPTION_MAX } from "@/lib/serviceDescription";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { priceLabelCOP } from "@/lib/money";
import { activateServiceAction, countUpcomingAppointmentsAction, deactivateServiceAction } from "@/lib/schedulingAdminActions";
import type { PersistedService } from "@/lib/serviceSave";
import type { Service, Site, Staff } from "../../AdminPanel";
import { CATEGORY_CHOICES, CATEGORY_GROUPS } from "../../services/categories";
import { initialForm, saveServiceForm, validate, type FormState, type Mode } from "../../services/ServiceEditor";
import { MButton, MCheck, MPill, MSegmented, MStaffAvatar } from "../kit";
import { formatThousands, plural } from "./logic";
import {
  CARD_M,
  Chevron,
  ConfirmSheet,
  ErrorNote,
  Field,
  Glyph,
  H2_M,
  INPUT_M,
  LABEL_M,
  ROW_M,
  SELECT_M,
  Screen,
  SubHeader,
  SwitchRow,
  siteStaffColors,
  type ConfigNav,
} from "./ui";

/** Stored category → the mobile pastel class (the agenda's colour family). */
export const CATEGORY_CLASS: Record<string, string> = { cut: "u-m-cut", grooming: "u-m-grooming", color: "u-m-color", feature: "u-m-feature", "": "u-m-neutral" };
const DURATIONS = [15, 30, 45, 60, 75, 90, 120];

function Dot({ category, size = 12 }: { category: string; size?: number }) {
  return <span aria-hidden className={`${CATEGORY_CLASS[category] ?? "u-m-neutral"} flex-none rounded-full`} style={{ width: size, height: size, background: "var(--m-dot)" }} />;
}

// ── 4.7 Servicios ────────────────────────────────────────────────────────────────

export function ServicesList({
  nav,
  sites,
  services,
  staff,
  siteServiceMap,
}: {
  nav: ConfigNav;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
}) {
  const [query, setQuery] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const view = nav.param("vista") === "archivados" ? "arc" : "act";
  const active = services.filter((s) => s.active);
  const archived = services.filter((s) => !s.active);
  const activeSites = sites.filter((s) => s.active);
  const activeStaff = staff.filter((p) => p.active);
  const q = query.trim().toLocaleLowerCase("es");
  const list = (view === "act" ? active : archived).filter(
    (s) =>
      (!q || s.name.toLocaleLowerCase("es").includes(q) || (s.description ?? "").toLocaleLowerCase("es").includes(q)) &&
      (!siteFilter || (siteServiceMap[siteFilter] ?? []).includes(s.id)),
  );
  const groups = CATEGORY_GROUPS.map((g) => ({ ...g, items: list.filter((s) => (CATEGORY_GROUPS.some((x) => x.value === s.category) ? s.category : "") === g.value) })).filter((g) => g.items.length > 0);

  return (
    <Screen
      label="Servicios"
      header={
        <SubHeader
          backLabel={nav.rootLabel ?? "Configuración"}
          onBack={() => nav.back(null)}
          title="Servicios"
          sub={`${plural(active.length, "activo", "activos")} · ${plural(archived.length, "archivado", "archivados")}`}
          action={{ label: "Nuevo servicio", text: <Glyph d="M8 3v10M3 8h10" size={18} width={1.6} />, onClick: () => nav.go("servicio", "nuevo") }}
        />
      }
    >
      <label className={`flex h-[48px] items-center gap-[8px] rounded-[12px] border border-m-bd bg-m-sf px-[12px] text-m-tx3 u-focus`}>
        <Glyph d="M7 11.6A4.6 4.6 0 1 0 7 2.4a4.6 4.6 0 0 0 0 9.2zM10.5 10.5 14 14" size={18} width={1.5} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar servicio"
          aria-label="Buscar servicio"
          className="h-[44px] min-w-0 flex-1 border-0 bg-transparent text-[16px] text-m-tx outline-none placeholder:text-m-tx3"
        />
      </label>
      <MSegmented
        label="Estado de los servicios"
        stretch
        value={view}
        onChange={(v) => nav.setParam("vista", v === "arc" ? "archivados" : null)}
        options={[
          { value: "act", label: `Activos ${active.length}` },
          { value: "arc", label: `Archivados ${archived.length}` },
        ]}
      />
      {activeSites.length > 1 ? (
        <select aria-label="Filtrar por sede" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className={SELECT_M}>
          <option value="">Todas las sedes</option>
          {activeSites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      ) : null}

      {groups.map((g) => (
        <section key={g.value || "none"} className="flex flex-col gap-[8px]">
          <div className="flex items-center gap-[8px]">
            <Dot category={g.value} />
            <h2 className={H2_M}>{g.label}</h2>
            <span className="text-[13px] text-m-tx3">{g.items.length}</span>
          </div>
          <div className={CARD_M}>
            {g.items.map((s) => {
              const pros = activeStaff.filter((p) => p.serviceIds.includes(s.id)).length;
              return (
                <button key={s.id} type="button" onClick={() => nav.go("servicio", s.id)} className={`${ROW_M} min-h-[68px]`}>
                  <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                    <span className="text-[16px] leading-[1.3] [overflow-wrap:anywhere]">{s.name}</span>
                    <span className="text-[13px] text-m-tx3">
                      {s.duration_min} min · {plural(pros, "profesional", "profesionales")}
                      {s.featured ? " · ★ Destacado" : ""}
                    </span>
                  </span>
                  <span className="u-tnum whitespace-nowrap text-right text-[15px]">{priceLabelCOP(s.price) ?? "A consultar"}</span>
                  <Chevron />
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {groups.length === 0 ? (
        <div className={`${CARD_M} flex flex-col items-center gap-[12px] px-[16px] py-[24px] text-center`}>
          <span className="text-[14px] text-m-tx3">
            {q || siteFilter ? "No hay servicios que coincidan." : view === "act" ? "Todavía no hay servicios activos." : "No hay servicios archivados."}
          </span>
          {view === "act" && !q && !siteFilter ? (
            <MButton kind="primary" onClick={() => nav.go("servicio", "nuevo")}>
              Nuevo servicio
            </MButton>
          ) : null}
        </div>
      ) : null}
    </Screen>
  );
}

// ── 4.8 Editor · 4.9 Descartar ───────────────────────────────────────────────────

export function ServiceEditorMobile({
  nav,
  clientId,
  service,
  newCategory,
  sites,
  staff,
  siteServiceMap,
  toast,
}: {
  nav: ConfigNav;
  clientId: string;
  /** null = a new service. */
  service: Service | null;
  newCategory: string | null;
  sites: Site[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  toast: (m: string) => void;
}) {
  const router = useRouter();
  const activeSites = useMemo(() => sites.filter((s) => s.active), [sites]);
  const activeStaff = useMemo(() => staff.filter((p) => p.active), [staff]);
  const mode = useMemo<Mode>(() => (service ? { kind: "edit", service } : { kind: "new", category: newCategory }), [service, newCategory]);
  const initial = useMemo(() => initialForm(mode, activeSites, activeStaff, siteServiceMap), [mode, activeSites, activeStaff, siteServiceMap]);

  const [form, setForm] = useState<FormState>(initial);
  const [priceMode, setPriceMode] = useState<"fijo" | "consultar">(initial.price === "" ? "consultar" : "fijo");
  const [customOn, setCustomOn] = useState(!DURATIONS.includes(Number(initial.duration)));
  const [open, setOpen] = useState({ prep: false, sites: false, staff: false });
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "discard" | { archive: number }>(null);
  const [busy, startBusy] = useTransition();
  const [checking, startCheck] = useTransition();
  const bodyRef = useRef<HTMLDivElement>(null);
  // What the SERVER holds right now — the same resume-not-repeat contract as the desktop editor.
  const persisted = useRef<PersistedService>({ id: service?.id ?? null, siteIds: initial.siteIds, staffIds: initial.staffIds });
  const wrote = useRef(false);

  const effective: FormState = { ...form, price: priceMode === "consultar" ? "" : form.price };
  const errors: Partial<Record<keyof FormState, string>> = validate(effective, mode);
  if (priceMode === "fijo" && !form.price.trim()) errors.price = "Escribe el precio o elige «A consultar».";
  const show = (k: keyof FormState) => ((attempted || touched[k]) && errors[k]) || null;
  const dirty = JSON.stringify(effective) !== JSON.stringify(initial);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (k: "staffIds" | "siteIds", id: string) => setForm((f) => ({ ...f, [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id] }));
  const step = (k: "bBefore" | "bAfter", d: number) => setForm((f) => ({ ...f, [k]: String(Math.max(0, Math.min(240, Number(f[k] || 0) + d))) }));

  const leave = () => {
    if (wrote.current) router.refresh();
    nav.back("servicios");
  };
  const requestLeave = () => {
    if (saving) return;
    if (dirty) setConfirm("discard");
    else leave();
  };

  const save = async () => {
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      setError("Revisa los campos marcados.");
      setOpen((o) => ({ prep: o.prep || Boolean(errors.bBefore || errors.bAfter), sites: o.sites || Boolean(errors.siteIds), staff: o.staff }));
      bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setSaving(true);
    setError(null);
    const out = await saveServiceForm(clientId, persisted.current, effective, activeSites, activeStaff);
    setSaving(false);
    if (out.ok) {
      toast(service ? "Servicio guardado" : "Servicio creado");
      router.refresh();
      nav.back("servicios");
      return;
    }
    if (out.partial) wrote.current = true;
    setError(wrote.current ? `Parte de los cambios ya se guardó. ${out.error} Pulsa Guardar para completar el resto.` : out.error);
    bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const askArchive = () =>
    startCheck(async () => {
      if (!service) return;
      const c = await countUpcomingAppointmentsAction(clientId, "service", service.id);
      setConfirm({ archive: c.ok ? c.count : 0 });
    });
  const archive = () =>
    startBusy(async () => {
      if (!service) return;
      const r = await deactivateServiceAction(clientId, service.id);
      setConfirm(null);
      if (!r.ok) {
        setError(r.error ?? "No se pudo archivar el servicio.");
        return;
      }
      toast("Servicio archivado");
      router.refresh();
      nav.back("servicios");
    });
  const reactivate = () =>
    startBusy(async () => {
      if (!service) return;
      const r = await activateServiceAction(clientId, service.id);
      if (!r.ok) setError(r.error ?? "No se pudo reactivar el servicio.");
      else {
        toast("Servicio reactivado");
        router.refresh();
      }
    });

  const prepSum =
    Number(effective.bBefore || 0) === 0 && Number(effective.bAfter || 0) === 0
      ? "Sin tiempo extra"
      : `${effective.bBefore || 0} min antes · ${effective.bAfter || 0} min después`;
  const sitesSum = activeSites.length === 0 ? "No hay sedes activas" : form.siteIds.length === 0 ? "Ninguna sede" : `${form.siteIds.length} de ${activeSites.length} sedes`;
  const staffSum = activeStaff.length === 0 ? "No hay profesionales activos" : form.staffIds.length === 0 ? "Nadie asignado" : plural(form.staffIds.length, "seleccionado", "seleccionados");
  const staffBySite = activeSites.map((site) => ({ site, people: activeStaff.filter((p) => p.site_id === site.id), colors: siteStaffColors(staff, site.id) })).filter((g) => g.people.length > 0);
  const durationErr = show("duration");

  return (
    <Screen
      label={service ? "Editar servicio" : "Nuevo servicio"}
      bodyRef={bodyRef}
      header={<SubHeader backLabel="Servicios" onBack={requestLeave} title={service ? "Editar servicio" : "Nuevo servicio"} sub={dirty ? "Cambios sin guardar" : service && !service.active ? "Archivado · no se puede reservar" : null} />}
      footer={
        <MButton kind="primary" grow onClick={save} disabled={!dirty} loading={saving} loadingLabel="Guardando…">
          {service ? "Guardar cambios" : "Crear servicio"}
        </MButton>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field id="sv-n" label="Nombre" error={show("name")}>
        <input
          id="sv-n"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          maxLength={160}
          placeholder="Ej. Corte clásico"
          aria-invalid={Boolean(show("name"))}
          className={INPUT_M}
        />
      </Field>
      <Field id="sv-d" label="Descripción" optional error={show("description")}>
        <textarea
          id="sv-d"
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, description: true }))}
          rows={2}
          maxLength={SERVICE_DESCRIPTION_MAX}
          aria-invalid={Boolean(show("description"))}
          className="min-h-[72px] w-full resize-none rounded-[12px] border border-m-bd bg-m-sf px-[14px] py-[12px] text-[16px] leading-[1.4] text-m-tx"
        />
      </Field>

      <section className="flex flex-col gap-[8px]">
        <h2 className={`m-0 ${LABEL_M}`}>Categoría</h2>
        <div role="radiogroup" aria-label="Categoría" className="flex flex-wrap gap-[8px]">
          {[...CATEGORY_CHOICES.slice(1), CATEGORY_CHOICES[0]].map((c) => (
            <MPill key={c.value || "none"} role="radio" selected={form.category === c.value} onClick={() => set("category", c.value)} dot={CATEGORY_CLASS[c.value]}>
              {c.label}
            </MPill>
          ))}
        </div>
        <span className="text-[13px] text-m-tx3">
          {form.category ? "La categoría define el color automático de sus citas." : "Sin categoría: la agenda elige el color según el nombre."}
        </span>
      </section>

      <section className="flex flex-col gap-[8px]">
        <h2 className={`m-0 ${LABEL_M}`}>Duración</h2>
        <div role="radiogroup" aria-label="Duración" className="grid grid-cols-4 gap-[8px]">
          {DURATIONS.map((m) => {
            const sel = !customOn && Number(form.duration) === m;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={sel}
                onClick={() => {
                  setCustomOn(false);
                  set("duration", String(m));
                }}
                className={`u-tnum flex min-h-[44px] items-center justify-center rounded-[12px] border text-[15px] ${sel ? "border-m-pri bg-m-pri font-semibold text-m-onpri" : "border-m-bd bg-m-sf text-m-tx"}`}
              >
                {m} min
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={customOn}
            onClick={() => setCustomOn(true)}
            className={`flex min-h-[44px] items-center justify-center rounded-[12px] border text-[15px] ${customOn ? "border-m-pri bg-m-pri font-semibold text-m-onpri" : "border-m-bd bg-m-sf text-m-tx"}`}
          >
            Otra
          </button>
        </div>
        {customOn ? (
          <div className="flex items-center gap-[8px]">
            <input
              type="text"
              inputMode="numeric"
              aria-label="Duración personalizada en minutos"
              value={form.duration}
              onChange={(e) => set("duration", e.target.value.replace(/\D/g, ""))}
              onBlur={() => setTouched((t) => ({ ...t, duration: true }))}
              placeholder="Ej.: 50"
              aria-invalid={Boolean(durationErr)}
              className={`${INPUT_M} u-tnum w-[120px]`}
            />
            <span className="text-[15px] text-m-tx2">minutos</span>
          </div>
        ) : null}
        {durationErr || (customOn && attempted && errors.duration) ? (
          <span role="alert" className="text-[13px] text-m-dn">
            {errors.duration}
          </span>
        ) : null}
      </section>

      <section className="flex flex-col gap-[8px]">
        <h2 className={`m-0 ${LABEL_M}`}>Precio</h2>
        <div role="radiogroup" aria-label="Precio" className="flex rounded-[12px] bg-m-sf2 p-[2px]">
          {(
            [
              ["fijo", "Precio fijo"],
              ["consultar", "A consultar"],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={priceMode === k}
              onClick={() => setPriceMode(k)}
              className={`flex h-[44px] min-w-[44px] flex-1 items-center justify-center whitespace-nowrap rounded-[10px] border-0 px-[14px] text-[15px] ${
                priceMode === k ? "bg-m-sf font-semibold text-m-tx shadow-[0_1px_2px_rgba(0,0,0,0.14)]" : "bg-transparent text-m-tx2"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        {priceMode === "fijo" ? (
          <>
            <div className={`flex h-[48px] items-center rounded-[12px] border bg-m-sf pl-[14px] u-focus ${show("price") ? "border-m-dn" : "border-m-bd"}`}>
              <span className="text-[16px] text-m-tx3">$</span>
              <input
                inputMode="numeric"
                aria-label="Precio en pesos"
                value={/^\d*$/.test(form.price) ? formatThousands(form.price) : form.price}
                onChange={(e) => set("price", e.target.value.replace(/\D/g, ""))}
                onBlur={() => setTouched((t) => ({ ...t, price: true }))}
                aria-invalid={Boolean(show("price"))}
                className="u-tnum h-[46px] min-w-0 flex-1 border-0 bg-transparent px-[10px] text-[16px] text-m-tx outline-none"
              />
              <span className="pr-[14px] text-[14px] text-m-tx3">COP</span>
            </div>
            {show("price") ? (
              <span role="alert" className="text-[13px] text-m-dn">
                {show("price")}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-[13px] text-m-tx3">Se muestra «A consultar» en la reserva y en la agenda.</span>
        )}
      </section>

      <SwitchRow
        checked={form.featured}
        onChange={() => set("featured", !form.featured)}
        label="Destacado"
        sub="Se ofrece primero cuando el cliente no especifica un servicio."
        className="min-h-[64px] rounded-[16px] py-[10px]"
      />

      <div className={CARD_M}>
        <button type="button" aria-expanded={open.prep} onClick={() => setOpen((o) => ({ ...o, prep: !o.prep }))} className="flex min-h-[64px] w-full items-center gap-[12px] border-0 bg-transparent px-[14px] py-[10px] text-left text-m-tx">
          <span className="flex flex-1 flex-col gap-[2px]">
            <span className="text-[16px]">Preparación</span>
            <span className="text-[13px] text-m-tx3">{prepSum}</span>
          </span>
          <Chevron open={open.prep} />
        </button>
        {open.prep ? (
          <div className="flex flex-col gap-[10px] px-[14px] pb-[14px]">
            {(
              [
                ["bBefore", "Antes de la cita", "antes"],
                ["bAfter", "Después de la cita", "después"],
              ] as const
            ).map(([k, label, word]) => (
              <div key={k} className="flex items-center gap-[8px]">
                <span className="flex-1 text-[15px]">{label}</span>
                <button type="button" aria-label={`Restar 5 minutos ${word}`} onClick={() => step(k, -5)} className="flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[20px] text-m-tx">
                  −
                </button>
                <span aria-live="polite" className="u-tnum w-[64px] text-center text-[15px]">
                  {form[k] || 0} min
                </span>
                <button type="button" aria-label={`Sumar 5 minutos ${word}`} onClick={() => step(k, 5)} className="flex size-[44px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[20px] text-m-tx">
                  +
                </button>
              </div>
            ))}
            <span className="text-[13px] text-m-tx3">Bloquea tiempo extra sin mostrarlo al cliente.</span>
          </div>
        ) : null}

        <button
          type="button"
          aria-expanded={open.sites}
          onClick={() => setOpen((o) => ({ ...o, sites: !o.sites }))}
          className="flex min-h-[64px] w-full items-center gap-[12px] border-0 border-t border-m-dv bg-transparent px-[14px] py-[10px] text-left text-m-tx"
        >
          <span className="flex flex-1 flex-col gap-[2px]">
            <span className="text-[16px]">Sedes</span>
            <span className={`text-[13px] ${show("siteIds") ? "text-m-dn" : "text-m-tx3"}`}>{sitesSum}</span>
          </span>
          <Chevron open={open.sites} />
        </button>
        {open.sites ? (
          <div className="px-[10px] pb-[6px]">
            {activeSites.map((site, i) => {
              const on = form.siteIds.includes(site.id);
              return (
                <button
                  key={site.id}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle("siteIds", site.id)}
                  className={`flex min-h-[56px] w-full items-center gap-[12px] border-0 bg-transparent px-[4px] py-[6px] text-left text-m-tx ${i ? "border-t border-m-dv" : ""}`}
                >
                  <MCheck on={on} />
                  <span className="flex flex-1 flex-col">
                    <span className="text-[15px]">{site.name}</span>
                    <span className="text-[13px] text-m-tx3">Agenda, asistente y reserva en línea</span>
                  </span>
                </button>
              );
            })}
            {show("siteIds") ? (
              <p role="alert" className="m-0 px-[4px] pb-[8px] text-[13px] text-m-dn">
                {show("siteIds")}
              </p>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          aria-expanded={open.staff}
          onClick={() => setOpen((o) => ({ ...o, staff: !o.staff }))}
          className="flex min-h-[64px] w-full items-center gap-[12px] border-0 border-t border-m-dv bg-transparent px-[14px] py-[10px] text-left text-m-tx"
        >
          <span className="flex flex-1 flex-col gap-[2px]">
            <span className="text-[16px]">Profesionales</span>
            <span className="text-[13px] text-m-tx3">{staffSum}</span>
          </span>
          <Chevron open={open.staff} />
        </button>
        {open.staff ? (
          <div className="px-[10px] pb-[6px]">
            {staffBySite.map(({ site, people, colors }) => (
              <div key={site.id}>
                {staffBySite.length > 1 ? <p className="m-0 px-[4px] pt-[8px] text-[13px] font-semibold text-m-tx3">{site.name}</p> : null}
                {people.map((p, i) => {
                  const on = form.staffIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      onClick={() => toggle("staffIds", p.id)}
                      className={`flex min-h-[56px] w-full items-center gap-[12px] border-0 bg-transparent px-[4px] py-[6px] text-left text-m-tx ${i ? "border-t border-m-dv" : ""}`}
                    >
                      <MCheck on={on} />
                      <MStaffAvatar id={p.id} name={p.name} size={32} color={colors.get(p.id)} />
                      <span className="flex-1 text-[15px] leading-[1.3]">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {service ? (
        service.active ? (
          <button
            type="button"
            onClick={checking || busy ? undefined : askArchive}
            aria-disabled={checking || busy || undefined}
            className="flex h-[48px] items-center justify-center rounded-[12px] border border-m-dnbd bg-transparent text-[15px] text-m-dn aria-disabled:opacity-60"
          >
            {checking ? "Comprobando citas…" : "Archivar servicio"}
          </button>
        ) : (
          <button type="button" onClick={reactivate} disabled={busy} className="flex h-[48px] items-center justify-center rounded-[12px] border border-m-bd bg-m-sf text-[15px] text-m-tx disabled:opacity-60">
            {busy ? "Reactivando…" : "Reactivar servicio"}
          </button>
        )
      ) : null}

      <ConfirmSheet
        open={confirm === "discard"}
        title="¿Descartar los cambios?"
        body={`Los cambios en «${form.name.trim() || service?.name || "este servicio"}» no se guardarán.`}
        cancelLabel="Seguir editando"
        okLabel="Descartar"
        onCancel={() => setConfirm(null)}
        onOk={() => {
          setConfirm(null);
          leave();
        }}
      />
      <ConfirmSheet
        open={typeof confirm === "object" && confirm !== null}
        title={`¿Archivar «${service?.name ?? ""}»?`}
        body={`Dejará de poder reservarse. ${
          typeof confirm === "object" && confirm && confirm.archive > 0
            ? `Tiene ${plural(confirm.archive, "cita próxima", "citas próximas")}: se conservan.`
            : "Sus citas y su historial se conservan."
        } Puedes reactivarlo desde Archivados.`}
        cancelLabel="Volver"
        okLabel="Archivar"
        busy={busy}
        busyLabel="Archivando…"
        onCancel={() => setConfirm(null)}
        onOk={archive}
      />
    </Screen>
  );
}
