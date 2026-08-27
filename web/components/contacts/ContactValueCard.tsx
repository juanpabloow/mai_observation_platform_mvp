import Link from "next/link";
import { avatarColor, staffInitials } from "@/lib/avatarColor";
import { priceLabelCOP } from "@/lib/money";
import { relativeAgeShort } from "@/lib/format";

/**
 * The record's two COMMERCIAL cards — "Valor del cliente" and "Preferencias"
 * (docs/ui-redesign-crm-inbox.md, artboard 23a).
 *
 * They live in one file because they read one payload (`getContactValueProfile`) and both
 * answer the same question from different angles: what is this person worth, and how do
 * they behave. Splitting them would mean threading the same profile into two components
 * that are always rendered together.
 *
 * EVERYTHING HERE IS DERIVED from completed appointments. Nothing is stored, so nothing
 * can go stale against the appointments it describes — and a card that cannot be computed
 * renders its own empty state rather than a zero.
 *
 * WHAT THE ARTBOARD HAS THAT THIS DOES NOT: the four-segment loyalty bar and the
 * "2 citas para el siguiente nivel de fidelidad" line. Those need a tier model — how many
 * levels, and whether the threshold is visits or money — which does not exist anywhere in
 * the schema and is a business rule rather than a query. Omitted entirely, including the
 * space it would occupy, on the product owner's instruction.
 */

export interface ContactValueProfileView {
  lifetimeValue: string | null;
  completedCount: number;
  averageTicket: string | null;
  /** 8 means "top 8%". Null when the cohort is too small to mean anything. */
  valuePercentile: number | null;
  usualStaffName: string | null;
  usualServiceName: string | null;
  avgDaysBetweenVisits: number | null;
}

/**
 * THE dark card. It is the one inverted surface on the record, and deliberately: money is
 * the fact an operator scans for first, and inverting it makes the card findable without
 * spending a hue or a border weight that the rest of the page would then have to
 * out-shout.
 */
