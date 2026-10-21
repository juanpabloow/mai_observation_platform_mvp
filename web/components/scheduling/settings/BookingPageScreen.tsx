"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { bookingLinkStatus, bookingPath } from "@/lib/bookingLink";
import { hoursLines, pageSections, type PageService } from "@/lib/bookingPage";
import { priceLabelCOP } from "@/lib/money";
import { schedulingHref } from "@/lib/schedulingNav";
import { updateSiteAction } from "@/lib/schedulingAdminActions";
import type { BookingCategory, Service, Site, Staff } from "../AdminPanel";
import { BookingLinkCard } from "../BookingLinkCard";
import { BookingCategoriesPanel } from "../services/BookingCategoriesPanel";
import { ServicePresentationEditor } from "../services/ServiceEditor";
import type { PromotionAdminRow } from "../promotions/PromotionsSection";
import { Alert, Button, Field, INPUT, buttonClass } from "../ui/system";
import { ModuleSurface, SurfaceHeader, SurfaceToolbar } from "@/components/ui/module/ModuleSurface";
import { EditorFrame, EditorSection, SaveNote, changesLabel } from "@/components/ui/module/Editor";
import { Notice } from "@/components/ui/module/FormKit";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { usePageFormGuard } from "@/components/ui/module/useEditorGuard";
import { useUrlState } from "@/components/ui/module/useUrlState";
import { returnFocus } from "@/components/ui/module/ListTable";
import { SitePicker } from "./SitePicker";

/**
 * «Página de reservas» (Presencia y marketing) — what the customer sees, managed by
 * sections in one surface, with a live preview that folds away on a laptop.
 *
 * It manages PRESENTATION only: the public contact of each site, the public categories
 * (order, how they are shown, visibility), how each service is presented, and the real
 * public link. Name, address and hours come from Sedes / Horarios, and price, duration
 * and professionals from Servicios — they are shown here, read-only, with a link to the
 * module that owns them, so there is never a second place to edit them.
 *
 * Saves stay where they were: the contact saves per site (updateSiteAction with only the
 * public keys), each category saves on its own, each service presentation saves on its
 * own. There is no page-wide «Guardar» that would batch them.
 *
 * The preview is built from the saved data with the SAME rule the public page uses
 * (lib/bookingPage.pageSections and the public listing predicate), not a mock-up.
 */

const STATUS_CHIP: Record<ReturnType<typeof bookingLinkStatus>, { label: string; tone: string }> = {
  available: { label: "Publicada", tone: "bg-success/15 text-success" },
  site_inactive: { label: "Sede inactiva", tone: "bg-chip text-muted" },
  scheduling_disabled: { label: "Agenda desactivada", tone: "bg-warn-soft text-warn" },
};

