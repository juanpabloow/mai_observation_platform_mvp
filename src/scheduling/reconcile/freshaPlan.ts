/**
 * FRESHA → M_AI RECONCILIATION — DRY RUN ONLY.
 *
 * A pure planner: it compares a snapshot exported from Fresha with a snapshot of one M_AI
 * site and returns the actions a reconciliation WOULD take, each with its evidence and
 * confidence. It never writes, never reads a database and never calls Fresha — the
 * snapshots are files (see src/scripts/freshaReconcileDryRun.ts). There is no Fresha
 * integration in this codebase (docs/scheduling-v1.md: M_AI is the single source of
 * truth); this is the first, read-only step towards one.
 *
 * Rules it enforces, because they are where a reconciliation goes wrong:
 *   - IDENTITY IS EXPLICIT. Staff and services are paired only through `mapping` (ids
 *     confirmed by a person), never by name. Unmapped Fresha staff (e.g. a non-bookable
 *     member) are reported and ignored, never created.
 *   - ONE BUSINESS. The M_AI snapshot must be the configured client + site; any entity
 *     from another site or client is an error, not a candidate.
 *   - DATES ARE LOCAL to the site (America/Bogota for Gallery): days are computed in that
 *     zone, never in UTC.
 *   - ONE-OFF ≠ RECURRING. A dated block or pause becomes a dated exception; a recurring
 *     rule is a decision about weekly hours and is only ever proposed, never applied.
 *     A pause whose persisted record is not verified is held back.
 *   - HISTORY IS KEPT. Appointments are never cancelled or rewritten by the plan; a
 *     service change never touches existing bookings (they carry their own
 *     name/duration/price snapshots).
 *   - IDEMPOTENT. Every proposed write carries a stable key (`fresha:<location>:<kind>:<id>`),
 *     so applying the same plan twice cannot create the same thing twice.
 */

export interface FreshaSnapshot {
  locationId: string;
  timezone: string;
  staff: { id: string; name: string }[];
  services: {
    id: string;
    name: string;
    durationMin: number;
    price: number;
    description?: string | null;
    promotion?: string | null;
    staffIds?: string[];
  }[];
  appointments: {
    id: string;
    staffId: string;
    serviceId: string | null;
    serviceName: string;
    start: string;
    end: string;
    status: "booked" | "confirmed" | "completed" | "cancelled" | "no_show";
  }[];
  blocks: {
    id: string;
    staffId: string;
    kind: "block" | "pause";
    start: string;
    end: string;
    /** null = a dated, one-off block. Anything else is a recurring rule. */
    recurrence: string | null;
    allowsOnlineBooking: boolean;
    /** Was the PERSISTED record checked (editor / export), not just the calendar render? */
    verified: boolean;
  }[];
}

export interface MaiSnapshot {
  clientId: string;
  siteId: string;
  timezone: string;
  staff: { id: string; siteId: string; name: string; active: boolean; takesBookings: boolean }[];
  services: { id: string; name: string; durationMin: number; price: number | null; description: string | null; active: boolean }[];
  appointments: {
    id: string;
    siteId: string;
    clientId: string;
    staffId: string;
    serviceId: string;
    serviceNameSnapshot: string;
    durationMinSnapshot: number;
    priceSnapshot: number | null;
    start: string;
    end: string;
    status: "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";
    idempotencyKey: string | null;
    /** Marked as a test booking by a person (never inferred from a name alone). */
    markedTest?: boolean;
  }[];
  exceptions: { id: string; siteId: string; staffId: string | null; start: string; end: string; reason: string | null }[];
}

export interface ReconcileMapping {
  /** Fresha staff id → M_AI staff id, confirmed by a person. */
  staff: Record<string, string>;
  /** Fresha service id → M_AI service id; `confirmed: false` = candidate only. */
  services: Record<string, { maiServiceId: string; confirmed: boolean }>;
}

export interface ReconcileTarget {
  clientId: string;
  siteId: string;
  freshaLocationId: string;
  /** The local day(s) to compare, yyyy-mm-dd in the site timezone. */
  days: string[];
}

export type ActionKind =
  | "ignore_unmapped_staff"
  | "service_diff"
  | "service_unmapped"
  | "create_exception"
  | "exception_already_present"
  | "exception_partial_overlap"
  | "block_conflicts_with_appointments"
  | "hold_unverified"
  | "propose_weekly_rule"
  | "appointment_match"
  | "appointment_mismatch"
  | "appointment_missing_in_mai"
  | "appointment_missing_in_fresha"
  | "appointment_cancelled_in_fresha";

