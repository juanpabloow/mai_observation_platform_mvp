"use client";

import { useState, useTransition } from "react";
import { formatDateTime } from "@/lib/format";
import type { NoteView } from "@/lib/contactShared";
import { addNoteAction, deleteNoteAction } from "@/lib/crmActions";

/**
 * SHARED notes block (C-4): a list of notes (body + author + time) with an inline
 * composer. Used by the inbox panel (most-recent notes) and available to the record.
 * The record's timeline also surfaces notes as entries; this composer writes through
 * C-3's addNoteAction and the caller refreshes via onChanged. Delete (soft) offered on
 * notes the viewer may edit (own, or owner/admin). Server re-validates every write.
 */

const INPUT = "w-full rounded-lg border border-line-strong bg-transparent px-2 py-1.5 text-sm";
const PRIMARY = "rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50";

export function NotesSection({
  clientId,
  contactId,
  notes,
  viewerUserId,
  viewerIsFullAccess,
  onChanged,
  dense = false,
}: {
  clientId: string;
  contactId: string;
  notes: NoteView[];
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onChanged?: () => void;
  dense?: boolean;
}) {
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const canEdit = (n: NoteView) => viewerIsFullAccess || n.createdByUserId === viewerUserId;

  const add = () => {
    const text = body.trim();
    if (!text) return;
    setErr(null);
    start(async () => {
      const r = await addNoteAction(clientId, contactId, text);
      if (!r.ok) setErr(r.error);
      else {
        setBody("");
        onChanged?.();
      }
    });
  };
  const remove = (noteId: string) => {
    setErr(null);
    start(async () => {
      const r = await deleteNoteAction(clientId, noteId);
      if (!r.ok) setErr(r.error);
      else onChanged?.();
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note…"
          rows={dense ? 2 : 3}
          className={INPUT}
        />
        <div className="flex items-center gap-2">
          <button type="button" onClick={add} disabled={pending || !body.trim()} className={PRIMARY}>
            Add
          </button>
          {err ? <span className="text-xs text-danger">{err}</span> : null}
        </div>
      </div>

      {notes.length === 0 ? (
        <p className="text-sm text-faint">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-lg border border-line bg-card p-2.5">
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">{n.body}</p>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-faint">
                <span>{n.authorName ?? "System"}</span>
                <span aria-hidden>·</span>
                <span>{formatDateTime(new Date(n.createdAt))}</span>
                {n.edited ? <span className="text-faint">· edited</span> : null}
                {canEdit(n) ? (
                  <button
                    type="button"
                    onClick={() => remove(n.id)}
                    disabled={pending}
                    className="ml-auto text-faint transition-colors hover:text-danger disabled:opacity-50"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