export function BookingPageScreen({
  clientId,
  sites,
  services,
  staff,
  siteServiceMap,
  schedulingEnabled,
  bookingCategories,
  promotions,
}: {
  clientId: string;
  sites: Site[];
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  schedulingEnabled: boolean;
  bookingCategories: BookingCategory[];
  promotions: PromotionAdminRow[];
}) {
  const router = useRouter();
  const [siteParam, setSiteParam] = useUrlState("sede", "");
  const [previewOpen, setPreviewOpen] = useState(true);
  const [presenting, setPresenting] = useState<Service | null>(null);
  const [contactDirty, setContactDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const site = sites.find((s) => s.id === siteParam) ?? sites.find((s) => s.active) ?? sites[0];
  const status = site ? bookingLinkStatus({ siteActive: site.active, schedulingEnabled }) : null;
  const active = services.filter((s) => s.active);

  const pickSite = (id: string) => {
    if (id === site?.id) return;
    if (contactDirty) setSwitchTo(id);
    else setSiteParam(id);
  };

  if (presenting) {
    return (
      <ModuleSurface label="Página de reservas">
        <ServicePresentationEditor
          clientId={clientId}
          service={presenting}
          sites={sites.filter((x) => x.active)}
          staff={staff.filter((x) => x.active)}
          siteServiceMap={siteServiceMap}
          bookingCategories={bookingCategories}
          allServices={active}
          servicesHref={schedulingHref(clientId, "services")}
          onClose={() => {
            const id = presenting.id;
            setPresenting(null);
            returnFocus(id);
          }}
          onSaved={() => {
            const id = presenting.id;
            setPresenting(null);
            router.refresh();
            returnFocus(id);
          }}
        />
      </ModuleSurface>
    );
  }

  const preview = site ? (
    <BookingPreview site={site} services={services} staff={staff} siteServiceMap={siteServiceMap} categories={bookingCategories} promotions={promotions} />
  ) : null;

  return (
    <ModuleSurface label="Página de reservas">
      <SurfaceHeader
        title="Página de reservas"
        status={status ? <span className={`rounded-full px-2 py-0.5 text-[0.7188rem] font-medium ${STATUS_CHIP[status].tone}`}>{STATUS_CHIP[status].label}</span> : null}
        summary="Lo que ve tu cliente al reservar: presentación, categorías públicas y catálogo visible."
        actions={
          <>
            <button
              type="button"
              onClick={() => setPreviewOpen(!previewOpen)}
              aria-pressed={!previewOpen}
              aria-controls="editor-aside"
              className={buttonClass({ className: "max-xl:hidden" })}
            >
              {previewOpen ? "Ocultar vista previa" : "Mostrar vista previa"}
            </button>
            {site ? (
              <a href={bookingPath(site.slug)} target="_blank" rel="noopener noreferrer" className={buttonClass()}>
                Abrir página
                <span className="sr-only"> (se abre en una pestaña nueva)</span>
              </a>
            ) : null}
          </>
        }
      />
      {sites.length > 1 && site ? (
        <SurfaceToolbar>
          <SitePicker sites={sites} value={site.id} onChange={pickSite} what="la presentación y el enlace" />
        </SurfaceToolbar>
      ) : null}

      {!site ? (
        <div className="p-6">
          <Notice>
            Aún no hay sedes. Crea la primera en{" "}
            <Link href={schedulingHref(clientId, "sites")} className="underline underline-offset-2">
              Sedes
            </Link>{" "}
            para tener una página de reservas.
          </Notice>
        </div>
      ) : (
        <EditorFrame
          sections={[
            { id: "bp-presentacion", label: "Presentación del negocio", dirty: contactDirty },
            { id: "bp-categorias", label: "Categorías públicas" },
            { id: "bp-catalogo", label: "Catálogo visible" },
            { id: "bp-enlace", label: "Enlace público" },
          ]}
          aside={preview}
          asideOpen={previewOpen}
          asideLabel="Vista previa"
        >
          <EditorSection id="bp-presentacion" title="Presentación del negocio" description="Datos que ve el cliente. El contacto se guarda aparte, para esta sede." summary={site.name}>
            <ContactForm key={site.id} clientId={clientId} site={site} onDirtyChange={setContactDirty} />
          </EditorSection>

          <EditorSection
            id="bp-categorias"
            title="Categorías públicas"
            description="Cómo se agrupan los servicios en la página pública: orden, cómo se muestra cada una y si está visible. No son las categorías internas de Servicios (que colorean la agenda). Cada categoría se guarda por separado."
            summary={`${bookingCategories.length} categoría${bookingCategories.length === 1 ? "" : "s"}`}
            defaultOpen={false}
          >
            <BookingCategoriesPanel clientId={clientId} categories={bookingCategories} embedded />
          </EditorSection>

          <EditorSection
            id="bp-catalogo"
            title="Catálogo visible"
            description="Cómo se presenta cada servicio. Nombre, precio y descripción vienen de Servicios: aquí solo cambia cómo se muestran."
            summary={`${active.filter((s) => s.public_visible !== false).length} de ${active.length} servicios visibles`}
            defaultOpen={false}
          >
            <CatalogPresentation services={active} categories={bookingCategories} onEdit={setPresenting} servicesHref={schedulingHref(clientId, "services")} />
          </EditorSection>

          <EditorSection id="bp-enlace" title="Enlace público" description="El enlace real de esta sede. La URL pública (slug) se cambia en Sedes." summary={bookingPath(site.slug)} defaultOpen={false}>
            <div className="overflow-hidden rounded-sch-card border border-line [&>section]:border-t-0">
              <BookingLinkCard slug={site.slug} siteActive={site.active} schedulingEnabled={schedulingEnabled} serviceCount={siteServiceMap[site.id]?.length ?? 0} />
            </div>
          </EditorSection>
        </EditorFrame>
      )}

      {switchTo ? (
        <DiscardChanges
          body={`Tienes cambios sin guardar en el contacto de ${site?.name}. Si cambias de sede, se pierden.`}
          onKeep={() => setSwitchTo(null)}
          onDiscard={() => {
            setContactDirty(false);
            setSiteParam(switchTo);
            setSwitchTo(null);
          }}
        />
      ) : null}
    </ModuleSurface>
  );
}

/** The site's public contact (WhatsApp, Google Maps), with the read-only facts that come
 *  from other modules beside it. Saves ONLY the public keys of this site. */
function ContactForm({ clientId, site, onDirtyChange }: { clientId: string; site: Site; onDirtyChange: (dirty: boolean) => void }) {
  const router = useRouter();
  const [whatsapp, setWhatsapp] = useState(site.public_whatsapp ?? "");
  const [mapsUrl, setMapsUrl] = useState(site.public_maps_url ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const changes = Number(whatsapp !== (site.public_whatsapp ?? "")) + Number(mapsUrl !== (site.public_maps_url ?? ""));
  const dirty = changes > 0;
  // Tell the page (it asks before switching sites with unsaved contact edits).
  const report = useRef(onDirtyChange);
  useEffect(() => {
    report.current = onDirtyChange;
  });
  useEffect(() => {
    report.current(dirty);
  }, [dirty]);
  const guard = usePageFormGuard(dirty && state !== "saving");
  const hours = hoursLines(site.opening_hours);

  const save = async () => {
    setState("saving");
    setError(null);
    const r = await updateSiteAction(clientId, site.id, { publicWhatsapp: whatsapp, publicMapsUrl: mapsUrl });
    if (!r.ok) {
      setState("idle");
      setError(`${r.error ?? "No se pudo guardar."} Lo que escribiste se conserva.`);
      return;
    }
    setState("saved");
    router.refresh();
  };

  return (
    <>
      <dl className="flex flex-col divide-y divide-line-soft rounded-sch-card border border-line text-[0.8438rem]">
        <FactRow label="Nombre público" value={site.name} href={schedulingHref(clientId, "sites")} linkLabel="Editar en Sedes" />
        <FactRow label="Dirección" value={site.address || "Sin dirección"} href={schedulingHref(clientId, "sites")} linkLabel="Editar en Sedes" />
        <FactRow
          label="Horario"
          value={
            hours.length ? (
              <span className="flex flex-col">
                {hours.map((h) => (
                  <span key={h.days} className="whitespace-nowrap">
                    {h.days} · {h.hours}
                  </span>
                ))}
              </span>
            ) : (
              "Sin horario de atención"
            )
          }
          href={schedulingHref(clientId, "hours")}
          linkLabel="Editar en Horarios"
        />
      </dl>
      <Notice>El logo del negocio lo sube la agencia desde Clientes. La página no tiene foto de portada.</Notice>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="WhatsApp del negocio" optional hint="Con indicativo. Vacío = no se muestra.">
          <input value={whatsapp} inputMode="tel" placeholder="+57 300 123 4567" onChange={(e) => setWhatsapp(e.target.value)} className={INPUT} />
        </Field>
        <Field label="Enlace de Google Maps" optional hint="Si está vacío, se busca la dirección.">
          <input value={mapsUrl} inputMode="url" placeholder="https://maps.app.goo.gl/…" onChange={(e) => setMapsUrl(e.target.value)} className={INPUT} />
        </Field>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span aria-live="polite" className="mr-auto text-[0.7812rem] text-muted">
          {dirty ? changesLabel(changes) : <SaveNote state={state === "saved" ? "saved" : "idle"} />}
        </span>
        {dirty ? (
          <Button
            onClick={() => {
              setWhatsapp(site.public_whatsapp ?? "");
              setMapsUrl(site.public_maps_url ?? "");
              setError(null);
            }}
            disabled={state === "saving"}
          >
            Descartar
          </Button>
        ) : null}
        <Button variant="primary" onClick={save} disabled={!dirty} loading={state === "saving"} loadingLabel="Guardando…">
          Guardar contacto
        </Button>
      </div>
      {guard.asking ? <DiscardChanges onKeep={guard.keepEditing} onDiscard={guard.discard} body="El contacto de la sede tiene cambios sin guardar. Si sales ahora, se pierden." /> : null}
    </>
  );
}

function FactRow({ label, value, href, linkLabel }: { label: string; value: React.ReactNode; href: string; linkLabel: string }) {
  // Label + link on one line, the value below at the full width of the card: an address
  // or a week of hours always reads whole, even with the preview open on a laptop.
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-3">
        <dt className="min-w-0 flex-1 text-xs text-muted">{label}</dt>
        {/* 44px tall on touch widths (same text size; the row absorbs it), compact from lg. */}
        <Link href={href} className="u-focus -my-3 inline-flex min-h-[44px] shrink-0 items-center rounded-sch-control px-1 text-[0.7812rem] font-medium text-foreground underline underline-offset-2 hover:text-muted lg:my-0 lg:min-h-0">
          {linkLabel}
        </Link>
      </div>
      <dd className="text-foreground [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

/** Every active service grouped as the page groups it, with its presentation facts and
 *  «Editar presentación». */
function CatalogPresentation({ services, categories, onEdit, servicesHref }: { services: Service[]; categories: BookingCategory[]; onEdit: (s: Service) => void; servicesHref: string }) {
  const cats = [...categories].sort((a, b) => a.sort_order - b.sort_order);
  const groups = [
    ...cats.map((c) => ({ id: c.id, name: c.name, hidden: !c.visible, contact: c.layout === "contact", items: services.filter((s) => s.public_category_id === c.id) })),
    {
      id: "none",
      name: "Sin categoría en la página",
      hidden: false,
      contact: false,
      items: services.filter((s) => !s.public_category_id || !cats.some((c) => c.id === s.public_category_id)),
    },
  ].filter((g) => g.items.length > 0 || g.id !== "none");
  const sorted = (items: Service[]) => [...items].sort((a, b) => (a.public_sort ?? 0) - (b.public_sort ?? 0) || a.name.localeCompare(b.name, "es"));
  if (services.length === 0) {
    return (
      <Notice>
        No hay servicios activos. Créalos en{" "}
        <Link href={servicesHref} className="underline underline-offset-2">
          Servicios
        </Link>
        .
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.id} aria-label={g.name} className="overflow-hidden rounded-sch-card border border-line">
          <header className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/50 px-4 py-2.5">
            <h3 className="text-[0.8438rem] font-semibold text-foreground">{g.name}</h3>
            {g.hidden ? <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">Categoría oculta</span> : null}
            {g.contact ? <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">Enlace a WhatsApp: no lista servicios</span> : null}
            <span className="ml-auto text-xs text-muted">{g.items.length}</span>
          </header>
          {g.items.length === 0 ? (
            <p className="px-4 py-3 text-xs text-muted">Ningún servicio en esta categoría.</p>
          ) : (
            <ul>
              {sorted(g.items).map((svc, i) => {
                const visible = svc.public_visible !== false;
                return (
                  <li key={svc.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${i > 0 ? "border-t border-line-soft" : ""}`}>
                    <span className="w-6 shrink-0 text-xs tabular-nums text-faint" title="Orden en la página">
                      {svc.public_sort ?? 0}
                    </span>
                    <div className="min-w-[10rem] flex-1">
                      <p className="text-[0.8438rem] font-medium text-foreground">
                        {svc.name}
                        {svc.public_recommended ? <span className="ml-2 text-[0.7188rem] font-normal text-muted">★ Recomendado</span> : null}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {svc.duration_min} min · {priceLabelCOP(svc.price) ?? "Precio a consultar"}
                        {svc.public_image_url ? " · con imagen" : ""}
                      </p>
                    </div>
                    <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${visible ? "bg-success/10 text-success" : "bg-chip text-muted"}`}>{visible ? "Visible" : "Oculto"}</span>
                    <Button size="sm" data-open-key={svc.id} onClick={() => onEdit(svc)}>
                      Editar presentación
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

/** A phone-sized approximation of the public page for ONE site, from the SAVED data and
 *  with the same listing rule as the public catalogue. */
function BookingPreview({
  site,
  services,
  staff,
  siteServiceMap,
  categories,
  promotions,
}: {
  site: Site;
  services: Service[];
  staff: Staff[];
  siteServiceMap: Record<string, string[]>;
  categories: BookingCategory[];
  promotions: PromotionAdminRow[];
}) {
  const visibleCats = useMemo(() => categories.filter((c) => c.visible).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "es")), [categories]);
  const hiddenIds = new Set(categories.filter((c) => !c.visible || c.layout === "contact").map((c) => c.id));
  // The public listing: active, enabled at this site, visible on the page, its category
  // neither hidden nor a contact link, and someone active here who takes bookings and
  // performs it. Ordered public_sort, featured first, name.
  const listed: Array<PageService & { featured: boolean }> = services
    .filter(
      (s) =>
        s.active &&
        s.public_visible !== false &&
        (siteServiceMap[site.id] ?? []).includes(s.id) &&
        !(s.public_category_id && hiddenIds.has(s.public_category_id)) &&
        staff.some((p) => p.active && p.site_id === site.id && p.takes_bookings !== false && p.serviceIds.includes(s.id)),
    )
    .sort((a, b) => (a.public_sort ?? 0) - (b.public_sort ?? 0) || Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name, "es"))
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      duration_min: s.duration_min,
      price: s.price,
      category_id: s.public_category_id ?? null,
      recommended: Boolean(s.public_recommended),
      image_url: s.public_image_url ?? null,
      includes: s.public_includes ?? [],
      upgrade_to: s.public_upgrade_service_id ?? null,
      featured: s.featured,
    }));
  const grouped = pageSections(
    listed,
    visibleCats.map((c) => ({ id: c.id, name: c.name, tagline: c.tagline, layout: c.layout })),
    { hasWhatsapp: Boolean(site.public_whatsapp) },
  );
  const sections = grouped ? grouped.sections : [{ key: "all", name: "Servicios", tagline: null, layout: "list" as const, items: listed }];
  const published = promotions.filter((p) => p.status === "published").length;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">Vista previa · móvil</p>
      <div className="flex flex-col gap-3 rounded-[22px] border border-line bg-surface p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-semibold text-ink-fg">
            {site.name.slice(0, 1).toLocaleUpperCase("es")}
          </span>
          <div className="min-w-0">
            <p className="text-[0.9375rem] font-semibold leading-tight text-foreground">{site.name}</p>
            <p className="text-[0.75rem] text-muted">{site.address || "Sin dirección"}</p>
          </div>
        </div>
        {listed.length === 0 ? <p className="rounded-xl bg-subtle px-3 py-2.5 text-[0.7812rem] text-muted">La página no listaría ningún servicio todavía.</p> : null}
        {sections.map((sec) => (
          <div key={sec.key} className="flex flex-col gap-1.5">
            <div>
              <p className="text-[0.8438rem] font-semibold text-foreground">{sec.name}</p>
              {sec.tagline ? <p className="text-[0.75rem] text-muted">{sec.tagline}</p> : null}
            </div>
            {sec.items.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-xl border border-line px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[0.8125rem] font-medium text-foreground">
                    {s.name}
                    {s.recommended ? <span className="ml-1.5 text-[0.6875rem] font-normal text-muted">Recomendado</span> : null}
                  </p>
                  <p className="text-[0.7188rem] text-muted">{s.duration_min} min</p>
                </div>
                <span className="shrink-0 text-[0.7812rem] font-semibold tabular-nums text-foreground">{priceLabelCOP(s.price) ?? "A consultar"}</span>
              </div>
            ))}
          </div>
        ))}
        {grouped?.contacts.map((c) => (
          <div key={c.id} className="flex flex-col gap-1">
            <p className="text-[0.8438rem] font-semibold text-foreground">{c.name}</p>
            <p className="rounded-xl border border-line px-3 py-2 text-center text-[0.7812rem] font-medium text-foreground">{c.tagline} · WhatsApp</p>
          </div>
        ))}
        <p className="text-[0.7188rem] text-muted">
          {published
            ? `También se muestran ${published} promoción${published === 1 ? "" : "es"} publicada${published === 1 ? "" : "s"} (dentro de su vigencia) y las reseñas publicadas, si las hay.`
            : "También se muestran las promociones vigentes y las reseñas publicadas, si las hay."}
        </p>
      </div>
      <p className="text-[0.7188rem] leading-relaxed text-muted">Aproximada, con lo guardado y las mismas reglas de la página pública. Para verla tal cual: «Abrir página».</p>
    </div>
  );
}
