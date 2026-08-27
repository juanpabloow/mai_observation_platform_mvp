"use client";

import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import type { ContactPanelData } from "@/lib/contactPanel";
import { ContactAvatar } from "@/components/contacts/ContactAvatar";
import { BOOK_CLS, SectionHeading, TOOLBAR_PRIMARY_CLS } from "@/components/ui/primitives";
import { IconPlus } from "@/components/ui/icons";
import { channelLabel } from "@/lib/contactLabels";
import { relativeAgeShort } from "@/lib/format";
import { AppointmentsSection } from "@/components/contacts/shared/AppointmentsSection";
import { TasksSection } from "@/components/contacts/shared/TasksSection";
import { NotesSection } from "@/components/contacts/shared/NotesSection";
import { TagsSection } from "@/components/contacts/shared/TagsSection";
import { linkConversationContactAction } from "@/lib/inboxContactActions";

/**
 * The inbox CUSTOMER PANEL (C-4) — the moment the platform's promise becomes visible:
 * an agent replying in chat sees who the person is and when they are next coming in,
 * without leaving the thread. A COMPACT variant assembled from the SAME shared
 * components as the record's left column + rail (identity summary, next appointment,
 * open tasks, recent notes + composer, tags) — not a parallel implementation.
 *
 * It loads the contact linked to the open conversation from a session-authed route
 * (client-scoped; re-validated server-side). When the conversation has NO linked contact,
 * it offers to link/create one through C-2's identity chokepoint
 * (linkConversationContactAction) so the channel identity attaches without a duplicate.
 */

interface PanelResponse {
  contactId: string | null;
  panel?: ContactPanelData;
  schedulingEnabled: boolean;
}

