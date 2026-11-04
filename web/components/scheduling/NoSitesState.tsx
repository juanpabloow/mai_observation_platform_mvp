"use client";

import Link from "next/link";
import { EmptyState } from "@/components/ui/module/States";
import { buttonClass } from "@/components/ui/controls";
import { schedulingHref } from "@/lib/schedulingNav";

/**
 * «Aún no hay sedes» — the ONE empty state of every scheduling screen that needs a site
 * before it can show anything (auditoría UI 2026-11-03, F04).
 *
 * Agenda, Equipo, Horarios, Reglas, Ocupación and Página de reservas each drew their own:
 * a dashed frame with a green link, a grey band, a lone centred sentence, one with no page
 * header at all, and two pointing at «Configuración de agenda», which no longer exists.
 * They are now the approved pattern Sedes already uses (ui/module/States EmptyState: icon,
 * title, explanation, action), and the screen keeps its own header around it.
 *
 * The ACTION FOLLOWS THE PERMISSION. Only a login with `settings.sites` gets «Ir a Sedes»;
 * everyone else is told who can do it, never shown a button that would fail. The page
 * still gates itself on the server — this only decides what is offered.
 */
export function NoSitesState({
  clientId,
  canManageSites,
  reason,
}: {
  clientId: string;
  /** can(scope, "settings.sites", clientId), resolved on the server. */
  canManageSites: boolean;
  /** Why THIS screen needs a site, in one sentence («Las citas se agendan en una sede.»). */
  reason: string;
}) {
  return (
    <EmptyState
      title="Aún no hay sedes"
      body={
        canManageSites
          ? `${reason} Crea la primera en Sedes, con su horario.`
          : `${reason} Pide a quien administra el negocio que cree la primera.`
      }
    >
      {canManageSites ? (
        // `max-lg:min-h-[44px]`: inside the agenda family (`.u-ag`: Equipo, Horarios) the
        // compact density shrinks buttons to 32px from 768px, which on a tablet is a touch
        // screen. A 44px floor below lg keeps the target; desktop keeps its density.
        <Link href={schedulingHref(clientId, "sites")} className={buttonClass({ variant: "primary", className: "max-lg:min-h-[44px]" })}>
          Ir a Sedes
        </Link>
      ) : null}
    </EmptyState>
  );
}
