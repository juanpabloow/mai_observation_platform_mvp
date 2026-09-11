import Link from "next/link";
import { ENTITY_ROW_CLS, TABLE_HEADER_CLS } from "@/components/ui/primitives";
import { AvatarStack, SourceLine, StatusCell } from "@/components/reuniones/MeetingBits";
import { MeetingActionsMenu } from "@/components/reuniones/MeetingDeletion";
import type { MeetingListItem } from "@/lib/meetingsData";

/**
 * The Reuniones list, in the SAME shape as the Contacts table.
 *
 * A grid rather than a `<table>` for the same reason Contacts is one: two of the
 * cells stack two lines (title over source, status over its progress bar), so
 * `<td>` widths would be content-derived and one long filename would reflow the
 * whole column. ARIA table roles keep the semantics the tag would have given.
 *
 * ONE REAL LINK PER ROW — the title, stretched over the row with
 * `after:absolute after:inset-0`. The row-menu button lifts above it.
 *
 * Rows WITHOUT a detail fixture are not links: a row that navigates to a 404 is
 * worse than a row that plainly does not navigate yet.
 */
const TEMPLATE =
  "minmax(220px,1.8fr) minmax(120px,0.9fr) 84px minmax(104px,0.7fr) minmax(180px,1.2fr) 56px 68px minmax(90px,0.7fr) 28px";

export function MeetingsTable({
  meetings,
  detailedIds,
  hrefFor,
  sort = "recent",
}: {
  meetings: MeetingListItem[];
  /** Ids that have a detail screen — only those rows link. */
  detailedIds: readonly string[];
  hrefFor: (id: string) => string;
  /** Which column the list is ordered by, so the head can say so. */
  sort?: "recent" | "oldest" | "longest";
}) {
  // The arrow marks the SORTED column and its direction — the sort control names
  // it in words too, so this is a reinforcement, not the only signal.
  const sortIndicator =
    sort === "longest" ? null : (
      <span aria-hidden className="text-faint">
        {sort === "recent" ? "\u2304" : "\u2303"}
      </span>
    );
  return (
    <div role="table" aria-label="Reuniones" className="min-w-[1000px]">
      <div role="row" style={{ gridTemplateColumns: TEMPLATE }} className={`sticky top-0 z-10 grid bg-surface ${TABLE_HEADER_CLS}`}>
        {/* Mono uppercase (`u-th`) — the sheet's column voice. NOTE: Contacts
            uses sentence case for its head; if the two screens should agree,
            this is the one line to change. */}
        <span role="columnheader" className="u-th">
          Reunión
        </span>
        <span role="columnheader" className="u-th">
          Fecha y hora {sortIndicator}
        </span>
        <span role="columnheader" className="u-th">
          Duración
        </span>
        <span role="columnheader" className="u-th">
          Participantes
        </span>
        <span role="columnheader" className="u-th">
          Estado
        </span>
        <span role="columnheader" className="u-th text-right">
          Tareas
        </span>
        <span role="columnheader" className="u-th text-right">
          Reportes
        </span>
        <span role="columnheader" className="u-th">
          Actualizado
        </span>
        <span role="columnheader">
          <span className="sr-only">Acciones</span>
        </span>
      </div>

      {meetings.map((m) => {
        const linked = detailedIds.includes(m.id);
        return (
          <div
            role="row"
            key={m.id}
            style={{ gridTemplateColumns: TEMPLATE }}
            className={`relative grid ${ENTITY_ROW_CLS} ${linked ? "hover:bg-subtle" : ""}`}
          >
            <span role="cell" className="flex min-w-0 flex-col gap-px">
              {linked ? (
                <Link
                  href={hrefFor(m.id)}
                  className="truncate text-[0.8125rem] font-medium tracking-[-0.01em] text-foreground no-underline after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline"
                >
                  {m.title}
                </Link>
              ) : (
                <span className="truncate text-[0.8125rem] font-medium tracking-[-0.01em] text-foreground" title={m.title}>
                  {m.title}
                </span>
              )}
              {/* A failed meeting says WHY on the second line, in brand red — it is
                  the row's most useful fact, not its filename. */}
              {m.status.kind === "failed" ? (
                <span className="truncate text-[0.71875rem] text-brand">{m.status.reason}</span>
              ) : (
                <SourceLine source={m.source} />
              )}
            </span>

            <span role="cell" className="truncate text-[0.78125rem] text-muted">
              {m.when}
            </span>
            <span role="cell" className="text-[0.75rem] text-muted u-mono">
              {m.duration ?? "—"}
            </span>
            <span role="cell">
              <AvatarStack people={m.participants} extra={m.extraParticipants} />
            </span>
            <span role="cell" className="min-w-0">
              <StatusCell status={m.status} retryHref={m.status.kind === "failed" ? "#" : undefined} />
            </span>
            <span role="cell" className="text-right text-[0.75rem] text-foreground u-mono">
              {m.tasks ?? "—"}
            </span>
            <span role="cell" className="text-right text-[0.75rem] text-foreground u-mono">
              {m.reports ?? "—"}
            </span>
            <span role="cell" className="truncate text-[0.78125rem] text-muted">
              {m.updated}
            </span>
            <span role="cell" className="relative z-10 flex justify-end">
              {/* EL MISMO menú y EL MISMO diálogo que la ficha: el proveedor de
                  arriba guarda la reunión pendiente y renderiza una sola
                  instancia del diálogo para toda la pantalla. */}
              <MeetingActionsMenu meeting={m} size={7} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
