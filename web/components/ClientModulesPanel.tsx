"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setClientModuleAction } from "@/lib/clientModuleActions";

/**
 * Per-client module cards (Phase 2: configuration only). One card per registered
 * module with an accessible switch. The visual state flips ONLY after the server
 * action succeeds (no optimistic flip → no lying UI on failure), a single
 * in-flight save blocks all switches (no concurrent/double toggles), and errors
 * are the action's sanitized messages. Enforcement of these toggles (hiding
 * surfaces, guarding APIs) is deliberately NOT claimed here — that's Phase 3.
 */

export interface ModuleState {
  key: string;
  enabled: boolean;
}

const MODULE_COPY: Record<string, { name: string; description: string }> = {
  crm: {
    name: "CRM",
    description: "Contacts, leads, customer history, and conversation attribution.",
  },
  scheduling: {
    name: "Scheduling",
    description: "Agenda, services, staff, availability, and appointments.",
  },
};

export function ClientModulesPanel({
  clientId,
  initialModules,
}: {
  clientId: string;
  initialModules: ModuleState[];
}) {
  const router = useRouter();
  const [modules, setModules] = useState<ModuleState[]>(initialModules);
  /** Key currently being saved — while set, EVERY switch is inert. */
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (key: string, next: boolean) => {
    if (savingKey) return; // one save at a time — no concurrent/double toggles
    setSavingKey(key);
    setError(null);
    try {
      const result = await setClientModuleAction({ clientId, moduleKey: key, enabled: next });
      if (result.ok) {
        // Flip the visual state only on confirmed success.
        setModules((prev) => prev.map((m) => (m.key === key ? { ...m, enabled: result.module.enabled } : m)));
        router.refresh();
      } else {
        setError(result.error);
      }
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" aria-live="polite" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {modules.map((m) => {
        const copy = MODULE_COPY[m.key] ?? { name: m.key, description: "" };
        const saving = savingKey === m.key;
        return (
          <section
            key={m.key}
            className="flex items-start justify-between gap-4 rounded-xl border border-line bg-card p-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{copy.name}</h2>
                <span
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    m.enabled ? "bg-success/15 text-success" : "bg-subtle text-muted"
                  }`}
                >
                  {m.enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{copy.description}</p>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={m.enabled}
              aria-busy={saving}
              aria-label={`${copy.name} ${m.enabled ? "enabled" : "disabled"}`}
              disabled={savingKey !== null}
              onClick={() => void toggle(m.key, !m.enabled)}
              className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-60 ${
                m.enabled ? "border-accent bg-accent/80" : "border-line-strong bg-subtle"
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-0.5 rounded-full bg-white shadow transition-all ${
                  m.enabled ? "left-[calc(100%-1.375rem)]" : "left-0.5"
                } ${saving ? "animate-pulse" : ""}`}
                style={{ width: "1.125rem", height: "1.125rem" }}
              />
            </button>
          </section>
        );
      })}

      <p className="text-xs text-faint">Existing data is preserved when a module is disabled.</p>
    </div>
  );
}
