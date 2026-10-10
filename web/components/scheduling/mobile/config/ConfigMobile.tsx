"use client";

import { useTheme } from "next-themes";
import type { Exception, Service, Site, Staff } from "../../AdminPanel";
import { MToast } from "../kit";
import { BlockForm, BlocksList } from "./BlocksMobile";
import { RULE_KEYS, ruleLabel, plural } from "./logic";
import { RulesScreen } from "./RulesMobile";
import { ServiceEditorMobile, ServicesList } from "./ServicesMobile";
import { SiteDetail, SiteEdit, SitesList } from "./SitesMobile";
import { CARD_M, CFG_ICON, NavRow, Screen, SectionLabel, SwitchRow, TopHeader, useConfigNav, useMounted, useToast, type ConfigNav } from "./ui";

/**
 * CONFIGURACIÓN DE AGENDA · PHONE (< 768px) — reference "M_AI Scheduling Móvil v2",
 * screens 4.1–4.14. Inicio is a list of sections with their key fact; every section is
 * its own screen with "‹ Atrás" and a full title (no horizontal tabs). The screen lives
 * in the URL (`?m=`), so the browser and system back walk it.
 *
 * Every write goes through the SAME server actions as the desktop panel (which stays
 * as it is from 768px up); nothing here is a placeholder for a feature the backend lacks.
 */
export interface ConfigMobileProps {
  clientId: string;
  clientName: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  exceptions: Exception[];
  pastExceptions: Exception[];
  siteServiceMap: Record<string, string[]>;
  schedulingEnabled: boolean;
}

export function ConfigMobile(props: ConfigMobileProps) {
  const nav = useConfigNav();
  const [toast, showToast] = useToast();
  return (
    // `relative z-0` makes this tree its own stacking context, so the toast stays under
    // any open sheet (they portal to <body>). The `[role=status]` colour re-asserts the
    // toast's on-primary text, which the kit's own `u-sch-m` colour overrides.
    <div className="u-sch-m relative z-0 -m-[var(--content-pad)] flex min-h-0 flex-1 flex-col bg-m-bg text-m-tx md:hidden [&_[role=status].fixed]:!text-m-onpri">
      <ConfigScreen {...props} nav={nav} toast={showToast} />
      <MToast message={toast} bottom={104} />
    </div>
  );
}

function ConfigScreen({ nav, toast, ...p }: ConfigMobileProps & { nav: ConfigNav; toast: (m: string) => void }) {
  const site = nav.id ? p.sites.find((s) => s.id === nav.id) ?? null : null;
  switch (nav.screen) {
    case "sedes":
      return <SitesList nav={nav} sites={p.sites} staff={p.staff} schedulingEnabled={p.schedulingEnabled} />;
    case "sede":
      if (!site) break;
      return (
        <SiteDetail
          key={site.id}
          nav={nav}
          clientId={p.clientId}
          site={site}
          staff={p.staff}
          serviceCount={(p.siteServiceMap[site.id] ?? []).filter((id) => p.services.some((s) => s.id === id && s.active)).length}
          schedulingEnabled={p.schedulingEnabled}
          toast={toast}
        />
      );
    case "sede-editar":
      if (!site) break;
      return <SiteEdit key={site.id} nav={nav} clientId={p.clientId} site={site} toast={toast} />;
    case "sede-nueva":
      return <SiteEdit key="new" nav={nav} clientId={p.clientId} site={null} toast={toast} />;
    case "servicios":
      return <ServicesList nav={nav} sites={p.sites} services={p.services} staff={p.staff} siteServiceMap={p.siteServiceMap} />;
    case "servicio": {
      const service = nav.id && nav.id !== "nuevo" ? p.services.find((s) => s.id === nav.id) ?? null : null;
      if (nav.id !== "nuevo" && !service) break;
      return (
        <ServiceEditorMobile
          key={service?.id ?? "new"}
          nav={nav}
          clientId={p.clientId}
          service={service}
          newCategory={nav.param("cat")}
          sites={p.sites}
          staff={p.staff}
          siteServiceMap={p.siteServiceMap}
          toast={toast}
        />
      );
    }
    case "bloqueos":
      return <BlocksList nav={nav} clientId={p.clientId} sites={p.sites} staff={p.staff} exceptions={p.exceptions} past={p.pastExceptions} toast={toast} />;
    case "bloqueo-nuevo":
      return <BlockForm key={nav.param("plantilla") ?? "blank"} nav={nav} clientId={p.clientId} sites={p.sites} staff={p.staff} template={nav.param("plantilla")} toast={toast} />;
    case "reglas":
      return <RulesScreen nav={nav} clientId={p.clientId} sites={p.sites} toast={toast} />;
    default:
      break;
  }
  return <Home nav={nav} {...p} />;
}

