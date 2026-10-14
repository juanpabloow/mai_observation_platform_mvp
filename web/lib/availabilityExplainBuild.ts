import { computeAvailability } from "@worker/scheduling/availability.js";
import { explainAvailability } from "@worker/scheduling/availabilityExplain.js";
import type { Slot } from "@worker/scheduling/types.js";
import { loadExplainExceptions, prepareAvailability, type PreparedAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { EXPLANATION_VERSION, projectDay, rangeSummary, type DayExplanationJson } from "./availabilityExplanation";
import { localClock24, localDay, localTimeFields } from "./localTime";

/**
 * Builds the `explanation` block of the availability API (?explain=true). Server-only.
 * Reads go through the SAME scoped loaders as the slots (tenant + site + the resolved
 * staff/service), so nothing of another business, site or professional can appear:
 *   - per requested professional and local day, the cause(s) from the engine's inputs;
 *   - `next_available`: the first REAL slot after the window (engine, same service and
 *     professional) — never a date deduced from where a block ends;
 *   - `alternatives`: other professionals with real slots for the same service in the
 *     same window.
 * No appointment detail, no internal block text, no ids of anything but professionals.
 */

const NEXT_SEARCH_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SlotRef {
  start_at: string;
  service_end_at: string;
  day: string;
  time: string;
  start_label: string;
}

function slotRef(s: { start_at: Date; service_end_at: Date }, tz: string, locale: string): SlotRef {
  return {
    start_at: s.start_at.toISOString(),
    service_end_at: s.service_end_at.toISOString(),
    day: localDay(s.start_at, tz),
    time: localClock24(s.start_at, tz),
    start_label: localTimeFields(s.start_at, s.service_end_at, tz, locale).start_label,
  };
}

export interface StaffExplanationJson {
  staff_id: string;
  staff_name: string | null;
  status: "available" | "partial" | "unavailable";
  summary: string;
  public_reason: string | null;
  public_reason_label: string | null;
  customer_message: string;
  days: DayExplanationJson[];
  next_available: SlotRef | null;
}

export interface ExplanationJson {
  version: number;
  staff: StaffExplanationJson[];
  /** slots_checked: true — each alternative comes WITH a real engine slot (first_slot). */
  alternatives: Array<{ staff_id: string; staff_name: string | null; slot_count: number; first_slot: SlotRef; slots_checked: true }>;
}

export async function buildExplanation(input: {
  tenantId: string;
  siteId: string;
  serviceId: string;
  staffId: string | null;
  from: Date;
  to: Date;
  now: Date;
  prepared: PreparedAvailability;
  slots: Slot[];
  nameById: Map<string, string>;
  tz: string;
  locale: string;
}): Promise<ExplanationJson> {
  const { prepared, slots, nameById, tz, locale } = input;
  const request = prepared.request;
  if (!request) return { version: EXPLANATION_VERSION, staff: [], alternatives: [] };
  const staffIds = input.staffId ? [input.staffId] : request.staff.map((s) => s.id);
  const exc = await loadExplainExceptions({ tenantId: input.tenantId, siteId: input.siteId, from: input.from, to: input.to, staffIds });
  const days = explainAvailability({ request, slots, staffIds, siteExceptions: exc.site, staffExceptions: exc.staff });

  const staff: StaffExplanationJson[] = [];
  for (const id of staffIds) {
    const name = nameById.get(id) ?? "El profesional";
    const mine = days.filter((d) => d.staff_id === id);
    const range = rangeSummary(mine, name);
    let next: SlotRef | null = null;
    if (range.status === "unavailable") {
      // The next bookable time comes ONLY from engine slots after the window.
      const start = new Date(Math.max(input.to.getTime(), input.now.getTime()));
      const ahead = await prepareAvailability({
        tenantId: input.tenantId,
        siteId: input.siteId,
        serviceId: input.serviceId,
        staffId: id,
        from: start,
        to: new Date(start.getTime() + NEXT_SEARCH_DAYS * DAY_MS),
        now: input.now,
      });
      const first = ahead?.request ? computeAvailability(ahead.request)[0] : undefined;
      const cand = first?.candidates.find((c) => c.staff_id === id);
      if (first && cand) next = slotRef({ start_at: first.start_at, service_end_at: cand.service_end_at }, tz, locale);
    }
    staff.push({
      staff_id: id,
      staff_name: nameById.get(id) ?? null,
      ...range,
      days: mine.map((d) => projectDay(d, name)),
      next_available: next,
    });
  }

  // Alternatives: other professionals with real slots for the SAME service and window.
  const alternatives: ExplanationJson["alternatives"] = [];
  if (input.staffId && staff[0]?.status !== "available") {
    const all = await prepareAvailability({
      tenantId: input.tenantId,
      siteId: input.siteId,
      serviceId: input.serviceId,
      staffId: null,
      from: input.from,
      to: input.to,
      now: input.now,
    });
    const allSlots = all?.request ? computeAvailability(all.request) : [];
    const per = new Map<string, Array<{ start_at: Date; service_end_at: Date }>>();
    for (const s of allSlots) {
      for (const c of s.candidates) {
        if (c.staff_id === input.staffId) continue;
        per.set(c.staff_id, [...(per.get(c.staff_id) ?? []), { start_at: s.start_at, service_end_at: c.service_end_at }]);
      }
    }
    for (const [id, list] of [...per.entries()].sort((a, b) => a[1][0].start_at.getTime() - b[1][0].start_at.getTime())) {
      alternatives.push({ staff_id: id, staff_name: nameById.get(id) ?? null, slot_count: list.length, first_slot: slotRef(list[0], tz, locale), slots_checked: true });
    }
  }
  return { version: EXPLANATION_VERSION, staff, alternatives };
}
