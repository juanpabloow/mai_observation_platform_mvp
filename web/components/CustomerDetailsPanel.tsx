"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import type { ContactPanelData } from "@/lib/contactPanel";
import { ContactIdentitySummary } from "@/components/contacts/shared/ContactIdentitySummary";
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

const SECTION_LABEL = "text-[0.625rem] font-medium uppercase tracking-wider text-faint";

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
        <h2 className="text-sm font-semibold">Customer</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close customer details"
            className="u-tap rounded-md border border-line-strong px-2 py-1 text-xs text-muted transition-colors hover:bg-subtle hover:text-foreground"
          >
            ✕
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {state.status === "loading" ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : state.status === "error" ? (
          <p className="text-sm text-faint">Couldn&rsquo;t load contact details.</p>
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
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-foreground">No linked contact</p>
              <p className="mt-0.5 text-sm text-faint">
                This conversation (<span className="break-all font-mono text-xs">{conversationRef}</span>) isn&rsquo;t linked to a
                contact yet.
              </p>
            </div>
            <button
              type="button"
              onClick={link}
              disabled={linking}
              className="w-fit rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {linking ? "Linking…" : "Link contact"}
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
  return (
    <div className="flex flex-col gap-4">
      {/* Same information, stacked: the disc over a centred name, with "Open full
          record" as the link under it (it used to be one of two equal buttons, which
          made the panel open on two competing calls to action). */}
      <ContactIdentitySummary
        summary={data.summary}
        identities={data.identities}
        dense
        centered
        action={
          <Link
            href={`/clients/${clientId}/contacts/${contactId}`}
            className="text-sm font-medium text-accent hover:underline"
          >
            Open full record
          </Link>
        }
      />

      {schedulingEnabled ? (
        <Link
          href={`/clients/${clientId}/scheduling/agenda`}
          className="inline-flex h-9 items-center justify-center rounded-md bg-brand px-3 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Book appointment
        </Link>
      ) : null}

      {schedulingEnabled ? (
        <section className="flex flex-col gap-2 border-t border-line pt-3">
          {/* The count of appointments ON RECORD rides the section label — one number
              where it means something, instead of a visits/no-shows pair floating
              under the name. Upcoming + past is every appointment this contact has. */}
          <div className="flex items-baseline justify-between gap-2">
            <p className={SECTION_LABEL}>Next appointment</p>
            <span className="u-mono text-[0.625rem] text-faint">
              {data.appointments.upcoming.length + data.appointments.past.length} total
            </span>
          </div>
          <AppointmentsSection clientId={clientId} appointments={data.appointments} onChanged={onChanged} showHistory={false} />
        </section>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <p className={SECTION_LABEL}>Open tasks</p>
        <TasksSection
          clientId={clientId}
          contactId={contactId}
          tasks={data.openTasks}
          assignableMembers={[]}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <p className={SECTION_LABEL}>Notes</p>
        <NotesSection
          clientId={clientId}
          contactId={contactId}
          notes={data.recentNotes}
          viewerUserId={viewerUserId}
          viewerIsFullAccess={viewerIsFullAccess}
          onChanged={onChanged}
          dense
        />
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-3">
        <p className={SECTION_LABEL}>Tags</p>
        <TagsSection
          clientId={clientId}
          contactId={contactId}
          tags={data.tags}
          catalogue={[]}
          canManageCatalog={viewerIsFullAccess}
          onChanged={onChanged}
        />
      </section>
    </div>
  );
}
