/**
 * COSTOS DE IA — split what OpenAI billed by business. PURE.
 *
 * Day by day:
 *   1. EXACT — every invoice line of a project assigned to a business goes to that business.
 *   2. SHARED — the rest of the day (shared / unassigned projects, e.g. «Default project») is
 *      split among the businesses WITHOUT their own billed project that day, in proportion to
 *      the tokens their bots used that day (n8n). Approximate, and labelled so.
 *   3. UNASSIGNED — what nobody's bots explain (no usage that day, or workflows not assigned to a
 *      business): tests, the n8n editor, other uses of the account. Never forced onto a client.
 *
 * Invoice days are UTC (OpenAI's buckets) and usage days are local; the shift of a few hours is
 * part of why the shared split is an approximation.
 */

export interface BilledLine {
  day: string;
  projectId: string;
  usd: number;
}

export interface DayTokens {
  day: string;
  /** Tokens per business key ('' = workflows not assigned to a business). */
  byClient: Record<string, number>;
}

export interface ClientSplit {
  exactUsd: number;
  sharedUsd: number;
  totalUsd: number;
}

export interface BillingSplit {
  byClient: Record<string, ClientSplit>;
  unassignedUsd: number;
  totalUsd: number;
}

export function splitBilling(input: {
  billed: BilledLine[];
  /** Business key → its own OpenAI project. */
  projectOf: Record<string, string>;
  tokens: DayTokens[];
}): BillingSplit {
  const ownerOf = new Map<string, string>(Object.entries(input.projectOf).map(([client, project]) => [project, client]));
  const tokensByDay = new Map(input.tokens.map((t) => [t.day, t.byClient]));
  const byClient: Record<string, ClientSplit> = {};
  const add = (client: string, part: 'exactUsd' | 'sharedUsd', usd: number) => {
    const c = (byClient[client] ??= { exactUsd: 0, sharedUsd: 0, totalUsd: 0 });
    c[part] += usd;
    c.totalUsd += usd;
  };
  let unassignedUsd = 0;
  let totalUsd = 0;

  const days = [...new Set(input.billed.map((b) => b.day))].sort();
  for (const day of days) {
    const lines = input.billed.filter((b) => b.day === day);
    let pool = 0;
    const exactToday = new Set<string>();
    for (const l of lines) {
      totalUsd += l.usd;
      const owner = ownerOf.get(l.projectId);
      if (owner !== undefined) {
        add(owner, 'exactUsd', l.usd);
        if (l.usd > 0) exactToday.add(owner);
      } else {
        pool += l.usd;
      }
    }
    if (pool <= 0) continue;
    // Businesses whose own project already explains their spend today don't take a shared part.
    const usage = Object.entries(tokensByDay.get(day) ?? {}).filter(([client, t]) => t > 0 && !exactToday.has(client));
    const totalTokens = usage.reduce((n, [, t]) => n + t, 0);
    if (totalTokens <= 0) {
      unassignedUsd += pool;
      continue;
    }
    for (const [client, t] of usage) {
      const share = (pool * t) / totalTokens;
      if (client === '') unassignedUsd += share;
      else add(client, 'sharedUsd', share);
    }
  }
  return { byClient, unassignedUsd, totalUsd };
}
