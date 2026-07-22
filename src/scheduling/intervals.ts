/**
 * Half-open UTC time intervals [start, end) and the set algebra the availability
 * engine needs: intersection and subtraction. All times are epoch-ms numbers here
 * (the engine converts Dates ↔ ms at the boundary) to keep the math simple.
 */

export interface Span {
  start: number; // epoch ms, inclusive
  end: number; // epoch ms, exclusive
}

/** Drop empty/inverted spans and merge overlapping/adjacent ones (sorted output). */
export function normalize(spans: Span[]): Span[] {
  const valid = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of valid) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** a ∩ b for two (individually normalized) span sets. */
export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  const A = normalize(a);
  const B = normalize(b);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i].start, B[j].start);
    const end = Math.min(A[i].end, B[j].end);
    if (end > start) out.push({ start, end });
    if (A[i].end < B[j].end) i++;
    else j++;
  }
  return out;
}

/** base ∖ holes (remove each hole from every base span). */
export function subtract(base: Span[], holes: Span[]): Span[] {
  const H = normalize(holes);
  let current = normalize(base);
  for (const hole of H) {
    const next: Span[] = [];
    for (const s of current) {
      if (hole.end <= s.start || hole.start >= s.end) {
        next.push(s); // no overlap
        continue;
      }
      if (hole.start > s.start) next.push({ start: s.start, end: hole.start });
      if (hole.end < s.end) next.push({ start: hole.end, end: s.end });
    }
    current = next;
  }
  return normalize(current);
}
