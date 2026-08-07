"use client";

import { useState, useTransition } from "react";
import { updateContactAction } from "@/lib/contactActions";
import { addNoteAction } from "@/lib/crmActions";
import type { FieldDefView } from "./ContactProperties";

/**
 * EDIT CLIENT DETAILS — the whole contact in one dialog, saved in one go.
 *
 * The record's left column already edits field-by-field (click a value, save it).
 * That is right for correcting one thing and wrong for the case this dialog serves:
 * a new customer whose email, phone and socials all need filling at once. Same
 * server action underneath (`updateContactAction`), so validation, client scoping
 * and the custom-field type checks are identical — this only batches the patch.
 *
 * WHAT IT DELIBERATELY DOESN'T HAVE:
 * - No avatar / "edit picture": contacts have no image and the disc is derived from
 *   the name, so a picture control would promise storage that doesn't exist.
 * - No occupation / country / birthday / gender: none of them are columns. Anything
 *   beyond name, email and phone renders from the CLIENT'S OWN field definitions
 *   (Instagram and Facebook are two of those), so a shop adds what it needs in CRM
 *   settings instead of the platform guessing which extra fields a barbershop wants.
 */
export function ContactEditDialog({
  clientId,
  contactId,
  initial,
  fieldDefs,
  onClose,
  onSaved,
}: {
  clientId: string;
  contactId: string;
  initial: { name: string | null; email: string | null; phone: string | null; customFields: Record<string, unknown> };
  fieldDefs: FieldDefView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial.name ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [custom, setCustom] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const d of fieldDefs) {
      const v = initial.customFields[d.key];
      seed[d.key] = v === undefined || v === null ? "" : String(v);
    }
    return seed;
  });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () => {
    setError(null);
    start(async () => {
      // Custom fields are typed on the server; send the empty string as NULL so
      // clearing a field is a real clear rather than an empty-string value.
      const customPatch: Record<string, unknown> = {};
      for (const d of fieldDefs) {
        const raw = custom[d.key] ?? "";
        if (raw === "") {
          customPatch[d.key] = null;
        } else if (d.type === "number") {
          customPatch[d.key] = Number(raw);
        } else if (d.type === "boolean") {
          customPatch[d.key] = raw === "true";
        } else {
          customPatch[d.key] = raw;
        }
      }
      const r = await updateContactAction(clientId, contactId, {
        name: name.trim() === "" ? null : name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        ...(fieldDefs.length > 0 ? { custom_fields: customPatch } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // The note is a SEPARATE record (contact_notes), so it is a separate write —
      // and only when something was actually typed.
      const body = note.trim();
      if (body !== "") {
        const n = await addNoteAction(clientId, contactId, body);
        if (!n.ok) {
          setError(n.error);
          return;
        }
      }
      onSaved();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-line bg-popover p-5 text-popover-foreground shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Edit client details</h2>

        <div className="mt-4 flex flex-col gap-3">
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} placeholder="Full name" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={INPUT}
                placeholder="name@mail.com"
                inputMode="email"
              />
            </Field>
            <Field label="Phone">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className={INPUT}
                placeholder="+57 300 000 0000"
                inputMode="tel"
              />
            </Field>
          </div>

          {/* ADDITIONAL INFORMATION — whatever this client has defined (Instagram and
              Facebook when they exist). Renders nothing at all when the client has no
              definitions, rather than an empty section header. */}
          {fieldDefs.length > 0 ? (
            <div className="mt-1 flex flex-col gap-3 border-t border-line pt-3">
              <p className="u-th">Additional information</p>
              {fieldDefs.map((d) => (
                <Field key={d.id} label={d.label}>
                  {d.type === "select" ? (
                    <select
                      value={custom[d.key] ?? ""}
                      onChange={(e) => setCustom((c) => ({ ...c, [d.key]: e.target.value }))}
                      className={INPUT}
                    >
                      <option value="">—</option>
                      {(d.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : d.type === "boolean" ? (
                    <select
                      value={custom[d.key] ?? ""}
                      onChange={(e) => setCustom((c) => ({ ...c, [d.key]: e.target.value }))}
                      className={INPUT}
                    >
                      <option value="">—</option>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  ) : (
                    <input
                      value={custom[d.key] ?? ""}
                      onChange={(e) => setCustom((c) => ({ ...c, [d.key]: e.target.value }))}
                      className={INPUT}
                      type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"}
                    />
                  )}
                </Field>
              ))}
            </div>
          ) : null}

          <div className="mt-1 flex flex-col gap-3 border-t border-line pt-3">
            <Field label="Note">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Add note…"
                className={`${INPUT} resize-none`}
              />
            </Field>
          </div>
        </div>

        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-md border border-line-strong px-3 text-sm transition-colors hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-brand px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-md border border-line-strong bg-transparent px-2.5 py-2 text-sm outline-none focus:border-brand";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
    </label>
  );
}
