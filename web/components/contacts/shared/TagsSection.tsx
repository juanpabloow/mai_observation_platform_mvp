"use client";

import { useState, useTransition } from "react";
import type { TagView } from "@/lib/contactShared";
import { tagChipClass } from "@/lib/tagColors";
import { attachTagAction, createTagAction, detachTagAction } from "@/lib/crmActions";
import { CRM_COPY } from "@/lib/contactLabels";

/**
 * SHARED tags block (C-4): current tags as colored chips with a remove ✕, plus an add
 * control that suggests the client's existing tags. Owner/admin can also create a new
 * tag inline (then it's attached). Writes through C-3's attach/detach/create actions;
 * the caller refreshes via onChanged.
 */

const INPUT = "rounded-lg border border-line-strong bg-transparent px-2 py-1 text-sm";

export function TagsSection({
  clientId,
  contactId,
  tags,
  catalogue,
  canManageCatalog,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  tags: TagView[];
  catalogue: TagView[];
  canManageCatalog: boolean;
  onChanged?: () => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const attached = new Set(tags.map((t) => t.id));
  const suggestable = catalogue.filter((t) => !attached.has(t.id));

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Something went wrong.");
      else onChanged?.();
    });
  };

  const attach = (tagId: string) => {
    if (!tagId) return;
    run(() => attachTagAction(clientId, contactId, tagId));
    setPick("");
  };
  const detach = (tagId: string) => run(() => detachTagAction(clientId, contactId, tagId));
  const create = () => {
    const name = newName.trim();
    if (!name) return;
    setErr(null);
    start(async () => {
      const r = await createTagAction(clientId, name, "gray");
      if (!r.ok || !r.id) {
        setErr(r.ok ? "Could not create tag." : r.error);
        return;
      }
      const a = await attachTagAction(clientId, contactId, r.id);
      if (!a.ok) setErr(a.error);
      else {
        setNewName("");
        setCreating(false);
        onChanged?.();
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 ? <span className="text-sm text-faint">{CRM_COPY.empty.tags}</span> : null}
        {tags.map((t) => (
          <span
            key={t.id}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tagChipClass(t.color)}`}
          >
            {t.name}
            <button
              type="button"
              onClick={() => detach(t.id)}
              disabled={pending}
              aria-label={`Quitar ${t.name}`}
              className="opacity-60 transition-opacity hover:opacity-100 disabled:opacity-40"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {suggestable.length > 0 ? (
          <select value={pick} onChange={(e) => attach(e.target.value)} disabled={pending} className={INPUT} aria-label="Agregar etiqueta existente">
            <option value="">{CRM_COPY.actions.addTag}</option>
            {suggestable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}

        {canManageCatalog ? (
          creating ? (
            <span className="inline-flex items-center gap-1.5">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nombre de la etiqueta"
                className={INPUT}
                autoFocus
              />
              <button type="button" onClick={create} disabled={pending || !newName.trim()} className="rounded-lg border border-line px-2 py-1 text-xs hover:bg-subtle disabled:opacity-50">
                {CRM_COPY.actions.create}
              </button>
              <button type="button" onClick={() => { setCreating(false); setNewName(""); }} className="text-xs text-faint hover:text-foreground">
                {CRM_COPY.actions.cancel}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setCreating(true)} className="rounded-lg border border-line px-2 py-1 text-xs text-muted hover:bg-subtle hover:text-foreground">
              {CRM_COPY.actions.newTag}
            </button>
          )
        ) : null}
        {err ? <span className="text-xs text-danger">{err}</span> : null}
      </div>
    </div>
  );
}