export function CustomerDetailsPanel({
  clientId,
  conversationId,
  conversationRef,
  viewerUserId,
  viewerIsFullAccess,
  onClose,
}: {
  clientId: string;
  conversationId: string;
  conversationRef: string;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onClose?: () => void;
}) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; data?: PanelResponse }>({ status: "loading" });
  const [linking, startLink] = useTransition();
  const [linkErr, setLinkErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox/${clientId}/conversations/${conversationId}/contact`, { cache: "no-store" });
      if (!res.ok) {
        setState({ status: "error" });
        return;
      }
      setState({ status: "ready", data: (await res.json()) as PanelResponse });
    } catch {
      setState({ status: "error" });
    }
  }, [clientId, conversationId]);

  // The workspace keys this component by conversation id, so it remounts (fresh
  // "loading" state) on selection change. load()'s setState runs only AFTER the fetch
  // await (the sanctioned async pattern) — the rule can't see past the callback.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState is async (post-fetch), not a sync cascade
    void load();
  }, [load]);

  const link = () => {
    setLinkErr(null);
    startLink(async () => {
      const r = await linkConversationContactAction(clientId, conversationId);
      if (!r.ok) setLinkErr(r.error);
      else await load();
    });
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* h-14 — aligned with the queue header, the thread header and the app header. */}
      <div className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-[0.875rem] font-semibold tracking-[-0.01em] text-foreground">Cliente</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar los datos del cliente"
            className="u-tap flex size-[22px] items-center justify-center rounded-sm text-xs text-faint transition-colors hover:bg-subtle hover:text-foreground"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <p className="px-4 py-4 text-sm text-faint">Cargando…</p>
        ) : state.status === "error" ? (
          <p className="px-4 py-4 text-sm text-faint">No se pudieron cargar los datos del contacto.</p>
        ) : state.data && state.data.contactId && state.data.panel ? (
          <Ready
            clientId={clientId}
            contactId={state.data.contactId}
            data={state.data.panel}
            schedulingEnabled={state.data.schedulingEnabled}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
            onChanged={load}
          />
        ) : (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div>
              <p className="text-sm font-medium text-foreground">Sin contacto vinculado</p>
              <p className="mt-0.5 text-sm text-faint">
                Esta conversación (
                <span className="u-mono break-all text-xs">{conversationRef}</span>) todavía no
                está vinculada a un contacto.
              </p>
            </div>
            <button
              type="button"
              onClick={link}
              disabled={linking}
              className={`w-fit ${TOOLBAR_PRIMARY_CLS}`}
            >
              {linking ? "Vinculando…" : "Vincular contacto"}
            </button>
            {linkErr ? <span className="text-xs text-danger">{linkErr}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Ready({
  clientId,
  contactId,
  data,
  schedulingEnabled,
  viewerUserId,
  viewerIsFullAccess,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  data: ContactPanelData;
  schedulingEnabled: boolean;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onChanged: () => void;
}) {
  const primaryIdentity = data.identities[0]?.value ?? null;
  const apptTotal = data.appointments.upcoming.length + data.appointments.past.length;
  // "hace 4 d la última" — the most recent appointment that has already happened. Derived
  // from the list the panel already holds rather than asked for separately: `past` is
  // every appointment behind us, so the newest of those IS the last visit.
  const lastVisitAt = data.appointments.past.reduce<string | null>(
    (latest, a) => (latest === null || a.startAt > latest ? a.startAt : latest),
    null,
  );
  const preferredChannel = data.summary.preferredChannel ?? null;

  return (
    <div className="flex flex-col">
      {/*
        ── IDENTITY (§3.5.2) ──
        LEFT-aligned, not centred. The panel used to stack a centred disc over a centred
        name, which reads as a profile card; this is a working surface beside a live
        conversation, so the design puts the identity on one line and gives the vertical
        space back to the content underneath.
      */}
      <div className="flex flex-col gap-2.5 px-4 pb-3 pt-3">
        <div className="flex items-center gap-2.5">
          <ContactAvatar
            name={data.summary.displayName}
            fallback={primaryIdentity ?? data.summary.displayName}
            size={38}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate text-[0.9375rem] tracking-[-0.015em] text-foreground">
                {data.summary.displayName}
              </span>
              <Link
                href={`/clients/${clientId}/contacts/${contactId}`}
                className="ml-auto shrink-0 text-[0.71875rem] text-brand no-underline hover:underline"
              >
                Ficha ↗
              </Link>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              {primaryIdentity ? (
                <span className="u-mono truncate text-[0.71875rem] text-muted">{primaryIdentity}</span>
              ) : null}
              {preferredChannel ? (
                <>
                  <span aria-hidden className="text-faintest">·</span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-[0.71875rem] text-muted">
                    <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
                    {channelLabel(preferredChannel)}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── ACTIONS (§3.5.3). `Agendar cita` is the ONE red button in this panel — see
               the note on --ink in globals.css for why nothing else here is. ── */}
        {schedulingEnabled ? (
          <div className="flex items-center gap-1.5">
            <Link
              href={`/clients/${clientId}/scheduling/agenda?book=${contactId}`}
              className={`flex-1 justify-center ${BOOK_CLS}`}
            >
              <IconPlus />
              Agendar cita
            </Link>
            <Link
              href={`/clients/${clientId}/contacts/${contactId}`}
              aria-label="Más acciones sobre este contacto"
              title="Más acciones"
              className="inline-flex h-8 w-[34px] shrink-0 items-center justify-center rounded-md border border-line-strong text-muted no-underline transition-colors hover:border-faint hover:text-foreground"
            >
              ···
            </Link>
          </div>
        ) : null}
      </div>

      {/*
        ── THE STAT STRIP (§3.5.4) ──
        Three numbers on one tinted band: how often they come, how often they don't, and
        how long since. They belong together — "14 visitas · 1 no-show" is a judgement
        about a person that neither number makes alone — and the design bands them so they
        read as one sentence rather than three tiles.
        The no-show count goes WARN only when it is non-zero: "0 no-shows" must not shout.
      */}
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 border-y border-line bg-panel-hero px-4 py-2.5">
        <Stat value={data.summary.visitCount} label={data.summary.visitCount === 1 ? "visita" : "visitas"} />
        <span aria-hidden className="text-faintest">·</span>
        <Stat
          value={data.summary.noShowCount}
          label={data.summary.noShowCount === 1 ? "no-show" : "no-shows"}
          tone={data.summary.noShowCount > 0 ? "warn" : undefined}
        />
        {lastVisitAt ? (
          <>
            <span aria-hidden className="text-faintest">·</span>
            <Stat value={relativeAgeShort(lastVisitAt)} label="la última" />
          </>
        ) : null}
      </div>

      {schedulingEnabled ? (
        <Section
          title="Próxima cita"
          trailing={
            apptTotal > 0 ? (
              <Link
                href={`/clients/${clientId}/contacts/${contactId}`}
                className="text-inherit no-underline hover:text-foreground"
              >
                {apptTotal} en total →
              </Link>
            ) : undefined
          }
        >
          <AppointmentsSection
            clientId={clientId}
            appointments={data.appointments}
            onChanged={onChanged}
            showHistory={false}
          />
        </Section>
      ) : null}

      <Section title="Tareas abiertas">
        <TasksSection
          clientId={clientId}
          contactId={contactId}
          tasks={data.openTasks}
          assignableMembers={[]}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
        />
      </Section>

      <Section title="Notas">
        <NotesSection
          clientId={clientId}
          contactId={contactId}
          notes={data.recentNotes}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
          dense
        />
      </Section>

      <Section title="Etiquetas">
        <TagsSection
          clientId={clientId}
          contactId={contactId}
          tags={data.tags}
          catalogue={[]}
          canManageCatalog={viewerIsFullAccess}
          onChanged={onChanged}
        />
      </Section>
    </div>
  );
}

/** One number-plus-noun in the stat strip. The NUMBER is the content; the noun labels it. */
function Stat({
  value,
  label,
  tone,
}: {
  value: number | string;
  label: string;
  tone?: "warn";
}) {
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span
        className={`text-[0.8125rem] font-semibold tracking-[-0.01em] ${
          tone === "warn" ? "text-warn" : "text-foreground"
        }`}
      >
        {value}
      </span>
      <span className="text-[0.71875rem] text-faint">{label}</span>
    </span>
  );
}

/**
 * One section of the panel: the shared heading, the content, closed by a full-width rule.
 *
 * `SectionHeading` rather than a local label constant — this panel used to define its own
 * `SECTION_LABEL` string, which is exactly how the inbox's headings and the contact
 * panel's headings ended up as two different sizes of the same idea.
 */
function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-b border-line px-4 py-3 last:border-b-0">
      <SectionHeading title={title} trailing={trailing} />
      {children}
    </section>
  );
}
