"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  changeStageAction,
  changeOwnerAction,
  attachTagAction,
  detachTagAction,
  createTagAction,
} from "@/lib/crmActions";
import { tagChipClass } from "./tagColors";
import { TAG_COLORS, CONTACT_STAGES } from "@/lib/crmValidation";
import type { ContactDTO, MemberOption, TagDTO } from "./types";

const CTRL =
  "rounded-lg border border-line-strong bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-accent/40";

export function ContactHeader({
  clientId,
  contact,
  members,
  contactTags,
  tagCatalog,
  canFullAccess,
}: {
  clientId: string;
  contact: ContactDTO;
  members: MemberOption[];
  contactTags: TagDTO[];
  tagCatalog: TagDTO[];
  canFullAccess: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [newTag, setNewTag] = useState("");
  const [newColor, setNewColor] = useState<string>(TAG_COLORS[0]);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string } | { ok: true; value?: unknown }>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  const attachedIds = new Set(contactTags.map((t) => t.id));
  const available = tagCatalog.filter((t) => !attachedIds.has(t.id));

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{contact.name ?? contact.channel_user_id}</h1>
        {contact.is_customer ? <span className="rounded bg-success/15 px-2 py-0.5 text-xs text-success">customer</span> : null}
        <span className="text-xs text-faint">
          {contact.channel} · {contact.channel_user_id}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        {/* Stage — owner/admin edit; members see it read-only. */}
        <label className="flex items-center gap-2">
          <span className="text-muted">Stage</span>
          {canFullAccess ? (
            <select
              value={contact.stage}
              disabled={pending}
              onChange={(e) => run(() => changeStageAction({ clientId, contactId: contact.id, stage: e.target.value }))}
              className={CTRL}
            >
              {CONTACT_STAGES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded bg-subtle px-2 py-0.5">{contact.stage}</span>
          )}
        </label>

        {/* Owner — owner/admin assign; members see the owner's NAME (never a UUID). */}
        <label className="flex items-center gap-2">
          <span className="text-muted">Owner</span>
          {canFullAccess ? (
            <select
              value={contact.assigned_to ?? ""}
              disabled={pending}
              onChange={(e) =>
                run(() => changeOwnerAction({ clientId, contactId: contact.id, ownerUserId: e.target.value || null }))
              }
              className={CTRL}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="rounded bg-subtle px-2 py-0.5">{contact.assignee_name ?? "Unassigned"}</span>
          )}
        </label>
      </div>

      {/* Tags — any CRM user may attach/detach existing tags. */}
      <div className="flex flex-wrap items-center gap-2">
        {contactTags.map((t) => (
          <span key={t.id} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-inset ${tagChipClass(t.color)}`}>
            {t.name}
            <button
              onClick={() => run(() => detachTagAction({ clientId, contactId: contact.id, tagId: t.id }))}
              disabled={pending}
              aria-label={`Remove tag ${t.name}`}
              className="opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
        {available.length > 0 ? (
          <select
            value=""
            disabled={pending}
            onChange={(e) => e.target.value && run(() => attachTagAction({ clientId, contactId: contact.id, tagId: e.target.value }))}
            className={CTRL}
          >
            <option value="">+ Tag…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {/* New catalog tag — owner/admin only. */}
      {canFullAccess ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="New tag name" className={CTRL} />
          <select value={newColor} onChange={(e) => setNewColor(e.target.value)} className={CTRL}>
            {TAG_COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            onClick={() =>
              newTag.trim() &&
              run(async () => {
                const r = await createTagAction({ clientId, name: newTag.trim(), color: newColor });
                if (r.ok) setNewTag("");
                return r;
              })
            }
            disabled={pending || newTag.trim().length === 0}
            className="rounded-lg border border-line px-2 py-1 hover:bg-subtle disabled:opacity-50"
          >
            Create tag
          </button>
        </div>
      ) : null}

      {error ? <span className="text-xs text-danger">{error}</span> : null}
    </header>
  );
}
