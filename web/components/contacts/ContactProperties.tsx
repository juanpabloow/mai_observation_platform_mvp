"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import type { ContactSummary, IdentityView, MemberOption } from "@/lib/contactShared";
import { ContactIdentitySummary } from "./shared/ContactIdentitySummary";
import { DuplicateBanner, type CandidateView } from "./DuplicateBanner";
import { updateContactAction } from "@/lib/contactActions";

/**
 * The record's LEFT column (C-4): the shared identity summary, an optional duplicate
 * banner, then the editable PROPERTIES and generic "Client fields". Editing is
 * inline/lightweight — click a value to edit it; each save is a single-field patch
 * through updateContactAction (server re-validates: unknown key / wrong type → the
 * error is surfaced; the assignee must have client access). Custom fields render
 * generically by type — the platform never special-cases a key.
 */

export type FieldType = "text" | "number" | "date" | "select" | "boolean";
export interface FieldDefView {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  options: string[] | null;
}

const MICRO = "text-[10px] font-medium uppercase tracking-wider text-faint";
const INPUT = "w-full rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm";

type Patch = Record<string, unknown>;
type Committer = (patch: Patch) => Promise<{ ok: boolean; error?: string }>;

/** One inline-editable property row. Read view shows the value + a quiet edit affordance;
 *  editing swaps to a type-appropriate input with Save/Cancel. */
