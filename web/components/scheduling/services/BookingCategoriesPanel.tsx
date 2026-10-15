"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CATEGORY_NAME_MAX, CATEGORY_TAGLINE_MAX, checkCategoryInput } from "@/lib/bookingPage";
import { deleteBookingCategoryAction, saveBookingCategoryAction } from "@/lib/schedulingAdminActions";
import type { BookingCategory } from "../AdminPanel";
import { Alert, Button, CARD, CheckRow, Field, INPUT } from "../ui/system";

/**
 * "Página de reservas · Categorías" — the business's own groups on the public page
 * ("Entre Nubes", "Signature", "Esencial"…), in order, each with a short phrase and how
 * it is shown. Which services belong to each group is chosen in each service's editor.
 * Presentation only: hiding or deleting a group never disables a service for the agenda
 * or the bot (a deleted group's services just appear under "Otros servicios").
 */

const LAYOUT_LABEL: Record<BookingCategory["layout"], { label: string; hint: string }> = {
  list: { label: "Tarjetas", hint: "Una tarjeta por servicio." },
  featured: { label: "Destacada", hint: "Tarjeta grande con imagen. Solo se muestran servicios con imagen, descripción, qué incluye, duración y precio." },
  contact: { label: "Enlace a WhatsApp", hint: "No lista servicios: muestra la frase como enlace al WhatsApp de la sede." },
};

type Draft = { id: string | null; name: string; tagline: string; layout: BookingCategory["layout"]; sortOrder: string; visible: boolean };

export function BookingCategoriesPanel({ clientId, categories }: { clientId: string; categories: BookingCategory[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BookingCategory | null>(null);

  const open = (c: BookingCategory | null) => {
    setError(null);
    setDraft(
      c
        ? { id: c.id, name: c.name, tagline: c.tagline ?? "", layout: c.layout, sortOrder: String(c.sort_order), visible: c.visible }
        : { id: null, name: "", tagline: "", layout: "list", sortOrder: String((categories.at(-1)?.sort_order ?? -1) + 1), visible: true },
    );
  };
  const checked = draft ? checkCategoryInput(draft) : null;
  const save = () => {
    if (!draft || !checked) return;
    if (!checked.ok) return setError(checked.error);
    start(async () => {
      const r = await saveBookingCategoryAction(clientId, draft.id, draft);
      if (!r.ok) return setError(r.error);
      setDraft(null);
      router.refresh();
    });
  };
  const remove = (c: BookingCategory) =>
    start(async () => {
      const r = await deleteBookingCategoryAction(clientId, c.id);
      setConfirmDelete(null);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <section aria-labelledby="bp-cats-title" className={`p-4 sm:p-5 ${CARD}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 id="bp-cats-title" className="text-[15px] font-semibold">
            Página de reservas · Categorías
          </h3>
          <p className="mt-0.5 text-[13px] text-muted">
            Cómo se agrupan los servicios en la página pública, en este orden. Sin categorías, la página agrupa por tipo de servicio como hasta ahora.
          </p>
        </div>
        <Button onClick={() => open(null)} disabled={pending}>
          Añadir categoría
        </Button>
      </div>

      {error && !draft ? (
        <div className="mt-3">
          <Alert>{error}</Alert>
        </div>
      ) : null}

      {categories.length > 0 ? (
        <ol className="mt-4 flex flex-col divide-y divide-line rounded-sch-control border border-line">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3">
              <span className="w-8 shrink-0 text-xs tabular-nums text-faint">{c.sort_order}</span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{c.name}</span>
                  <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">{LAYOUT_LABEL[c.layout].label}</span>
                  {!c.visible ? <span className="rounded-full bg-chip px-2 py-0.5 text-[0.6875rem] text-muted">Oculta</span> : null}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {[c.tagline, c.layout === "contact" ? null : `${c.service_count} ${c.service_count === 1 ? "servicio" : "servicios"}`].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Button size="sm" onClick={() => open(c)} disabled={pending}>
                Editar
              </Button>
              <Button size="sm" variant="tertiary" onClick={() => setConfirmDelete(c)} disabled={pending}>
                Eliminar
              </Button>
            </li>
          ))}
        </ol>
      ) : null}

      {confirmDelete ? (
        <div role="alertdialog" aria-labelledby="bp-cat-del" className="mt-4 rounded-sch-control border border-line bg-subtle p-3.5">
          <p id="bp-cat-del" className="text-sm text-foreground">
            ¿Eliminar «{confirmDelete.name}»? Sus servicios siguen publicados, sin categoría.
          </p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => setConfirmDelete(null)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" onClick={() => remove(confirmDelete)} loading={pending} loadingLabel="Eliminando…">
              Eliminar
            </Button>
          </div>
        </div>
      ) : null}

      {draft ? (
        <div className="mt-4 rounded-sch-control border border-line bg-subtle/50 p-4">
          <h4 className="text-sm font-semibold">{draft.id ? "Editar categoría" : "Nueva categoría"}</h4>
          {error ? (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          ) : null}
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.4fr_10rem_6rem]">
            <Field label="Nombre">
              <input value={draft.name} maxLength={CATEGORY_NAME_MAX} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ej. Signature" className={INPUT} />
            </Field>
            <Field label="Frase" optional hint={draft.layout === "contact" ? "Es el texto del enlace." : "Se muestra bajo el nombre."}>
              <input
                value={draft.tagline}
                maxLength={CATEGORY_TAGLINE_MAX}
                onChange={(e) => setDraft({ ...draft, tagline: e.target.value })}
                placeholder={draft.layout === "contact" ? "¿Buscas color?" : "El ritual completo"}
                className={INPUT}
              />
            </Field>
            <Field label="Se muestra como" hint={LAYOUT_LABEL[draft.layout].hint}>
              <select value={draft.layout} onChange={(e) => setDraft({ ...draft, layout: e.target.value as Draft["layout"] })} className={INPUT}>
                {(Object.keys(LAYOUT_LABEL) as Array<Draft["layout"]>).map((k) => (
                  <option key={k} value={k}>
                    {LAYOUT_LABEL[k].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Orden">
              <input inputMode="numeric" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: e.target.value })} className={INPUT} />
            </Field>
          </div>
          <div className="mt-2">
            <CheckRow checked={draft.visible} onChange={() => setDraft({ ...draft, visible: !draft.visible })} hint="Oculta = no aparece en la página; sus servicios tampoco. La agenda y el agente no cambian.">
              Visible en la página
            </CheckRow>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setDraft(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={save} loading={pending} loadingLabel="Guardando…">
              Guardar categoría
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
