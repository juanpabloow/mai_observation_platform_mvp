"use client";

/**
 * The three-step progress line. "Paso N de 3" always; from `sm` up the three named
 * steps follow as pills — the current one solid ink, a finished one underlined with a
 * green ✓ (and clickable, to go back), a future one quiet and inert. On the phone the
 * pills would not fit 390px, so the current step's NAME rides the "Paso N de 3" line.
 * PRESENTATIONAL — the flow decides which steps are reachable.
 */

export interface StepItem<T extends number> {
  value: T;
  label: string;
}

export function BookingStepper<T extends number>({
  steps,
  current,
  onSelect,
}: {
  steps: ReadonlyArray<StepItem<T>>;
  current: T;
  onSelect: (value: T) => void;
}) {
  const index = steps.findIndex((s) => s.value === current);
  return (
    <nav aria-label="Progreso de la reserva" className="flex flex-wrap items-center gap-4">
      <span className="shrink-0 text-[13px] text-muted">
        Paso <span className="u-mono text-foreground">{index + 1}</span> de {steps.length}
        <span className="sm:hidden">
          {" "}
          · <span className="font-semibold text-foreground">{steps[index]?.label}</span>
        </span>
      </span>
      <ol className="hidden flex-wrap items-center gap-1.5 sm:flex">
        {steps.map((s, i) => {
          const isCurrent = i === index;
          const done = i < index;
          return (
            <li key={s.value}>
              <button
                type="button"
                aria-current={isCurrent ? "step" : undefined}
                disabled={!done}
                onClick={() => done && onSelect(s.value)}
                className={`u-focus flex h-[36px] items-center gap-2 rounded-full pl-1.5 pr-3 text-[13px] ${
                  isCurrent
                    ? "bg-ink text-ink-fg"
                    : done
                      ? "cursor-pointer text-foreground underline underline-offset-[3px]"
                      : "cursor-default text-muted"
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-6 items-center justify-center rounded-full text-xs no-underline ${
                    isCurrent ? "bg-ink-fg text-ink" : done ? "bg-success/12 text-success" : "bg-subtle text-muted"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>
                {s.label}
                {done ? <span className="sr-only"> (completado)</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
