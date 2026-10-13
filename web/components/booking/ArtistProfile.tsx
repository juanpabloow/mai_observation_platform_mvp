"use client";

import { useEffect, useRef } from "react";
import { artistInitials, artistTone } from "@/lib/publicBookingFlow";
import { CTA_BASE, ctaTone, IconBack, Portrait, SERIF, type ServiceOption, type StaffOption } from "./ui";

/**
 * The artist's PROFILE — a full view on the phone, a centred dialog on desktop (CSS in
 * globals.css, `.pb-dialog`). Native <dialog> + showModal(): focus is trapped and the
 * page behind is inert. Back, Escape or a tap outside close it WITHOUT changing the
 * choice; only "Elegir a …" picks. On close, focus returns to the "Ver perfil" that
 * opened it.
 */
export function ArtistProfile({
  artist,
  siteName,
  services,
  isChosen,
  onClose,
  onChoose,
  returnFocusTo,
}: {
  artist: StaffOption | null;
  siteName: string;
  services: ServiceOption[];
  isChosen: boolean;
  onClose: () => void;
  onChoose: (id: string) => void;
  returnFocusTo: HTMLElement | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The trigger outlives the prop (the parent clears it as it closes) and Safari does not
  // focus a button on click, so the native restore cannot be relied on.
  const trigger = useRef<HTMLElement | null>(null);
  const open = Boolean(artist);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      trigger.current = returnFocusTo;
      d.showModal();
      closeBtn.current?.focus();
    } else if (!open && d.open) {
      d.close();
      const t = trigger.current;
      trigger.current = null;
      // close() takes the dialog out of the top layer synchronously, so the page is no
      // longer inert here and the trigger can take focus right away.
      t?.focus();
    }
  }, [open, returnFocusTo]);

  const performs = artist ? services.filter((s) => artist.service_ids.includes(s.id)) : [];

  return (
    <dialog
      ref={ref}
      className="pb-dialog"
      aria-labelledby="pb-profile-name"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the <dialog> itself (desktop).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {artist ? (
        <>
          <div className="flex flex-none items-center gap-2.5 px-4 py-3">
            <button
              ref={closeBtn}
              type="button"
              aria-label="Volver sin elegir"
              onClick={onClose}
              className="flex size-11 flex-none items-center justify-center rounded-full border border-pb-line2 bg-white p-0 text-pb-ink"
            >
              <IconBack />
            </button>
            <span className="text-[15px] font-[590]">Perfil del artista</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-5">
            <div className="flex items-center gap-4 pt-1">
              <Portrait
                photoUrl={artist.photo_url}
                initials={artistInitials(artist.name)}
                tone={artistTone(artist.id)}
                label={artist.photo_url ? `Foto de ${artist.name}` : `${artist.name}, sin foto`}
                className="size-24 flex-none overflow-hidden rounded-full lg:size-28"
                initialsClass="text-[34px]"
              />
              <div className="flex min-w-0 flex-col gap-1">
                <h2 id="pb-profile-name" className={`${SERIF} m-0 text-[34px] leading-none [overflow-wrap:anywhere]`}>
                  {artist.name}
                </h2>
                <span className="text-[14px] text-pb-muted">{[artist.title, siteName].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
            {artist.bio ? <p className="m-0 whitespace-pre-line text-[16px] leading-[1.6] text-pb-body">{artist.bio}</p> : null}
            {performs.length > 0 ? (
              <div className="flex flex-col gap-2.5">
                <h3 className="m-0 text-[14px] font-[590]">Servicios que realiza</h3>
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
                  {performs.map((s) => (
                    <li key={s.id} className="rounded-[8px] bg-pb-sf2 px-2.5 py-1.5 text-[13.5px] text-pb-body">
                      {s.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className="flex-none border-t border-pb-line bg-white px-4 pb-[calc(14px+env(safe-area-inset-bottom))] pt-3">
            <button type="button" onClick={() => onChoose(artist.id)} className={`${CTA_BASE} ${ctaTone("on")} w-full`}>
              {isChosen ? `Seguir con ${artist.name}` : `Elegir a ${artist.name}`}
            </button>
          </div>
        </>
      ) : null}
    </dialog>
  );
}
