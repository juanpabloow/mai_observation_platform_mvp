import Link from "next/link";
import { connection } from "next/server";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { PageShell } from "@/components/ui/PageShell";
import { PageHeading } from "@/components/ui/PageTitle";
import { EmptyState, FacetPills, Pagination } from "@/components/ui/primitives";
import { MeetingsTable } from "@/components/reuniones/MeetingsTable";
import { UploadMeetingButton } from "@/components/reuniones/UploadMeetingDialog";
import { MeetingsSearch } from "@/components/reuniones/MeetingsSearch";
import { ActiveRangeChip, MeetingsFilterMenu, MeetingsSortMenu } from "@/components/reuniones/MeetingsToolbar";
import { RANGE_KEYS, SORT_KEYS, type RangeKey, type SortKey } from "@/lib/meetingsFilters";
import { headlineOf, listMeetings, type MeetingFacet } from "@/lib/meetingsData";
import { parseMediaLimits } from "@worker/meetings/mediaLimits.js";

const FACETS = new Set<MeetingFacet>(["all", "done", "processing", "attention"]);
const PAGE_SIZE = 9;

/**
 * Reuniones — the client-scoped listing.
 *
 * Gated by the same central resolver every module surface uses: session +
 * canAccessClient + a real non-default client + the `meetings` module enabled.
 * Any failure is an indistinguishable 404.
 *
 * FIXTURES, NOT QUERIES (yet). The rows come from web/lib/meetingsData.ts. The
 * screen is deliberately built against the real shell — the rail, the page
 * shell, the shared table geometry — because the point of shipping the UI first
 * is to review it where it will actually live, not in a mock frame.
 *
 * ONE CONTROL BAND. The facets, the active range, the two headline metrics and
 * `Filtrar`/`Orden` share a single row above the table. They used to be a strip
 * of five big metric tiles plus a separate pill row, which spent two bands of
 * vertical space restating numbers the pills already carry — and pushed the
 * first meeting below the fold.
 *
 * Every control is URL state (`?facet=`, `?q=`, `?sort=`, `?range=`, `?page=`),
 * like Contacts: a filter is a link, so it deep-links, middle-clicks and works
 * before hydration.
 */
