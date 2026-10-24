"use client";

import type { CardParts } from "../agenda/AppointmentCard";
import { Icon, ICON, Sheet } from "./kit";

/**
 * The appointment DETAIL on the phone: the shared AppointmentCard (card language 5a — the
 * same sections, states, permissions and actions as the desktop panel) inside the bottom sheet
 * that opens part-way and expands from its handle (tap or drag). Header: the service-colour
 * bar, the client and «Vie 23 oct · 12:00 – 12:45 · 45 min»; the footer stays above the safe
 * area with the secondary action and the ONE next step. Cancel and no-show confirm in place,
 * inside the card, with the safe option first and focused.
 *
 * Phone-only rows (Sede, the automatic colour) come from AppointmentPanel; the card has no
 * per-appointment manual colour and no internal note — neither exists in the product.
 */
export function MobileAppointmentSheet({ parts, onClose }: { parts: CardParts; onClose: () => void }) {
  return (
    <Sheet
      open
      onClose={onClose}
      label="Detalle de la cita"
      expandable
      tone="card"
      header={
        <div className="c5-head flex-none pt-0">
          <div className="flex items-center gap-3">
            {parts.leading}
            <h2 className="c5-title min-w-0 flex-1 break-words">{parts.title}</h2>
            <button type="button" aria-label="Cerrar detalle" title="Cerrar" onClick={onClose} className="u-focus c5-x">
              <Icon d={ICON.close} size={16} width={1.6} />
            </button>
          </div>
          {parts.meta}
        </div>
      }
      footer={parts.footer}
      bodyClassName="c5-body"
    >
      {parts.body}
    </Sheet>
  );
}
