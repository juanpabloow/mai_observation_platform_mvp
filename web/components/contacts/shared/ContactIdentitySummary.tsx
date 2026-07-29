import type { ContactSummary, IdentityView } from "@/lib/contactShared";

/**
 * SHARED identity headline (C-4) — the same markup renders in the record's left column
 * (full) and the inbox customer panel (dense). Avatar + display name + Customer/consent
 * badges + a visits/no-shows quick-stats line + the IDENTITIES list (C-2's payoff: one
 * person, several identities). Pure/presentational — no server data beyond its props.
 */

const BADGE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

function Avatar({ name, dense }: { name: string; dense: boolean }) {
  const initial = (name.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className={`flex ${dense ? "size-9" : "size-12"} shrink-0 items-center justify-center rounded-full border border-line-strong bg-subtle font-semibold text-foreground ${dense ? "text-sm" : "text-lg"}`}
    >
      {initial}
    </span>
  );
}

function IdentityIcon({ kind }: { kind: IdentityView["kind"] }) {
  const cls = "size-3.5 shrink-0 text-faint";
  if (kind === "phone") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <path d="M6 3h3l1.5 4.5-2 1.5a11 11 0 0 0 5 5l1.5-2 4.5 1.5V21a1 1 0 0 1-1 1A16 16 0 0 1 5 6a1 1 0 0 1 1-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "email") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={cls} fill="none" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ContactIdentitySummary({
  summary,
  identities,
  dense = false,
}: {
  summary: ContactSummary;
  identities: IdentityView[];
  dense?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Avatar name={summary.displayName} dense={dense} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`truncate font-semibold text-foreground ${dense ? "text-sm" : "text-lg"}`}>
            {summary.displayName}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {summary.isCustomer ? (
              <span className={`${BADGE} bg-emerald-500/15 text-emerald-700 dark:text-emerald-400`}>Customer</span>
            ) : null}
            {/* Consent surfaces ONLY when opted out — quiet, informational, not an error. */}
            {summary.consent === "opted_out" ? (
              <span className={`${BADGE} bg-subtle text-muted`} title="This contact has opted out of messaging">
                Opted out
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {/* Quick stats — derived from appointments, not a stored column. */}
      <div className="flex items-center gap-4 text-xs text-muted">
        <span>
          <span className="font-medium text-foreground tabular-nums">{summary.visitCount}</span> visits
        </span>
        <span>
          <span className="font-medium text-foreground tabular-nums">{summary.noShowCount}</span> no-shows
        </span>
      </div>

      {/* Identities as a list (not fields) — every contact_identities row. */}
      {identities.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {identities.map((i, idx) => (
            <li key={`${i.kind}:${i.value}:${idx}`} className="flex items-center gap-2 text-sm">
              <IdentityIcon kind={i.kind} />
              <span className={`truncate text-foreground ${i.kind === "phone" ? "font-mono text-xs" : ""}`}>{i.value}</span>
              {i.label ? <span className="truncate text-xs text-faint">{i.label}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
