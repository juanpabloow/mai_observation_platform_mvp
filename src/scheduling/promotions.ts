import { utcToZonedParts, type Weekday } from './timezone.js';

/**
 * PROMOTIONS — the ONE place that decides whether a promotion may be shown and whether a
 * given booking qualifies (migration 1805). Pure: the public page, the booking POST, the
 * agenda and (through a future machine endpoint) the bot all call these functions, so the
 * rules are never re-typed in a prompt or a component.
 *
 * Two windows, never mixed:
 *   A. WHEN THE BOOKING IS MADE — status `published` and `now` inside
 *      [bookable_from, bookable_until). Outside it the promotion is not shown at all.
 *   B. WHEN THE APPOINTMENT HAPPENS — weekdays, date range and time range, read in the
 *      SITE's timezone. A promotion "para citas los lunes y martes" is shown on a
 *      Wednesday; only a Wednesday APPOINTMENT does not qualify.
 *
 * Arriving from an ad changes nothing here: there is no parameter for it.
 *
 * BENEFITS: only the types that are actually defined. `two_for_one` is defined as a
 * commercial idea, but how it is BOOKED (which services, how the two people are
 * identified and scheduled, simultaneous or consecutive, the eligibility proof) is still
 * a business decision — so it can be drafted and previewed, never published or applied.
 */

export type PromotionStatus = 'draft' | 'published' | 'paused' | 'archived';
export type BenefitType = 'two_for_one';

export interface PromotionRules {
  status: PromotionStatus;
  benefit_type: BenefitType;
  benefit_params: Record<string, unknown>;
  site_id: string | null;
  service_ids: string[];
  /** Empty = whoever performs the service. */
  staff_ids: string[];
  bookable_from: Date | null;
  bookable_until: Date | null;
  /** ISO weekdays, 1 = Monday … 7 = Sunday; null = any day. */
  appointment_weekdays: number[] | null;
  /** YYYY-MM-DD in the site's calendar. */
  appointment_from: string | null;
  appointment_until: string | null;
  /** HH:MM[:SS] in the site's clock. */
  appointment_time_from: string | null;
  appointment_time_until: string | null;
}

const ISO_OF: Record<Weekday, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
const DAY_ES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];

/** What is still undecided for a benefit type before it can be booked. Empty = ready. */
export function benefitPending(type: BenefitType, _params: Record<string, unknown>): string[] {
  switch (type) {
    case 'two_for_one':
      return [
        'qué servicios incluye exactamente',
        'el requisito universitario y cómo se comprueba',
        'cómo se identifican y agendan las dos personas',
        'si las atenciones son simultáneas o consecutivas',
        'duración, artistas y recursos necesarios',
      ];
  }
}

export const BENEFIT_LABEL: Record<BenefitType, string> = { two_for_one: '2×1' };

/** A. Is it on offer right now? (published, inside its booking window). */
export function isOnOffer(p: Pick<PromotionRules, 'status' | 'bookable_from' | 'bookable_until'>, now: Date): boolean {
  if (p.status !== 'published') return false;
  if (p.bookable_from && now.getTime() < p.bookable_from.getTime()) return false;
  if (p.bookable_until && now.getTime() >= p.bookable_until.getTime()) return false;
  return true;
}

export type IneligibleReason =
  | 'not_published'
  | 'outside_booking_window'
  | 'other_site'
  | 'service_not_included'
  | 'staff_not_included'
  | 'weekday'
  | 'date_range'
  | 'time_range'
  | 'benefit_not_bookable';

/** The customer-facing explanation of each reason (Spanish). */
export const INELIGIBLE_MESSAGE: Record<IneligibleReason, string> = {
  not_published: 'Esta promoción no está disponible.',
  outside_booking_window: 'Esta promoción ya no está vigente.',
  other_site: 'Esta promoción no aplica en esta sede.',
  service_not_included: 'Esta promoción no incluye el servicio elegido.',
  staff_not_included: 'Esta promoción no aplica con el artista elegido.',
  weekday: 'La fecha elegida no aplica para esta promoción.',
  date_range: 'La fecha elegida está fuera de las fechas de la promoción.',
  time_range: 'La hora elegida está fuera del horario de la promoción.',
  benefit_not_bookable: 'Esta promoción todavía no se puede reservar en línea.',
};

