"use client";

import { artistInitials, artistTone, type ArtistChoice } from "@/lib/publicBookingFlow";
import { bioLead } from "@/lib/staffPublicProfile";
import { BTN_SECONDARY, chooseBtn, IconCheck, IconShuffle, Portrait, RatingButton, ring, SERIF, type StaffOption } from "./ui";

/**
 * STEP 2 — Elige a tu artista. Its own step, apart from the service and the date.
 * "Sin preferencia" lets the ENGINE assign whoever is free when the booking is confirmed
 * (no staff_id is sent) — nothing here picks someone arbitrarily. "Ver perfil" and
 * "Elegir" are separate actions: opening a profile never changes the choice. The rating
 * sits on the portrait as a pill over its lower edge, compact ("★ 4,8 (4)", full sentence
 * as its accessible name), and
 * opens THAT artist's recent reviews — shown only when they have approved ones. Missing
 * pieces (photo → monogram, title, bio, rating) are simply omitted, never invented.
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
      {/* One card per row. Each card is an <article> with SIBLING buttons — never a button
          inside a button: a quiet "Ver perfil" text only opens the profile; "Elegir" (the one
          real button) chooses. Selected = black border + ✓ on the portrait + "Elegido", in the
          same box (chooseBtn), so nothing changes size. */}
      <div role="group" aria-label="Artista" className="flex flex-col gap-2.5">
        {state === "loaded" && staff.length === 0 ? null : (
          <div className={`pb-rise flex items-center gap-3 rounded-[16px] px-3.5 py-3 ${ring(anySel)}`}>
            <span aria-hidden className="relative flex size-11 flex-none items-center justify-center rounded-full bg-pb-lav">
              <IconShuffle />
              {anySel ? <SelectedDot /> : null}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[16px] font-[590] leading-[1.3]">Sin preferencia</span>
              <span className="text-[13.5px] leading-[1.4] text-pb-muted">Te asignamos un artista disponible.</span>
            </div>
            <button
              type="button"
              aria-pressed={anySel}
              aria-label={anySel ? "Sin preferencia, elegido" : "Elegir sin preferencia"}
              onClick={() => onPick("any")}
              className={`flex-none ${chooseBtn(anySel, "sm")}`}
            >
              <ChooseLabel selected={anySel} />
            </button>
          </div>
        )}

        {state === "loading" || state === "idle"
          ? [0, 1].map((k) => <div key={k} aria-hidden className="pb-skel h-[196px] rounded-[16px]" />)
          : null}

        {staff.map((a, i) => {
          const sel = selected === a.id;
          return (
            <article
              key={a.id}
              aria-label={a.name}
              style={{ ["--i" as string]: i + 1 }}
              className={`pb-rise flex flex-col gap-3 rounded-[16px] p-4 lg:grid lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center lg:gap-x-5 lg:gap-y-1 lg:[grid-template-areas:'photo_info_actions'_'photo_bio_actions'] ${ring(sel)}`}
            >
              <div className="flex items-center gap-4 lg:contents">
                {/* The rating sits ON the portrait, as a pill over its lower edge. */}
                <div className={`relative flex-none ${a.rating ? "pb-2.5" : ""} lg:[grid-area:photo]`}>
                  <Portrait
                    photoUrl={a.photo_url}
                    initials={artistInitials(a.name)}
                    tone={artistTone(a.id)}
                    label={a.photo_url ? `Foto de ${a.name}` : `${a.name}, sin foto`}
                    className="size-20 overflow-hidden rounded-full"
                    initialsClass="text-[28px]"
                  />
                  {sel ? <SelectedDot /> : null}
                  {a.rating ? (
                    <span className="absolute bottom-0 left-1/2 z-10 flex -translate-x-1/2 items-center whitespace-nowrap rounded-full border border-pb-line bg-white px-2 py-0.5 shadow-[0_1px_4px_rgba(17,19,22,0.12)]">
                      <RatingButton rating={a.rating} label={a.name} onOpen={(t) => onOpenReviews(a, t)} />
                    </span>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1 lg:self-end lg:[grid-area:info]">
                  <h2 className={`${SERIF} m-0 text-[23px] leading-[1.12] [overflow-wrap:anywhere] [text-wrap:balance]`}>{a.name}</h2>
                  {a.title ? <span className="line-clamp-2 text-[14px] leading-[1.35] text-pb-muted">{a.title}</span> : null}
                  {/* A quiet text action, not a second button: only "Elegir" looks like one. */}
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={`Ver perfil de ${a.name}`}
                    onClick={(e) => onView(a.id, e.currentTarget)}
                    className="-mx-1 -my-2.5 inline-flex min-h-11 items-center self-start rounded-[8px] px-1 text-[13.5px] text-pb-tx2 hover:text-pb-ink hover:underline hover:underline-offset-[3px]"
                  >
                    Ver perfil
                  </button>
                </div>
              </div>
              {/* Only the business's approved public presentation — nothing is made up. */}
              {a.bio ? <p className="m-0 line-clamp-2 text-[14px] leading-[1.45] text-pb-tx2 lg:self-start lg:[grid-area:bio]">{bioLead(a.bio)}</p> : null}
              {/* The ONE button, compact: bottom right on the phone, on the right on a laptop. */}
              <button
                type="button"
                aria-pressed={sel}
                aria-label={sel ? `${a.name}, elegido` : `Elegir a ${a.name}`}
                onClick={() => onPick(a.id)}
                className={`${chooseBtn(sel, "sm")} self-end lg:self-center lg:[grid-area:actions]`}
              >
                <ChooseLabel selected={sel} />
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

/** The ✓ on the portrait of the chosen option (decorative: the button says "elegido"). */
function SelectedDot() {
  return (
    <span aria-hidden className="pb-pop absolute -right-0.5 -top-0.5 flex size-6 items-center justify-center rounded-full border-2 border-white bg-pb-ink">
      <IconCheck size={12} width={2.4} />
    </span>
  );
}

function ChooseLabel({ selected }: { selected: boolean }) {
  return selected ? (
    <>
      <IconCheck size={15} stroke="#111316" width={2.2} />
      Elegido
    </>
  ) : (
    <>Elegir</>
  );
}
