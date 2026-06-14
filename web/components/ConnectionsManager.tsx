"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { addConnectionAction, setConnectionActiveAction } from "@/lib/connectionActions";

export interface ConnectionView {
  id: string;
  name: string;
  n8n_base_url: string;
  is_active: boolean;
}

export function ConnectionsManager({ connections }: { connections: ConnectionView[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await addConnectionAction({ name, baseUrl, apiKey });
      if (!res.ok) {
        setError(res.error ?? "Could not add the connection.");
        return;
      }
      // Clear inputs — especially the key — from client state on success.
      setName("");
      setBaseUrl("");
      setApiKey("");
      setOk(true);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, isActive: boolean) {
    setBusy(true);
    try {
      await setConnectionActiveAction({ id, isActive });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {connections.length > 0 ? (
        <ul className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 dark:divide-white/5 dark:border-white/10">
          {connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                      c.is_active
                        ? "bg-green-500/15 text-green-400"
                        : "bg-white/10 text-neutral-500"
                    }`}
                  >
                    {c.is_active ? "active" : "inactive"}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-neutral-500">
                  {c.n8n_base_url} · key ••••••••
                </div>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => toggle(c.id, !c.is_active)}
                className="shrink-0 rounded-lg border border-black/10 px-3 py-1.5 text-sm transition-colors hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/[0.06]"
              >
                {c.is_active ? "Deactivate" : "Activate"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <form
        onSubmit={onAdd}
        className="flex flex-col gap-3 rounded-xl border border-black/10 p-4 dark:border-white/10"
      >
        <h3 className="text-sm font-semibold">Add a connection</h3>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">Name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production n8n"
            className="rounded-lg border border-white/10 bg-transparent px-3 py-2 outline-none focus:border-white/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">n8n base URL</span>
          <input
            required
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-n8n.example.com"
            className="rounded-lg border border-white/10 bg-transparent px-3 py-2 outline-none focus:border-white/30"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-400">n8n API key</span>
          <input
            required
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="n8n_api_…"
            className="rounded-lg border border-white/10 bg-transparent px-3 py-2 font-mono outline-none focus:border-white/30"
          />
          <span className="text-xs text-neutral-600">
            Stored encrypted; we verify it works before saving and never show it again.
          </span>
        </label>

        {error ? (
          <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        {ok ? (
          <p className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-400">
            Connection added — the worker will start ingesting shortly.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Verifying…" : "Add connection"}
        </button>
      </form>
    </div>
  );
}
