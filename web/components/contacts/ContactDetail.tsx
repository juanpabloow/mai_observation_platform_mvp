"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateContactAction } from "@/lib/contactActions";

interface ContactData {
  id: string;
  name: string | null;
  channel: string;
  channel_user_id: string;
  phone_e164: string | null;
  email: string | null;
  stage: string;
  bot_human_mode: string;
  message_count: number;
  is_customer: boolean;
}
interface Conv { id: string; workflow_ref: string; conversation_ref: string; mode: string; last_message_at: string | null }
interface Appt { id: string; service_name: string; staff_name: string | null; site_name: string | null; start_at: string; status: string; origin: string }
interface Activity { id: string; event_type: string; actor_type: string; created_at: string; detail: Record<string, unknown> }

type Tab = "data" | "conversations" | "appointments" | "activity";

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5";

const fmt = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : "—";

export function ContactDetail({
  clientId,
  initialTab = "data",
  agendaHref,
  contact,
  conversations,
  appointments,
  activity,
}: {
  /** The validated owning client — saves go through the client-scoped action. */
  clientId: string;
  /** Section to open first (?tab= — e.g. AgendaView's "View conversation"). */
  initialTab?: Tab;
  /** Client-scoped Agenda link, or null when Scheduling is disabled for this client. */
  agendaHref: string | null;
  contact: ContactData;
  conversations: Conv[];
  appointments: Appt[];
  activity: Activity[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [name, setName] = useState(contact.name ?? "");
  const [phone, setPhone] = useState(contact.phone_e164 ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [stage, setStage] = useState(contact.stage);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setMsg(null);
    startTransition(async () => {
      const r = await updateContactAction(clientId, contact.id, {
        name,
        phone,
        email,
        stage: stage as "new" | "active" | "customer" | "archived",
      });
      if (!r.ok) setMsg(r.error);
      else {
        setMsg("Saved.");
        router.refresh();
      }
    });
  };

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "data", label: "Data" },
    { key: "conversations", label: `Conversations (${conversations.length})` },
    { key: "appointments", label: `Appointments (${appointments.length})` },
    { key: "activity", label: `Activity (${activity.length})` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{contact.name ?? contact.channel_user_id}</h1>
        {contact.is_customer ? <span className="rounded bg-success/15 px-2 py-0.5 text-xs text-success">customer</span> : null}
        <span className="text-xs text-faint">{contact.channel} · {contact.channel_user_id}</span>
      </div>

      <nav className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm ${tab === t.key ? "border-b-2 border-accent font-medium text-foreground" : "text-muted hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "data" ? (
        <div className="flex max-w-md flex-col gap-3 text-sm">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></Field>
          <Field label="Phone (E.164)"><input value={phone} onChange={(e) => setPhone(e.target.value)} className={INPUT} placeholder="+57300…" /></Field>
          <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} /></Field>
          <Field label="Stage">
            <select value={stage} onChange={(e) => setStage(e.target.value)} className={INPUT}>
              {["new", "active", "customer", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <p className="text-xs text-faint">Messages: {contact.message_count} · Bot/human mode: {contact.bot_human_mode}</p>
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={pending} className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
              {pending ? "Saving…" : "Save"}
            </button>
            {msg ? <span className="text-xs text-muted">{msg}</span> : null}
          </div>
        </div>
      ) : null}

      {tab === "conversations" ? (
        <ul className="flex flex-col gap-2 text-sm">
          {conversations.length === 0 ? <li className="text-muted">No conversations.</li> : null}
          {conversations.map((c) => (
            <li key={c.id} className="rounded-lg border border-line p-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs">{c.workflow_ref} / {c.conversation_ref}</span>
                <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px]">{c.mode}</span>
              </div>
              <p className="mt-1 text-xs text-muted">Last message: {fmt(c.last_message_at)}</p>
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
                <p className="text-xs text-muted">{fmt(a.start_at)} · {a.staff_name ?? "—"} · {a.site_name ?? "—"} · {a.origin}</p>
              </div>
              <span className="rounded bg-subtle px-1.5 py-0.5 text-[11px]">{a.status}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tab === "activity" ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {activity.length === 0 ? <li className="text-muted">No activity.</li> : null}
          {activity.map((e) => (
            <li key={e.id} className="flex items-center gap-2 text-xs">
              <span className="text-faint">{fmt(e.created_at)}</span>
              <span className="rounded bg-subtle px-1.5 py-0.5">{e.event_type}</span>
              <span className="text-muted">by {e.actor_type}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Only when Scheduling is enabled for this client (server-resolved). */}
      {agendaHref ? (
        <Link href={agendaHref} className="text-xs text-accent hover:underline">Open agenda →</Link>
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
