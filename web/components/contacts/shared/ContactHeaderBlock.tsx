"use client";

import type { ReactNode } from "react";
import { Chip, MetricBox, MetricCell, StageChip } from "@/components/ui/primitives";
import { contactSince, relativeAge } from "@/lib/contactForm";
import { consentLabel, sourceLabel } from "@/lib/contactLabels";
import { Avatar } from "@/components/contacts/form/formPrimitives";
import { avatarToneVar } from "@/lib/avatarColor";

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

/** The contact's tone as a CSS var, for the header wash. */
export function contactToneVar(facts: Pick<ContactHeaderFacts, "displayName" | "primaryIdentity">): string {
  return avatarToneVar(contactToneSeed(facts));
}

/** Avatar + name + chips + the context line. One introduction, two surfaces. */
export function ContactHeaderBlock({
  facts,
  actions,
  size = "regular",
}: {
  facts: ContactHeaderFacts;
  /** Rendered at the right of the name row (the panel's close control). */
  actions?: ReactNode;
  /** `compact` trims the avatar for the 360px panel; the type scale is unchanged. */
  size?: "regular" | "compact";
}) {
  const avatarSize = size === "compact" ? 34 : 38;
  // ONE meta line, not three stacked ones. The activity count is deliberately absent:
  // the ACTIVIDADES tile right below already states it, and printing the same number
  // twice in a 360px header is what made this read as clutter.
  const meta = [facts.primaryIdentity, contactSince(facts.createdAt)].filter(Boolean).join(" · ");
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
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export interface ContactMetricFacts {
  activityCount: number;
  /** ISO. */
  lastContactAt: string;
  /** The raw origin channel — humanised here, never printed as stored. */
  sourceChannel: string;
}

/**
 * The three header metrics, as ONE divided box. Both surfaces show the SAME three, from
 * the same numbers: `activityCount` in particular comes from one loader, so the panel
 * and the drawer can never quote a different total for the same contact.
 */
export function ContactMetrics({ facts, now }: { facts: ContactMetricFacts; now: Date }) {
  return (
    // ONE bordered box divided into three cells, not three separate tiles. The
    // reference groups them because they are one reading — "how much, how recently, by
    // which channel" — and three floating tiles read as three unrelated facts. The box
    // and the cell are shared primitives: the staff panel draws its four KPIs from the
    // same pair, so a metric strip means the same thing on both screens.
    <MetricBox>
      <MetricCell label="CITAS" value={String(facts.activityCount)} />
      <MetricCell label="ÚLTIMA" value={relativeAge(facts.lastContactAt, now)} />
      {/* The channel is a live route, so it carries a state dot; a count and a
          timestamp are not states and get none. */}
      <MetricCell label="CANAL" value={sourceLabel(facts.sourceChannel)} dot />
    </MetricBox>
  );
}
