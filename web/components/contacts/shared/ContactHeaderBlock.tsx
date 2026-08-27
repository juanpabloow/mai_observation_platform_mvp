"use client";

import type { ReactNode } from "react";
import { Chip, StageChip } from "@/components/ui/primitives";
import { consentLabel } from "@/lib/contactLabels";
import { Avatar } from "@/components/contacts/form/formPrimitives";
import { avatarToneStyle } from "@/lib/avatarColor";

/**
 * The contact HEADER, shared by the list's quick view and the edit drawer.
 *
 * The two surfaces stay deliberately different SHAPES — the quick view is a card that
 * lives beside the table, the drawer is a full-height overlay with a scrim — because
 * that difference is what says "you are looking" versus "you are changing things".
 * What must NOT differ is the vocabulary: the same avatar, the same name treatment,
 * the same chips, the same context line, the same metric tiles. Before this component
 * the drawer had metrics and no avatar while the panel had an avatar and no metrics,
 * so the same person was introduced two different ways depending on the door.
 *
 * Composition, not configuration: each surface still owns its own frame and its own
 * actions (the panel's sit at the top, because a view that saves nothing has no
 * footer to put them in). This only owns who the contact IS.
 *
 * DENSITY IS PART OF THE CONTRACT. At 360px the header competes with the content it is
 * introducing, so it is exactly two lines: name + chips, then one meta line. The
 * activity count lives in the tile below and is NOT repeated here — saying "2
 * actividades" directly above a tile reading "ACTIVIDADES 2" is the kind of doubling
 * that reads as clutter without adding a fact.
 */

export interface ContactHeaderFacts {
  /** Completed visits — the "· 14 citas" beside the identity. */
  visitCount?: number;
  displayName: string;
  /** The phone/email the reader recognises them by — shown under the name. */
  primaryIdentity: string | null;
  stage: string;
  isCustomer: boolean;
  consent: string;
  /** ISO — drives "Contacto desde ago 2026". */
  createdAt: string;
  activityCount: number;
}

/**
 * The seed the contact's colour hashes on — a name when there is one, else the identity
 * the reader recognises them by. Exported so the header WASH and the avatar DISC derive
 * from the same string: two seeds would mean a teal disc on a purple header.
 */
export function contactToneSeed(facts: Pick<ContactHeaderFacts, "displayName" | "primaryIdentity">): string {
  return facts.displayName?.trim() ? facts.displayName : (facts.primaryIdentity ?? facts.displayName);
}

/**
 * The contact's tone as the inline style the header wash needs — BOTH stops of their
 * avatar pair, because the discs are two-tone spheres and the wash fades the same
 * gradient (see `avatarToneStyle`). It returns a style object rather than a single var
 * so no caller has to know the `--tone-a` / `--tone-b` custom-property names.
 */
export function contactToneStyle(
  facts: Pick<ContactHeaderFacts, "displayName" | "primaryIdentity">,
): Record<string, string> {
  return avatarToneStyle(contactToneSeed(facts));
}

/** Avatar + name + chips + the context line. One introduction, two surfaces. */
export function ContactHeaderBlock({
  facts,
  actions,
  recordAction,
  size = "regular",
}: {
  facts: ContactHeaderFacts;
  /** Rendered at the right of the name row (the panel's close control). */
  actions?: ReactNode;
  /**
   * A quiet NAVIGATION affordance on the name line — the design's `Ficha ↗`
   * (§2.5 / §3.5). Separate from `actions` because it is neither a control on this
   * panel nor an action on the customer: it is a link out, and the design gives it the
   * lightest weight available for exactly that reason.
   */
  recordAction?: ReactNode;
  /** `compact` trims the avatar for the 360px panel; the type scale is unchanged. */
  size?: "regular" | "compact";
}) {
  const avatarSize = size === "compact" ? 34 : 38;
  // ONE meta line: the identity, then how many times they have been in — the artboard's
  // "+1 415 555 0134 · 14 citas".
  //
  // It used to print `contactSince` ("Contacto desde ago 2026") instead of the visit
  // count, which truncated to "Contacto desde ago 2…" in a 380px panel and told an
  // operator the least actionable fact available. When they first arrived is a record
  // fact and lives in the Contacto section as "Cliente desde"; how often they come is
  // what you want beside their name.
  const visits = facts.visitCount ?? 0;
  const meta = [facts.primaryIdentity, visits > 0 ? `${visits} ${visits === 1 ? "cita" : "citas"}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex w-full min-w-0 items-start gap-2.5">
      <Avatar name={facts.displayName} fallback={facts.primaryIdentity ?? facts.displayName} size={avatarSize} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
          <h2 className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground">
            {facts.displayName}
          </h2>
          <StageChip stage={facts.stage} />
          {facts.isCustomer ? <Chip tone="muted">cliente</Chip> : null}
          {/* Consent surfaces ONLY when opted out — quiet, informational, not an error. */}
          {facts.consent === "opted_out" ? (
            <Chip tone="warn" title="Este contacto rechazó recibir mensajes">
              {consentLabel("opted_out").toLowerCase()}
            </Chip>
          ) : null}
        </div>
        <p className="truncate text-[0.6875rem] leading-4 text-faint" title={meta}>
          {meta}
        </p>
      </div>
      {recordAction ? <div className="shrink-0 self-start pt-1">{recordAction}</div> : null}
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

