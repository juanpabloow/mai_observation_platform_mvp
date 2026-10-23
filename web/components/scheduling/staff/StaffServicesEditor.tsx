"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { setStaffServiceAction } from "@/lib/schedulingAdminActions";
import { useNavigationGuard } from "@/components/ui/module/useEditorGuard";
import { DiscardChanges } from "@/components/ui/module/ConfirmLayer";
import { Button, INPUT } from "../ui/system";
import type { StaffServiceOpt } from "./StaffTab";

/**
 * ASIGNAR SERVICIOS — what this professional performs (staff_services). Search, groups by
 * category, «Seleccionar todos» per group, and ONE explicit save. Removing a service never
 * changes an appointment already booked: it only stops NEW bookings of it with this person.
 * A failed save keeps the selection and says which pairings did not save.
 */
const CATEGORY_LABEL: Record<string, string> = { cut: "Corte", grooming: "Barba y cuidado", color: "Color", feature: "Tratamiento destacado" };

export function StaffServicesEditor(props: {
  clientId: string;
  staffId: string;
  staffName: string;
  services: StaffServiceOpt[];
  assigned: string[];
  canEdit: boolean;
  onSaved: (message: string) => void;
  /** Reports unsaved changes to the host (the ficha guards its tabs with it). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const active = props.services.filter((s) => s.active || props.assigned.includes(s.id));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.assigned));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const initial = useMemo(() => new Set(props.assigned), [props.assigned]);
  const toAdd = [...selected].filter((id) => !initial.has(id));
  const toRemove = [...initial].filter((id) => !selected.has(id));
  const dirty = toAdd.length + toRemove.length > 0;
  const nav = useNavigationGuard({ dirty, onAsk: () => setAsking(true) });
  const onDirtyChange = props.onDirtyChange;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const q = query.trim().toLocaleLowerCase("es");
  const groups = useMemo(() => {
    const m = new Map<string, StaffServiceOpt[]>();
    for (const s of active) {
      if (q && !s.name.toLocaleLowerCase("es").includes(q)) continue;
      const k = s.category ?? "other";
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()].sort((a, b) => (CATEGORY_LABEL[a[0]] ?? "Otros").localeCompare(CATEGORY_LABEL[b[0]] ?? "Otros"));
  }, [active, q]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    if (sending.current || !dirty) return;
    sending.current = true;
    setError(null);
    startTransition(async () => {
      const failed: string[] = [];
      try {
        for (const id of toAdd) {
          const r = await setStaffServiceAction(props.clientId, props.staffId, id, true);
          if (!r.ok) failed.push(active.find((s) => s.id === id)?.name ?? id);
        }
        for (const id of toRemove) {
          const r = await setStaffServiceAction(props.clientId, props.staffId, id, false);
          if (!r.ok) failed.push(active.find((s) => s.id === id)?.name ?? id);
        }
      } catch {
        failed.push("la conexión");
      } finally {
        sending.current = false;
      }
      if (failed.length > 0) setError(`No se guardó: ${failed.join(", ")}. Tu selección sigue aquí; vuelve a intentarlo.`);
      else props.onSaved(`Servicios guardados · ${props.staffName}`);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${INPUT} max-w-sm`} placeholder="Buscar servicio" aria-label="Buscar servicio" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="text-[13px] text-muted">
          {selected.size} de {active.length} servicios
        </span>
      </div>
      {groups.length === 0 ? <p className="text-[13px] text-muted">Ningún servicio coincide con «{query}».</p> : null}
      {groups.map(([cat, list]) => {
        const all = list.every((s) => selected.has(s.id));
        return (
          <section key={cat} aria-labelledby={`svc-${cat}`} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <h4 id={`svc-${cat}`} className="min-w-0 flex-1 text-[12.5px] font-semibold uppercase tracking-[0.06em] text-muted">
                {CATEGORY_LABEL[cat] ?? "Otros"}
              </h4>
              {props.canEdit ? (
                <button
                  type="button"
                  className="u-focus rounded text-[12.5px] font-medium hover:underline"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const s of list) {
                        if (all) next.delete(s.id);
                        else next.add(s.id);
                      }
                      return next;
                    })
                  }
                >
                  {all ? "Quitar todos" : "Seleccionar todos"}
                </button>
              ) : null}
            </div>
            <ul className="divide-y divide-line-soft rounded-[12px] border border-line">
              {list.map((s) => {
                const on = selected.has(s.id);
                return (
                  <li key={s.id}>
                    <label className={`flex min-h-[48px] items-center gap-3 px-3.5 py-2 ${props.canEdit ? "cursor-pointer hover:bg-subtle" : ""}`}>
                      <input type="checkbox" checked={on} disabled={!props.canEdit} onChange={() => toggle(s.id)} className="size-4 accent-[var(--foreground)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{s.name}</span>
                        <span className="block text-[12px] text-muted">
                          {s.durationMin} min{!s.active ? " · inactivo en el catálogo" : ""}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="text-[12.5px] text-muted">Quitar un servicio no cambia las citas ya reservadas: solo deja de ofrecerse con {props.staffName}.</p>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
      {props.canEdit && dirty ? (
        <div className="sticky bottom-0 z-10 flex items-center gap-2 rounded-[12px] border border-line bg-surface px-3 py-2.5 shadow-[var(--shadow-float)]">
          <span className="min-w-0 flex-1 text-[13px] text-muted">
            {toAdd.length + toRemove.length} {toAdd.length + toRemove.length === 1 ? "cambio" : "cambios"} sin guardar
          </span>
          <Button onClick={() => setAsking(true)} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={pending} loadingLabel="Guardando…">
            {error ? "Reintentar" : "Guardar servicios"}
          </Button>
        </div>
      ) : null}
      {asking ? (
        <DiscardChanges
          onKeep={() => {
            setAsking(false);
            nav.forget();
          }}
          onDiscard={() => {
            setAsking(false);
            setSelected(new Set(props.assigned));
            setError(null);
            if (nav.hasPending()) nav.follow();
          }}
        />
      ) : null}
    </div>
  );
}
