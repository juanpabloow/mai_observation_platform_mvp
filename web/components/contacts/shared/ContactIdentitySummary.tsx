import type { ReactNode } from "react";
import { avatarColor } from "@/lib/avatarColor";
import { consentLabel } from "@/lib/contactLabels";
import type { ContactSummary, IdentityView } from "@/lib/contactShared";

/**
 * SHARED identity headline (C-4) — the same markup renders in the record's left column
 * (full) and the inbox customer panel (dense). Avatar + display name + Customer/consent
 * badges + a visits/no-shows quick-stats line + the IDENTITIES list (C-2's payoff: one
 * person, several identities). Pure/presentational — no server data beyond its props.
 *
 * `centered` is an opt-in LAYOUT variant (the inbox panel uses it): the avatar grows
 * and stacks over a centred name, with `action` — a link the caller supplies, e.g.
 * "Open full record" — underneath. It changes only the arrangement: the same avatar,
 * name, badges, stats and identity rows render in both variants, so the record's
 * column is untouched.
 */

const BADGE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";

/**
 * The contact's disc. Two INITIALS and the deterministic per-contact colour (the same
 * helper the inbox queue and thread use), so the person is recognisable by the same
 * mark everywhere in the app.
 */
function Avatar({
  name,
  size,
  colorKey,
}: {
  name: string;
  size: "dense" | "full" | "hero";
  /** What the tone hashes on. The contact's PHONE when it has one, so the disc
   *  matches the inbox queue and thread (which only know the channel id); the name
   *  otherwise. */
  colorKey: string;
}) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length > 0
      ? words
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase()
      : "?";
  const box = size === "hero" ? "size-14 text-base" : size === "full" ? "size-12 text-lg" : "size-9 text-sm";
  return (
    <span
      aria-hidden
      className={`u-mono flex ${box} shrink-0 items-center justify-center rounded-full font-semibold ${avatarColor(colorKey)}`}
    >
      {initials}
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
  centered = false,
  row = false,
  action,
}: {
  summary: ContactSummary;
  identities: IdentityView[];
  dense?: boolean;
  /** Stack the avatar over a centred name (the inbox customer panel). */
  centered?: boolean;
  /** ONE compact line: small avatar, name + handles beside it, `action` on the right.
   *  The CRM side panel uses this; the inbox panel keeps `centered` untouched. */
  row?: boolean;
  /** Rendered under the name in the centred variant, or at the right end of `row`. */
  action?: ReactNode;
}) {
  // The phone is the identity the inbox knows this person by, so it is what the tone
  // hashes on; a contact with no phone falls back to its display name.
  const colorKey = identities.find((i) => i.kind === "phone")?.value ?? summary.displayName;

  const badges = (
    <div className={`flex flex-wrap items-center gap-1.5 ${centered ? "justify-center" : ""}`}>
      {summary.isCustomer ? <span className={`${BADGE} bg-success/15 text-success`}>cliente</span> : null}
      {/* Consent surfaces ONLY when opted out — quiet, informational, not an error. */}
      {summary.consent === "opted_out" ? (
        <span className={`${BADGE} bg-subtle text-muted`} title="Este contacto rechazó recibir mensajes">
          {consentLabel("opted_out")}
        </span>
      ) : null}
    </div>
  );

  if (row) {
    // The panel header is the strip the reader spends the least time in and the most
    // vertical space on: a hero avatar over a centred name restates what they just
    // clicked. Identity left, the actions worth a button right, one line.
    const inline = identities.slice(0, 2);
    return (
      // w-full + min-w-0 all the way down: without them this row sizes to max-content
      // and a long email pushes the actions straight out of a 360px panel.
      <div className="flex w-full min-w-0 items-center gap-3">
        <Avatar name={summary.displayName} size="dense" colorKey={colorKey} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground">
            {summary.displayName}
          </span>
          {inline.length > 0 ? (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
              {inline.map((i, idx) => (
                <span key={`${i.kind}:${i.value}:${idx}`} className="flex min-w-0 items-center gap-1.5">
                  {idx > 0 ? <span aria-hidden className="text-faintest">&middot;</span> : null}
                  <span className={`truncate ${i.kind === "phone" ? "u-mono text-muted" : "text-muted"}`}>
                    {i.value}
                  </span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
        {action}
      </div>
    );
  }

  if (centered) {
    // The identities read as ONE line under the name (email · phone) rather than a
    // stacked list: at the top of a panel they are the person's handles, not records
    // to inspect — the full list still renders in the record's own column.
    const inline = identities.slice(0, 3);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar name={summary.displayName} size="hero" colorKey={colorKey} />
          <span className="max-w-full truncate text-lg font-semibold text-foreground">{summary.displayName}</span>
          {inline.length > 0 ? (
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-sm">
              {inline.map((i, idx) => (
                <span key={`${i.kind}:${i.value}:${idx}`} className="flex items-center gap-2">
                  {idx > 0 ? (
                    <span aria-hidden className="text-faintest">
                      &middot;
                    </span>
                  ) : null}
                  <span className={i.kind === "phone" ? "u-mono text-[0.8125rem] text-foreground" : "text-brand"}>
                    {i.value}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          {badges}
          {action}
        </div>
        {/* No visits/no-shows line and no stacked identity list in the CENTRED
            variant: the numbers moved to the Next appointment section, and the
            identities are the inline line above. The record's column keeps both. */}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Avatar name={summary.displayName} size={dense ? "dense" : "full"} colorKey={colorKey} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className={`truncate font-semibold text-foreground ${dense ? "text-sm" : "text-lg"}`}>
            {summary.displayName}
          </span>
          {badges}
        </div>
      </div>

      <Stats summary={summary} />
      <Identities identities={identities} />
    </div>
  );
}

/** Quick stats — derived from appointments, not a stored column. */
function Stats({ summary }: { summary: ContactSummary }) {
  return (
    <div className="flex items-center gap-4 text-xs text-muted">
      <span>
        <span className="font-medium text-foreground tabular-nums">{summary.visitCount}</span> visitas
      </span>
      <span>
        <span className="font-medium text-foreground tabular-nums">{summary.noShowCount}</span> no-shows
      </span>
    </div>
  );
}

/** Identities as a list (not fields) — every contact_identities row. */
function Identities({ identities }: { identities: IdentityView[] }) {
  if (identities.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {identities.map((i, idx) => (
        <li key={`${i.kind}:${i.value}:${idx}`} className="flex items-center gap-2 text-sm">
          <IdentityIcon kind={i.kind} />
          <span className={`truncate text-foreground ${i.kind === "phone" ? "font-mono text-xs" : ""}`}>{i.value}</span>
          {i.label ? <span className="truncate text-xs text-faint">{i.label}</span> : null}
        </li>
      ))}
    </ul>
  );
}
