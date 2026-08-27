import Link from "next/link";
import type { ContactListItem, PreferredChannel } from "@worker/db/repositories/contacts.js";
import { ContactAvatar } from "@/components/contacts/ContactAvatar";
import { Chip, OwnerDisc, StackedCell, StageChip, VisitsMeter } from "@/components/ui/primitives";
import { channelLabel, sourceLabel } from "@/lib/contactLabels";
import type { ContactColumnKey } from "@/lib/contactColumns";
import { formatStampFull, formatStampShort, relativeAgeShort } from "@/lib/format";

/**
 * THE contacts table, in the redesign's shape (docs/ui-redesign-crm-inbox.md §2.3).
 *
 * WHY THIS IS A GRID AND NOT A `<table>`. The design's row is not a row of single
 * values — three of its seven cells stack two lines (name over email, channel over
 * "hace 2 h"), and one is a meter. `<td>` can hold that, but the column WIDTHS then
 * depend on content: a table lays itself out from its cells, so one long email widens
 * the name column and every other row reflows around it. The design specifies fixed
 * proportions (`minmax(200px,1.7fr) …`), and a grid is the only way to actually honour
 * them. The head and the rows read the SAME template constant, which is what keeps them
 * aligned — two hand-written column lists is how a sticky head drifts one pixel off its
 * body.
 *
 * Semantics are preserved explicitly rather than inherited from the tag: the grid
 * carries `role="table"` / `role="row"` / `role="columnheader"` / `role="cell"`, so a
 * screen reader still announces "column 3 of 7, Origen" the way the `<table>` did.
 *
 * ONE REAL LINK PER ROW. The name is a link stretched over the whole row via
 * `after:absolute after:inset-0`, so the entire 54px band is clickable while the row
 * contributes exactly one tab stop and no JS click handler. Anything that must be
 * separately clickable inside the row (the "+ Agregar email" prompt, the ··· menu)
 * lifts above that overlay with `relative z-10`.
 */

/** The seven columns the design specifies, in order. */
const CORE_TEMPLATE =
  "minmax(200px,1.7fr) minmax(128px,1fr) minmax(92px,0.72fr) minmax(108px,0.86fr) minmax(140px,1fr) 44px 28px";

/**
 * The optional columns keep working, appended after `Dueño`.
 *
 * The design has no `Columnas` control, and taking the default view to exactly seven
 * columns is the point of it. But the six optional columns were a real capability
 * (a shop that works by stage, or watches consent, filters on them), and a redesign
 * should not quietly delete function — so they still render, after the core seven,
 * each at a fixed 1fr. The DEFAULT is the artboard; the extras are opt-in.
 */
const OPTIONAL_TRACK = "minmax(110px,1fr)";

const OPTIONAL_HEAD: Record<ContactColumnKey, string> = {
  channel: "Canal",
  stage: "Stage",
  owner: "Dueño asignado",
  nextAppt: "Próxima cita",
  visits: "Visitas totales",
  consent: "Consentimiento",
  created: "Creado",
  openTasks: "Tareas",
};