export function ContactValueCard({
  profile,
  ownerName,
  changeOwnerHref,
}: {
  profile: ContactValueProfileView | null;
  ownerName: string | null;
  /** Where "Cambiar" points — the edit drawer owns assignment, so this is a link out. */
  changeOwnerHref?: string;
}) {
  const money = profile?.lifetimeValue ? priceLabelCOP(profile.lifetimeValue) : null;
  const ticket = profile?.averageTicket ? priceLabelCOP(profile.averageTicket) : null;

  return (
    <section
      aria-label="Valor del cliente"
      className="flex flex-col gap-3 rounded-xl bg-bubble-bot p-4 text-bubble-bot-fg"
    >
      <h2 className="text-[0.6875rem] font-semibold tracking-[0.06em] text-bubble-bot-label">
        VALOR DEL CLIENTE
      </h2>

      {money ? (
        <>
          <p className="flex items-baseline gap-2.5">
            <span className="u-mono text-[1.625rem] font-semibold tracking-[-0.03em] text-white">
              {money}
            </span>
            <span className="text-xs text-bubble-bot-label">
              en {profile!.completedCount} {profile!.completedCount === 1 ? "cita" : "citas"}
            </span>
          </p>
          {/* Ticket and rank on one line: the average is only interesting NEXT TO the
              total (a big total from few big tickets is a different customer from the same
              total spread thin), and the rank is what tells you whether either number is
              good for this shop. */}
          <p className="flex items-baseline gap-2">
            {ticket ? (
              <span className="text-[0.71875rem] text-[#B0B6C2]">Ticket promedio {ticket}</span>
            ) : null}
            {profile!.valuePercentile !== null ? (
              <span
                className="ml-auto text-[0.71875rem] font-semibold text-white"
                title="Posición por valor acumulado, entre los clientes de este negocio con al menos una visita"
              >
                Top {profile!.valuePercentile}%
              </span>
            ) : null}
          </p>
        </>
      ) : (
        // A contact with no completed visit has no value to state. Saying so beats "$0",
        // which reads as a judgement rather than as an absence.
        <p className="text-[0.8125rem] leading-snug text-[#B0B6C2]">
          Todavía sin visitas completadas, así que no hay valor acumulado que mostrar.
        </p>
      )}

      {/* THE OWNER, on the same card as the money, because "who is responsible for this
          relationship" is part of the commercial picture rather than a separate fact. */}
      <div className="flex items-center gap-2.5 border-t border-bubble-bot-rule pt-3">
        {ownerName ? (
          <span
            aria-hidden
            className={`u-mono flex size-[26px] shrink-0 items-center justify-center rounded-full text-[0.53125rem] font-semibold ${avatarColor(ownerName)}`}
          >
            {staffInitials(ownerName)}
          </span>
        ) : (
          <span
            aria-hidden
            className="flex size-[26px] shrink-0 items-center justify-center rounded-full border border-dashed border-bubble-bot-label text-[0.625rem] text-bubble-bot-label"
          >
            ?
          </span>
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[0.78125rem] text-[#F5F6F8]">
            {ownerName ?? "Sin asignar"}
          </span>
          <span className="text-[0.6875rem] text-bubble-bot-label">Dueño del contacto</span>
        </span>
        {changeOwnerHref ? (
          <Link
            href={changeOwnerHref}
            className="shrink-0 text-[0.71875rem] text-[#B0B6C2] no-underline transition-colors hover:text-white"
          >
            Cambiar
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/**
 * "Preferencias" — the habits an operator needs before booking: who they see, what they
 * get, how often.
 *
 * These are DERIVED, not stated: the contact never told us "cada 28 días", it is the mean
 * gap between their completed visits. The card says "habitual" rather than "preferido" for
 * exactly that reason — claiming a preference the customer never expressed is how an
 * operator ends up telling someone "you always see Paola" when Paola was simply who was
 * free. The one genuinely STATED preference the schema holds is the messaging channel, and
 * that lives in the left column's Mensajería block where it belongs.
 */
export function ContactPreferencesCard({ profile }: { profile: ContactValueProfileView | null }) {
  const rows: { label: string; value: string }[] = [];
  if (profile?.usualStaffName) rows.push({ label: "Atiende habitualmente", value: profile.usualStaffName });
  if (profile?.usualServiceName) rows.push({ label: "Servicio habitual", value: profile.usualServiceName });
  if (profile?.avgDaysBetweenVisits) {
    rows.push({ label: "Frecuencia", value: `cada ${profile.avgDaysBetweenVisits} días` });
  }

  return (
    <section
      aria-label="Preferencias"
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-card)]"
    >
      <h2 className="text-[0.6875rem] font-semibold text-muted">Preferencias</h2>
      {rows.length > 0 ? (
        <dl className="flex flex-col">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center gap-2.5 py-1">
              <dt className="w-[7.5rem] shrink-0 text-[0.71875rem] text-faint">{r.label}</dt>
              <dd className="min-w-0 flex-1 truncate text-[0.78125rem] font-medium text-foreground">
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[0.78125rem] leading-snug text-faint">
          Se derivan de las visitas completadas. Aparecen a partir de la primera.
        </p>
      )}
      {/* FREQUENCY needs two visits to exist at all, so a one-visit customer sees the
          other two rows and not this one. Saying why beats a silently missing row. */}
      {profile && profile.completedCount === 1 ? (
        <p className="text-[0.6875rem] leading-snug text-faintest">
          La frecuencia aparece con la segunda visita.
        </p>
      ) : null}
    </section>
  );
}

/** The header's meta line uses this too, so the wording of "last visit" is defined once. */
export function lastVisitLabel(lastVisitAt: string | null, now: Date): string | null {
  return lastVisitAt ? `última ${relativeAgeShort(lastVisitAt, now)}` : null;
}
