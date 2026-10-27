"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setInboxAutoReturnMinutesAction } from "@/lib/inboxSettingsActions";

/**
 * JP-2 — per-client "return an unattended conversation to the bot" threshold. Agency or Client Owner
 * only (the page + the action both gate). 0 = never. The field is minutes; a small hint reads the
 * current value back in hours for the common case.
 */
export function InboxSettingsPanel({ clientId, initialMinutes }: { clientId: string; initialMinutes: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialMinutes));
  const [saved, setSaved] = useState(initialMinutes);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const n = Number(value);
  const valid = /^\d+$/.test(value.trim()) && Number.isInteger(n) && n >= 0 && n <= 10080;
  const dirty = valid && n !== saved;

  const hint =
    !valid ? "Un número de minutos entre 0 y 10080." :
    n === 0 ? "Nunca se devuelve al bot automáticamente." :
    n % 60 === 0 ? `${n} minutos (${n / 60} h).` : `${n} minutos.`;

  const save = () => {
    if (!dirty || pending) return;
    setError(null);
    setDone(false);
    start(async () => {
      const r = await setInboxAutoReturnMinutesAction(clientId, n);
      if (!r.ok) { setError(r.error); return; }
      setSaved(r.value);
      setValue(String(r.value));
      setDone(true);
      router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line p-5">
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold tracking-tight">Devolver al bot sin atención</h2>
        <p className="text-sm text-muted">
          Si nadie atiende una conversación escalada, o quien la tomó deja de responder, vuelve al bot
          automáticamente pasado este tiempo. <strong className="text-foreground">0 = nunca</strong>.
        </p>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Minutos sin atención</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={10080}
          step={5}
          value={value}
          onChange={(e) => { setValue(e.target.value); setDone(false); }}
          className="u-focus h-[38px] w-[140px] rounded-[9px] border border-line-strong bg-transparent px-3 tabular-nums outline-none"
          aria-describedby="ar-hint"
        />
        <span id="ar-hint" className="text-[12.5px] text-muted">{hint}</span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {pending ? "Guardando…" : "Guardar"}
        </button>
        <span role="status" aria-live="polite" className={`text-[13px] ${error ? "text-danger" : "text-muted"}`}>
          {error ?? (pending ? "" : done ? "Guardado" : dirty ? "Sin guardar" : "")}
        </span>
      </div>
    </section>
  );
}
