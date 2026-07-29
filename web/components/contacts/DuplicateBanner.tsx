"use client";

import { useState, useTransition } from "react";
import { mergeContactsAction, dismissCandidateAction } from "@/lib/contactActions";

/**
 * Compact duplicate-candidate banner on the contact record (C-4). Surfaces C-2's
 * unresolved duplicate_contact_candidates rows involving THIS contact (either side),
 * exactly where a human notices them. Merge folds the recorded duplicate into the keep
 * contact; Dismiss clears the candidate. Both are owner/admin only and server-gated
 * (hasFullAccess) — a member never sees this banner. A quiet, informational treatment.
 */

export interface CandidateView {
  id: string;
  contactIdKeep: string;
  keepName: string | null;
  keepRef: string;
  contactIdDuplicate: string;
  dupName: string | null;
  dupRef: string;
}

function otherSide(c: CandidateView, contactId: string): { name: string | null; ref: string } {
  return c.contactIdKeep === contactId
    ? { name: c.dupName, ref: c.dupRef }
    : { name: c.keepName, ref: c.keepRef };
}

export function DuplicateBanner({
  clientId,
  contactId,
  candidates,
  onChanged,
}: {
  clientId: string;
  contactId: string;
  candidates: CandidateView[];
  onChanged?: () => void;
}) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  if (candidates.length === 0) return null;

  const merge = (c: CandidateView) => {
    setErr(null);
    start(async () => {
      const r = await mergeContactsAction(clientId, c.contactIdKeep, c.contactIdDuplicate);
      if (!r.ok) setErr(r.error);
      else onChanged?.();
    });
  };
  const dismiss = (c: CandidateView) => {
    setErr(null);
    start(async () => {
      const r = await dismissCandidateAction(clientId, c.id);
      if (!r.ok) setErr(r.error);
      else onChanged?.();
    });
  };

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
      <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
        Possible duplicate{candidates.length > 1 ? "s" : ""}
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {candidates.map((c) => {
          const other = otherSide(c, contactId);
          return (
            <li key={c.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 text-sm">
                <span className="truncate text-foreground">{other.name ?? other.ref}</span>
                {other.name ? <span className="ml-1 truncate font-mono text-xs text-faint">{other.ref}</span> : null}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => merge(c)}
                  disabled={pending}
                  className="rounded-lg border border-line px-2 py-1 text-xs text-foreground transition-colors hover:bg-subtle disabled:opacity-50"
                >
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => dismiss(c)}
                  disabled={pending}
                  className="rounded-lg px-2 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-50"
                >
                  Dismiss
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {err ? <p className="mt-1 text-xs text-danger">{err}</p> : null}
    </div>
  );
}
