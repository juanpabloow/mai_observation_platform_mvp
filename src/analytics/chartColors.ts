/**
 * The palette businesses are drawn with in charts (COSTOS DE IA and anything that follows).
 * Fixed order, starting on the app's bot violet. Both columns passed the dataviz palette checks
 * (lightness band, chroma floor, CVD and normal-vision separation, contrast) on their surface;
 * the light amber's low contrast is covered by legends and table views.
 *
 * Stored per business as the SLOT (`clients.chart_color`), never the hex.
 */
export const CHART_COLORS = [
  { slot: 's1', label: 'Violeta', light: '#6e62d0', dark: '#8476e0' },
  { slot: 's2', label: 'Verde azulado', light: '#2aa198', dark: '#25a094' },
  { slot: 's3', label: 'Ámbar', light: '#d18a1f', dark: '#c78524' },
  { slot: 's4', label: 'Rosa', light: '#d9668f', dark: '#d4648c' },
  { slot: 's5', label: 'Azul', light: '#4a8fe0', dark: '#4d8fdd' },
  { slot: 's6', label: 'Verde', light: '#5f9e2f', dark: '#6aa83a' },
  { slot: 's7', label: 'Morado', light: '#b05cc0', dark: '#bb6bcb' },
  { slot: 's8', label: 'Coral', light: '#e06a4a', dark: '#d66b4d' },
] as const;

export type ChartColorSlot = (typeof CHART_COLORS)[number]['slot'];

export function isChartColorSlot(v: unknown): v is ChartColorSlot {
  return typeof v === 'string' && CHART_COLORS.some((c) => c.slot === v);
}

/**
 * Slot per business: its chosen color first; the rest take the free slots in name order, so
 * an automatic color never changes because another business ranked higher this period.
 * Businesses past the palette (more than 8 without a free slot) get null (drawn gray).
 */
export function assignChartColors(
  businesses: ReadonlyArray<{ key: string; name: string; chartColor: string | null }>,
): Map<string, ChartColorSlot | null> {
  const out = new Map<string, ChartColorSlot | null>();
  const taken = new Set<string>();
  for (const b of businesses) {
    if (isChartColorSlot(b.chartColor)) {
      out.set(b.key, b.chartColor);
      taken.add(b.chartColor);
    }
  }
  const free: ChartColorSlot[] = CHART_COLORS.map((c) => c.slot).filter((sl) => !taken.has(sl));
  for (const b of [...businesses].sort((x, y) => x.name.localeCompare(y.name, 'es'))) {
    if (out.has(b.key)) continue;
    out.set(b.key, free.shift() ?? null);
  }
  return out;
}
