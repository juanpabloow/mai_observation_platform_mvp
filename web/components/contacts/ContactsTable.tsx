import Link from "next/link";
import type { CSSProperties } from "react";
import type { ContactListItem, PreferredChannel } from "@worker/db/repositories/contacts.js";
import { ContactAvatar } from "@/components/contacts/ContactAvatar";
import { Chip, ENTITY_ROW_CLS, OwnerDisc, StackedCell, StageChip, TABLE_HEADER_CLS, VisitsMeter } from "@/components/ui/primitives";
import { channelLabel, sourceLabel } from "@/lib/contactLabels";
import { originColumnChip, originColumnDetail } from "@/lib/originDisplay";
import { STAGE_LABEL, STATUS_LABEL } from "@/lib/pipelineBoard";
import type { ContactColumnKey } from "@/lib/contactColumns";
import { formatStampFull, formatStampShort, relativeAgeShort } from "@/lib/format";
import { CORE_TEMPLATE, TABLET_TEMPLATE, mobileRowLines, withOptionalTracks } from "@/lib/contactListLayout";
import { displayContactName, isMeaningfulName } from "@/lib/contactName";

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
 * separately clickable inside the row (the "+ Agregar email" prompt, the → record link)
 * lifts above that overlay with `relative z-10`.
 */

/**
 * The optional columns keep working, appended after `Dueño`.
 *
 * The design has no `Columnas` control, and taking the default view to exactly seven
 * columns is the point of it. But the six optional columns were a real capability
 * (a shop that works by stage, or watches consent, filters on them), and a redesign
 * should not quietly delete function — so they still render, after the core seven,
 * each at a fixed 1fr. The DEFAULT is the artboard; the extras are opt-in.
 */
const OPTIONAL_HEAD: Record<ContactColumnKey, string> = {
  channel: "Canal",
  stage: "Etapa",
  pipeline: "Pipeline",
  owner: "Dueño asignado",
  nextAppt: "Próxima cita",
  visits: "Visitas totales",
  consent: "Consentimiento",
  created: "Creado",
  openTasks: "Tareas",
};

/**
 * The Origen cell: the AT-1 attribution origin as a chip (Anuncio accent, the rest neutral) over a
 * quiet detail line (ad name · campaign; "Anuncio de prueba" for a test ad; "WhatsApp" / "Reservado
 * por otra persona"; etc.). When the viewer can't see origin (staff), it falls back to the channel.
 */
