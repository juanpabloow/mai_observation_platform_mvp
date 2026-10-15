"use client";

import { artistInitials, artistTone, type ArtistChoice } from "@/lib/publicBookingFlow";
import { bioLead } from "@/lib/staffPublicProfile";
import { BTN_PRIMARY_SM, BTN_SECONDARY, IconCheck, IconShuffle, LINK_BTN, Portrait, RatingButton, ring, SERIF, type StaffOption } from "./ui";

/**
 * STEP 2 — Elige a tu artista. Its own step, apart from the service and the date.
 * "Sin preferencia" lets the ENGINE assign whoever is free when the booking is confirmed
 * (no staff_id is sent) — nothing here picks someone arbitrarily. "Ver perfil" and
 * "Elegir" are separate actions: opening a profile never changes the choice. The rating
 * sits next to the name ("★ 4,8 (4 reseñas)") and opens THAT artist's recent reviews —
 * it is shown only when they have approved ones, never a placeholder.
 */
export function ArtistStep({
  serviceName,
  staff,
  state,
  selected,
  notice,
  onPick,
  onView,
  onRetry,
  onOpenReviews,
}: {
  serviceName: string;
  staff: StaffOption[];
  state: "idle" | "loading" | "loaded" | "error";
  selected: ArtistChoice;
  notice: string | null;
  onPick: (choice: Exclude<ArtistChoice, null>) => void;
  onView: (id: string, trigger: HTMLElement) => void;
  onRetry: () => void;
  onOpenReviews: (artist: StaffOption, trigger: HTMLElement) => void;
}) {
  const anySel = selected === "any";
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[14.5px] leading-[1.45] text-pb-muted">
        Para <span className="font-[590] text-pb-ink">{serviceName}</span>.
      </p>
      {notice ? (
        <div role="status" className="flex items-start gap-2.5 rounded-[12px] border border-pb-warn-bd bg-pb-warn-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-warn-fg">
          <span>{notice}</span>
        </div>
      ) : null}
      {/* One full-width row per option (avatar · who · action), like a staff list. */}
      <div role="group" aria-label="Artista" className="flex flex-col gap-2.5">
        {state === "loaded" && staff.length === 0 ? null : (
          <div className={`pb-rise flex items-center gap-3.5 rounded-[16px] p-3.5 sm:gap-4 sm:p-4 ${ring(anySel)}`}>
            <span aria-hidden className="flex size-16 flex-none items-center justify-center rounded-full bg-pb-lav sm:size-20">
              <IconShuffle />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`${SERIF} text-[21px] leading-[1.15] sm:text-[23px]`}>Sin preferencia</span>
              <span className="text-[13.5px] leading-[1.4] text-pb-muted">Te asignamos un artista disponible.</span>
            </div>
            <button
              type="button"
              aria-pressed={anySel}
              aria-label={anySel ? "Sin preferencia, elegido" : "Elegir sin preferencia"}
              onClick={() => onPick("any")}
              className={`flex-none ${anySel ? BTN_PRIMARY_SM : BTN_SECONDARY}`}
            >
              {anySel ? "Elegido" : "Elegir"}
            </button>
          </div>
        )}

        {state === "loading" || state === "idle"
          ? [0, 1].map((k) => <div key={k} aria-hidden className="pb-skel h-[112px] rounded-[16px]" />)
          : null}

        {staff.map((a, i) => {
          const sel = selected === a.id;
          return (
            <article key={a.id} style={{ ["--i" as string]: i + 1 }} className={`pb-rise flex items-center gap-3.5 rounded-[16px] p-3.5 sm:gap-4 sm:p-4 ${ring(sel)}`}>
              <div className="relative flex-none">
                <Portrait
                  photoUrl={a.photo_url}
                  initials={artistInitials(a.name)}
                  tone={artistTone(a.id)}
                  label={a.photo_url ? `Foto de ${a.name}` : `${a.name}, sin foto`}
                  className="size-16 overflow-hidden rounded-full sm:size-20"
                  initialsClass="text-[24px] sm:text-[28px]"
                />
                {sel ? (
                  <span aria-hidden className="pb-pop absolute -right-0.5 -top-0.5 flex size-6 items-center justify-center rounded-full border-2 border-white bg-pb-ink">
                    <IconCheck size={12} width={2.4} />
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2.5">
                  <h2 className={`${SERIF} m-0 truncate text-[21px] leading-[1.15] sm:text-[23px]`}>{a.name}</h2>
                  {a.rating ? <RatingButton rating={a.rating} label={a.name} onOpen={(t) => onOpenReviews(a, t)} /> : null}
                </div>
                {a.title ? <span className="line-clamp-2 text-[13.5px] leading-[1.35] text-pb-muted">{a.title}</span> : null}
                {/* Only the business's approved public presentation — nothing is made up. */}
                {a.bio ? <p className="m-0 line-clamp-2 text-[13.5px] leading-[1.45] text-pb-tx2">{bioLead(a.bio)}</p> : null}
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-label={`Ver perfil de ${a.name}`}
                  onClick={(e) => onView(a.id, e.currentTarget)}
                  className={`${LINK_BTN} -mb-2 -ml-2 self-start`}
                >
                  Ver perfil
                </button>
              </div>
              <button
                type="button"
                aria-pressed={sel}
                aria-label={sel ? `${a.name}, elegido` : `Elegir a ${a.name}`}
                onClick={() => onPick(a.id)}
                className={`flex-none ${sel ? BTN_PRIMARY_SM : BTN_SECONDARY}`}
              >
                {sel ? "Elegido" : "Elegir"}
              </button>
            </article>
          );
        })}
      </div>

      {state === "error" ? (
        <div role="alert" className="flex flex-col items-start gap-2.5 rounded-[16px] border border-pb-line bg-white p-4 text-[14px] leading-[1.45] text-pb-muted">
          No pudimos cargar los artistas. Puedes reintentar o reservar sin preferencia.
          <button type="button" onClick={onRetry} className={BTN_SECONDARY}>
            Reintentar
          </button>
        </div>
      ) : null}
      {state === "loaded" && staff.length === 0 ? (
        <p className="m-0 text-[14px] leading-[1.45] text-pb-muted">Ningún artista ofrece este servicio en línea por ahora. Elige otro servicio.</p>
      ) : null}
    </div>
  );
}
