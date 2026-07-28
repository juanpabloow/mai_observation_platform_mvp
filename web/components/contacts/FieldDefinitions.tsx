"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createFieldDefinitionAction, updateFieldDefinitionAction } from "@/lib/fieldDefinitionActions";

type FieldType = "text" | "number" | "date" | "select" | "boolean";
export interface DefView { id: string; key: string; label: string; type: FieldType; options: string[] | null; enabled: boolean; position: number }

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";
const TYPES: FieldType[] = ["text", "number", "date", "select", "boolean"];

/**
 * Owner/admin custom-field DEFINITION manager (C-2). Plain — C-4 restyles. `key` is
 * immutable once created; existing fields can be relabelled/enabled/disabled.
 */
export function FieldDefinitions({ clientId, defs }: { clientId: string; defs: DefView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState("");

  const create = () => {
    setErr(null);
    startTransition(async () => {
      const r = await createFieldDefinitionAction(clientId, {
        key: key.trim(),
        label: label.trim(),
        type,
        options: type === "select" ? options.split(",").map((o) => o.trim()).filter(Boolean) : null,
      });
      if (!r.ok) setErr(r.error);
      else {
        setKey("");
        setLabel("");
        setOptions("");
        setType("text");
        router.refresh();
      }
    });
  };

  const toggle = (id: string, enabled: boolean) => {
    startTransition(async () => {
      await updateFieldDefinitionAction(clientId, id, { enabled });
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1.5 text-sm">
        {defs.length === 0 ? <li className="text-muted">No custom fields yet.</li> : null}
        {defs.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <span>
              <span className="font-medium">{d.label}</span>{" "}
              <span className="font-mono text-xs text-faint">{d.key}</span>{" "}
              <span className="text-xs text-muted">· {d.type}{d.options ? ` (${d.options.join(", ")})` : ""}</span>
              {!d.enabled ? <span className="ml-2 text-xs text-faint">disabled</span> : null}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => toggle(d.id, !d.enabled)}
              className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:bg-subtle disabled:opacity-50"
            >
              {d.enabled ? "Disable" : "Enable"}
            </button>
          </li>
        ))}
      </ul>

      <div className="flex max-w-md flex-col gap-2 rounded-xl border border-line p-3">
        <p className="text-xs font-medium uppercase tracking-wider text-faint">New field</p>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. Preferred barber)" className={INPUT} />
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="key (immutable, e.g. preferred_barber)" className={`${INPUT} font-mono`} />
        <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={INPUT}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {type === "select" ? (
          <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="options, comma-separated" className={INPUT} />
        ) : null}
        <div className="flex items-center gap-3">
          <button onClick={create} disabled={pending || !key.trim() || !label.trim()} className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            Add field
          </button>
          {err ? <span className="text-xs text-red-600 dark:text-red-400">{err}</span> : null}
        </div>
      </div>
    </div>
  );
}
