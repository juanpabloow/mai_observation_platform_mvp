"use client";

import Link from "next/link";
import { EmptyState, NoResults } from "@/components/ui/module/States";
import { buttonClass } from "@/components/ui/controls";

/**
 * The contacts list with nothing to show, in the approved module states (auditoría UI
 * 2026-11-03, F04) instead of the old dashed hairline with a green link:
 *
 *   filtered    the search or a filter hides everyone → «Sin resultados» + a way back
 *   empty       the business has no contacts yet     → where they come from
 *
 * The two never mix: an empty search must not read as «no tienes contactos». No «Nuevo
 * contacto» here — the header's primary action is the same button, one line up.
 */
export function ContactsEmptyState({ filtered, clearHref }: { filtered: boolean; clearHref: string }) {
  if (filtered) {
    return (
      <NoResults body="Ningún contacto coincide con la búsqueda o los filtros.">
        <Link href={clearHref} className={buttonClass()}>
          Limpiar búsqueda y filtros
        </Link>
      </NoResults>
    );
  }
  return (
    <EmptyState
      title="Todavía no hay contactos"
      body="Las personas aparecen aquí en cuanto un flujo, una reserva o un agente las crea, o cuando agregas una con «Nuevo contacto»."
    />
  );
}
