import { zonedPartsToUtc } from '../scheduling/timezone.js';
import { addDays, daysBetweenInclusive, isValidDay, PERIOD_MAX_DAYS, type Period } from './valueDashboardModel.js';

/**
 * COSTOS DE IA — the period the current one is compared WITH (the baseline). Two presets and a
 * free choice:
 *   - 'anterior'  the equally long window right before (default, same as the value dashboard);
 *   - 'mes'       the same calendar dates one month earlier (keeps weekdays/paydays roughly aligned);
 *   - 'custom'    any two local dates, ≤ PERIOD_MAX_DAYS, not overlapping the current period.
 * A baseline of a different length is compared per day for totals (see compareAiCosts).
 */

export type BaselineKey = 'anterior' | 'mes' | 'custom';
export type BaselineInput = { key: BaselineKey; from?: string | null; to?: string | null };

export interface Baseline {
  key: BaselineKey;
  fromDay: string;
  toDay: string;
  days: number;
  startUtc: string;
  endUtc: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function midnightUtc(day: string, tz: string): string {
  const m = DAY_RE.exec(day)!;
  return zonedPartsToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, tz).toISOString();
}

/** Same day-of-month one month earlier, clamped to that month's last day (31 mar → 28/29 feb). */
export function monthEarlier(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) throw new Error(`invalid day ${day}`);
  const y = Number(m[1]);
  const month = Number(m[2]) - 1; // 0-based target month = current - 1
  const target = new Date(Date.UTC(y, month - 1, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(Number(m[3]), last));
  return target.toISOString().slice(0, 10);
}

export function baselineInputFrom(params: { comparar?: string | null; cdesde?: string | null; chasta?: string | null }): BaselineInput {
  const key: BaselineKey = params.comparar === 'mes' || params.comparar === 'custom' ? params.comparar : 'anterior';
  return key === 'custom' ? { key, from: params.cdesde ?? null, to: params.chasta ?? null } : { key };
}

export type BaselineResult = { ok: true; baseline: Baseline } | { ok: false; error: string };

export function resolveBaseline(period: Period, input: BaselineInput, tz: string): BaselineResult {
  let fromDay: string;
  let toDay: string;
  if (input.key === 'anterior') {
    fromDay = period.prevFromDay;
    toDay = period.prevToDay;
  } else if (input.key === 'mes') {
    fromDay = monthEarlier(period.fromDay);
    toDay = monthEarlier(period.toDay);
    if (toDay >= period.fromDay) {
      return { ok: false, error: 'El periodo es más largo que un mes: compáralo con el periodo anterior.' };
    }
  } else {
    if (!isValidDay(input.from) || !isValidDay(input.to)) return { ok: false, error: 'Elige dos fechas válidas para comparar.' };
    fromDay = input.from;
    toDay = input.to;
    if (fromDay > toDay) return { ok: false, error: 'En la comparación, la fecha inicial debe ser anterior a la final.' };
    if (daysBetweenInclusive(fromDay, toDay) > PERIOD_MAX_DAYS) {
      return { ok: false, error: `El periodo de comparación puede tener como máximo ${PERIOD_MAX_DAYS} días.` };
    }
    if (fromDay <= period.toDay && toDay >= period.fromDay) {
      return { ok: false, error: 'El periodo de comparación no puede cruzarse con el periodo actual.' };
    }
  }
  return {
    ok: true,
    baseline: {
      key: input.key,
      fromDay,
      toDay,
      days: daysBetweenInclusive(fromDay, toDay),
      startUtc: midnightUtc(fromDay, tz),
      endUtc: midnightUtc(addDays(toDay, 1), tz),
    },
  };
}
