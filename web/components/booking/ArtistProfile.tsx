"use client";

import { useEffect, useRef, useState } from "react";
import { ratingText, relativeWhen, reviewCountText } from "@/lib/publicReviews";
import { artistInitials, artistTone } from "@/lib/publicBookingFlow";
import { CTA_BASE, ctaTone, IconBack, IconStar, Portrait, SERIF, type ServiceOption, type StaffOption } from "./ui";

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
  // "Ver más reseñas" belongs to ONE artist: opening another profile starts collapsed.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const allReviews = artist !== null && expandedFor === artist.id;
  const reviews = artist?.reviews ?? [];
  const shown = allReviews ? reviews : reviews.slice(0, 3);

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
                {artist.rating ? (
                  <span className="mt-1 flex items-center gap-1.5 text-[15px]">
                    <IconStar size={16} />
                    <span className="font-semibold [font-variant-numeric:tabular-nums]">{ratingText(artist.rating.average)}</span>
                    <span className="text-pb-muted">· {reviewCountText(artist.rating.count)}</span>
                  </span>
                ) : null}
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
            {reviews.length > 0 ? (
              <section aria-label="Reseñas" className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h3 className="m-0 text-[14px] font-[590]">Reseñas</h3>
                  <span className="text-[12.5px] text-pb-muted">De clientes con una cita completada</span>
                </div>
                {shown.map((rv, i) => (
                  <article key={`${rv.submitted_at}-${i}`} className="flex flex-col gap-1.5 rounded-[16px] border border-pb-line bg-white p-3.5">
                    <div className="flex items-center gap-2.5">
                      <span aria-hidden className="flex size-8 flex-none items-center justify-center rounded-full bg-pb-sf2 text-[12px] font-semibold">
                        {rv.author.split(/\s+/).map((w) => w.charAt(0)).join("").slice(0, 2)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[14px] font-[590]">{rv.author}</span>
                        <span className="truncate text-[12.5px] text-pb-muted">
                          {rv.service} · {relativeWhen(rv.submitted_at)}
                        </span>
                      </span>
                      <span aria-label={`${rv.rating} de 5 estrellas`} className="flex flex-none gap-px">
                        {Array.from({ length: rv.rating }, (_, k) => (
                          <IconStar key={k} />
                        ))}
                      </span>
                    </div>
                    {rv.comment ? <p className="m-0 whitespace-pre-line text-[14.5px] leading-[1.5] text-pb-body">{rv.comment}</p> : null}
                  </article>
                ))}
                {reviews.length > 3 ? (
                  <button
                    type="button"
                    onClick={() => setExpandedFor(allReviews ? null : artist.id)}
                    className="inline-flex min-h-11 self-start items-center rounded-[12px] border border-pb-line2 bg-white px-4 text-[14.5px] text-pb-ink"
                  >
                    {allReviews ? "Ver menos" : "Ver más reseñas"}
                  </button>
                ) : null}
              </section>
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
