"use client";

/**
 * "Revisa tu reserva" — a compact label/value record. An unchosen field says "Por
 * elegir" in a quiet tone, never a value that looks decided. PRESENTATIONAL.
 */

export interface SummaryRow {
  label: string;
  value: string | null;
  mono?: boolean;
}

export function BookingSummary({
  rows,
  title = "Revisa tu reserva",
  note = "Nada se reserva hasta que confirmes.",
}: {
  rows: SummaryRow[];
  title?: string;
  note?: string | null;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1.5 rounded-xl border border-line px-4 py-3.5">
      <h3 className="text-xs font-semibold uppercase tracking-[0.04em] text-muted">{title}</h3>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-3 border-b border-line py-2.5 last:border-b-0">
            <dt className="w-24 shrink-0 text-[13px] text-muted">{row.label}</dt>
            <dd className={`min-w-0 flex-1 break-words text-sm ${row.value ? "text-foreground" : "text-faint"} ${row.value && row.mono ? "u-mono" : ""}`}>
              {row.value ?? "Por elegir"}
            </dd>
          </div>
        ))}
      </dl>
      {note ? <p className="pt-1 text-[12.5px] leading-relaxed text-muted">{note}</p> : null}
    </section>
  );
}
