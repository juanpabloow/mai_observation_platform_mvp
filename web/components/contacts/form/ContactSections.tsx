"use client";

import type { ReactNode } from "react";
import type { PreferredChannel } from "@worker/db/repositories/contacts.js";
import type { TagView } from "@/lib/contactShared";
import { COPY, type ContactFormValues } from "@/lib/contactForm";
import { EMPTY, channelLabel, consentLabel, customFieldLabel, yesNoLabel } from "@/lib/contactLabels";
import { StageChip } from "@/components/ui/primitives";
import { tagChipClass } from "@/lib/tagColors";
import type { FieldDefView } from "../ContactProperties";
import { ClientFieldsSection } from "./ClientFieldsSection";
import { AssignmentSection, CommunicationSection } from "./ContactFormSections";
import { IdentitySection } from "./IdentitySection";
import {
  Field,
  FormSection,
  IconAssign,
  IconBusiness,
  IconComms,
  IconIdentity,
  IconInternal,
  OptionalDivider,
  TagChips,
  type OwnerOption,
} from "./formPrimitives";

/**
 * THE contact body — one component, two modes.
 *
 * WHY THIS EXISTS. Viewing a contact and editing one had drifted into two products:
 * the drawer had icon-headed sections, Spanish, humanised values and segmented
 * controls; the record's left column was a flat list of raw enums ("new", "manual",
 * "unknown") in English. They disagreed about section order, about spacing, and about
 * what a contact even consists of.
 *
 * So the SECTIONS, THEIR ORDER and THE FIELDS INSIDE THEM are declared exactly once —
 * here — and `mode` decides only how each value is PAINTED: text in read mode, the
 * existing controls in edit mode. Adding a field to the drawer now necessarily adds it
 * to the record, which is the property that stops the two from diverging again. Same
 * reasoning as loadContactEditPayload doing the loading for both.
 *
 * READ MODE IS NOT DISABLED EDIT MODE. It renders values as plain text with no field
 * borders and no inputs, because a greyed-out input still reads as "you may type here,
 * later" and invites clicking. Everything editable is reached through one door: the
 * "Editar contacto" button that opens this same component in edit mode.
 *
 * ONE DELIBERATE ASYMMETRY. In edit mode INTERNO carries the note composer; in read
 * mode it carries only the tags, because the record already owns notes, tasks and the
 * activity timeline in its own regions and duplicating them in the left column would
 * be a third place to read the same rows.
 */

export interface ContactReadValues {
  name: string | null;
  /** Identities already on record, in the order the loader resolved them. */
  phones: string[];
  emails: string[];
  /** Resolved display name of the owner, or null for unassigned. */
  ownerLabel: string | null;
  stage: string;
  preferredChannel: PreferredChannel | null;
  doNotContact: boolean;
  consent: string;
  consentUpdatedAt: string | null;
  consentSource: string | null;
  customFields: Record<string, unknown>;
  tags: TagView[];
}

export interface ContactEditHandles {
  values: ContactFormValues;
  onChange: (patch: Partial<ContactFormValues>) => void;
  owners: OwnerOption[];
  /** Identity inputs are ADD-ONLY on edit; the existing ones render as facts above. */
  existingPhones: string[];
  existingEmails: string[];
  newPhones: string[];
  newEmails: string[];
  onNewPhones: (v: string[]) => void;
  onNewEmails: (v: string[]) => void;
  excludeContactId: string | null;
  identityError: string | null;
  consentUpdatedAt: string | null;
  consentSource: string | null;
  /** Receives the BOX state. The CALLER maps it onto a stored value, because
   *  "unchecked" must not manufacture an explicit `opted_out` nobody gave. */
  onConsentToggle: (optedIn: boolean) => void;
  /** The append-only note block — record-owned in read mode, so only edit passes it. */
  notesSlot?: ReactNode;
  canManageTagCatalog: boolean;
}