function EditableRow({
  label,
  type,
  value,
  options,
  display,
  onCommit,
  patchKey,
}: {
  label: string;
  type: FieldType;
  value: string; // current value as an editable string ("" = empty)
  options?: string[];
  display: React.ReactNode; // read-mode rendering
  patchKey: string;
  onCommit: Committer;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const begin = () => {
    setDraft(value);
    setErr(null);
    setEditing(true);
  };
  const save = () => {
    setErr(null);
    start(async () => {
      const r = await onCommit({ [patchKey]: draft === "" ? null : draft });
      if (!r.ok) setErr(r.error ?? "Could not save.");
      else setEditing(false);
    });
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className={MICRO}>{label}</span>
      {editing ? (
        <div className="flex flex-col gap-1">
          {type === "select" ? (
            <select value={draft} onChange={(e) => setDraft(e.target.value)} className={INPUT} autoFocus>
              {(options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : type === "boolean" ? (
            <select value={draft} onChange={(e) => setDraft(e.target.value)} className={INPUT} autoFocus>
              <option value="">—</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : (
            <input
              type={type === "number" ? "number" : type === "date" ? "date" : "text"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={INPUT}
              autoFocus
            />
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={save} disabled={pending} className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-faint hover:text-foreground">
              Cancel
            </button>
            {err ? <span className="text-xs text-danger">{err}</span> : null}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={begin}
          className="group flex items-center justify-between gap-2 rounded-lg px-1 py-0.5 text-left text-sm text-foreground transition-colors hover:bg-subtle"
        >
          <span className="min-w-0 truncate">{display}</span>
          <span aria-hidden className="shrink-0 text-[11px] text-faint opacity-0 transition-opacity group-hover:opacity-100">
            Edit
          </span>
        </button>
      )}
    </div>
  );
}

function ReadRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={MICRO}>{label}</span>
      <span className="px-1 text-sm text-foreground">{value}</span>
    </div>
  );
}

const STAGES = ["new", "active", "customer", "archived"];
const CONSENTS = ["unknown", "opted_in", "opted_out"];

export function ContactProperties({
  clientId,
  contactId,
  summary,
  identities,
  candidates,
  canManageDuplicates,
  canEditFieldDefs,
  initial,
  members,
  ownerName,
  fieldDefs,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  summary: ContactSummary;
  identities: IdentityView[];
  candidates: CandidateView[];
  canManageDuplicates: boolean;
  canEditFieldDefs: boolean;
  initial: {
    name: string | null;
    stage: string;
    assignedTo: string | null;
    consent: string;
    consentSource: string | null;
    source: string; // origin channel (read-only)
    createdAt: string; // ISO
    customFields: Record<string, unknown>;
  };
  members: MemberOption[];
  ownerName: string | null;
  fieldDefs: FieldDefView[];
  onChanged?: () => void;
}) {
  const [custom, setCustom] = useState<Record<string, unknown>>(initial.customFields);

  const commit: Committer = async (patch) => {
    const r = await updateContactAction(clientId, contactId, patch);
    if (r.ok) onChanged?.();
    return r;
  };
  // Custom-field commit: send the WHOLE blob (updateContactAction replaces it + drops
  // empties). Keep local state in sync so subsequent edits merge correctly.
  const commitCustom = async (key: string, raw: string, type: FieldType) => {
    let v: unknown = raw;
    if (raw === "") v = null;
    else if (type === "number") v = Number(raw);
    else if (type === "boolean") v = raw === "true";
    const next = { ...custom };
    if (v === null) delete next[key];
    else next[key] = v;
    const r = await updateContactAction(clientId, contactId, { custom_fields: next });
    if (r.ok) {
      setCustom(next);
      onChanged?.();
    }
    return r;
  };

  const ownerOptions = ["", ...members.map((m) => m.userId)];

  return (
    <div className="flex flex-col gap-4">
      <ContactIdentitySummary summary={summary} identities={identities} />

      {canManageDuplicates ? (
        <DuplicateBanner clientId={clientId} contactId={contactId} candidates={candidates} onChanged={onChanged} />
      ) : null}

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <EditableRow
          label="Name"
          type="text"
          patchKey="name"
          value={initial.name ?? ""}
          display={initial.name ?? <span className="text-faint">Add a name</span>}
          onCommit={commit}
        />
        <EditableRow
          label="Stage"
          type="select"
          patchKey="stage"
          options={STAGES}
          value={initial.stage}
          display={initial.stage}
          onCommit={commit}
        />
        {members.length > 0 ? (
          <EditableRow
            label="Owner"
            type="select"
            patchKey="assigned_to"
            options={ownerOptions}
            value={initial.assignedTo ?? ""}
            display={ownerName ?? <span className="text-faint">Unassigned</span>}
            onCommit={async (p) => commit({ assigned_to: p.assigned_to })}
          />
        ) : (
          <ReadRow label="Owner" value={ownerName ?? <span className="text-faint">Unassigned</span>} />
        )}
        <ReadRow label="Source" value={initial.source} />
        <EditableRow
          label="Consent"
          type="select"
          patchKey="messaging_consent"
          options={CONSENTS}
          value={initial.consent}
          display={initial.consent}
          onCommit={commit}
        />
        <EditableRow
          label="Consent source"
          type="text"
          patchKey="consent_source"
          value={initial.consentSource ?? ""}
          display={initial.consentSource ?? <span className="text-faint">—</span>}
          onCommit={commit}
        />
        <ReadRow label="Created" value={formatDateTime(new Date(initial.createdAt))} />
      </div>

      {/* Client fields — generic by type; render NOTHING when none are defined. Owner/
          admin get a quiet link to define them. */}
      {fieldDefs.length > 0 ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <span className={MICRO}>Client fields</span>
            {canEditFieldDefs ? (
              <Link href={`/clients/${clientId}/contacts/fields`} className="text-[11px] text-muted hover:text-foreground">
                Manage
              </Link>
            ) : null}
          </div>
          {fieldDefs.map((d) => {
            const cur = custom[d.key];
            const asString = cur === undefined || cur === null ? "" : typeof cur === "boolean" ? String(cur) : String(cur);
            const displayVal =
              cur === undefined || cur === null || cur === ""
                ? "—"
                : d.type === "boolean"
                  ? cur ? "Yes" : "No"
                  : String(cur);
            return (
              <EditableRow
                key={d.id}
                label={d.label}
                type={d.type}
                patchKey={d.key}
                options={d.type === "select" ? ["", ...(d.options ?? [])] : undefined}
                value={asString}
                display={cur === undefined || cur === null || cur === "" ? <span className="text-faint">{displayVal}</span> : displayVal}
                onCommit={(p) => commitCustom(d.key, (p[d.key] ?? "") as string, d.type)}
              />
            );
          })}
        </div>
      ) : canEditFieldDefs ? (
        <div className="border-t border-line pt-4">
          <Link href={`/clients/${clientId}/contacts/fields`} className="text-xs text-muted hover:text-foreground">
            Define client fields →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
