import type { HandoffSendSummary } from "@worker/db/repositories/analytics.js";

/**
 * The words for the agent-send tile (workflow Analytics). Pure, so the denominators are
 * tested (test/unit/handoffSendMetrics.test.ts). "Accepted" is the workflow's `sent`, which
 * is NOT a WhatsApp delivery receipt — the tile says so, instead of letting a 100% read as
 * "every reply reached the customer".
 */
export function handoffSendTile(s: HandoffSendSummary, days: number): {
  label: string;
  value: string;
  sub: string;
  failures: string | null;
  note: string;
} {
  const pct = (n: number) => (s.total > 0 ? `${Math.round((n / s.total) * 100)}%` : "—");
  return {
    label: `Agent sends · ${days}d`,
    value: s.total.toLocaleString("en-US"),
    sub: `${s.accepted} accepted (${pct(s.accepted)}) · ${s.failed} failed (${pct(s.failed)}) · ${s.pending} pending`,
    failures: s.failedByCode.length > 0 ? s.failedByCode.map((f) => `${f.code} ${f.count}`).join(" · ") : null,
    note: "Accepted by the workflow, not confirmed delivered — WhatsApp delivery receipts are not tracked.",
  };
}