function OriginCell({ c, canSeeOrigin }: { c: ContactListItem; canSeeOrigin: boolean }) {
  if (!canSeeOrigin) {
    return <span className="truncate text-[0.8125rem] text-muted">{sourceLabel(c.channel)}</span>;
  }
  const chip = originColumnChip(c.origin_kind);
  const detail = originColumnDetail({
    originKind: c.origin_kind,
    adName: c.origin_ad_name,
    adHeadline: c.origin_ad_headline,
    adIsTest: c.origin_ad_is_test,
    campaignName: c.origin_campaign_name,
  });
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[0.625rem] font-medium ${chip.tone}`}>{chip.label}</span>
      {detail ? (
        <span className="truncate text-[0.6875rem] text-faint" title={detail}>{detail}</span>
      ) : null}
    </span>
  );
}

export function ContactsTable({
  clientId,
  contacts,
  selectedId,
  ownerName,
  optionalColumns,
  hrefWith,
  now,
  canSeeOrigin,
  sort,
}: {
  /** The VALIDATED client the page resolved — every link out of a row stays inside it. */
  clientId: string;
  contacts: ContactListItem[];
  selectedId: string | null;
  /** userId → display name. Built once by the page; never a per-row lookup. */
  ownerName: Map<string, string>;
  optionalColumns: ContactColumnKey[];
  /** Builds a link that preserves the whole facet set — the page owns this. */
  hrefWith: (patch: Record<string, string | undefined>) => string;
  now: Date;
  /** Same visibility as the contact's Origen card: agency/owner/setter yes, staff no. When false
   *  the column falls back to the free-text channel (staff never reach this list in practice). */
  canSeeOrigin: boolean;
  /** Active sort, for the Origen column's aria-sort. */
  sort: "recent" | "origin";
}) {
  // The record-link (→) column sits LAST in the core template, so the extras have to be spliced
  // in before it rather than appended — otherwise the row menu drifts into the middle
  // of the table the moment one optional column is on.
  // Desktop and tablet templates as CSS variables, picked by breakpoint (see
  // lib/contactListLayout): an inline `gridTemplateColumns` cannot be responsive.
  const gridVars = {
    "--contacts-tpl": withOptionalTracks(CORE_TEMPLATE, optionalColumns.length),
    "--contacts-tpl-md": withOptionalTracks(TABLET_TEMPLATE, optionalColumns.length),
  } as CSSProperties;
  const GRID = "grid [grid-template-columns:var(--contacts-tpl-md)] lg:[grid-template-columns:var(--contacts-tpl)]";

  // The meter is relative to THIS PAGE's busiest contact, so the column reads as
  // "who comes in most, of the people I'm looking at". A fixed ceiling would make
  // every bar a sliver for a shop whose regulars have 8 visits, not 80.
  const maxVisits = contacts.reduce((m, c) => Math.max(m, c.visit_count), 0);

  return (
    <>
    {/* ── PHONE (< md): one compact row per contact. The table below is hidden here —
           it measured 860px inside a 345px card at 390. Same links as the table: the row
           opens the quick view (`?c=`), the arrow opens the full record. ── */}
    <ul aria-label="Contactos" className="md:hidden">
      {contacts.map((c) => {
        const selected = c.id === selectedId;
        const lines = mobileRowLines(c);
        const overdue = c.overdue_task_count > 0;
        return (
          <li
            key={c.id}
            className={`relative flex min-h-[72px] items-center gap-3 border-b border-line-soft py-2.5 pl-4 pr-1 last:border-b-0 ${selected ? "bg-chip" : ""}`}
          >
            <ContactAvatar name={lines.titleIsId ? null : c.name} fallback={c.channel_user_id} size={38} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <Link
                  href={hrefWith({ c: c.id })}
                  scroll={false}
                  aria-current={selected ? "true" : undefined}
                  className={`u-focus truncate text-[15px] font-medium tracking-[-0.01em] text-foreground no-underline after:absolute after:inset-0 after:content-[''] ${
                    lines.titleIsId ? "u-mono" : ""
                  }`}
                >
                  {lines.title}
                </Link>
                {c.messaging_consent === "opted_out" ? (
                  <Chip tone="muted" title="Este contacto rechazó la mensajería">
                    no contactar
                  </Chip>
                ) : null}
                {overdue ? (
                  <Chip tone="warn" title={`${c.overdue_task_count} tarea(s) vencida(s) para este contacto`}>
                    {c.overdue_task_count === 1 ? "1 vencida" : `${c.overdue_task_count} vencidas`}
                  </Chip>
                ) : null}
              </span>
              <span className={`truncate text-[13px] ${lines.identityKind === "phone" ? "u-mono text-muted" : lines.identityKind === "email" ? "text-muted" : "text-faint"}`}>
                {lines.identity}
              </span>
              <span className="truncate text-xs text-faint">
                {canSeeOrigin ? originColumnChip(c.origin_kind).label : sourceLabel(c.channel)} ·{" "}
                <span title={formatStampFull(c.last_contact_at)}>{relativeAgeShort(c.last_contact_at, now)}</span>
              </span>
            </span>
            <Link
              href={`/clients/${clientId}/contacts/${c.id}`}
              aria-label={`Abrir la ficha de ${lines.title}`}
              title="Abrir la ficha"
              className="u-focus relative z-10 inline-flex size-[44px] shrink-0 items-center justify-center rounded-sch-control text-base text-faint no-underline transition-colors hover:bg-subtle hover:text-foreground"
            >
              <span aria-hidden>→</span>
            </Link>
          </li>
        );
      })}
    </ul>

    <div role="table" aria-label="Contactos" style={gridVars} className="hidden md:block md:min-w-[680px] lg:min-w-[860px]">
      <div
        role="row"
        className={`sticky top-0 z-10 ${GRID} bg-surface ${TABLE_HEADER_CLS}`}
      >
        {/* Sentence-case sans at 590 — NOT the app's older mono-uppercase `u-th`. The
            design moved the table head to the same voice as the panel section headings,
            which is what stops a dense table from reading as a log file. */}
        <span role="columnheader">Nombre</span>
        <span role="columnheader">Teléfono</span>
        <span role="columnheader" aria-sort={sort === "origin" ? "ascending" : undefined}>Origen</span>
        <span role="columnheader" className="max-lg:hidden">Visitas</span>
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
        const named = isMeaningfulName(c.name);
        // The shared display name (real name → masked phone → "Sin nombre"), same as the board.
        const display = displayContactName({ name: c.name, phoneE164: c.phone_e164, channelUserId: c.channel_user_id });
        return (
          <div
            role="row"
            key={c.id}
            className={`relative ${GRID} ${ENTITY_ROW_CLS} ${
              // SELECTION IS THE ONLY THING THAT CHANGES A ROW'S GROUND — one step
              // darker, no tint, no left rule. The panel that opens beside it is already
              // the loud signal; a coloured bar as well read as an alert.
              //
              // An overdue task used to paint the row too (`.u-row-overdue`: an amber
              // wash + a 2px amber rule). Two different meanings were competing for the
              // same channel, and the wash lost: a tinted row with a left bar reads as
              // "you are hovering this" or "this one is open", not as "this person has a
              // late task". It moved to a chip on the name — see below.
              selected ? "bg-chip" : "hover:bg-subtle"
            }`}
          >
            {/* ── Nombre: sphere + name over email ── */}
            <span role="cell" className="flex min-w-0 items-center gap-2.5">
              <ContactAvatar name={named ? c.name : null} fallback={c.channel_user_id} />
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
                    {display}
                  </Link>
                  {/* A contact who opted out must be visible as such ANYWHERE someone
                      might decide to message them — so this rides the name, not an
                      optional column that can be switched off. */}
                  {c.messaging_consent === "opted_out" ? (
                    <Chip tone="muted" title="Este contacto rechazó la mensajería">
                      no contactar
                    </Chip>
                  ) : null}
                  {/* LATE TASKS, as a chip rather than as a wash over the whole row. It
                      carries its own TEXT and its own count, so it survives greyscale
                      outright instead of depending on a colour plus a rule — and it sits
                      on the name, where the other fact about this person that changes
                      what you do next already lives. */}
                  {overdue ? (
                    <Chip tone="warn" title={`${c.overdue_task_count} tarea(s) vencida(s) para este contacto`}>
                      {c.overdue_task_count === 1 ? "1 vencida" : `${c.overdue_task_count} vencidas`}
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

            {/* ── Origen: the AT-1 attribution origin (a chip + a quiet detail line), gated like
                   the contact's Origen card. Falls back to the free-text channel when not visible. ── */}
            <span role="cell" className="min-w-0">
              <OriginCell c={c} canSeeOrigin={canSeeOrigin} />
            </span>

            {/* ── Visitas (desktop only; the record keeps the figure) ── */}
            <span role="cell" className="min-w-0 max-lg:hidden">
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

            {/* ── Open the record. A LINK to the contact's full record rather than a
                   popover: every action (edit, book, note, merge) already lives on the
                   record and the panel, so a third copy of a menu would be a third place
                   to keep in sync. It used to wear `···`, which promises a menu it never
                   opened, and pointed at the legacy /contacts/{id} — a detour through
                   the no-client shell ("Elige un cliente") before the redirect landed.
                   The arrow is the app's "go to" mark ("Ver en la agenda →"). ── */}
            <span role="cell" className="text-right">
              <Link
                href={`/clients/${clientId}/contacts/${c.id}`}
                aria-label={`Abrir la ficha de ${display}`}
                title="Abrir la ficha"
                className="relative z-10 inline-flex size-6 items-center justify-center rounded-sm text-xs text-faint no-underline transition-colors hover:bg-subtle hover:text-foreground max-lg:size-[44px] max-lg:text-sm"
              >
                <span aria-hidden>→</span>
              </Link>
            </span>
          </div>
        );
      })}
    </div>
    </>
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
    case "pipeline":
      return c.pipeline_stage ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[0.625rem] font-medium text-foreground">
          {STAGE_LABEL[c.pipeline_stage]}
          {c.pipeline_status && c.pipeline_status !== "open" ? <span className="font-normal text-faint">· {STATUS_LABEL[c.pipeline_status]}</span> : null}
        </span>
      ) : (
        <span className="text-faint">—</span>
      );
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