export default async function ClientMeetingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<{ q?: string; facet?: string; sort?: string; range?: string; page?: string }>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "meetings");
  const { q, facet: facetRaw, sort: sortRaw, range: rangeRaw, page: pageRaw } = await searchParams;

  // Every param is validated before it reaches the data layer; an unknown value
  // is simply the default, never an error page.
  const facet: MeetingFacet = facetRaw && FACETS.has(facetRaw as MeetingFacet) ? (facetRaw as MeetingFacet) : "all";
  const sort: SortKey = sortRaw && SORT_KEYS.has(sortRaw) ? (sortRaw as SortKey) : "recent";
  const range: RangeKey = rangeRaw && RANGE_KEYS.has(rangeRaw) ? (rangeRaw as RangeKey) : "30d";
  const search = q?.trim() || undefined;

  // El gate devuelve el ámbito ya verificado; de ahí salen los dos uuids que
  // el repositorio pone en el WHERE. La página nunca los toma de la URL más
  // allá del clientId que el propio gate acaba de validar.
  const all = await listMeetings(
    { tenantId: scope.tenantId, clientId: client.id },
    { facet, search, sort },
  );
  const headline = headlineOf(all);
  // Los límites EFECTIVOS, no los por defecto: `MEETINGS_MAX_MEDIA_BYTES` y
  // compañía pueden apretarlos en Railway, y el portero del navegador tiene que
  // rechazar lo mismo que rechazaría el servidor. Se leen aquí porque
  // `process.env` sólo existe en el servidor.
  const { limits } = parseMediaLimits(process.env);
  const requestedPage = Math.max(1, Math.trunc(Number(pageRaw)) || 1);
  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const meetings = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const base = `/clients/${client.id}/reuniones`;
  const hrefWith = (patch: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q,
      facet: facet === "all" ? undefined : facet,
      sort: sort === "recent" ? undefined : sort,
      range: range === "30d" ? undefined : range,
      page: page > 1 ? String(page) : undefined,
      ...patch,
    };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const filtered = Boolean(search || facet !== "all" || range !== "all");
  const firstShown = all.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastShown = (page - 1) * PAGE_SIZE + meetings.length;

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-[var(--content-pad)]">
      {/* HEADER CARD — title + count, the wide search, and the primary. Same band
          as Contacts, so the two list screens read as one system. */}
      <PageShell grow={false} clip={false}>
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
          <PageHeading title="Reuniones" count={headline.total} />
          <MeetingsSearch />
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <UploadMeetingButton clientId={client.id} limits={limits} basePath={base} />
          </span>
        </div>
      </PageShell>

      <PageShell clip={false}>
        {/* THE ONE CONTROL BAND. Left: the four buckets, with counts, plus the
            active range. Right: the two numbers worth a permanent place, then
            Filtrar and Orden. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line-row px-3 py-2">
          <FacetPills
            label="Filtrar reuniones por estado"
            items={[
              { key: "all", label: "Todas", count: headline.total, href: hrefWith({ facet: undefined, page: undefined }), active: facet === "all" },
              { key: "done", label: "Completadas", count: headline.done, href: hrefWith({ facet: "done", page: undefined }), active: facet === "done" },
              {
                key: "processing",
                label: "En proceso",
                count: headline.processing,
                href: hrefWith({ facet: "processing", page: undefined }),
                active: facet === "processing",
              },
              {
                key: "attention",
                label: "Requieren atención",
                count: headline.attention,
                href: hrefWith({ facet: "attention", page: undefined }),
                active: facet === "attention",
              },
            ]}
          />
          <ActiveRangeChip range={range} />

          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* The two headline numbers, inline. Neither is a filter, so neither
                is a pill — they are context, in the same voice as the row meta. */}
            <span className="flex items-center gap-2 text-[0.78125rem] text-muted">
              <span>
                <span className="font-medium text-foreground u-mono">{headline.transcribedLabel}</span> transcritas
              </span>
              {/* «Tareas abiertas» sólo cuando haya de dónde contarlas. Sin
                  almacenamiento de tareas, `openTasks` es null y pintarla
                  dejaba « tareas abiertas» con el número vacío delante: una
                  métrica que parece rota en vez de una que no existe todavía. */}
              {headline.openTasks !== null ? (
                <>
                  <span aria-hidden className="text-faintest">
                    ·
                  </span>
                  <span>
                    <span className="font-medium text-foreground u-mono">{headline.openTasks}</span> tareas abiertas
                  </span>
                </>
              ) : null}
            </span>
            <MeetingsFilterMenu range={range} />
            <MeetingsSortMenu sort={sort} />
          </span>
        </div>

        {meetings.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={filtered ? "Ninguna reunión coincide con estos filtros." : "Todavía no hay reuniones."}
              hint={
                filtered ? (
                  <Link href={base} className="text-accent hover:underline">
                    Quitar los filtros
                  </Link>
                ) : (
                  "Sube una grabación y en unos minutos podrás preguntarle a la reunión, con la cita y el minuto exacto de cada respuesta."
                )
              }
            />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto">
              <MeetingsTable meetings={meetings} detailedIds={meetings.map((m) => m.id)} hrefFor={(id) => `${base}/${id}`} sort={sort} />
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line-row px-4 py-2.5">
              <span className="text-[0.71875rem] text-faint">
                Mostrando {firstShown}–{lastShown} de {headline.total} reuniones
              </span>
              <span className="ml-auto">
                <Pagination page={page} pageCount={pageCount} hrefForPage={(n) => hrefWith({ page: n > 1 ? String(n) : undefined })} />
              </span>
            </div>
          </>
        )}
      </PageShell>
    </main>
  );
}