/**
 * B (+ A + scope). Does THIS booking qualify? Every failing rule is returned, so the page
 * can explain and let the visitor correct it — never silently change price or service.
 */
export function checkEligibility(
  p: PromotionRules,
  b: { now: Date; startAt: Date; timeZone: string; siteId: string; serviceId: string; staffId: string | null },
): { eligible: boolean; reasons: IneligibleReason[] } {
  const reasons: IneligibleReason[] = [];
  if (p.status !== 'published') reasons.push('not_published');
  else if (!isOnOffer(p, b.now)) reasons.push('outside_booking_window');
  if (p.site_id && p.site_id !== b.siteId) reasons.push('other_site');
  if (!p.service_ids.includes(b.serviceId)) reasons.push('service_not_included');
  if (p.staff_ids.length > 0 && (!b.staffId || !p.staff_ids.includes(b.staffId))) reasons.push('staff_not_included');
  reasons.push(...appointmentReasons(p, b.startAt, b.timeZone));
  if (benefitPending(p.benefit_type, p.benefit_params).length > 0) reasons.push('benefit_not_bookable');
  return { eligible: reasons.length === 0, reasons };
}

/** Only the appointment window (B), in the site's timezone. */
export function appointmentReasons(
  p: Pick<PromotionRules, 'appointment_weekdays' | 'appointment_from' | 'appointment_until' | 'appointment_time_from' | 'appointment_time_until'>,
  startAt: Date,
  timeZone: string,
): IneligibleReason[] {
  const z = utcToZonedParts(startAt, timeZone);
  const out: IneligibleReason[] = [];
  if (p.appointment_weekdays && !p.appointment_weekdays.includes(ISO_OF[z.weekday])) out.push('weekday');
  const day = `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
  if ((p.appointment_from && day < p.appointment_from) || (p.appointment_until && day > p.appointment_until)) out.push('date_range');
  if (p.appointment_time_from && p.appointment_time_until) {
    const hm = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
    if (hm < p.appointment_time_from.slice(0, 5) || hm >= p.appointment_time_until.slice(0, 5)) out.push('time_range');
  }
  return out;
}

/** "Disponible para citas los lunes y martes" — from the rule, never typed by hand. */
export function appointmentRuleText(p: Pick<PromotionRules, 'appointment_weekdays' | 'appointment_time_from' | 'appointment_time_until'>): string | null {
  const days = [...new Set(p.appointment_weekdays ?? [])].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  const parts: string[] = [];
  if (days.length > 0 && days.length < 7) {
    const names = days.map((d) => DAY_ES[d]);
    parts.push(`los ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`}`);
  }
  if (p.appointment_time_from && p.appointment_time_until) parts.push(`de ${p.appointment_time_from.slice(0, 5)} a ${p.appointment_time_until.slice(0, 5)}`);
  return parts.length ? `Disponible para citas ${parts.join(' ')}` : null;
}

/** What blocks PUBLISHING (in the editor and on the server). Empty = can publish. */
export function publishProblems(p: PromotionRules & { name: string }): string[] {
  const out: string[] = [];
  if (!p.name.trim()) out.push('Escribe el nombre.');
  if (p.service_ids.length === 0) out.push('Elige al menos un servicio incluido.');
  if (p.bookable_from && p.bookable_until && p.bookable_until <= p.bookable_from) out.push('La vigencia termina antes de empezar.');
  if (p.appointment_weekdays && p.appointment_weekdays.length === 0) out.push('Elige al menos un día para las citas.');
  const pending = benefitPending(p.benefit_type, p.benefit_params);
  if (pending.length) out.push(`El ${BENEFIT_LABEL[p.benefit_type]} todavía no se puede reservar: falta definir ${pending.join('; ')}.`);
  return out;
}

/** Allowed status moves (the editor offers exactly these; the server enforces them). */
export function canMove(from: PromotionStatus, to: PromotionStatus): boolean {
  const next: Record<PromotionStatus, PromotionStatus[]> = {
    draft: ['published', 'archived'],
    published: ['paused', 'archived'],
    paused: ['published', 'archived'],
    archived: [],
  };
  return next[from].includes(to);
}
