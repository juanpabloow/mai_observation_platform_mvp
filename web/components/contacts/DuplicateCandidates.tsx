"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergeContactsAction, dismissCandidateAction } from "@/lib/contactActions";

export interface CandidateView {
  id: string;
  contact_id_keep: string;
  keep_name: string | null;
  keep_ref: string;
  contact_id_duplicate: string;
  dup_name: string | null;
  dup_ref: string;
  reason: string | null;
}

/**
 * Owner/admin-only "Possible duplicates" section (C-2). Plain styling — C-4 restyles.
 * Merge keeps the survivor (the older contact) and moves the duplicate's history into
 * it; Dismiss marks the pair "not the same person". Both are server-action gated.
 */
export function DuplicateCandidates({ clientId, candidates }: { clientId: string; candidates: CandidateView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  if (candidates.length === 0) return null;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setErr(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setErr(r.error ?? "Failed.");
      else router.refresh();
    });
  };

  return (
    <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
      <h2 className="text-sm font-semibold text-amber-700 dark:text-amber-400">
        Possible duplicates ({candidates.length})
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        Same identity value across two contacts. New activity attaches to the survivor; merge to combine histories.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {candidates.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm">
            <span className="min-w-0">
              <strong>Keep:</strong> {c.keep_name ?? c.keep_ref}{" "}
              <span className="text-faint">↔</span> <strong>Duplicate:</strong> {c.dup_name ?? c.dup_ref}
              <span className="ml-2 text-[11px] text-faint">({c.reason})</span>
            </span>
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => mergeContactsAction(clientId, c.contact_id_keep, c.contact_id_duplicate))}
                className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
              >
                Merge
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => dismissCandidateAction(clientId, c.id))}
                className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:bg-subtle disabled:opacity-50"
              >
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
      {err ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p> : null}
    </section>
  );
}