type Props =
  | {
      mode: "read";
      clientId: string;
      fieldDefs: FieldDefView[];
      read: ContactReadValues;
      /** 2 at panel width (the reference), 1 in the record's narrow rail. */
      columns?: 1 | 2;
    }
  | { mode: "edit"; clientId: string; fieldDefs: FieldDefView[]; edit: ContactEditHandles };

/**
 * Two-up grid for read-mode fields. The reference pairs Nombre|Teléfono and Email|… at
 * panel width, which nearly halves the column's height. `columns={1}` is for the
 * record's 300px rail, where two would leave ~140px per value: the FIELDS and their
 * ORDER are identical either way — only the density adapts.
 */
function ReadGrid({ columns, children }: { columns: 1 | 2; children: ReactNode }) {
  // gap-y is 0: each ReadField now pays its own `py-1`, so a second gap here would
  // reintroduce exactly the airiness the one-line fact row was meant to remove.
  return <div className={`grid gap-x-4 ${columns === 2 ? "grid-cols-2" : "grid-cols-1"}`}>{children}</div>;
}

/**
 * A read-mode value, in the redesign's FACT ROW shape (§2.5): the label on a fixed-width
 * left column, the value hard right on the same line.
 *
 * It used to stack — a mono-uppercase label with the value beneath it — which cost two
 * lines per fact and made a nine-fact panel scroll. Putting them on one line halves that,
 * and right-aligning the values gives the column an edge the eye can run down, which is
 * the whole reason the design does it: you scan for the VALUE ("who owns this?"), not for
 * the label you already know is there.
 *
 * The value keeps `min-w-0` and its own wrapping so a long email still truncates rather
 * than pushing the label out of the panel.
 */
function ReadField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2.5 py-1">
      <span className="w-[6.5rem] shrink-0 text-[0.71875rem] leading-5 text-faint">{label}</span>
      <div className="flex min-w-0 flex-1 justify-end text-right text-[0.8125rem] text-foreground">
        {children}
      </div>
    </div>
  );
}

/**
 * A communication setting as a FACT ROW with a state dot.
 *
 * It used to be a tinted BOX per setting — a green wash for a live route, amber for
 * something unresolved, grey for nothing set. Three filled rows stacked in a 320px column
 * turned "Mensajería" into the loudest block on the record, louder than the money, and
 * the tint restated what the dot and the words already said.
 *
 * The design (artboard 23a) renders them as the same label/value rows as every other
 * section, keeping only the DOT. That is enough: the dot previews the answer, the value
 * states it, and the row no longer shouts. The reading order in the column is now uniform,
 * which is the whole point of the left card being one document.
 *
 * The dot is decoration carrying a hint, never the meaning — each row still prints its own
 * value, so the block survives greyscale.
 */
function StateRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone: "ok" | "pending" | "off";
}) {
  const dot = tone === "ok" ? "bg-success" : tone === "pending" ? "bg-warn" : "bg-line-strong";
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="min-w-0 flex-1 truncate text-[0.71875rem] text-faint">{label}</span>
      <span className="shrink-0 text-[0.78125rem] text-foreground">{value}</span>
    </div>
  );
}

function Empty() {
  return <span className="text-faint">{EMPTY}</span>;
}

/** Identities as facts — the same list shape the drawer shows under "En el registro". */
function IdentityList({ values, mono }: { values: string[]; mono?: boolean }) {
  if (values.length === 0) return <Empty />;
  return (
    <ul className="flex flex-col gap-1">
      {values.map((v) => (
        <li key={v} className={`truncate text-sm text-foreground ${mono ? "u-mono text-[0.8125rem]" : ""}`} title={v}>
          {v}
        </li>
      ))}
    </ul>
  );
}

