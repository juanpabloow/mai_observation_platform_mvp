"use client";

/**
 * The contact EDIT FORM (name/phone/email/stage/consent/owner/custom fields) +
 * read-only identities. C-3 replaced this component's old Data|Conversations|
 * Appointments|Activity tabs with the edit form here + a unified <ContactActivity/>
 * (timeline + notes + tasks + tags). All of this contact-record UI is TEMPORARY
 * scaffolding — C-4 redesigns the record against an approved mockup and deletes it.
 * Existing tokens only; no new visual language.
 */

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
  messaging_consent: string;
  consent_source: string | null;
  assigned_to: string | null;
  custom_fields: Record<string, unknown>;
}
export interface IdentityView { kind: string; value: string; label: string | null }
export interface MemberOption { user_id: string; email: string; name: string | null }
export interface FieldDefView { id: string; key: string; label: string; type: "text" | "number" | "date" | "select" | "boolean"; options: string[] | null }

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5";

export function ContactDetail({
  clientId,
  contact,
  identities,
  assignableMembers,
  fieldDefs,
}: {
  clientId: string;
  contact: ContactData;
  identities: IdentityView[];
  assignableMembers: MemberOption[];
  fieldDefs: FieldDefView[];
}) {
  const router = useRouter();
  const [name, setName] = useState(contact.name ?? "");
  const [phone, setPhone] = useState(contact.phone_e164 ?? "");
  const [email, setEmail] = useState(contact.email ?? "");
  const [stage, setStage] = useState(contact.stage);
  const [consent, setConsent] = useState(contact.messaging_consent);
  const [consentSource, setConsentSource] = useState(contact.consent_source ?? "");
  const [owner, setOwner] = useState(contact.assigned_to ?? "");
  const [custom, setCustom] = useState<Record<string, unknown>>(contact.custom_fields ?? {});
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setFieldValue = (key: string, v: unknown) => setCustom((c) => ({ ...c, [key]: v }));

  const save = () => {
    setMsg(null);
    const customPayload: Record<string, unknown> = {};
    for (const def of fieldDefs) {
      const raw = custom[def.key];
      if (raw === undefined || raw === null || raw === "") continue;
      customPayload[def.key] = def.type === "number" ? Number(raw) : def.type === "boolean" ? Boolean(raw) : String(raw);
    }
    startTransition(async () => {
      const patch: Record<string, unknown> = {
        name, phone, email, stage,
        messaging_consent: consent as "unknown" | "opted_in" | "opted_out",
        consent_source: consentSource || null,
        custom_fields: customPayload,
      };
      if (assignableMembers.length > 0) patch.assigned_to = owner || null;
      const r = await updateContactAction(clientId, contact.id, patch);
      if (!r.ok) setMsg(r.error);
      else { setMsg("Saved."); router.refresh(); }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{contact.name ?? contact.channel_user_id}</h1>
        {contact.is_customer ? <span className="rounded bg-success/15 px-2 py-0.5 text-xs text-success">customer</span> : null}
        <span className="text-xs text-faint">{contact.channel} · {contact.channel_user_id}</span>
      </div>

      <div className="flex max-w-md flex-col gap-3 text-sm">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} /></Field>
        <Field label="Phone (E.164)"><input value={phone} onChange={(e) => setPhone(e.target.value)} className={INPUT} placeholder="+57300…" /></Field>
        <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} className={INPUT} /></Field>
        <Field label="Stage">
          <select value={stage} onChange={(e) => setStage(e.target.value)} className={INPUT}>
            {["new", "active", "customer", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Messaging consent">
          <select value={consent} onChange={(e) => setConsent(e.target.value)} className={INPUT}>
            {["unknown", "opted_in", "opted_out"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Consent source"><input value={consentSource} onChange={(e) => setConsentSource(e.target.value)} className={INPUT} placeholder="e.g. verbal, form" /></Field>
        {assignableMembers.length > 0 ? (
          <Field label="Owner">
            <select value={owner} onChange={(e) => setOwner(e.target.value)} className={INPUT}>
              <option value="">— unassigned —</option>
              {assignableMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.name ?? m.email}</option>)}
            </select>
          </Field>
        ) : null}
        {fieldDefs.length > 0 ? (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Custom fields</p>
            {fieldDefs.map((def) => (
              <Field key={def.id} label={def.label}>
                <CustomInput def={def} value={custom[def.key]} onChange={(v) => setFieldValue(def.key, v)} />
              </Field>
            ))}
          </div>
        ) : null}
        {identities.length > 0 ? (
          <div className="border-t border-line pt-3">
            <p className="text-xs font-medium uppercase tracking-wider text-faint">Identities</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted">
              {identities.map((i) => (
                <li key={`${i.kind}:${i.value}`}><span className="font-mono">{i.kind}</span> {i.value}{i.label ? ` · ${i.label}` : ""}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-faint">Messages: {contact.message_count} · Bot/human mode: {contact.bot_human_mode}</p>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={pending} className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            {pending ? "Saving…" : "Save"}
          </button>
          {msg ? <span className="text-xs text-muted">{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}

function CustomInput({ def, value, onChange }: { def: FieldDefView; value: unknown; onChange: (v: unknown) => void }) {
  if (def.type === "boolean") return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  if (def.type === "select") {
    return (
      <select value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className={INPUT}>
        <option value="">—</option>
        {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  const type = def.type === "number" ? "number" : def.type === "date" ? "date" : "text";
  return <input type={type} value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} className={INPUT} />;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