export interface PlanAction {
  kind: ActionKind;
  /** Stable, deterministic key — the idempotency key for anything that would be written. */
  key: string;
  confidence: "high" | "medium" | "low";
  /** Every action is a proposal; nothing here writes. Decisions need a person. */
  needsDecision: boolean;
  evidence: Record<string, unknown>;
}

export interface ReconcilePlan {
  dryRun: true;
  target: ReconcileTarget;
  errors: string[];
  actions: PlanAction[];
  summary: Record<ActionKind, number>;
}

const ms = (iso: string) => Date.parse(iso);
const overlaps = (a0: string, a1: string, b0: string, b1: string) => ms(a0) < ms(b1) && ms(b0) < ms(a1);

/** yyyy-mm-dd of an instant in the given timezone. */
export function localDay(iso: string, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

/** "HH:MM" of an instant in the given timezone — for evidence strings. */
export function localTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

export function freshaKey(locationId: string, kind: "block" | "appointment" | "service" | "staff", id: string): string {
  return `fresha:${locationId}:${kind}:${id}`;
}

const LIVE_MAI = new Set(["scheduled", "confirmed"]);

export function planFreshaReconciliation(input: {
  target: ReconcileTarget;
  fresha: FreshaSnapshot;
  mai: MaiSnapshot;
  mapping: ReconcileMapping;
}): ReconcilePlan {
  const { target, fresha, mai, mapping } = input;
  const errors: string[] = [];
  const actions: PlanAction[] = [];
  const tz = mai.timezone;

  // ── Isolation and identity checks: refuse to plan across businesses. ──────────
  if (mai.clientId !== target.clientId) errors.push(`M_AI snapshot client ${mai.clientId} ≠ target ${target.clientId}`);
  if (mai.siteId !== target.siteId) errors.push(`M_AI snapshot site ${mai.siteId} ≠ target ${target.siteId}`);
  if (fresha.locationId !== target.freshaLocationId) errors.push(`Fresha snapshot location ${fresha.locationId} ≠ target ${target.freshaLocationId}`);
  if (fresha.timezone !== mai.timezone) errors.push(`timezone mismatch: Fresha ${fresha.timezone} vs M_AI ${mai.timezone}`);
  for (const a of mai.appointments) {
    if (a.siteId !== target.siteId || a.clientId !== target.clientId) errors.push(`appointment ${a.id} belongs to another site/client`);
  }
  for (const e of mai.exceptions) if (e.siteId !== target.siteId) errors.push(`exception ${e.id} belongs to another site`);

  const maiStaff = new Map(mai.staff.map((s) => [s.id, s]));
  for (const [fid, mid] of Object.entries(mapping.staff)) {
    const s = maiStaff.get(mid);
    if (!fresha.staff.some((f) => f.id === fid)) errors.push(`mapping: Fresha staff ${fid} not in the Fresha snapshot`);
    if (!s) errors.push(`mapping: M_AI staff ${mid} not in the M_AI snapshot`);
    else if (s.siteId !== target.siteId) errors.push(`mapping: M_AI staff ${mid} belongs to another site`);
  }
  const mappedValues = Object.values(mapping.staff);
  if (new Set(mappedValues).size !== mappedValues.length) errors.push("mapping: two Fresha staff map to the same M_AI staff");
  const maiServices = new Map(mai.services.map((s) => [s.id, s]));
  for (const [fid, m] of Object.entries(mapping.services)) {
    if (!maiServices.has(m.maiServiceId)) errors.push(`mapping: M_AI service ${m.maiServiceId} (for Fresha ${fid}) not in the snapshot`);
  }

  // With a broken mapping the comparison would be fiction — stop here.
  if (errors.length > 0) return finish(target, errors, actions);

  const inDays = (iso: string) => target.days.includes(localDay(iso, tz));

  // ── Staff: report, never create. ───────────────────────────────────────────────
  for (const f of fresha.staff) {
    if (!mapping.staff[f.id]) {
      actions.push({
        kind: "ignore_unmapped_staff",
        key: freshaKey(fresha.locationId, "staff", f.id),
        confidence: "high",
        needsDecision: false,
        evidence: { freshaStaff: f.name, note: "not mapped to a bookable M_AI professional — ignored, nothing is created or deleted" },
      });
    }
  }

  // ── Services: diffs on mapped pairs; the bookings keep their snapshots. ────────
  for (const f of fresha.services) {
    const m = mapping.services[f.id];
    if (!m) {
      actions.push({
        kind: "service_unmapped",
        key: freshaKey(fresha.locationId, "service", f.id),
        confidence: "high",
        needsDecision: true,
        evidence: { fresha: { name: f.name, durationMin: f.durationMin, price: f.price } },
      });
      continue;
    }
    const s = maiServices.get(m.maiServiceId)!;
    const diffs: Record<string, { fresha: unknown; mai: unknown }> = {};
    if (f.durationMin !== s.durationMin) diffs.durationMin = { fresha: f.durationMin, mai: s.durationMin };
    if (s.price === null || Number(f.price) !== Number(s.price)) diffs.price = { fresha: f.price, mai: s.price };
    if ((f.description ?? null) !== (s.description ?? null)) diffs.description = { fresha: f.description ?? null, mai: s.description };
    if (f.promotion) diffs.promotion = { fresha: f.promotion, mai: "M_AI has no promotion field — needs a product decision" };
    if (!s.active) diffs.active = { fresha: true, mai: false };
    if (Object.keys(diffs).length === 0) continue;
    const bookings = mai.appointments.filter((a) => a.serviceId === s.id).length;
    actions.push({
      kind: "service_diff",
      key: freshaKey(fresha.locationId, "service", f.id),
      confidence: m.confirmed ? "high" : "low",
      needsDecision: true,
      evidence: {
        freshaService: f.name,
        maiService: s.name,
        mappingConfirmed: m.confirmed,
        diffs,
        existingBookingsUnaffected: bookings,
        note: "an update changes FUTURE bookings only; existing appointments keep their name/duration/price snapshots",
      },
    });
  }

  // ── Blocks and pauses. ──────────────────────────────────────────────────────────
  for (const b of fresha.blocks) {
    const staffId = mapping.staff[b.staffId];
    if (!staffId) continue; // unmapped staff were reported above
    const key = freshaKey(fresha.locationId, "block", b.id);
    const span = `${localDay(b.start, tz)} ${localTime(b.start, tz)}–${localTime(b.end, tz)}`;
    if (b.recurrence !== null) {
      actions.push({
        kind: "propose_weekly_rule",
        key,
        confidence: "medium",
        needsDecision: true,
        evidence: { staffId, kind: b.kind, recurrence: b.recurrence, span, note: "a recurring rule maps to weekly working hours, not to dated exceptions — never applied automatically" },
      });
      continue;
    }
    if (!inDays(b.start)) continue;
    if (!b.verified) {
      actions.push({
        kind: "hold_unverified",
        key,
        confidence: "low",
        needsDecision: true,
        evidence: { staffId, kind: b.kind, span, note: "the persisted Fresha record was not verified (calendar and editor disagree) — held back" },
      });
      continue;
    }
    const sameStaff = mai.exceptions.filter((e) => e.staffId === staffId);
    const exact = sameStaff.find((e) => ms(e.start) === ms(b.start) && ms(e.end) === ms(b.end));
    const partial = sameStaff.filter((e) => e !== exact && overlaps(e.start, e.end, b.start, b.end));
    const clashing = mai.appointments.filter((a) => a.staffId === staffId && LIVE_MAI.has(a.status) && overlaps(a.start, a.end, b.start, b.end));
    if (exact) {
      actions.push({ kind: "exception_already_present", key, confidence: "high", needsDecision: false, evidence: { staffId, span, maiException: exact.id } });
    } else if (partial.length > 0) {
      actions.push({ kind: "exception_partial_overlap", key, confidence: "medium", needsDecision: true, evidence: { staffId, span, maiExceptions: partial.map((e) => e.id) } });
    } else {
      actions.push({
        kind: "create_exception",
        key,
        confidence: clashing.length > 0 ? "low" : "high",
        needsDecision: clashing.length > 0,
        evidence: { staffId, kind: b.kind, span, write: { table: "schedule_exceptions", staff_id: staffId, starts_at: b.start, ends_at: b.end, idempotencyKey: key } },
      });
    }
    if (clashing.length > 0) {
      actions.push({
        kind: "block_conflicts_with_appointments",
        key: `${key}:conflicts`,
        confidence: "high",
        needsDecision: true,
        evidence: {
          staffId,
          span,
          appointments: clashing.map((a) => ({ id: a.id, at: `${localTime(a.start, tz)}–${localTime(a.end, tz)}`, service: a.serviceNameSnapshot, markedTest: Boolean(a.markedTest) })),
          note: "nothing is cancelled: a person decides whether each booking is real, a test or must move",
        },
      });
    }
  }

  // ── Appointments. ───────────────────────────────────────────────────────────────
  const matchedMai = new Set<string>();
  for (const f of fresha.appointments) {
    if (!inDays(f.start)) continue;
    const staffId = mapping.staff[f.staffId];
    if (!staffId) continue;
    const key = freshaKey(fresha.locationId, "appointment", f.id);
    const byKey = mai.appointments.find((a) => a.idempotencyKey === key);
    const candidates = byKey
      ? [byKey]
      : mai.appointments.filter((a) => a.staffId === staffId && !matchedMai.has(a.id) && overlaps(a.start, a.end, f.start, f.end));
    const mappedService = f.serviceId ? mapping.services[f.serviceId] : undefined;
    if (f.status === "cancelled") {
      const live = candidates.filter((a) => LIVE_MAI.has(a.status));
      if (live.length > 0) {
        live.forEach((a) => matchedMai.add(a.id));
        actions.push({
          kind: "appointment_cancelled_in_fresha",
          key,
          confidence: byKey ? "high" : "medium",
          needsDecision: true,
          evidence: { staffId, fresha: describeF(f, tz), mai: live.map((a) => describeM(a, tz)), note: "proposed only — M_AI bookings are never cancelled by the plan" },
        });
      }
      continue;
    }
    if (candidates.length === 0) {
      actions.push({
        kind: "appointment_missing_in_mai",
        key,
        confidence: "high",
        needsDecision: true,
        evidence: { staffId, fresha: describeF(f, tz), note: "creating it needs a contact and a confirmed service mapping" },
      });
      continue;
    }
    const a = candidates[0];
    matchedMai.add(a.id);
    const diffs: string[] = [];
    if (ms(a.start) !== ms(f.start) || ms(a.end) !== ms(f.end)) diffs.push("time");
    if (!mappedService || mappedService.maiServiceId !== a.serviceId) diffs.push("service");
    actions.push({
      kind: diffs.length === 0 ? "appointment_match" : "appointment_mismatch",
      key,
      confidence: byKey ? "high" : diffs.length === 0 ? "high" : "medium",
      needsDecision: diffs.length > 0,
      evidence: { staffId, diffs, fresha: describeF(f, tz), mai: describeM(a, tz), matchedBy: byKey ? "idempotency_key" : "same professional + overlapping time" },
    });
  }
  for (const a of mai.appointments) {
    if (matchedMai.has(a.id) || !inDays(a.start) || !LIVE_MAI.has(a.status)) continue;
    if (!Object.values(mapping.staff).includes(a.staffId)) continue;
    actions.push({
      kind: "appointment_missing_in_fresha",
      key: `mai:${mai.siteId}:appointment:${a.id}`,
      confidence: "medium",
      needsDecision: true,
      evidence: { mai: describeM(a, tz), markedTest: Boolean(a.markedTest), note: "not cancelled: confirm whether it is a test, a block or a real booking" },
    });
  }

  return finish(target, errors, actions);
}

function describeF(f: FreshaSnapshot["appointments"][number], tz: string) {
  return { id: f.id, at: `${localDay(f.start, tz)} ${localTime(f.start, tz)}–${localTime(f.end, tz)}`, service: f.serviceName, status: f.status };
}
function describeM(a: MaiSnapshot["appointments"][number], tz: string) {
  return {
    id: a.id,
    at: `${localDay(a.start, tz)} ${localTime(a.start, tz)}–${localTime(a.end, tz)}`,
    service: a.serviceNameSnapshot,
    durationMinSnapshot: a.durationMinSnapshot,
    priceSnapshot: a.priceSnapshot,
    status: a.status,
  };
}

const ALL_KINDS: ActionKind[] = [
  "ignore_unmapped_staff",
  "service_diff",
  "service_unmapped",
  "create_exception",
  "exception_already_present",
  "exception_partial_overlap",
  "block_conflicts_with_appointments",
  "hold_unverified",
  "propose_weekly_rule",
  "appointment_match",
  "appointment_mismatch",
  "appointment_missing_in_mai",
  "appointment_missing_in_fresha",
  "appointment_cancelled_in_fresha",
];

function finish(target: ReconcileTarget, errors: string[], actions: PlanAction[]): ReconcilePlan {
  const sorted = [...actions].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const summary = Object.fromEntries(ALL_KINDS.map((k) => [k, sorted.filter((a) => a.kind === k).length])) as Record<ActionKind, number>;
  return { dryRun: true, target, errors, actions: sorted, summary };
}
