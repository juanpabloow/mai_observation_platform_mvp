"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createNoteAction, updateNoteAction, deleteNoteAction } from "@/lib/crmActions";
import { fmtDateTime, type NoteDTO } from "./types";

const INPUT =
  "w-full rounded-lg border border-line-strong bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/40";

/** Notes list + composer for the Overview tab. Every CRM user may add a note;
 * edit/delete is gated server-side (canManage precomputed per note). */
export function NotesPanel({
  clientId,
  contactId,
  notes,
}: {
  clientId: string;
  contactId: string;
  notes: NoteDTO[];
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const add = () => {
    const value = body.trim();
    if (!value) return;
    setError(null);
    startTransition(async () => {
      const r = await createNoteAction({ clientId, contactId, body: value });
      if (!r.ok) setError(r.error);
      else {
        setBody("");
        router.refresh();
      }
    });
  };

  const saveEdit = (noteId: string) => {
    const value = editBody.trim();
    if (!value) return;
    setError(null);
    startTransition(async () => {
      const r = await updateNoteAction({ clientId, noteId, body: value });
      if (!r.ok) setError(r.error);
      else {
        setEditingId(null);
        router.refresh();
      }
    });
  };

  const remove = (noteId: string) => {
    setError(null);
    startTransition(async () => {
      const r = await deleteNoteAction({ clientId, noteId });
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note…"
          rows={2}
          className={INPUT}
        />
        <div className="flex items-center gap-3">
          <button
            onClick={add}
            disabled={pending || body.trim().length === 0}
            className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Add note"}
          </button>
          {error ? <span className="text-xs text-danger">{error}</span> : null}
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {notes.length === 0 ? <li className="text-sm text-muted">No notes yet.</li> : null}
        {notes.map((n) => (
          <li key={n.id} className="rounded-lg border border-line p-3">
            {editingId === n.id ? (
              <div className="flex flex-col gap-2">
                <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} className={INPUT} />
                <div className="flex gap-2">
                  <button
                    onClick={() => saveEdit(n.id)}
                    disabled={pending}
                    className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button onClick={() => setEditingId(null)} className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-subtle">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-faint">
                  <span>
                    {n.authorName ?? "Unknown"} · {fmtDateTime(n.createdAt)}
                    {n.updatedAt !== n.createdAt ? " · edited" : ""}
                  </span>
                  {n.canManage ? (
                    <span className="flex gap-2">
                      <button
                        onClick={() => {
                          setEditingId(n.id);
                          setEditBody(n.body);
                        }}
                        className="text-muted hover:text-foreground"
                      >
                        Edit
                      </button>
                      <button onClick={() => remove(n.id)} disabled={pending} className="text-muted hover:text-danger disabled:opacity-50">
                        Delete
                      </button>
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