export function ContactSections(props: Props) {
  const { clientId, fieldDefs, mode } = props;
  const cols: 1 | 2 = mode === "read" ? (props.columns ?? 2) : 1;

  return (
    <div className="flex flex-col">
      {/* ── IDENTIDAD ─────────────────────────────────────────────────────── */}
      <FormSection title="Contacto" icon={<IconIdentity />}>
        {mode === "read" ? (
          <ReadGrid columns={cols}>
            <ReadField label="Nombre">{props.read.name?.trim() || <Empty />}</ReadField>
            <ReadField label="Teléfono">
              <IdentityList values={props.read.phones} mono />
            </ReadField>
            <ReadField label="Email">
              <IdentityList values={props.read.emails} />
            </ReadField>
          </ReadGrid>
        ) : (
          <>
            {props.edit.existingPhones.length + props.edit.existingEmails.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">En el registro</span>
                <ul className="flex flex-col gap-1">
                  {[...props.edit.existingPhones, ...props.edit.existingEmails].map((v) => (
                    <li
                      key={v}
                      className="u-mono flex items-center justify-between gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[0.8125rem] text-foreground"
                    >
                      <span className="truncate">{v}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <IdentitySection
              clientId={clientId}
              name={props.edit.values.name}
              onNameChange={(v) => props.edit.onChange({ name: v })}
              phones={props.edit.newPhones}
              onPhonesChange={props.edit.onNewPhones}
              emails={props.edit.newEmails}
              onEmailsChange={props.edit.onNewEmails}
              excludeContactId={props.edit.excludeContactId}
              identityError={props.edit.identityError}
            />
          </>
        )}
      </FormSection>

      {/* ── ASIGNACIÓN ────────────────────────────────────────────────────── */}
      <FormSection title="Asignación" icon={<IconAssign />}>
        {mode === "read" ? (
          <ReadGrid columns={cols}>
            <ReadField label="Dueño">{props.read.ownerLabel ?? <span className="text-faint">Sin asignar</span>}</ReadField>
            {/* The SAME chip the record header and the list use — stage is never a bare
                word in one place and a pill in another. */}
            <ReadField label="Stage">
              <StageChip stage={props.read.stage} />
            </ReadField>
          </ReadGrid>
        ) : (
          <AssignmentSection
            owners={props.edit.owners}
            ownerId={props.edit.values.assignedTo}
            onOwnerChange={(v) => props.edit.onChange({ assignedTo: v })}
            stage={props.edit.values.stage}
            onStageChange={(v) => props.edit.onChange({ stage: v })}
          />
        )}
      </FormSection>

      {/* ── COMUNICACIÓN ──────────────────────────────────────────────────── */}
      <FormSection title="Mensajería" icon={<IconComms />}>
        {mode === "read" ? (
          <div className="flex flex-col gap-1.5">
            <StateRow
              label="Canal preferido"
              tone={props.read.preferredChannel ? "ok" : "off"}
              value={
                props.read.preferredChannel ? (
                  channelLabel(props.read.preferredChannel)
                ) : (
                  <span className="font-normal text-faint">{channelLabel(null)}</span>
                )
              }
            />
            <StateRow
              label="Consentimiento de mensajería"
              tone={props.read.consent === "opted_in" ? "ok" : props.read.consent === "opted_out" ? "off" : "pending"}
              value={
                <span className="flex flex-col items-end">
                  {consentLabel(props.read.consent)}
                  <ConsentProvenance
                    consent={props.read.consent}
                    updatedAt={props.read.consentUpdatedAt}
                    source={props.read.consentSource}
                  />
                </span>
              }
            />
            <StateRow
              label={COPY.doNotContact}
              tone={props.read.doNotContact ? "pending" : "off"}
              value={yesNoLabel(props.read.doNotContact)}
            />
          </div>
        ) : (
          <CommunicationSection
            channel={props.edit.values.preferredChannel}
            onChannelChange={(v) => props.edit.onChange({ preferredChannel: v })}
            doNotContact={props.edit.values.doNotContact}
            onDoNotContactChange={(v) => props.edit.onChange({ doNotContact: v })}
            consent={props.edit.values.consent}
            consentUpdatedAt={props.edit.consentUpdatedAt}
            consentSource={props.edit.consentSource}
            onConsentChange={props.edit.onConsentToggle}
          />
        )}
      </FormSection>

      {/* ── INTERNO ───────────────────────────────────────────────────────── */}
      <FormSection title="Interno" icon={<IconInternal />}>
        {mode === "read" ? (
          <ReadField label="Etiquetas">
            {props.read.tags.length === 0 ? (
              <Empty />
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {props.read.tags.map((t) => (
                  <span
                    key={t.id}
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${tagChipClass(t.color)}`}
                  >
                    {t.name}
                  </span>
                ))}
              </span>
            )}
          </ReadField>
        ) : (
          <>
            <Field label="Etiquetas">
              <TagChips
                tags={props.edit.values.tags}
                onAdd={(t) =>
                  props.edit.onChange({
                    tags: props.edit.values.tags.some((x) => x.toLowerCase() === t.toLowerCase())
                      ? props.edit.values.tags
                      : [...props.edit.values.tags, t],
                  })
                }
                onRemove={(t) => props.edit.onChange({ tags: props.edit.values.tags.filter((x) => x !== t) })}
              />
              {!props.edit.canManageTagCatalog ? (
                <p className="mt-1 text-[11px] text-faint">Solo puedes usar etiquetas que ya existan.</p>
              ) : null}
            </Field>
            {props.edit.notesSlot}
          </>
        )}
      </FormSection>

      {/*
        "Todo lo de abajo es opcional" is an EDITING affordance — it tells someone filling
        the form that they can stop here. Two reasons it used to be wrong:
        it rendered in READ mode, where there is nothing to fill in and "opcional" states
        nothing about the facts below it; and it rendered even with no business fields
        defined, announcing an optional section that then did not exist.
        It now appears only when it is both true and useful: editing, and there is
        something below it to introduce.
      */}
      {mode === "edit" && fieldDefs.length > 0 ? (
        <div className="border-b border-line px-4 py-3">
          <OptionalDivider label={COPY.optionalDivider} />
        </div>
      ) : null}

      {/* ── CONFIGURADO POR EL NEGOCIO ────────────────────────────────────── */}
      {/* Renders NOTHING when the tenant defined no fields — in BOTH modes, so the
          record and the drawer agree about whether the section exists at all. */}
      {fieldDefs.length > 0 ? (
        <FormSection
          title={COPY.businessConfigured}
          icon={<IconBusiness />}
          trailing={
            <span className="u-mono rounded border border-line bg-chip px-1.5 py-0.5 text-[0.625rem] uppercase tracking-wider text-faint">
              custom fields
            </span>
          }
        >
          {mode === "read" ? (
            fieldDefs.map((d) => (
              <ReadField key={d.id} label={d.label}>
                {(() => {
                  const text = customFieldLabel(d.type, props.read.customFields[d.key]);
                  return text === EMPTY ? <Empty /> : text;
                })()}
              </ReadField>
            ))
          ) : (
            <ClientFieldsSection
              fieldDefs={fieldDefs}
              values={props.edit.values.customFields}
              onChange={(next) => props.edit.onChange({ customFields: next })}
            />
          )}
        </FormSection>
      ) : null}
    </div>
  );
}

/** "Aceptado el 12 mar 2023 por WhatsApp" — shown only when consent is on record. */
function ConsentProvenance({
  consent,
  updatedAt,
  source,
}: {
  consent: string;
  updatedAt: string | null;
  source: string | null;
}) {
  if (consent !== "opted_in" || !updatedAt) return null;
  const d = new Date(updatedAt);
  if (Number.isNaN(d.getTime())) return null;
  const when = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" }).format(d);
  return <span className="text-[11px] text-faint">{source ? `Aceptado el ${when} por ${source}` : `Aceptado el ${when}`}</span>;
}
