import { IconInfo, SERIF } from "./ui";

/**
 * A promotion as the visitor sees it in "Promociones". The SAME component renders the
 * admin preview, so what the team approves is what the customer gets. Every line comes
 * from the promotion's own fields; the appointment rule ("Disponible para citas los lunes
 * y martes") is generated from the rule itself (src/scheduling/promotions.ts), never typed.
 *
 * It offers nothing it cannot honour: without `bookable` it shows the information and no
 * booking action.
 */
export interface PromotionView {
  name: string;
  description: string | null;
  conditions: string | null;
  image_url: string | null;
  benefit_label: string;
  /** "Disponible para citas los lunes y martes" — from the appointment window (B). */
  rule_text: string | null;
  /** The included services' names (as they appear on the page). */
  services: string[];
}

export function PromotionCard({ promo, preview = false, action }: { promo: PromotionView; preview?: boolean; action?: React.ReactNode }) {
  return (
    <article aria-label={promo.name} className="pb-rise overflow-hidden rounded-[20px] border border-pb-line bg-white">
      {promo.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element -- the business's own uploaded image (R2), sized by CSS
        <img src={promo.image_url} alt="" className="block aspect-[16/9] w-full object-cover" decoding="async" />
      ) : null}
      <div className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-pb-peach px-2.5 py-0.5 text-[12.5px] font-[590] text-pb-peach-fg">{promo.benefit_label}</span>
          {preview ? <span className="rounded-full bg-pb-sf2 px-2.5 py-0.5 text-[12.5px] text-pb-tx2">Vista previa</span> : null}
        </div>
        <h4 className={`${SERIF} m-0 text-[24px] leading-[1.15] [overflow-wrap:anywhere]`}>{promo.name}</h4>
        {promo.rule_text ? (
          <p className="m-0 flex items-start gap-2 rounded-[12px] bg-pb-sky px-3 py-2 text-[14px] leading-[1.45] text-pb-sky-fg">
            <IconInfo />
            {promo.rule_text}
          </p>
        ) : null}
        {promo.description ? <p className="m-0 whitespace-pre-line text-[15px] leading-[1.55] text-pb-body">{promo.description}</p> : null}
        {promo.services.length > 0 ? <p className="m-0 text-[13.5px] text-pb-muted">Incluye: {promo.services.join(", ")}</p> : null}
        {promo.conditions ? (
          <details className="text-[13.5px] text-pb-tx2">
            <summary className="min-h-11 cursor-pointer content-center underline underline-offset-[3px]">Condiciones</summary>
            <p className="m-0 whitespace-pre-line pb-1 leading-[1.5]">{promo.conditions}</p>
          </details>
        ) : null}
        {action}
      </div>
    </article>
  );
}
