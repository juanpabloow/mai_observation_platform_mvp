"use client";

import { artistInitials, artistTone, type ArtistChoice } from "@/lib/publicBookingFlow";
import { bioLead } from "@/lib/staffPublicProfile";
import { BTN_PRIMARY_SM, BTN_SECONDARY, IconCheck, IconShuffle, LINK_BTN, Portrait, ring, SERIF, type StaffOption } from "./ui";

/**
 * STEP 2 — Elige a tu artista. Its own step, apart from the service and the date.
 * "Sin preferencia" lets the ENGINE assign whoever is free when the booking is confirmed
 * (no staff_id is sent) — nothing here picks someone arbitrarily. "Ver perfil" and
 * "Elegir artista" are separate actions: opening a profile never changes the choice.
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
}: {
  serviceName: string;
  staff: StaffOption[];
  state: "idle" | "loading" | "loaded" | "error";
  selected: ArtistChoice;
  notice: string | null;
  onPick: (choice: Exclude<ArtistChoice, null>) => void;
  onView: (id: string, trigger: HTMLElement) => void;
  onRetry: () => void;
}) {
  const anySel = selected === "any";
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[14.5px] leading-[1.45] text-pb-muted">
        Para <span className="font-[590] text-pb-ink">{serviceName}</span>. Ver el perfil no te asigna al artista.
      </p>
      {notice ? (
        <div role="status" className="flex items-start gap-2.5 rounded-[12px] border border-pb-warn-bd bg-pb-warn-bg px-3.5 py-3 text-[14px] leading-[1.45] text-pb-warn-fg">
          <span>{notice}</span>
        </div>
      ) : null}
      <div role="group" aria-label="Artista" className="grid grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))] gap-2.5">
        {state === "loaded" && staff.length === 0 ? null : (
        <div className={`flex items-center gap-3.5 rounded-[16px] p-3.5 ${ring(anySel)}`}>
          <span aria-hidden className="flex size-14 flex-none items-center justify-center rounded-full bg-pb-lav">
            <IconShuffle />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[16.5px] font-[590]">Sin preferencia</span>
            <span className="text-[13.5px] leading-[1.4] text-pb-muted">Te asignaremos un artista disponible para el servicio elegido.</span>
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
          ? [0, 1].map((k) => <div key={k} aria-hidden className="h-[176px] rounded-[16px] bg-pb-hair" />)
          : null}

        {staff.map((a) => {
          const sel = selected === a.id;
          return (
            <article key={a.id} className={`flex gap-3.5 rounded-[16px] p-3 ${ring(sel)}`}>
              <div className="relative flex-none self-stretch">
                <Portrait
                  photoUrl={a.photo_url}
                  initials={artistInitials(a.name)}
                  tone={artistTone(a.id)}
                  label={a.photo_url ? `Foto de ${a.name}` : `${a.name}, sin foto`}
                  className="h-full min-h-[148px] w-[104px] overflow-hidden rounded-[12px] lg:min-h-[160px] lg:w-[120px]"
                  initialsClass="text-[34px]"
                />
                {sel ? (
                  <span aria-hidden className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-pb-ink">
                    <IconCheck size={12} width={2.4} />
                  </span>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h2 className={`${SERIF} m-0 text-[25px] leading-[1.1] [overflow-wrap:anywhere]`}>{a.name}</h2>
                {a.title ? <span className="text-[13px] text-pb-muted">{a.title}</span> : null}
                {a.bio ? <p className="m-0 mt-0.5 line-clamp-2 text-[14px] leading-[1.45] text-pb-tx2">{bioLead(a.bio)}</p> : null}
                <div className="mt-auto flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-1.5">
                  <button
                    type="button"
                    aria-pressed={sel}
                    aria-label={sel ? `${a.name}, elegido` : `Elegir a ${a.name}`}
                    onClick={() => onPick(a.id)}
                    className={sel ? BTN_PRIMARY_SM : BTN_SECONDARY}
                  >
                    {sel ? "Elegido" : "Elegir artista"}
                  </button>
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={`Ver perfil de ${a.name}`}
                    onClick={(e) => onView(a.id, e.currentTarget)}
                    className={LINK_BTN}
                  >
                    Ver perfil
                  </button>
                </div>
              </div>
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
