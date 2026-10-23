"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { setStaffServiceAction } from "@/lib/schedulingAdminActions";
import { Button } from "../ui/system";
import { SidePanel, type SidePanelHandle } from "../agenda/SidePanel";
import type { StaffServiceOpt } from "./StaffTab";

/**
 * SERVICIOS DE UN PROFESIONAL (reference f58). The ficha's tab is the READ list — every
 * service of the catalogue, the ones they perform ticked — and «Editar servicios» opens
 * «Servicios que realiza»: search, groups by category with «Seleccionar todos / Quitar
 * todos», and ONE explicit save (staff_services). Removing a service never changes an
 * appointment already booked: it only stops NEW bookings of it with this person. A failed
 * save keeps the selection and says which pairings did not save. Closing with changes asks.
 */
const CATEGORY_LABEL: Record<string, string> = { cut: "Corte", grooming: "Barba y cuidado", color: "Color", feature: "Tratamiento destacado" };
const CATEGORY_DOT: Record<string, string> = {
  cut: "var(--appt-cut-rule)",
  grooming: "var(--appt-grooming-rule)",
  color: "var(--appt-color-rule)",
  feature: "var(--appt-feature-rule)",
};

export function StaffServicesList(props: { services: StaffServiceOpt[]; assigned: string[]; canEdit: boolean; onEdit: () => void }) {
  const list = props.services.filter((s) => s.active || props.assigned.includes(s.id));
  return (
    <section aria-labelledby="svc-list" className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h3 id="svc-list" className="min-w-0 flex-1 text-[15px] font-medium">
          Servicios que realiza <span className="font-normal text-muted">· {props.assigned.length} de {list.length}</span>
        </h3>
        {props.canEdit ? (
          <button type="button" onClick={props.onEdit} className="u-focus inline-flex h-[36px] items-center rounded-[10px] border border-[var(--line-strong)] bg-[var(--surface)] px-3.5 text-[13.5px] font-medium hover:bg-[var(--subtle)]">
            Editar servicios
          </button>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {list.map((s) => {
          const has = props.assigned.includes(s.id);
          return (
            <li key={s.id} className={`flex items-center gap-2.5 py-2.5 text-[13.5px] shadow-[inset_0_-1px_0_var(--line-soft)] ${has ? "text-foreground" : "text-muted"}`}>
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: CATEGORY_DOT[s.category ?? ""] ?? "var(--line-strong)" }} />
              <span className="min-w-0 flex-1 truncate">
                {s.name}
                {!s.active ? <span className="text-muted"> · inactivo en el catálogo</span> : null}
              </span>
              <span className="tabular-nums text-muted">{s.durationMin} min</span>
              <span className="w-5 text-right" aria-label={has ? "Lo realiza" : "No lo realiza"}>
                {has ? "✓" : ""}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-[12.5px] text-muted">Quitar un servicio no cambia las citas ya reservadas: solo deja de ofrecerse con este profesional.</p>
    </section>
  );
}

export function StaffServicesEditor(props: {
  clientId: string;
  staffId: string;
  staffName: string;
  services: StaffServiceOpt[];
  assigned: string[];
  canEdit: boolean;
  onSaved: (message: string) => void;
  onClose: () => void;
}) {
  const active = props.services.filter((s) => s.active || props.assigned.includes(s.id));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.assigned));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const sending = useRef(false);
  const handle = useRef<SidePanelHandle | null>(null);
  const initial = useMemo(() => new Set(props.assigned), [props.assigned]);
  const toAdd = [...selected].filter((id) => !initial.has(id));
  const toRemove = [...initial].filter((id) => !selected.has(id));
  const changes = toAdd.length + toRemove.length;
  const dirty = changes > 0;

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
    <SidePanel
      name="staff-services"
      title="Servicios que realiza"
      subtitle={`${props.staffName} · ${selected.size} ${selected.size === 1 ? "seleccionado" : "seleccionados"}`}
      dirty={dirty}
      onClose={props.onClose}
      handleRef={handle}
      footer={
        <div className="flex items-center gap-2">
          <span className={`min-w-0 flex-1 truncate text-[13px] ${error ? "text-danger" : "text-muted"}`}>
            {error ?? (changes === 0 ? "Sin cambios" : `${changes} ${changes === 1 ? "cambio" : "cambios"} sin guardar`)}
          </span>
          <Button onClick={() => handle.current?.requestClose()} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty || !props.canEdit} loading={pending} loadingLabel="Guardando…">
            {error ? "Reintentar" : "Guardar"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex h-[32px] items-center gap-2 rounded-[9px] bg-[var(--chip)] px-2.5 text-muted">
          <svg aria-hidden viewBox="0 0 16 16" className="size-[14px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="7" cy="7" r="4.6" /><path d="M10.4 10.4L14 14" /></svg>
          <input type="search" className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted" placeholder="Buscar servicio" aria-label="Buscar servicio" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {groups.length === 0 ? <p className="text-[13px] text-muted">Ningún servicio coincide con «{query}».</p> : null}
        {groups.map(([cat, list]) => {
          const all = list.every((s) => selected.has(s.id));
          const n = list.filter((s) => selected.has(s.id)).length;
          return (
            <section key={cat} aria-labelledby={`svc-${cat}`} className="flex flex-col">
              <div className="flex items-center gap-2 pb-1">
                <span aria-hidden className="size-2 rounded-full" style={{ background: CATEGORY_DOT[cat] ?? "var(--line-strong)" }} />
                <h4 id={`svc-${cat}`} className="min-w-0 flex-1 text-[13px] text-[var(--ag-ink2)]">
                  {CATEGORY_LABEL[cat] ?? "Otros"} · {n} de {list.length}
                </h4>
                {props.canEdit ? (
                  <button
                    type="button"
                    className="u-focus rounded text-[13px] text-[var(--ag-ink2)] underline decoration-[var(--line-strong)] underline-offset-[3px]"
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
              <ul className="flex flex-col">
                {list.map((s) => (
                  <li key={s.id}>
                    <label className={`flex min-h-[40px] items-center gap-3 py-1 ${props.canEdit ? "cursor-pointer" : ""}`}>
                      <input type="checkbox" checked={selected.has(s.id)} disabled={!props.canEdit} onChange={() => toggle(s.id)} className="size-[18px] accent-[var(--ink)]" />
                      <span className="min-w-0 flex-1 truncate text-[14px]">
                        {s.name}
                        {!s.active ? <span className="text-muted"> · inactivo en el catálogo</span> : null}
                      </span>
                      <span className="text-[13px] tabular-nums text-muted">{s.durationMin} min</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        <p className="text-[12.5px] leading-[1.45] text-muted">Solo aparecen servicios activos de la sede. Al quitar un servicio, sus citas ya reservadas no cambian.</p>
      </div>
    </SidePanel>
  );
}