// ── 4.1 Inicio ───────────────────────────────────────────────────────────────────

function Home({ nav, clientId, clientName, sites, services, staff, exceptions }: ConfigMobileProps & { nav: ConfigNav }) {
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();
  const dark = mounted && resolvedTheme === "dark";

  const activeSites = sites.filter((s) => s.active);
  const inactiveSites = sites.length - activeSites.length;
  const activeServices = services.filter((s) => s.active);
  const categories = new Set(activeServices.map((s) => s.category ?? "none")).size;
  const activeStaff = staff.filter((p) => p.active);
  const inactiveStaff = staff.length - activeStaff.length;

  const sitesSub =
    sites.length === 0
      ? "Ninguna todavía"
      : [plural(activeSites.length, "activa", "activas"), inactiveSites ? plural(inactiveSites, "inactiva", "inactivas") : null].filter(Boolean).join(" · ");
  const rulesSite = activeSites[0] ?? sites[0];
  const differs =
    activeSites.length > 1 &&
    activeSites.some((s) => RULE_KEYS.some((k) => s.scheduling_config[k] !== activeSites[0].scheduling_config[k]));
  const rulesSub = !rulesSite
    ? "Sin sedes"
    : differs
      ? `Distintas en ${activeSites.length} sedes`
      : `Cada ${ruleLabel("slot_interval_min", rulesSite.scheduling_config.slot_interval_min)} · hasta ${ruleLabel("booking_horizon_days", rulesSite.scheduling_config.booking_horizon_days)}`;
  const siteSub = activeSites.length === 1 ? activeSites[0].name : activeSites.length > 1 ? plural(activeSites.length, "sede", "sedes") : "Sin sedes activas";

  return (
    <Screen label="Configuración" header={<TopHeader name={clientName} title="Configuración" sub={`${clientName} · ${siteSub}`} />}>
      <SectionLabel>Agenda</SectionLabel>
      <nav aria-label="Configuración de agenda" className={CARD_M}>
        <NavRow icon={CFG_ICON.sede} title="Sedes y horarios" sub={sitesSub} onClick={() => nav.go("sedes")} />
        <NavRow
          icon={CFG_ICON.svc}
          title="Servicios"
          sub={`${plural(activeServices.length, "activo", "activos")} · ${plural(categories, "categoría", "categorías")}`}
          onClick={() => nav.go("servicios")}
        />
        <NavRow
          icon={CFG_ICON.team}
          title="Equipo"
          sub={[plural(activeStaff.length, "profesional", "profesionales"), inactiveStaff ? plural(inactiveStaff, "inactivo", "inactivos") : null].filter(Boolean).join(" · ")}
          href={`/clients/${clientId}/scheduling/staff`}
        />
        <NavRow icon={CFG_ICON.block} title="Bloqueos" sub={exceptions.length ? plural(exceptions.length, "próximo", "próximos") : "Ninguno próximo"} onClick={() => nav.go("bloqueos")} />
        <NavRow icon={CFG_ICON.rules} title="Reglas de reserva" sub={rulesSub} onClick={() => nav.go("reglas")} />
      </nav>
      <SectionLabel>Preferencias</SectionLabel>
      <SwitchRow checked={dark} onChange={() => setTheme(dark ? "light" : "dark")} label="Modo oscuro" icon={CFG_ICON.moon} className="min-h-[60px] rounded-[16px] py-[8px]" />
    </Screen>
  );
}