export function ContactsTable({
  contacts,
  selectedId,
  ownerName,
  optionalColumns,
  hrefWith,
  now,
}: {
  contacts: ContactListItem[];
  selectedId: string | null;
  /** userId → display name. Built once by the page; never a per-row lookup. */
  ownerName: Map<string, string>;
  optionalColumns: ContactColumnKey[];
  /** Builds a link that preserves the whole facet set — the page owns this. */
  hrefWith: (patch: Record<string, string | undefined>) => string;
  now: Date;
}) {
  // The `···` column sits LAST in the core template, so the extras have to be spliced
  // in before it rather than appended — otherwise the row menu drifts into the middle
  // of the table the moment one optional column is on.
  const coreTracks = CORE_TEMPLATE.split(" ");
  const rowMenuTrack = coreTracks.pop()!;
  const template = [...coreTracks, ...optionalColumns.map(() => OPTIONAL_TRACK), rowMenuTrack].join(
    " ",
  );

  // The meter is relative to THIS PAGE's busiest contact, so the column reads as
  // "who comes in most, of the people I'm looking at". A fixed ceiling would make
  // every bar a sliver for a shop whose regulars have 8 visits, not 80.
  const maxVisits = contacts.reduce((m, c) => Math.max(m, c.visit_count), 0);

  return (
    <div role="table" aria-label="Contactos" className="min-w-[860px]">
      <div
        role="row"
        style={{ gridTemplateColumns: template }}
        className="sticky top-0 z-10 grid h-[38px] items-center gap-2.5 border-b border-line-row bg-surface px-4 text-[0.6875rem] font-semibold tracking-[0.01em] text-muted"
      >
        {/* Sentence-case sans at 590 — NOT the app's older mono-uppercase `u-th`. The
            design moved the table head to the same voice as the panel section headings,
            which is what stops a dense table from reading as a log file. */}
        <span role="columnheader">Nombre</span>
        <span role="columnheader">Teléfono</span>
        <span role="columnheader">Origen</span>
        <span role="columnheader">Visitas</span>
        <span role="columnheader">Última interacción</span>
        <span role="columnheader">Dueño</span>
        {optionalColumns.map((k) => (
          <span key={k} role="columnheader" className="truncate">
            {OPTIONAL_HEAD[k]}
          </span>
        ))}
        {/* The row-menu column has no label; it is announced by its buttons. */}
        <span role="columnheader">
          <span className="sr-only">Acciones</span>
        </span>
      </div>

      {contacts.map((c) => {
        const selected = c.id === selectedId;
        const overdue = c.overdue_task_count > 0;
        const named = Boolean(c.name?.trim());
        return (
          <div
            role="row"
            key={c.id}
            style={{ gridTemplateColumns: template }}
            className={`relative grid h-[54px] items-center gap-2.5 border-b border-line-soft px-4 transition-colors last:border-b-0 ${
              // The SELECTED row is one step darker — no tint, no left rule. The design
              // makes selection a change of GROUND rather than a coloured marker,
              // because the panel that opens beside it is already the loud signal that
              // something is selected; a red bar as well read as an alert.
              selected ? "bg-chip" : "hover:bg-subtle"
            } ${overdue ? "u-row-overdue" : ""}`}
          >
            {/* ── Nombre: sphere + name over email ── */}
            <span role="cell" className="flex min-w-0 items-center gap-2.5">
              <ContactAvatar name={c.name} fallback={c.channel_user_id} />
              <span className="flex min-w-0 flex-col gap-px">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Link
                    href={hrefWith({ c: c.id })}
                    scroll={false}
                    aria-current={selected ? "true" : undefined}
                    className={`truncate text-[0.8125rem] tracking-[-0.01em] text-foreground no-underline after:absolute after:inset-0 after:content-[''] hover:underline focus-visible:underline ${
                      named ? "" : "u-mono"
                    }`}
                  >
                    {c.name?.trim() || c.channel_user_id}
                  </Link>
                  {/* A contact who opted out must be visible as such ANYWHERE someone
                      might decide to message them — so this rides the name, not an
                      optional column that can be switched off. */}
                  {c.messaging_consent === "opted_out" ? (
                    <Chip tone="muted" title="Este contacto rechazó la mensajería">
                      no contactar
                    </Chip>
                  ) : null}
                </span>
                {/* The email is the second line. An EMPTY one is a prompt that does the
                    thing — it opens this contact's panel with the edit dialog already
                    up — so it lifts above the row's stretched link. */}
                {c.email ? (
                  <span className="truncate text-[0.6875rem] text-faint">{c.email}</span>
                ) : (
                  <Link
                    href={hrefWith({ c: c.id, edit: "1" })}
                    scroll={false}
                    className="relative z-10 w-fit text-[0.6875rem] text-faint hover:text-foreground hover:underline"
                  >
                    + Agregar email
                  </Link>
                )}
              </span>
            </span>

            {/* ── Teléfono ── */}
            <span role="cell" className="min-w-0">
              {c.phone_e164 ? (
                <span className="u-mono block truncate text-[0.8125rem] text-muted">
                  {c.phone_e164}
                </span>
              ) : (
                <Link
                  href={hrefWith({ c: c.id, edit: "1" })}
                  scroll={false}
                  className="relative z-10 text-[0.75rem] text-faint hover:text-foreground hover:underline"
                >
                  + Agregar número
                </Link>
              )}
            </span>

            {/* ── Origen: how they first arrived. Plain text, no chip — the design keeps
                   this column quiet because it is context, not state. ── */}
            <span role="cell" className="truncate text-[0.8125rem] text-muted">
              {sourceLabel(c.channel)}
            </span>

            {/* ── Visitas ── */}
            <span role="cell" className="min-w-0">
              <VisitsMeter value={c.visit_count} max={maxVisits} />
            </span>

            {/* ── Última interacción: the channel we'd reach them on, over how long ago
                   we last heard from them. Two facts that are only useful together. ── */}
            <span role="cell" className="min-w-0">
              <StackedCell
                primary={
                  c.last_channel ? (
                    channelLabel(c.last_channel as PreferredChannel)
                  ) : (
                    <span className="text-faint">—</span>
                  )
                }
                secondary={
                  <span title={formatStampFull(c.last_contact_at)}>
                    {relativeAgeShort(c.last_contact_at, now)}
                  </span>
                }
              />
            </span>

            {/* ── Dueño ── */}
            <span role="cell">
              <OwnerDisc name={c.assigned_to ? ownerName.get(c.assigned_to) ?? null : null} />
            </span>

            {/* ── The opt-in extras ── */}
            {optionalColumns.map((k) => (
              <span key={k} role="cell" className="min-w-0 truncate text-[0.8125rem] text-muted">
                <OptionalCell column={k} contact={c} ownerName={ownerName} now={now} />
              </span>
            ))}

            {/* ── Row menu. A LINK to the contact's record rather than a popover: the
                   design draws a `···` affordance and every action behind it (edit,
                   book, note, merge) already lives on the record and the panel, so a
                   third copy of that menu would be a third place to keep in sync. ── */}
            <span role="cell" className="text-right">
              <Link
                href={`/contacts/${c.id}`}
                aria-label={`Abrir la ficha de ${c.name?.trim() || c.channel_user_id}`}
                className="relative z-10 inline-flex size-6 items-center justify-center rounded-sm text-xs text-faint no-underline transition-colors hover:bg-subtle hover:text-foreground"
              >
                ···
              </Link>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One optional cell's content. Kept beside the head map so the two cannot drift. */
function OptionalCell({
  column,
  contact: c,
  ownerName,
  now,
}: {
  column: ContactColumnKey;
  contact: ContactListItem;
  ownerName: Map<string, string>;
  now: Date;
}) {
  switch (column) {
    case "channel":
      return <>{sourceLabel(c.channel)}</>;
    case "stage":
      return <StageChip stage={c.stage} />;
    case "owner":
      return <>{c.assigned_to ? ownerName.get(c.assigned_to) ?? "—" : "—"}</>;
    case "nextAppt":
      return c.next_appointment_at ? (
        <span className="u-mono text-foreground" title={formatStampFull(c.next_appointment_at)}>
          {formatStampShort(c.next_appointment_at)}
        </span>
      ) : (
        <span className="text-faint">—</span>
      );
    case "visits":
      return <span className="u-mono">{c.appointment_count}</span>;
    case "consent":
      return <>{c.messaging_consent.replace("_", " ")}</>;
    case "created":
      return (
        <span title={formatStampFull(c.created_at)}>{relativeAgeShort(c.created_at, now)}</span>
      );
    case "openTasks":
      return (
        <span className={`u-mono ${c.open_task_count > 0 ? "text-foreground" : "text-faint"}`}>
          {c.open_task_count}
        </span>
      );
  }
}
