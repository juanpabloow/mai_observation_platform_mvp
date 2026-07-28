"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateContactAction } from "@/lib/contactActions";
import { ContactHeader } from "@/components/crm/ContactHeader";
import { NotesPanel } from "@/components/crm/NotesPanel";
import { TasksPanel } from "@/components/crm/TasksPanel";
import { TimelinePanel } from "@/components/crm/TimelinePanel";
import {
  fmtDateTime,
  type AppointmentDTO,
  type ContactDTO,
  type ContactTab,
  type ConversationDTO,
  type MemberOption,
  type NoteDTO,
  type TagDTO,
  type TaskDTO,
  type TimelineItemDTO,
} from "@/components/crm/types";

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ContactDetail({
  clientId,
  initialTab = "overview",
  canFullAccess,
  members,
  agendaHref,
  contact,
  tagCatalog,
  contactTags,
  notes,
  tasks,
  conversations,
  appointments,
  timelineItems,
  timelineCursor,
}: {
  clientId: string;
  initialTab?: ContactTab;
  canFullAccess: boolean;
  members: MemberOption[];
  agendaHref: string | null;
  contact: ContactDTO;
  tagCatalog: TagDTO[];
  contactTags: TagDTO[];
  notes: NoteDTO[];
  tasks: TaskDTO[];
  conversations: ConversationDTO[];
  appointments: AppointmentDTO[];
  timelineItems: TimelineItemDTO[];
  timelineCursor: string | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<ContactTab>(initialTab);
  const [name, setName] = useState(contact.name ?? "");
  const [phone, setPhone] = useState(contact.phone_e164 ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openTasks = tasks.filter((t) => t.status === "open").length;

  const save = () => {
    setMsg(null);
    startTransition(async () => {
      const r = await updateContactAction(clientId, contact.id, { name, phone, email });
      if (!r.ok) setMsg(r.error);
      else {
        setMsg("Saved.");
        router.refresh();
      }
    });
  };

  const tabs: Array<{ key: ContactTab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "timeline", label: "Timeline" },
    { key: "conversations", label: `Conversations (${conversations.length})` },
    { key: "appointments", label: `Appointments (${appointments.length})` },
    { key: "tasks", label: `Tasks${openTasks ? ` (${openTasks})` : ""}` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ContactHeader
        clientId={clientId}
        contact={contact}
        members={members}
        contactTags={contactTags}
        tagCatalog={tagCatalog}
        canFullAccess={canFullAccess}
      />

      <nav className="flex gap-1 overflow-x-auto border-b border-line" role="tablist" aria-label="Contact sections">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap px-3 py-2 text-sm ${
              tab === t.key ? "border-b-2 border-accent font-medium text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="flex flex-col gap-6">
          <div className="flex max-w-md flex-col gap-3 text-sm">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
            </Field>
            <Field label="Phone (E.164)">
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={INPUT} placeholder="+57300…" />
            </Field>
            <Field label="Email">
              <input value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} />
            </Field>
            <p className="text-xs text-faint">
              Messages: {contact.message_count} · Bot/human mode: {contact.bot_human_mode}
            </p>
            <div className="flex items-center gap-3">
              <button onClick={save} disabled={pending} className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {pending ? "Saving…" : "Save"}
              </button>
              {msg ? <span className="text-xs text-muted">{msg}</span> : null}
            </div>
          </div>
          <div>
            <h2 className="mb-2 text-sm font-semibold">Notes</h2>
            <NotesPanel clientId={clientId} contactId={contact.id} notes={notes} />
          </div>
        </div>
      ) : null}

      {tab === "timeline" ? (
        <TimelinePanel clientId={clientId} contactId={contact.id} initialItems={timelineItems} initialCursor={timelineCursor} />
      ) : null}

      {tab === "conversations" ? (
        <ul className="flex flex-col gap-2 text-sm">
          {conversations.length === 0 ? <li className="text-muted">No conversations.</li> : null}
          {conversations.map((c) => (
            <li key={c.id} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">
                  {c.workflow_ref} / {c.conversation_ref}
                </span>
                <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px]">{c.mode}</span>
              </div>
              <p className="mt-1 text-xs text-muted">Last message: {fmtDateTime(c.last_message_at)}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {tab === "appointments" ? (
        <ul className="flex flex-col gap-2 text-sm">
          {appointments.length === 0 ? <li className="text-muted">No appointments.</li> : null}
          {appointments.map((a) => (
            <li key={a.id} className="flex items-center justify-between rounded-lg border border-line p-3">
              <div>
                <p className="font-medium">{a.service_name}</p>
                <p className="text-xs text-muted">
                  {fmtDateTime(a.start_at)} · {a.staff_name ?? "—"} · {a.site_name ?? "—"} · {a.origin}
                </p>
              </div>
              <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px]">{a.status}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tab === "tasks" ? (
        <TasksPanel clientId={clientId} contactId={contact.id} tasks={tasks} members={members} canAssignOthers={canFullAccess} />
      ) : null}

      {agendaHref ? (
        <Link href={agendaHref} className="text-xs text-accent hover:underline">
          Open agenda →
        </Link>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
