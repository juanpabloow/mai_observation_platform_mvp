"use client";

import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import type { ContactPanelData } from "@/lib/contactPanel";
import { SectionHeading } from "@/components/ui/primitives";
import { channelLabel } from "@/lib/contactLabels";
import { AppointmentsSection } from "@/components/contacts/shared/AppointmentsSection";
import { TasksSection } from "@/components/contacts/shared/TasksSection";
import { NotesSection } from "@/components/contacts/shared/NotesSection";
import { TagsSection } from "@/components/contacts/shared/TagsSection";
import { linkConversationContactAction } from "@/lib/inboxContactActions";
import { formatConversationRef } from "@/lib/inboxView";
import { avatarText, isPhoneRef } from "@/lib/inboxPresent";
import { BTN_PRIMARY, BTN_SECONDARY, IconBack, IconClose, InboxAvatar } from "./inbox/InboxUi";

/**
 * The inbox CUSTOMER CARD — "Ficha del cliente" (frames 1e / 2g / 3e).
 *
 * Compact, top to bottom: identity (name · channel · workflow), the phone — or the channel
 * ID in monospace when there is no phone (it is never presented as a number) — "Agendar
 * cita" + "Abrir contacto", the NEXT APPOINTMENT card with visits and no-shows, then tasks,
 * notes and tags as sections whose "+" opens the form: no permanent empty forms.
 *
 * The disc is the inbox's own (InboxAvatar, keyed by the conversation identifier), so one
 * person wears one disc across the queue, the thread and this card.
 *
 * Built from the SAME shared components as the contact record (C-4): AppointmentsSection
 * (kept behind "Gestionar citas", so cancel/reschedule from the inbox still work),
 * TasksSection, NotesSection, TagsSection — opened in their CONTROLLED mode from the "+".
 * The contact loads from the session-authed, client-scoped route; when the conversation has
 * no linked contact it offers to link one through C-2's identity chokepoint.
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
  workflowName = null,
  viewerUserId,
  viewerIsFullAccess,
  onClose,
}: {
  clientId: string;
  conversationId: string;
  conversationRef: string;
  workflowName?: string | null;
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

  const identityLine = isPhoneRef(conversationRef) ? (
    <IdentityRow label="Teléfono" value={formatConversationRef(conversationRef)} />
  ) : (
    <IdentityRow label="ID de canal" value={conversationRef} mono />
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex h-[var(--topbar-height)] min-h-14 shrink-0 items-center gap-1 border-b border-line px-2 md:px-4">
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Volver a la conversación" className="inline-flex size-11 items-center justify-center rounded-full hover:bg-subtle md:hidden">
            <IconBack />
          </button>
        ) : null}
        <h2 className="flex-1 text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">Ficha del cliente</h2>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Cerrar la ficha del cliente" className="hidden size-9 items-center justify-center rounded-lg text-muted hover:bg-subtle hover:text-foreground md:inline-flex">
            <IconClose />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {state.status === "loading" ? (
          <div className="flex flex-col gap-3 px-4 py-4" aria-busy="true" aria-label="Cargando la ficha">
            <span className="h-10 w-2/3 animate-pulse rounded-lg bg-chip" />
            <span className="h-24 animate-pulse rounded-xl bg-chip" />
          </div>
        ) : state.status === "error" ? (
          <div className="flex flex-col items-start gap-2 px-4 py-4">
            <p className="text-sm text-muted">No se pudieron cargar los datos del contacto.</p>
            <button type="button" onClick={() => void load()} className={BTN_SECONDARY}>
              Reintentar
            </button>
          </div>
        ) : state.data && state.data.contactId && state.data.panel ? (
          <Ready
            clientId={clientId}
            contactId={state.data.contactId}
            data={state.data.panel}
            schedulingEnabled={state.data.schedulingEnabled}
            workflowName={workflowName}
            identityLine={identityLine}
            conversationRef={conversationRef}
            viewerUserId={viewerUserId}
            viewerIsFullAccess={viewerIsFullAccess}
            onChanged={load}
          />
        ) : (
          <div className="flex flex-col gap-3 px-4 py-4">
            <div className="flex items-center gap-3">
              <InboxAvatar text={avatarText(null, conversationRef)} toneKey={conversationRef} size={40} />
              <div className="flex min-w-0 flex-col">
                <span className="text-[1.0625rem] font-semibold text-foreground">Contacto sin nombre</span>
                <span className="truncate text-xs text-muted">{["WhatsApp", workflowName].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
            {identityLine}
            <p className="text-sm text-muted">Esta conversación todavía no está vinculada a un contacto.</p>
            <button type="button" onClick={link} disabled={linking} className={`w-fit ${BTN_PRIMARY}`}>
              {linking ? "Vinculando…" : "Vincular contacto"}
            </button>
            {linkErr ? <span className="text-xs text-danger">{linkErr}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function IdentityRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className={`min-w-0 truncate text-foreground ${mono ? "u-mono text-xs" : "tabular-nums"}`}>{value}</span>
    </p>
  );
}

function Ready({
  clientId,
  contactId,
  data,
  schedulingEnabled,
  workflowName,
  identityLine,
  conversationRef,
  viewerUserId,
  viewerIsFullAccess,
  onChanged,
}: {
  clientId: string;
  conversationRef: string;
  contactId: string;
  data: ContactPanelData;
  schedulingEnabled: boolean;
  workflowName: string | null;
  identityLine: ReactNode;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<null | "task" | "note" | "tag">(null);
  const [manageAppts, setManageAppts] = useState(false);
  const channel = data.summary.preferredChannel ? channelLabel(data.summary.preferredChannel) : "WhatsApp";
  const next = data.appointments.next;
  const visits = data.summary.visitCount;
  const noShows = data.summary.noShowCount;
  const toggle = (k: "task" | "note" | "tag") => setOpen((o) => (o === k ? null : k));

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-4 pb-4 pt-4">
        <div className="flex items-center gap-3">
          <InboxAvatar text={avatarText(data.summary.displayName, conversationRef)} toneKey={conversationRef} size={40} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-[1.0625rem] font-semibold tracking-[-0.01em] text-foreground">{data.summary.displayName}</span>
            <span className="truncate text-xs text-muted">{[channel, workflowName].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {identityLine}
        <div className="flex gap-2">
          {schedulingEnabled ? (
            <Link href={`/clients/${clientId}/scheduling/agenda?book=${contactId}`} className={`flex-1 ${BTN_PRIMARY}`}>
              Agendar cita
            </Link>
          ) : null}
          <Link href={`/clients/${clientId}/contacts/${contactId}`} className={`${schedulingEnabled ? "" : "flex-1"} ${BTN_SECONDARY}`}>
            Abrir contacto
          </Link>
        </div>

        {schedulingEnabled ? (
          <div className="flex flex-col gap-1 rounded-xl border border-line px-3.5 py-3">
            <span className="text-xs text-muted">Próxima cita</span>
            {next ? (
              <>
                <span className="text-[0.9375rem] font-semibold text-foreground">{apptWhen(next.startAt, next.siteTimezone)}</span>
                <span className="text-sm text-muted">{[next.serviceName, next.staffName].filter(Boolean).join(" · ")}</span>
              </>
            ) : (
              <span className="text-sm text-foreground">Sin cita próxima</span>
            )}
            <span className={`text-xs ${noShows > 0 ? "text-warn" : "text-faint"}`}>
              {visits} {visits === 1 ? "visita" : "visitas"} · {noShows} {noShows === 1 ? "inasistencia" : "inasistencias"}
            </span>
            {data.appointments.upcoming.length > 0 ? (
              <button type="button" onClick={() => setManageAppts((m) => !m)} aria-expanded={manageAppts} className="mt-1 self-start text-xs font-medium text-foreground underline underline-offset-2">
                {manageAppts ? "Ocultar citas" : "Gestionar citas"}
              </button>
            ) : null}
            {manageAppts ? (
              <div className="mt-2">
                <AppointmentsSection clientId={clientId} appointments={data.appointments} onChanged={onChanged} showHistory={false} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <Section title={`Tareas abiertas (${data.openTasks.length})`} add="Tarea" open={open === "task"} onAdd={() => toggle("task")}>
        <TasksSection
          clientId={clientId}
          contactId={contactId}
          tasks={data.openTasks}
          assignableMembers={[]}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
          addOpen={open === "task"}
          onAddOpenChange={(o) => setOpen(o ? "task" : null)}
        />
      </Section>

      <Section title={`Notas (${data.recentNotes.length})`} add="Nota" open={open === "note"} onAdd={() => toggle("note")}>
        <NotesSection
          clientId={clientId}
          contactId={contactId}
          notes={data.recentNotes}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
          dense
          addOpen={open === "note"}
          onAddOpenChange={(o) => setOpen(o ? "note" : null)}
        />
      </Section>

      <Section title={`Etiquetas (${data.tags.length})`} add="Etiqueta" open={open === "tag"} onAdd={() => toggle("tag")}>
        <TagsSection
          clientId={clientId}
          contactId={contactId}
          tags={data.tags}
          catalogue={[]}
          canManageCatalog={viewerIsFullAccess}
          onChanged={onChanged}
          addOpen={open === "tag"}
          onAddOpenChange={(o) => setOpen(o ? "tag" : null)}
        />
      </Section>
    </div>
  );
}

/** "Jue 15 oct · 10:00" in the SITE's timezone (an appointment happens at a place). */
function apptWhen(iso: string, tz: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(/\./g, "");
  const time = d.toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz });
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} · ${time}`;
}

/** A ficha section: shared heading with a "+ X" that opens its form. */
function Section({
  title,
  add,
  open,
  onAdd,
  children,
}: {
  title: string;
  add: string;
  open: boolean;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 border-t border-line px-4 py-3.5">
      <SectionHeading
        title={title}
        trailing={
          <button type="button" onClick={onAdd} aria-expanded={open} className="inline-flex min-h-[44px] items-center gap-1 rounded-md px-1 text-sm font-medium text-foreground hover:bg-subtle md:min-h-8">
            <span aria-hidden>+</span> {add}
          </button>
        }
      />
      {children}
    </section>
  );
}
